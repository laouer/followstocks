"""Placement CRUD and snapshot routes."""
import logging
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import auth, crud, models, schemas
from ..database import get_session

log = logging.getLogger("followstocks")

router = APIRouter(tags=["placements"])


# ── Helpers ─────────────────────────────────────────────────


def _placement_cash_delta(entry_kind: str | None, value: float) -> float:
    kind = (entry_kind or "VALUE").upper()
    if kind == "INITIAL":
        return -value
    if kind == "WITHDRAWAL":
        return value
    return 0.0


def _placement_contribution_delta(entry_kind: str | None, value: float) -> float:
    kind = (entry_kind or "VALUE").upper()
    if kind == "CONTRIBUTION":
        return value
    return 0.0


def _compute_new_liquidity(account: models.Account, delta: float) -> float:
    current = account.liquidity or 0.0
    new_liquidity = current + delta
    if new_liquidity < 0:
        if abs(new_liquidity) <= 1e-6:
            return 0.0
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient account liquidity for {account.name}",
        )
    return new_liquidity


def _compute_new_manual_invested(account: models.Account, delta: float) -> float:
    current = account.manual_invested or 0.0
    new_manual = current + delta
    if new_manual < 0:
        if abs(new_manual) <= 1e-6:
            return 0.0
        raise HTTPException(
            status_code=400,
            detail="Capital contributed cannot go below zero",
        )
    return new_manual


def _apply_account_liquidity(db: Session, account: models.Account, new_liquidity: float) -> None:
    account.liquidity = new_liquidity
    account.updated_at = datetime.now(timezone.utc)
    db.add(account)
    db.commit()
    db.refresh(account)


def _apply_account_manual_invested(
    db: Session, account: models.Account, new_manual_invested: float
) -> None:
    account.manual_invested = new_manual_invested
    account.updated_at = datetime.now(timezone.utc)
    db.add(account)
    db.commit()
    db.refresh(account)


# ── Routes ──────────────────────────────────────────────────


