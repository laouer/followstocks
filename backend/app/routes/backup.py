"""Backup export/import routes."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import auth, crud, models, schemas
from ..core.config import PRICE_TRACKER_YAHOO
from ..database import get_session

router = APIRouter(prefix="/backup", tags=["backup"])


@router.get("/export", response_model=schemas.BackupPayload)
def export_backup(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    accounts = crud.get_accounts(db, current_user.id)
    holdings = db.query(models.Holding).filter(models.Holding.user_id == current_user.id).all()
    transactions = db.query(models.Transaction).filter(models.Transaction.user_id == current_user.id).all()
    cash_transactions = db.query(models.CashTransaction).filter(models.CashTransaction.user_id == current_user.id).all()
    placements = db.query(models.Placement).filter(models.Placement.user_id == current_user.id).all()
    placement_snapshots = (
        db.query(models.PlacementSnapshot)
        .join(models.Placement, models.Placement.id == models.PlacementSnapshot.placement_id)
        .filter(models.Placement.user_id == current_user.id)
        .all()
    )
    holding_daily_snapshots = db.query(models.HoldingDailySnapshot).filter(models.HoldingDailySnapshot.user_id == current_user.id).all()
    portfolio_daily_snapshots = db.query(models.PortfolioDailySnapshot).filter(models.PortfolioDailySnapshot.user_id == current_user.id).all()

    payload = schemas.BackupPayload(
        exported_at=datetime.now(timezone.utc),
        accounts=[schemas.BackupAccount.model_validate(a) for a in accounts],
        holdings=[schemas.BackupHolding.model_validate(h) for h in holdings],
        transactions=[schemas.BackupTransaction.model_validate(t) for t in transactions],
        cash_transactions=[schemas.BackupCashTransaction.model_validate(t) for t in cash_transactions],
        placements=[schemas.BackupPlacement.model_validate(p) for p in placements],
        placement_snapshots=[schemas.BackupPlacementSnapshot.model_validate(s) for s in placement_snapshots],
        holding_daily_snapshots=[schemas.BackupHoldingDailySnapshot.model_validate(s) for s in holding_daily_snapshots],
        portfolio_daily_snapshots=[schemas.BackupPortfolioDailySnapshot.model_validate(s) for s in portfolio_daily_snapshots],
    )
    filename = f"backup-{datetime.now(timezone.utc).strftime('%Y%m%d')}.json"
    return JSONResponse(
        content=jsonable_encoder(payload),
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/import", response_model=schemas.BackupImportResult)
async def import_backup(
    file: UploadFile = File(...),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    content = await file.read()
    try:
        payload = schemas.BackupPayload.model_validate(json.loads(content))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON file") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid backup payload: {exc}") from exc

    if payload.version != 1:
        raise HTTPException(status_code=400, detail="Unsupported backup version")

    # Validate referential integrity
    account_ids = {a.id for a in payload.accounts}
    missing_account_refs: set[int] = set()
    for h in payload.holdings:
        if h.account_id not in account_ids:
            missing_account_refs.add(h.account_id)
    for t in payload.transactions:
        if t.account_id not in account_ids:
            missing_account_refs.add(t.account_id)
    for t in payload.cash_transactions:
        if t.account_id not in account_ids:
            missing_account_refs.add(t.account_id)
    for p in payload.placements:
        if p.account_id is not None and p.account_id not in account_ids:
            missing_account_refs.add(p.account_id)
    if missing_account_refs:
        missing = ", ".join(str(aid) for aid in sorted(missing_account_refs))
        raise HTTPException(status_code=400, detail=f"Missing accounts in backup: {missing}")

    placement_ids = {p.id for p in payload.placements}
    missing_placement_refs = {s.placement_id for s in payload.placement_snapshots if s.placement_id not in placement_ids}
    if missing_placement_refs:
        missing = ", ".join(str(pid) for pid in sorted(missing_placement_refs))
        raise HTTPException(status_code=400, detail=f"Missing placements in backup: {missing}")

    # Delete existing data
    db.query(models.PlacementSnapshot).filter(
        models.PlacementSnapshot.placement_id.in_(
            db.query(models.Placement.id).filter(models.Placement.user_id == current_user.id)
        )
    ).delete(synchronize_session=False)
    db.query(models.HoldingDailySnapshot).filter(models.HoldingDailySnapshot.user_id == current_user.id).delete(synchronize_session=False)
    db.query(models.PortfolioDailySnapshot).filter(models.PortfolioDailySnapshot.user_id == current_user.id).delete(synchronize_session=False)
    db.query(models.Placement).filter(models.Placement.user_id == current_user.id).delete(synchronize_session=False)
    db.query(models.Holding).filter(models.Holding.user_id == current_user.id).delete(synchronize_session=False)
    db.query(models.Transaction).filter(models.Transaction.user_id == current_user.id).delete(synchronize_session=False)
    db.query(models.CashTransaction).filter(models.CashTransaction.user_id == current_user.id).delete(synchronize_session=False)
    db.query(models.Account).filter(models.Account.user_id == current_user.id).delete(synchronize_session=False)
    db.commit()

    # Import accounts
    account_id_map: dict[int, int] = {}
    for account in payload.accounts:
        created = models.Account(
            user_id=current_user.id, name=account.name, account_type=account.account_type,
            liquidity=account.liquidity, manual_invested=account.manual_invested,
            created_at=account.created_at, updated_at=account.updated_at,
        )
        db.add(created)
        db.flush()
        account_id_map[account.id] = created.id

    # Import holdings
    for holding in payload.holdings:
        account_id = account_id_map.get(holding.account_id)
        if not account_id:
            raise HTTPException(status_code=400, detail=f"Account id {holding.account_id} missing for holding {holding.symbol}")
        db.add(models.Holding(
            user_id=current_user.id, account_id=account_id, symbol=holding.symbol,
            price_tracker=holding.price_tracker or PRICE_TRACKER_YAHOO,
            tracker_symbol=holding.tracker_symbol, shares=holding.shares,
            cost_basis=holding.cost_basis, acquisition_fee_value=holding.acquisition_fee_value,
            fx_rate=holding.fx_rate, currency=holding.currency, last_price=holding.last_price,
            last_snapshot_at=holding.last_snapshot_at, sector=holding.sector,
            industry=holding.industry, asset_type=holding.asset_type, isin=holding.isin,
            acquired_at=holding.acquired_at, mic=holding.mic, name=holding.name,
            href=holding.href, created_at=holding.created_at, updated_at=holding.updated_at,
        ))

    # Import transactions
    for transaction in payload.transactions:
        account_id = account_id_map.get(transaction.account_id)
        if not account_id:
            raise HTTPException(status_code=400, detail=f"Account id {transaction.account_id} missing for transaction")
        db.add(models.Transaction(
            user_id=current_user.id, account_id=account_id, symbol=transaction.symbol,
            side=transaction.side, shares=transaction.shares, price=transaction.price,
            fee_value=transaction.fee_value, currency=transaction.currency,
            executed_at=transaction.executed_at, realized_gain=transaction.realized_gain,
            created_at=transaction.created_at, updated_at=transaction.updated_at,
        ))

    # Import cash transactions
    for transaction in payload.cash_transactions:
        account_id = account_id_map.get(transaction.account_id)
        if not account_id:
            raise HTTPException(status_code=400, detail=f"Account id {transaction.account_id} missing for cash transaction")
        db.add(models.CashTransaction(
            user_id=current_user.id, account_id=account_id, amount=transaction.amount,
            direction=transaction.direction, reason=transaction.reason,
            created_at=transaction.created_at, updated_at=transaction.updated_at,
        ))

    # Import placements
    placement_id_map: dict[int, int] = {}
    for placement in payload.placements:
        account_id = None
        if placement.account_id is not None:
            account_id = account_id_map.get(placement.account_id)
            if not account_id:
                raise HTTPException(status_code=400, detail=f"Account id {placement.account_id} missing for placement {placement.name}")
        created = models.Placement(
            user_id=current_user.id, account_id=account_id, name=placement.name,
            placement_type=placement.placement_type, sector=placement.sector,
            industry=placement.industry, currency=placement.currency,
            initial_value=placement.initial_value, initial_recorded_at=placement.initial_recorded_at,
            total_contributions=placement.total_contributions, total_withdrawals=placement.total_withdrawals,
            total_interests=placement.total_interests, total_fees=placement.total_fees,
            current_value=placement.current_value, last_snapshot_at=placement.last_snapshot_at,
            notes=placement.notes, created_at=placement.created_at, updated_at=placement.updated_at,
        )
        db.add(created)
        db.flush()
        placement_id_map[placement.id] = created.id

    # Import placement snapshots
    for snapshot in payload.placement_snapshots:
        placement_id = placement_id_map.get(snapshot.placement_id)
        if not placement_id:
            raise HTTPException(status_code=400, detail=f"Placement id {snapshot.placement_id} missing for placement snapshot")
        db.add(models.PlacementSnapshot(
            placement_id=placement_id, entry_kind=snapshot.entry_kind, value=snapshot.value,
            recorded_at=snapshot.recorded_at, created_at=snapshot.created_at, updated_at=snapshot.updated_at,
        ))

    # Import daily snapshots
    for snapshot in payload.holding_daily_snapshots:
        db.add(models.HoldingDailySnapshot(
            user_id=current_user.id, snapshot_date=snapshot.snapshot_date, symbol=snapshot.symbol,
            name=snapshot.name, currency=snapshot.currency, shares=snapshot.shares,
            close_price=snapshot.close_price, cost_total=snapshot.cost_total,
            market_value=snapshot.market_value, gain_abs=snapshot.gain_abs,
            gain_pct=snapshot.gain_pct, created_at=snapshot.created_at, updated_at=snapshot.updated_at,
        ))

    for snapshot in payload.portfolio_daily_snapshots:
        db.add(models.PortfolioDailySnapshot(
            user_id=current_user.id, snapshot_date=snapshot.snapshot_date,
            holdings_value=snapshot.holdings_value, placements_value=snapshot.placements_value,
            liquidity_value=snapshot.liquidity_value, total_cost=snapshot.total_cost,
            total_value=snapshot.total_value, total_gain_abs=snapshot.total_gain_abs,
            total_gain_pct=snapshot.total_gain_pct, created_at=snapshot.created_at,
            updated_at=snapshot.updated_at,
        ))

    db.commit()

    return schemas.BackupImportResult(
        accounts=len(payload.accounts), holdings=len(payload.holdings),
        transactions=len(payload.transactions), cash_transactions=len(payload.cash_transactions),
        placements=len(payload.placements), placement_snapshots=len(payload.placement_snapshots),
        holding_daily_snapshots=len(payload.holding_daily_snapshots),
        portfolio_daily_snapshots=len(payload.portfolio_daily_snapshots),
    )
