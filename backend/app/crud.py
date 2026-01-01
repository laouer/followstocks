from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy.orm import Session, selectinload

from . import models, schemas

DEFAULT_ACCOUNT_NAME = "Main"


def get_user(db: Session, user_id: int) -> Optional[models.User]:
    return db.query(models.User).filter(models.User.id == user_id).first()


def get_user_by_email(db: Session, email: str) -> Optional[models.User]:
    return db.query(models.User).filter(models.User.email == email.lower()).first()


def create_user(db: Session, data: schemas.UserCreate, hashed_password: str) -> models.User:
    user = models.User(
        email=data.email.lower(),
        name=data.name,
        hashed_password=hashed_password,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def get_accounts(db: Session, user_id: int) -> List[models.Account]:
    return (
        db.query(models.Account)
        .filter(models.Account.user_id == user_id)
        .order_by(models.Account.name.asc())
        .all()
    )


def get_account(db: Session, user_id: int, account_id: int) -> Optional[models.Account]:
    return (
        db.query(models.Account)
        .filter(models.Account.id == account_id, models.Account.user_id == user_id)
        .first()
    )


def get_account_by_name(db: Session, user_id: int, name: str) -> Optional[models.Account]:
    return (
        db.query(models.Account)
        .filter(models.Account.user_id == user_id, models.Account.name == name)
        .first()
    )


def create_account(db: Session, user_id: int, data: schemas.AccountCreate) -> models.Account:
    account = models.Account(
        user_id=user_id,
        name=data.name,
        account_type=data.account_type,
        liquidity=data.liquidity,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def get_or_create_account_by_name(
    db: Session,
    user_id: int,
    name: str,
    account_type: Optional[str] = None,
    liquidity: float = 0.0,
) -> models.Account:
    account = get_account_by_name(db, user_id, name)
    if account:
        return account
    payload = schemas.AccountCreate(
        name=name,
        account_type=account_type,
        liquidity=liquidity,
    )
    return create_account(db, user_id, payload)


def get_or_create_default_account(db: Session, user_id: int) -> models.Account:
    return get_or_create_account_by_name(db, user_id, DEFAULT_ACCOUNT_NAME)


def update_account(
    db: Session, account: models.Account, data: schemas.AccountUpdate
) -> models.Account:
    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(account, field, value)
    account.updated_at = datetime.utcnow()
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def delete_account(db: Session, account: models.Account) -> None:
    holdings = (
        db.query(models.Holding)
        .filter(models.Holding.account_id == account.id)
        .all()
    )
    for holding in holdings:
        db.delete(holding)
    db.delete(account)
    db.commit()


def get_holding(db: Session, user_id: int, holding_id: int) -> Optional[models.Holding]:
    return (
        db.query(models.Holding)
        .filter(models.Holding.id == holding_id, models.Holding.user_id == user_id)
        .first()
    )


def get_holding_by_symbol(db: Session, user_id: int, symbol: str) -> Optional[models.Holding]:
    return (
        db.query(models.Holding)
        .filter(models.Holding.symbol == symbol.upper(), models.Holding.user_id == user_id)
        .first()
    )


def create_holding(db: Session, user_id: int, data: schemas.HoldingCreate) -> models.Holding:
    holding = models.Holding(
        user_id=user_id,
        account_id=data.account_id,
        symbol=data.symbol.upper(),
        shares=data.shares,
        cost_basis=data.cost_basis,
        acquisition_fee_value=data.acquisition_fee_value,
        currency=data.currency,
        sector=data.sector,
        industry=data.industry,
        asset_type=data.asset_type,
        isin=data.isin,
        acquired_at=data.acquired_at,
        mic=data.mic,
        name=data.name,
        href=data.href,
    )
    db.add(holding)
    db.commit()
    db.refresh(holding)
    return holding


def update_holding(db: Session, holding: models.Holding, data: schemas.HoldingUpdate) -> models.Holding:
    updates = data.model_dump(exclude_unset=True)
    if "symbol" in updates:
        updates["symbol"] = updates["symbol"].upper()
    if "isin" in updates and updates["isin"]:
        updates["isin"] = updates["isin"].upper()
    if "mic" in updates and updates["mic"]:
        updates["mic"] = updates["mic"].upper()
    if "href" in updates:
        updates["href"] = updates["href"] or None
    if "name" in updates:
        updates["name"] = updates["name"] or None

    for field, value in updates.items():
        setattr(holding, field, value)

    holding.updated_at = datetime.utcnow()
    db.add(holding)
    db.commit()
    db.refresh(holding)
    return holding


def delete_holding(db: Session, user_id: int, holding_id: int) -> bool:
    holding = get_holding(db, user_id, holding_id)
    if not holding:
        return False
    db.delete(holding)
    db.commit()
    return True


def add_price_snapshot(db: Session, holding: models.Holding, data: schemas.PriceSnapshotCreate) -> models.PriceSnapshot:
    recorded_at = data.recorded_at or datetime.utcnow()
    snapshot = models.PriceSnapshot(holding_id=holding.id, price=data.price, recorded_at=recorded_at)
    holding.updated_at = datetime.utcnow()
    db.add(snapshot)
    db.add(holding)
    db.commit()
    db.refresh(snapshot)
    return snapshot


def _latest_snapshot(db: Session, holding_id: int) -> Optional[models.PriceSnapshot]:
    return (
        db.query(models.PriceSnapshot)
        .filter(models.PriceSnapshot.holding_id == holding_id)
        .order_by(models.PriceSnapshot.recorded_at.desc())
        .first()
    )


def _previous_snapshot(db: Session, holding_id: int, latest: models.PriceSnapshot) -> Optional[models.PriceSnapshot]:
    cutoff = latest.recorded_at - timedelta(hours=1)
    prior_hour = (
        db.query(models.PriceSnapshot)
        .filter(
            models.PriceSnapshot.holding_id == holding_id,
            models.PriceSnapshot.id != latest.id,
            models.PriceSnapshot.recorded_at <= cutoff,
        )
        .order_by(models.PriceSnapshot.recorded_at.desc())
        .first()
    )
    if prior_hour:
        return prior_hour

    return (
        db.query(models.PriceSnapshot)
        .filter(models.PriceSnapshot.holding_id == holding_id, models.PriceSnapshot.id != latest.id)
        .order_by(models.PriceSnapshot.recorded_at.desc())
        .first()
    )


def build_holding_stats(db: Session, holding: models.Holding) -> schemas.HoldingStats:
    latest = _latest_snapshot(db, holding.id)
    previous = _previous_snapshot(db, holding.id, latest) if latest else None

    fee_value = holding.acquisition_fee_value if holding.acquisition_fee_value is not None else 0
    cost_total = holding.shares * holding.cost_basis + fee_value
    last_price = latest.price if latest else None
    market_value = holding.shares * last_price if last_price is not None else None
    gain_abs = market_value - cost_total if market_value is not None else None
    gain_pct = (gain_abs / cost_total) if gain_abs is not None and cost_total > 0 else None

    hourly_change = None
    hourly_change_pct = None
    if latest and previous:
        hourly_change = (latest.price - previous.price) * holding.shares
        if previous.price > 0:
            hourly_change_pct = (latest.price - previous.price) / previous.price

    return schemas.HoldingStats(
        id=holding.id,
        account_id=holding.account_id,
        symbol=holding.symbol,
        shares=holding.shares,
        cost_basis=holding.cost_basis,
        acquisition_fee_value=holding.acquisition_fee_value,
        currency=holding.currency,
        sector=holding.sector,
        industry=holding.industry,
        asset_type=holding.asset_type,
        account=holding.account,
        isin=holding.isin,
        acquired_at=holding.acquired_at,
        mic=holding.mic,
        name=holding.name,
        href=holding.href,
        created_at=holding.created_at,
        updated_at=holding.updated_at,
        last_price=last_price,
        last_snapshot_at=latest.recorded_at if latest else None,
        market_value=market_value,
        gain_abs=gain_abs,
        gain_pct=gain_pct,
        hourly_change=hourly_change,
        hourly_change_pct=hourly_change_pct,
    )


def get_holdings_with_stats(db: Session, user_id: int) -> List[schemas.HoldingStats]:
    holdings = (
        db.query(models.Holding)
        .options(selectinload(models.Holding.account))
        .filter(models.Holding.user_id == user_id)
        .order_by(models.Holding.symbol.asc())
        .all()
    )
    return [build_holding_stats(db, holding) for holding in holdings]


def get_holdings(db: Session, user_id: int) -> List[models.Holding]:
    return (
        db.query(models.Holding)
        .filter(models.Holding.user_id == user_id)
        .order_by(models.Holding.symbol.asc())
        .all()
    )


def get_snapshots_for_holding(
    db: Session, user_id: int, holding_id: int, limit: int = 24
) -> List[models.PriceSnapshot]:
    holding = get_holding(db, user_id, holding_id)
    if not holding:
        return []
    return (
        db.query(models.PriceSnapshot)
        .filter(models.PriceSnapshot.holding_id == holding.id)
        .order_by(models.PriceSnapshot.recorded_at.desc())
        .limit(limit)
        .all()
    )


def portfolio_summary(db: Session, user_id: int) -> schemas.PortfolioResponse:
    holdings = get_holdings_with_stats(db, user_id)
    accounts = get_accounts(db, user_id)

    total_cost = sum(
        h.shares * h.cost_basis + (h.acquisition_fee_value or 0)
        for h in holdings
    )
    market_values = [h.market_value for h in holdings if h.market_value is not None]
    total_value = sum(market_values) if market_values else None

    total_gain_abs = (total_value - total_cost) if total_value is not None else None
    total_gain_pct = (total_gain_abs / total_cost) if total_gain_abs is not None and total_cost > 0 else None

    hourly_changes = [h.hourly_change for h in holdings if h.hourly_change is not None]
    hourly_change_abs = sum(hourly_changes) if hourly_changes else None
    base_value = total_value - hourly_change_abs if total_value is not None and hourly_change_abs is not None else None
    hourly_change_pct = (hourly_change_abs / base_value) if base_value and base_value > 0 else None

    summary = schemas.PortfolioSummary(
        total_cost=total_cost,
        total_value=total_value,
        total_gain_abs=total_gain_abs,
        total_gain_pct=total_gain_pct,
        hourly_change_abs=hourly_change_abs,
        hourly_change_pct=hourly_change_pct,
    )
    return schemas.PortfolioResponse(summary=summary, holdings=holdings, accounts=accounts)