@router.get("/placements", response_model=List[schemas.Placement])
def list_placements(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    return crud.get_placements(db, current_user.id)


@router.post("/placements", response_model=schemas.Placement)
def create_placement(
    payload: schemas.PlacementCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    if payload.account_id is None:
        account = crud.get_or_create_default_account(db, current_user.id)
        payload = payload.model_copy(update={"account_id": account.id})
    else:
        account = crud.get_account(db, current_user.id, payload.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
    new_liquidity = None
    if payload.initial_value is not None:
        initial_delta = _placement_cash_delta("INITIAL", payload.initial_value)
        if abs(initial_delta) > 1e-9:
            new_liquidity = _compute_new_liquidity(account, initial_delta)
    placement = crud.create_placement(db, current_user.id, payload)
    if new_liquidity is not None:
        try:
            _apply_account_liquidity(db, account, new_liquidity)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account liquidity for placement %s: %s",
                placement.name,
                exc,
            )
    return placement


@router.put("/placements/{placement_id}", response_model=schemas.Placement)
def update_placement(
    placement_id: int,
    payload: schemas.PlacementUpdate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    if payload.account_id is not None:
        account = crud.get_account(db, current_user.id, payload.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
    return crud.update_placement(db, placement, payload)


@router.delete("/placements/{placement_id}")
def delete_placement(
    placement_id: int,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    crud.delete_placement(db, placement)
    return {"status": "deleted"}


@router.get("/placements/{placement_id}/snapshots", response_model=List[schemas.PlacementSnapshot])
def list_placement_snapshots(
    placement_id: int,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    return crud.get_placement_snapshots(db, placement.id, limit=limit)


@router.post("/placements/{placement_id}/snapshots", response_model=schemas.Placement)
def add_placement_snapshot(
    placement_id: int,
    payload: schemas.PlacementSnapshotCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    entry_kind = (payload.entry_kind or "VALUE").upper()
    delta = _placement_cash_delta(entry_kind, payload.value)
    contribution_delta = _placement_contribution_delta(entry_kind, payload.value)
    account = None
    new_liquidity = None
    new_manual_invested = None
    if abs(delta) > 1e-9 or abs(contribution_delta) > 1e-9:
        if placement.account_id is None:
            raise HTTPException(
                status_code=400,
                detail="Placement must be linked to an account to record cash movements",
            )
        account = crud.get_account(db, current_user.id, placement.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
        if abs(delta) > 1e-9:
            new_liquidity = _compute_new_liquidity(account, delta)
        if abs(contribution_delta) > 1e-9:
            new_manual_invested = _compute_new_manual_invested(account, contribution_delta)
    try:
        crud.add_placement_snapshot(db, placement, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if new_liquidity is not None and account is not None:
        try:
            _apply_account_liquidity(db, account, new_liquidity)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account liquidity for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    if new_manual_invested is not None and account is not None:
        try:
            _apply_account_manual_invested(db, account, new_manual_invested)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account contribution for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    db.refresh(placement)
    return placement


@router.put("/placements/{placement_id}/snapshots/{snapshot_id}", response_model=schemas.Placement)
def update_placement_snapshot(
    placement_id: int,
    snapshot_id: int,
    payload: schemas.PlacementSnapshotUpdate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    snapshot = (
        db.query(models.PlacementSnapshot)
        .filter(
            models.PlacementSnapshot.id == snapshot_id,
            models.PlacementSnapshot.placement_id == placement.id,
        )
        .first()
    )
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    entry_kind_prev = (snapshot.entry_kind or "VALUE").upper()
    entry_kind_next = (payload.entry_kind or entry_kind_prev).upper()
    value_next = snapshot.value if payload.value is None else payload.value
    delta = _placement_cash_delta(entry_kind_next, value_next) - _placement_cash_delta(
        entry_kind_prev, snapshot.value
    )
    contribution_delta = _placement_contribution_delta(
        entry_kind_next, value_next
    ) - _placement_contribution_delta(entry_kind_prev, snapshot.value)
    account = None
    new_liquidity = None
    new_manual_invested = None
    if abs(delta) > 1e-9 or abs(contribution_delta) > 1e-9:
        if placement.account_id is None:
            raise HTTPException(
                status_code=400,
                detail="Placement must be linked to an account to record cash movements",
            )
        account = crud.get_account(db, current_user.id, placement.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
        if abs(delta) > 1e-9:
            new_liquidity = _compute_new_liquidity(account, delta)
        if abs(contribution_delta) > 1e-9:
            new_manual_invested = _compute_new_manual_invested(account, contribution_delta)
    try:
        crud.update_placement_snapshot(db, placement, snapshot, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if new_liquidity is not None and account is not None:
        try:
            _apply_account_liquidity(db, account, new_liquidity)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account liquidity for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    if new_manual_invested is not None and account is not None:
        try:
            _apply_account_manual_invested(db, account, new_manual_invested)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account contribution for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    db.refresh(placement)
    return placement


@router.delete("/placements/{placement_id}/snapshots/{snapshot_id}")
def delete_placement_snapshot(
    placement_id: int,
    snapshot_id: int,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    snapshot = (
        db.query(models.PlacementSnapshot)
        .filter(
            models.PlacementSnapshot.id == snapshot_id,
            models.PlacementSnapshot.placement_id == placement.id,
        )
        .first()
    )
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    delta = -_placement_cash_delta(snapshot.entry_kind, snapshot.value)
    contribution_delta = -_placement_contribution_delta(snapshot.entry_kind, snapshot.value)
    account = None
    new_liquidity = None
    new_manual_invested = None
    if abs(delta) > 1e-9 or abs(contribution_delta) > 1e-9:
        if placement.account_id is None:
            raise HTTPException(
                status_code=400,
                detail="Placement must be linked to an account to record cash movements",
            )
        account = crud.get_account(db, current_user.id, placement.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
        if abs(delta) > 1e-9:
            new_liquidity = _compute_new_liquidity(account, delta)
        if abs(contribution_delta) > 1e-9:
            new_manual_invested = _compute_new_manual_invested(account, contribution_delta)
    crud.delete_placement_snapshot(db, placement, snapshot)
    if new_liquidity is not None and account is not None:
        try:
            _apply_account_liquidity(db, account, new_liquidity)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account liquidity for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    if new_manual_invested is not None and account is not None:
        try:
            _apply_account_manual_invested(db, account, new_manual_invested)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account contribution for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    return {"status": "deleted"}
