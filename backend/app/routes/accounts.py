"""Account CRUD routes."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import auth, crud, models, schemas
from ..database import get_session

router = APIRouter(tags=["accounts"])


@router.get("/accounts", response_model=List[schemas.Account])
def list_accounts(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    accounts = crud.get_accounts(db, current_user.id)
    for account in accounts:
        if (account.liquidity or 0.0) < 0:
            raise HTTPException(
                status_code=400,
                detail=f"Account {account.name} has negative liquidity. Please adjust it.",
            )
    return accounts


@router.post("/accounts", response_model=schemas.Account)
def create_account(
    payload: schemas.AccountCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    existing = crud.get_account_by_name(db, current_user.id, payload.name)
    if existing:
        raise HTTPException(status_code=400, detail="Account already exists")
    try:
        return crud.create_account(db, current_user.id, payload)
    except IntegrityError as exc:
        raise HTTPException(status_code=400, detail="Account already exists") from exc


@router.put("/accounts/{account_id}", response_model=schemas.Account)
def update_account(
    account_id: int,
    payload: schemas.AccountUpdate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    account = crud.get_account(db, current_user.id, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    try:
        return crud.update_account(db, account, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(status_code=400, detail="Account already exists") from exc


@router.post("/accounts/{account_id}/cash", response_model=schemas.Account)
def move_account_cash(
    account_id: int,
    payload: schemas.CashMovementRequest,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    account = crud.get_account(db, current_user.id, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    try:
        return crud.apply_cash_movement(db, account, current_user.id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/accounts/{account_id}")
def delete_account(
    account_id: int,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    account = crud.get_account(db, current_user.id, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    deleted_holdings = len(account.holdings)
    crud.delete_account(db, account)
    return {"status": "deleted", "deleted_holdings": deleted_holdings}
