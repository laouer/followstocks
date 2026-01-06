from datetime import datetime
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
    manual_invested = data.manual_invested or 0.0
    liquidity = (data.liquidity or 0.0) + manual_invested
    created_at = data.created_at or datetime.utcnow()
    account = models.Account(
        user_id=user_id,
        name=data.name,
        account_type=data.account_type,
        liquidity=liquidity,
        manual_invested=manual_invested,
        created_at=created_at,
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
    manual_invested_delta = None
    if "manual_invested" in updates:
        manual_invested_value = updates["manual_invested"] or 0.0
        manual_invested_delta = manual_invested_value - (account.manual_invested or 0.0)
        updates["manual_invested"] = manual_invested_value
    for field, value in updates.items():
        setattr(account, field, value)
    if manual_invested_delta:
        new_liquidity = (account.liquidity or 0.0) + manual_invested_delta
        if new_liquidity < 0:
            if abs(new_liquidity) <= 1e-6:
                new_liquidity = 0.0
            else:
                raise ValueError("Manual invested would make liquidity negative")
        account.liquidity = new_liquidity
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


def apply_cash_movement(
    db: Session,
    account: models.Account,
    user_id: int,
    payload: schemas.CashMovementRequest,
) -> models.Account:
    amount = payload.amount
    delta = amount if payload.direction == "ADD" else -amount
    new_liquidity = (account.liquidity or 0.0) + delta
    if new_liquidity < 0:
        raise ValueError("Cash available cannot go below zero")
    account.liquidity = new_liquidity
    if payload.reason.strip().lower() in {"contribution", "withdrawal"}:
        new_manual_invested = (account.manual_invested or 0.0) + delta
        if new_manual_invested < 0:
            if abs(new_manual_invested) <= 1e-6:
                new_manual_invested = 0.0
            else:
                raise ValueError("Capital contributed cannot go below zero")
        account.manual_invested = new_manual_invested
    account.updated_at = datetime.utcnow()
    transaction = models.CashTransaction(
        user_id=user_id,
        account_id=account.id,
        amount=amount,
        direction=payload.direction,
        reason=payload.reason,
    )
    db.add(transaction)
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


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


def get_holding_by_symbol_account(
    db: Session, user_id: int, account_id: int, symbol: str
) -> Optional[models.Holding]:
    return (
        db.query(models.Holding)
        .filter(
            models.Holding.symbol == symbol.upper(),
            models.Holding.user_id == user_id,
            models.Holding.account_id == account_id,
        )
        .first()
    )


def create_holding(db: Session, user_id: int, data: schemas.HoldingCreate) -> models.Holding:
    existing = get_holding_by_symbol_account(db, user_id, data.account_id, data.symbol)
    fee_value = data.acquisition_fee_value or 0
    buy_cost_total = data.shares * data.cost_basis + fee_value
    buy_cost_basis = buy_cost_total / data.shares
    buy_fx_rate = data.fx_rate
    if data.currency.upper() == "EUR":
        buy_fx_rate = 1.0

    if existing:
        if existing.currency.upper() != data.currency.upper():
            raise ValueError("Currency mismatch for existing holding")
        existing_total_cost = (
            existing.shares * existing.cost_basis + (existing.acquisition_fee_value or 0)
        )
        new_total_cost = existing_total_cost + buy_cost_total
        new_shares = existing.shares + data.shares
        existing.shares = new_shares
        existing.cost_basis = new_total_cost / new_shares
        existing.acquisition_fee_value = 0.0
        existing_fx_rate = existing.fx_rate
        if existing.currency.upper() == "EUR":
            existing_fx_rate = 1.0
        if existing_fx_rate is None and buy_fx_rate is not None:
            existing.fx_rate = buy_fx_rate
        elif existing_fx_rate is not None and buy_fx_rate is not None:
            weighted = (existing_total_cost * existing_fx_rate) + (buy_cost_total * buy_fx_rate)
            existing.fx_rate = weighted / new_total_cost if new_total_cost > 0 else existing_fx_rate
        if data.acquired_at:
            if existing.acquired_at is None or data.acquired_at < existing.acquired_at:
                existing.acquired_at = data.acquired_at
        if not existing.sector:
            existing.sector = data.sector
        if not existing.industry:
            existing.industry = data.industry
        if not existing.asset_type:
            existing.asset_type = data.asset_type
        if not existing.isin:
            existing.isin = data.isin
        if not existing.mic:
            existing.mic = data.mic
        if not existing.name:
            existing.name = data.name
        if not existing.href:
            existing.href = data.href
        existing.updated_at = datetime.utcnow()
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return existing

    holding = models.Holding(
        user_id=user_id,
        account_id=data.account_id,
        symbol=data.symbol.upper(),
        shares=data.shares,
        cost_basis=buy_cost_basis,
        acquisition_fee_value=0.0,
        fx_rate=buy_fx_rate if data.currency.upper() != "EUR" else None,
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


def create_transaction(
    db: Session,
    user_id: int,
    data: schemas.TransactionCreate,
    realized_gain: Optional[float] = None,
) -> models.Transaction:
    transaction = models.Transaction(
        user_id=user_id,
        account_id=data.account_id,
        symbol=data.symbol.upper(),
        side=data.side,
        shares=data.shares,
        price=data.price,
        fee_value=data.fee_value,
        currency=data.currency,
        executed_at=data.executed_at,
        realized_gain=realized_gain,
    )
    db.add(transaction)
    db.commit()
    db.refresh(transaction)
    return transaction


def update_holding(db: Session, holding: models.Holding, data: schemas.HoldingUpdate) -> models.Holding:
    updates = data.model_dump(exclude_unset=True)
    if "symbol" in updates:
        updates["symbol"] = updates["symbol"].upper()
    if "isin" in updates and updates["isin"]:
        updates["isin"] = updates["isin"].upper()
    if "mic" in updates and updates["mic"]:
        updates["mic"] = updates["mic"].upper()
    if "fx_rate" in updates and updates["fx_rate"] is None:
        updates.pop("fx_rate")
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


def add_price_snapshot(
    db: Session, holding: models.Holding, data: schemas.PriceSnapshotCreate
) -> models.Holding:
    recorded_at = data.recorded_at or datetime.utcnow()
    holding.last_price = data.price
    holding.last_snapshot_at = recorded_at
    holding.updated_at = datetime.utcnow()
    db.add(holding)
    db.commit()
    db.refresh(holding)
    return holding


def build_holding_stats(db: Session, holding: models.Holding) -> schemas.HoldingStats:
    fee_value = holding.acquisition_fee_value if holding.acquisition_fee_value is not None else 0
    cost_total = holding.shares * holding.cost_basis + fee_value
    last_price = holding.last_price
    market_value = holding.shares * last_price if last_price is not None else None
    gain_abs = market_value - cost_total if market_value is not None else None
    gain_pct = (gain_abs / cost_total) if gain_abs is not None and cost_total > 0 else None

    hourly_change = None
    hourly_change_pct = None

    return schemas.HoldingStats(
        id=holding.id,
        account_id=holding.account_id,
        symbol=holding.symbol,
        shares=holding.shares,
        cost_basis=holding.cost_basis,
        acquisition_fee_value=holding.acquisition_fee_value,
        fx_rate=holding.fx_rate,
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
        last_snapshot_at=holding.last_snapshot_at,
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


def get_placements(db: Session, user_id: int) -> List[models.Placement]:
    return (
        db.query(models.Placement)
        .filter(models.Placement.user_id == user_id)
        .order_by(models.Placement.name.asc())
        .all()
    )


def get_placement(db: Session, user_id: int, placement_id: int) -> Optional[models.Placement]:
    return (
        db.query(models.Placement)
        .filter(models.Placement.id == placement_id, models.Placement.user_id == user_id)
        .first()
    )


def create_placement(db: Session, user_id: int, data: schemas.PlacementCreate) -> models.Placement:
    placement = models.Placement(
        user_id=user_id,
        account_id=data.account_id,
        name=data.name,
        placement_type=data.placement_type,
        sector=data.sector,
        industry=data.industry,
        currency=data.currency,
        notes=data.notes,
    )
    db.add(placement)
    db.commit()
    db.refresh(placement)
    if data.initial_value is not None:
        snapshot_payload = schemas.PlacementSnapshotCreate(
            entry_kind="INITIAL",
            value=data.initial_value,
            recorded_at=data.recorded_at,
        )
        add_placement_snapshot(db, placement, snapshot_payload)
        db.refresh(placement)
    return placement


def update_placement(
    db: Session, placement: models.Placement, data: schemas.PlacementUpdate
) -> models.Placement:
    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(placement, field, value)
    placement.updated_at = datetime.utcnow()
    db.add(placement)
    db.commit()
    db.refresh(placement)
    return placement


def delete_placement(db: Session, placement: models.Placement) -> None:
    db.delete(placement)
    db.commit()


def _recompute_placement_values(
    db: Session,
    placement: models.Placement,
) -> models.Placement:
    snapshots = (
        db.query(models.PlacementSnapshot)
        .filter(models.PlacementSnapshot.placement_id == placement.id)
        .order_by(
            models.PlacementSnapshot.recorded_at.asc(),
            models.PlacementSnapshot.id.asc(),
        )
        .all()
    )
    if not snapshots:
        placement.initial_value = None
        placement.initial_recorded_at = None
        placement.total_contributions = None
        placement.total_withdrawals = None
        placement.total_interests = None
        placement.total_fees = None
        placement.current_value = None
        placement.last_snapshot_at = None
        placement.updated_at = datetime.utcnow()
        db.add(placement)
        db.commit()
        db.refresh(placement)
        return placement

    initial_snapshot = next(
        (snapshot for snapshot in snapshots if snapshot.entry_kind == "INITIAL"),
        None,
    )
    if not initial_snapshot:
        initial_snapshot = next(
            (snapshot for snapshot in snapshots if snapshot.entry_kind == "VALUE"),
            None,
        )
    if initial_snapshot:
        placement.initial_value = initial_snapshot.value
        placement.initial_recorded_at = initial_snapshot.recorded_at
    else:
        placement.initial_value = None
        placement.initial_recorded_at = None

    current_value = None
    total_contributions = 0.0
    total_withdrawals = 0.0
    total_interests = 0.0
    total_fees = 0.0
    for snapshot in snapshots:
        entry_kind = (snapshot.entry_kind or "VALUE").upper()
        if entry_kind in {"VALUE", "INITIAL"}:
            current_value = snapshot.value
        elif entry_kind == "INTEREST":
            current_value = (current_value or 0.0) + snapshot.value
            total_interests += snapshot.value
        elif entry_kind == "FEE":
            current_value = (current_value or 0.0) - snapshot.value
            total_fees += snapshot.value
        elif entry_kind == "CONTRIBUTION":
            current_value = (current_value or 0.0) + snapshot.value
            total_contributions += snapshot.value
        elif entry_kind == "WITHDRAWAL":
            current_value = (current_value or 0.0) - snapshot.value
            total_withdrawals += snapshot.value
    placement.current_value = current_value
    placement.total_contributions = total_contributions if total_contributions > 0 else 0.0
    placement.total_withdrawals = total_withdrawals if total_withdrawals > 0 else 0.0
    placement.total_interests = total_interests if total_interests > 0 else 0.0
    placement.total_fees = total_fees if total_fees > 0 else 0.0
    placement.last_snapshot_at = snapshots[-1].recorded_at
    placement.updated_at = datetime.utcnow()
    db.add(placement)
    db.commit()
    db.refresh(placement)
    return placement


def add_placement_snapshot(
    db: Session,
    placement: models.Placement,
    data: schemas.PlacementSnapshotCreate,
) -> models.PlacementSnapshot:
    entry_kind = (data.entry_kind or "VALUE").upper()
    if entry_kind not in {"VALUE", "INITIAL"}:
        has_value = (
            db.query(models.PlacementSnapshot)
            .filter(
                models.PlacementSnapshot.placement_id == placement.id,
                models.PlacementSnapshot.entry_kind.in_(["VALUE", "INITIAL"]),
            )
            .first()
        )
        if not has_value:
            raise ValueError(
                "Initial placement or value is required before interests, fees, contributions, or withdrawals"
            )
    recorded_at = data.recorded_at or datetime.utcnow()
    snapshot = models.PlacementSnapshot(
        placement_id=placement.id,
        entry_kind=entry_kind,
        value=data.value,
        recorded_at=recorded_at,
    )
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    _recompute_placement_values(db, placement)
    return snapshot


def update_placement_snapshot(
    db: Session,
    placement: models.Placement,
    snapshot: models.PlacementSnapshot,
    data: schemas.PlacementSnapshotUpdate,
) -> models.PlacementSnapshot:
    updates = data.model_dump(exclude_unset=True)
    if "entry_kind" in updates and updates["entry_kind"]:
        updates["entry_kind"] = updates["entry_kind"].upper()
    entry_kind_next = updates.get("entry_kind", snapshot.entry_kind) or "VALUE"
    if entry_kind_next not in {"VALUE", "INITIAL"}:
        other_value = (
            db.query(models.PlacementSnapshot)
            .filter(
                models.PlacementSnapshot.placement_id == placement.id,
                models.PlacementSnapshot.entry_kind.in_(["VALUE", "INITIAL"]),
                models.PlacementSnapshot.id != snapshot.id,
            )
            .first()
        )
        if not other_value:
            raise ValueError(
                "Initial placement or value is required before interests, fees, contributions, or withdrawals"
            )
    for field, value in updates.items():
        setattr(snapshot, field, value)
    snapshot.updated_at = datetime.utcnow()
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    _recompute_placement_values(db, placement)
    return snapshot


def delete_placement_snapshot(
    db: Session,
    placement: models.Placement,
    snapshot: models.PlacementSnapshot,
) -> None:
    db.delete(snapshot)
    db.commit()
    _recompute_placement_values(db, placement)


def get_placement_snapshots(
    db: Session,
    placement_id: int,
    limit: int = 50,
) -> List[models.PlacementSnapshot]:
    return (
        db.query(models.PlacementSnapshot)
        .filter(models.PlacementSnapshot.placement_id == placement_id)
        .order_by(models.PlacementSnapshot.recorded_at.desc())
        .limit(limit)
        .all()
    )


def portfolio_summary(db: Session, user_id: int) -> schemas.PortfolioResponse:
    holdings = get_holdings_with_stats(db, user_id)
    accounts = get_accounts(db, user_id)
    placements = get_placements(db, user_id)
    for account in accounts:
        if (account.liquidity or 0.0) < 0:
            raise ValueError(f"Account {account.name} has negative liquidity. Please adjust it.")

    total_cost = sum(
        h.shares * h.cost_basis + (h.acquisition_fee_value or 0)
        for h in holdings
    )
    placement_values = []
    placement_costs = []
    for placement in placements:
        if placement.current_value is None:
            continue
        placement_values.append(placement.current_value)
        base = (
            placement.initial_value
            if placement.initial_value is not None
            else placement.current_value
        )
        contributions = placement.total_contributions or 0.0
        withdrawals = placement.total_withdrawals or 0.0
        placement_costs.append(base + contributions - withdrawals)
    if placement_costs:
        total_cost += sum(placement_costs)

    market_values = [h.market_value for h in holdings if h.market_value is not None]
    value_components = market_values + placement_values
    total_value = sum(value_components) if value_components else None

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
    return schemas.PortfolioResponse(
        summary=summary,
        holdings=holdings,
        accounts=accounts,
        placements=placements,
    )
