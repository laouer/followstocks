"""Holdings CRUD, sell, refund, and price routes."""
import logging
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, crud, models, schemas
from ..core.config import PRICE_TRACKER_BOURSORAMA, PRICE_TRACKER_YAHOO
from ..database import get_session
from ..services.refresh_service import group_holdings_by_tracker, refresh_grouped_holdings
from ..utils.price_trackers import normalize_price_tracker

log = logging.getLogger("followstocks")

router = APIRouter(tags=["holdings"])


@router.post("/holdings", response_model=schemas.Holding)
async def create_holding(
    holding: schemas.HoldingCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    if holding.account_id is None:
        account = crud.get_or_create_default_account(db, current_user.id)
        holding = holding.model_copy(update={"account_id": account.id})
    else:
        account = crud.get_account(db, current_user.id, holding.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
    buy_total = holding.shares * holding.cost_basis + (holding.acquisition_fee_value or 0.0)
    rate = 1.0
    if holding.currency.upper() != "EUR":
        if holding.fx_rate:
            rate = holding.fx_rate
        else:
            raise HTTPException(status_code=400, detail="FX rate is required for non-EUR holdings")
    buy_total_eur = buy_total * rate
    available_liquidity = account.liquidity or 0.0
    new_liquidity = available_liquidity - buy_total_eur
    if new_liquidity < 0:
        if abs(new_liquidity) <= 1e-6:
            new_liquidity = 0.0
        else:
            raise HTTPException(status_code=400, detail="Insufficient account liquidity for this buy")
    try:
        created = crud.create_holding(db, current_user.id, holding)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        account.liquidity = new_liquidity
        account.updated_at = datetime.now(timezone.utc)
        db.add(account)
        db.commit()
        db.refresh(account)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to update account liquidity for %s: %s", holding.symbol, exc)
    try:
        transaction = schemas.TransactionCreate(
            account_id=holding.account_id,
            symbol=holding.symbol,
            side="BUY",
            shares=holding.shares,
            price=holding.cost_basis,
            fee_value=holding.acquisition_fee_value,
            currency=holding.currency,
            executed_at=holding.acquired_at,
        )
        crud.create_transaction(db, current_user.id, transaction)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to record BUY transaction for %s: %s", holding.symbol, exc)
    try:
        holdings = (
            db.query(models.Holding)
            .filter(models.Holding.symbol == created.symbol)
            .all()
        )
        grouped = group_holdings_by_tracker(holdings)
        await refresh_grouped_holdings(db, grouped)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to fetch/store initial price for %s: %s", created.symbol, exc)
    return created


@router.post("/holdings/{holding_id}/sell", response_model=schemas.HoldingSellResult)
def sell_holding(
    holding_id: int,
    payload: schemas.HoldingSellRequest,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    if holding.shares <= 0:
        raise HTTPException(status_code=400, detail="Holding has no shares to sell")
    epsilon = 1e-6
    if payload.shares > holding.shares + epsilon:
        raise HTTPException(status_code=400, detail="Not enough shares to sell")
    account = crud.get_account(db, current_user.id, holding.account_id)
    if not account:
        raise HTTPException(status_code=400, detail="Account not found")

    fee_value = payload.fee_value or 0.0
    total_cost = holding.shares * holding.cost_basis + (holding.acquisition_fee_value or 0.0)
    cost_per_share = total_cost / holding.shares
    proceeds = payload.price * payload.shares - fee_value
    realized_gain = (payload.price - cost_per_share) * payload.shares - fee_value

    rate = 1.0
    if holding.currency.upper() != "EUR":
        if payload.fx_rate:
            rate = payload.fx_rate
        else:
            log.warning("Missing FX rate for %s sell; using 1.0", holding.currency)
    account.liquidity = (account.liquidity or 0.0) + (proceeds * rate)
    account.updated_at = datetime.now(timezone.utc)

    remaining_shares = holding.shares - payload.shares
    if remaining_shares <= epsilon:
        db.delete(holding)
        remaining_shares = 0.0
    else:
        holding.shares = remaining_shares
        holding.cost_basis = cost_per_share
        holding.acquisition_fee_value = 0.0
        holding.updated_at = datetime.now(timezone.utc)
        db.add(holding)

    transaction = models.Transaction(
        user_id=current_user.id,
        account_id=account.id,
        symbol=holding.symbol,
        side="SELL",
        shares=payload.shares,
        price=payload.price,
        fee_value=fee_value,
        currency=holding.currency,
        executed_at=payload.executed_at,
        realized_gain=realized_gain,
    )
    db.add(account)
    db.add(transaction)
    db.commit()
    db.refresh(account)

    return schemas.HoldingSellResult(
        status="sold",
        realized_gain=realized_gain,
        remaining_shares=remaining_shares,
        account_liquidity=account.liquidity,
    )


@router.get("/holdings", response_model=List[schemas.HoldingStats])
def list_holdings(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    return crud.get_holdings_with_stats(db, current_user.id)


@router.put("/holdings/{holding_id}", response_model=schemas.Holding)
def update_holding(
    holding_id: int,
    payload: schemas.HoldingUpdate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    if payload.account_id is not None:
        account = crud.get_account(db, current_user.id, payload.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
    if payload.price_tracker is not None or payload.tracker_symbol is not None:
        next_tracker = normalize_price_tracker(
            payload.price_tracker or getattr(holding, "price_tracker", None)
        )
        next_symbol = (
            payload.tracker_symbol
            if payload.tracker_symbol is not None
            else getattr(holding, "tracker_symbol", None)
        )
        if next_tracker == PRICE_TRACKER_BOURSORAMA and not next_symbol:
            fallback_symbol = holding.symbol
            if not fallback_symbol:
                raise HTTPException(
                    status_code=400,
                    detail="Tracker symbol is required for Boursorama quotes",
                )
            payload = payload.model_copy(update={"tracker_symbol": fallback_symbol})
        if payload.price_tracker is not None and next_tracker == PRICE_TRACKER_YAHOO:
            payload = payload.model_copy(update={"tracker_symbol": None})
    return crud.update_holding(db, holding, payload)


@router.delete("/holdings/{holding_id}")
def remove_holding(
    holding_id: int,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    deleted = crud.delete_holding(db, current_user.id, holding_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Holding not found")
    return {"status": "deleted"}


@router.post("/holdings/{holding_id}/refund")
def remove_holding_and_refund(
    holding_id: int,
    payload: schemas.HoldingRefundRequest | None = None,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    account = crud.get_account(db, current_user.id, holding.account_id)
    if not account:
        raise HTTPException(status_code=400, detail="Account not found")
    total_cost = holding.shares * holding.cost_basis + (holding.acquisition_fee_value or 0.0)
    rate = 1.0
    if holding.currency.upper() != "EUR":
        fx_rate = payload.fx_rate if payload else None
        if fx_rate:
            rate = fx_rate
        else:
            log.warning("Missing FX rate for %s refund; using 1.0", holding.currency)
    account.liquidity = (account.liquidity or 0.0) + (total_cost * rate)
    account.updated_at = datetime.now(timezone.utc)
    db.add(account)
    db.delete(holding)
    db.commit()
    db.refresh(account)
    return {"status": "deleted", "refunded": total_cost, "account_liquidity": account.liquidity}


@router.post("/prices", response_model=schemas.HoldingStats)
def add_price(
    snapshot: schemas.PriceSnapshotCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, snapshot.holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    updated = crud.add_price_snapshot(db, holding, snapshot)
    try:
        snapshot_day = snapshot.recorded_at.date() if snapshot.recorded_at else None
        crud.capture_daily_history(db, current_user.id, snapshot_day)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        log.warning("Failed to capture daily history after manual price update: %s", exc)
    return crud.build_holding_stats(db, updated)


@router.post("/holdings/refresh")
async def refresh_holdings_prices(
    current_user: models.User = Depends(auth.get_current_user),
) -> dict:
    from ..services.refresh_service import refresh_holdings_prices_once

    try:
        await refresh_holdings_prices_once()
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Failed to refresh holdings prices") from exc
