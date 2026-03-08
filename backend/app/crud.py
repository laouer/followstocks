from datetime import date, datetime, timedelta
from typing import Any, List, Optional

from sqlalchemy.orm import Session, selectinload

from . import models, schemas
from .services.market_data_service import fetch_fx_rate_sync

DEFAULT_ACCOUNT_NAME = "Main"
EVOLUTION_WINDOWS = (
    ("evolution_1y_pct", timedelta(days=365)),
    ("evolution_1m_pct", timedelta(days=30)),
    ("evolution_5d_pct", timedelta(days=5)),
    ("evolution_1d_pct", timedelta(days=1)),
)


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
    incoming_tracker = (data.price_tracker or "yahoo").lower()
    incoming_tracker_symbol = data.tracker_symbol
    if existing and "price_tracker" not in data.model_fields_set:
        incoming_tracker = (existing.price_tracker or "yahoo").lower()
    if incoming_tracker == "boursorama":
        if existing and not incoming_tracker_symbol:
            incoming_tracker_symbol = existing.tracker_symbol
        incoming_tracker_symbol = incoming_tracker_symbol or data.symbol
    fee_value = data.acquisition_fee_value or 0
    buy_cost_total = data.shares * data.cost_basis + fee_value
    buy_cost_basis = buy_cost_total / data.shares
    buy_fx_rate = data.fx_rate
    if data.currency.upper() == "EUR":
        buy_fx_rate = 1.0

    if existing:
        existing_tracker = (existing.price_tracker or "yahoo").lower()
        if existing_tracker != incoming_tracker:
            raise ValueError(
                "Holding already exists with a different price tracker. Edit it to change tracker."
            )
        if incoming_tracker == "boursorama":
            existing_symbol = existing.tracker_symbol
            if existing_symbol and incoming_tracker_symbol and existing_symbol != incoming_tracker_symbol:
                raise ValueError(
                    "Holding already exists with a different tracker symbol. Edit it to change symbol."
                )
            if not existing_symbol and incoming_tracker_symbol:
                existing.tracker_symbol = incoming_tracker_symbol
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
        if not existing.price_tracker:
            existing.price_tracker = incoming_tracker
        existing.updated_at = datetime.utcnow()
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return existing

    holding = models.Holding(
        user_id=user_id,
        account_id=data.account_id,
        symbol=data.symbol.upper(),
        price_tracker=incoming_tracker,
        tracker_symbol=incoming_tracker_symbol if incoming_tracker == "boursorama" else None,
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
    if "price_tracker" in updates and updates["price_tracker"]:
        updates["price_tracker"] = str(updates["price_tracker"]).lower()
    if "tracker_symbol" in updates:
        updates["tracker_symbol"] = updates["tracker_symbol"] or None
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


def _build_holding_snapshot_lookup(
    db: Session,
    user_id: int,
    symbols: list[str],
) -> dict[str, list[models.HoldingDailySnapshot]]:
    if not symbols:
        return {}
    rows = (
        db.query(models.HoldingDailySnapshot)
        .filter(
            models.HoldingDailySnapshot.user_id == user_id,
            models.HoldingDailySnapshot.symbol.in_(symbols),
            models.HoldingDailySnapshot.close_price.isnot(None),
        )
        .order_by(
            models.HoldingDailySnapshot.symbol.asc(),
            models.HoldingDailySnapshot.snapshot_date.desc(),
        )
        .all()
    )
    lookup: dict[str, list[models.HoldingDailySnapshot]] = {}
    for row in rows:
        symbol_key = (row.symbol or "").upper().strip()
        if not symbol_key:
            continue
        lookup.setdefault(symbol_key, []).append(row)
    return lookup


def _compute_holding_evolution_pct(
    holding: models.Holding,
    snapshot_rows: list[models.HoldingDailySnapshot],
) -> dict[str, float | None]:
    evolution_pct: dict[str, float | None] = {key: None for key, _ in EVOLUTION_WINDOWS}
    latest_price = float(holding.last_price) if holding.last_price and holding.last_price > 0 else None
    if latest_price is None:
        for row in snapshot_rows:
            if row.close_price and row.close_price > 0:
                latest_price = float(row.close_price)
                break
    if latest_price is None:
        return evolution_pct

    as_of_day = holding.last_snapshot_at.date() if holding.last_snapshot_at else date.today()
    for key, window in EVOLUTION_WINDOWS:
        target_day = as_of_day - window
        reference_price: float | None = None
        for row in snapshot_rows:
            if row.snapshot_date > target_day:
                continue
            if row.close_price is None or row.close_price <= 0:
                continue
            reference_price = float(row.close_price)
            break
        if reference_price is not None and reference_price > 0:
            evolution_pct[key] = (latest_price - reference_price) / reference_price
    return evolution_pct


def build_holding_stats(
    db: Session,
    holding: models.Holding,
    snapshot_lookup: Optional[dict[str, list[models.HoldingDailySnapshot]]] = None,
) -> schemas.HoldingStats:
    fee_value = holding.acquisition_fee_value if holding.acquisition_fee_value is not None else 0
    cost_total = holding.shares * holding.cost_basis + fee_value
    last_price = holding.last_price
    market_value = holding.shares * last_price if last_price is not None else None
    gain_abs = market_value - cost_total if market_value is not None else None
    gain_pct = (gain_abs / cost_total) if gain_abs is not None and cost_total > 0 else None

    hourly_change = None
    hourly_change_pct = None
    symbol_key = (holding.symbol or "").upper().strip()
    snapshot_rows = snapshot_lookup.get(symbol_key, []) if snapshot_lookup else []
    evolution_pct = _compute_holding_evolution_pct(holding, snapshot_rows)

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
        price_tracker=getattr(holding, "price_tracker", None) or "yahoo",
        tracker_symbol=getattr(holding, "tracker_symbol", None),
        account=holding.account,
        isin=holding.isin,
        acquired_at=holding.acquired_at,
        mic=holding.mic,
        name=holding.name,
        href=holding.href,
        created_at=holding.created_at,
        updated_at=holding.updated_at,
        yahoo_target_low=getattr(holding, "yahoo_target_low", None),
        yahoo_target_mean=getattr(holding, "yahoo_target_mean", None),
        yahoo_target_high=getattr(holding, "yahoo_target_high", None),
        yahoo_target_parsed_at=getattr(holding, "yahoo_target_parsed_at", None),
        last_price=last_price,
        last_snapshot_at=holding.last_snapshot_at,
        market_value=market_value,
        gain_abs=gain_abs,
        gain_pct=gain_pct,
        hourly_change=hourly_change,
        hourly_change_pct=hourly_change_pct,
        evolution_1y_pct=evolution_pct["evolution_1y_pct"],
        evolution_1m_pct=evolution_pct["evolution_1m_pct"],
        evolution_5d_pct=evolution_pct["evolution_5d_pct"],
        evolution_1d_pct=evolution_pct["evolution_1d_pct"],
    )


def get_holdings_with_stats(db: Session, user_id: int) -> List[schemas.HoldingStats]:
    holdings = (
        db.query(models.Holding)
        .options(selectinload(models.Holding.account))
        .filter(models.Holding.user_id == user_id)
        .order_by(models.Holding.symbol.asc())
        .all()
    )
    symbols = sorted({(holding.symbol or "").upper().strip() for holding in holdings if holding.symbol})
    snapshot_lookup = _build_holding_snapshot_lookup(db, user_id, symbols)
    return [build_holding_stats(db, holding, snapshot_lookup) for holding in holdings]


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


def capture_daily_history(
    db: Session,
    user_id: int,
    snapshot_date: Optional[date] = None,
) -> tuple[int, int]:
    snapshot_day = snapshot_date or date.today()
    holdings = (
        db.query(models.Holding)
        .filter(models.Holding.user_id == user_id)
        .all()
    )

    grouped: dict[str, dict[str, object]] = {}
    fx_rate_cache: dict[str, float | None] = {"EUR": 1.0}

    def convert_to_eur(
        amount: float | None,
        currency: str | None,
        fallback_rate: float | None = None,
    ) -> float | None:
        if amount is None:
            return None
        curr = (currency or "EUR").upper().strip() or "EUR"
        if curr == "EUR":
            return float(amount)
        if curr not in fx_rate_cache:
            fx_rate_cache[curr] = fetch_fx_rate_sync(curr, "EUR")
        rate = fx_rate_cache.get(curr)
        if (rate is None or rate <= 0) and fallback_rate and fallback_rate > 0:
            rate = fallback_rate
        if rate is None or rate <= 0:
            return float(amount)
        return float(amount) * float(rate)

    for holding in holdings:
        symbol = (holding.symbol or "").upper().strip()
        if not symbol:
            continue
        currency = (holding.currency or "EUR").upper().strip() or "EUR"
        shares = float(holding.shares or 0.0)
        fee_value = float(holding.acquisition_fee_value or 0.0)
        cost_total = shares * float(holding.cost_basis or 0.0) + fee_value
        entry = grouped.get(symbol)
        if entry is None:
            entry = {
                "symbol": symbol,
                "name": holding.name or symbol,
                "currency": currency,
                "shares": 0.0,
                "cost_total": 0.0,
                "priced_shares": 0.0,
                "market_value": 0.0,
                "fx_weighted_sum": 0.0,
                "fx_weight": 0.0,
            }
            grouped[symbol] = entry

        entry["shares"] = float(entry["shares"]) + shares
        entry["cost_total"] = float(entry["cost_total"]) + cost_total
        fx_rate = float(holding.fx_rate) if holding.fx_rate else None
        if fx_rate and fx_rate > 0:
            entry["fx_weighted_sum"] = float(entry["fx_weighted_sum"]) + (cost_total * fx_rate)
            entry["fx_weight"] = float(entry["fx_weight"]) + cost_total
        if not entry.get("name") and holding.name:
            entry["name"] = holding.name

        price = holding.last_price
        if price is not None:
            entry["priced_shares"] = float(entry["priced_shares"]) + shares
            entry["market_value"] = float(entry["market_value"]) + (shares * float(price))

    existing_rows = (
        db.query(models.HoldingDailySnapshot)
        .filter(
            models.HoldingDailySnapshot.user_id == user_id,
            models.HoldingDailySnapshot.snapshot_date == snapshot_day,
        )
        .all()
    )
    existing_by_symbol = {row.symbol.upper(): row for row in existing_rows}
    current_symbols = set(grouped.keys())
    for row in existing_rows:
        if row.symbol.upper() not in current_symbols:
            db.delete(row)

    holdings_saved = 0
    holdings_value = 0.0
    holdings_cost = 0.0
    for symbol, payload in grouped.items():
        shares = float(payload["shares"])
        priced_shares = float(payload["priced_shares"])
        cost_total = float(payload["cost_total"])
        fx_weight = float(payload.get("fx_weight", 0.0) or 0.0)
        fallback_fx_rate = (
            float(payload["fx_weighted_sum"]) / fx_weight if fx_weight > 0 else None
        )
        currency = str(payload.get("currency") or "EUR")
        market_value = float(payload["market_value"]) if priced_shares > 0 else None
        close_price = (market_value / priced_shares) if market_value is not None and priced_shares > 0 else None
        gain_abs = (market_value - cost_total) if market_value is not None else None
        gain_pct = (gain_abs / cost_total) if gain_abs is not None and cost_total > 0 else None

        snapshot_row = existing_by_symbol.get(symbol)
        if snapshot_row is None:
            snapshot_row = models.HoldingDailySnapshot(
                user_id=user_id,
                snapshot_date=snapshot_day,
                symbol=symbol,
            )

        snapshot_row.name = str(payload.get("name") or symbol)
        snapshot_row.currency = currency
        snapshot_row.shares = shares
        snapshot_row.close_price = close_price
        snapshot_row.cost_total = cost_total
        snapshot_row.market_value = market_value
        snapshot_row.gain_abs = gain_abs
        snapshot_row.gain_pct = gain_pct
        snapshot_row.updated_at = datetime.utcnow()
        db.add(snapshot_row)
        holdings_saved += 1
        holdings_cost += convert_to_eur(cost_total, currency, fallback_fx_rate) or 0.0
        if market_value is not None:
            holdings_value += convert_to_eur(market_value, currency, fallback_fx_rate) or 0.0

    placements = get_placements(db, user_id)
    placements_value = 0.0
    placements_cost = 0.0
    for placement in placements:
        placement_currency = (placement.currency or "EUR").upper().strip() or "EUR"
        if placement.current_value is not None:
            placements_value += convert_to_eur(placement.current_value, placement_currency) or 0.0
        base = (
            placement.initial_value
            if placement.initial_value is not None
            else placement.current_value
        )
        if base is not None:
            contributions = placement.total_contributions or 0.0
            withdrawals = placement.total_withdrawals or 0.0
            placements_cost += (
                convert_to_eur(base + contributions - withdrawals, placement_currency) or 0.0
            )

    accounts = get_accounts(db, user_id)
    liquidity_value = sum(account.liquidity or 0.0 for account in accounts)
    total_cost = holdings_cost + placements_cost
    total_value = holdings_value + placements_value + liquidity_value
    total_gain_abs = total_value - total_cost
    total_gain_pct = (total_gain_abs / total_cost) if total_cost > 0 else None

    portfolio_row = (
        db.query(models.PortfolioDailySnapshot)
        .filter(
            models.PortfolioDailySnapshot.user_id == user_id,
            models.PortfolioDailySnapshot.snapshot_date == snapshot_day,
        )
        .first()
    )
    if portfolio_row is None:
        portfolio_row = models.PortfolioDailySnapshot(
            user_id=user_id,
            snapshot_date=snapshot_day,
        )

    portfolio_row.holdings_value = holdings_value
    portfolio_row.placements_value = placements_value
    portfolio_row.liquidity_value = liquidity_value
    portfolio_row.total_cost = total_cost
    portfolio_row.total_value = total_value
    portfolio_row.total_gain_abs = total_gain_abs
    portfolio_row.total_gain_pct = total_gain_pct
    portfolio_row.updated_at = datetime.utcnow()
    db.add(portfolio_row)

    db.commit()
    return holdings_saved, 1


def get_holding_daily_snapshots(
    db: Session,
    user_id: int,
    days: int = 90,
    symbol: Optional[str] = None,
) -> List[models.HoldingDailySnapshot]:
    start_day = date.today() - timedelta(days=max(days - 1, 0))
    query = db.query(models.HoldingDailySnapshot).filter(
        models.HoldingDailySnapshot.user_id == user_id,
        models.HoldingDailySnapshot.snapshot_date >= start_day,
    )
    if symbol:
        query = query.filter(models.HoldingDailySnapshot.symbol == symbol.upper().strip())
    return query.order_by(
        models.HoldingDailySnapshot.snapshot_date.desc(),
        models.HoldingDailySnapshot.symbol.asc(),
    ).all()


def get_portfolio_daily_snapshots(
    db: Session,
    user_id: int,
    days: int = 90,
) -> List[models.PortfolioDailySnapshot]:
    start_day = date.today() - timedelta(days=max(days - 1, 0))
    return (
        db.query(models.PortfolioDailySnapshot)
        .filter(
            models.PortfolioDailySnapshot.user_id == user_id,
            models.PortfolioDailySnapshot.snapshot_date >= start_day,
        )
        .order_by(models.PortfolioDailySnapshot.snapshot_date.desc())
        .all()
    )


def _bsf120_row_to_item(row: models.Bsf120ForecastSnapshot) -> dict[str, Any]:
    return {
        "symbol": row.symbol,
        "name": row.name,
        "currency": row.currency,
        "price": row.price,
        "target_low_price": row.target_low_price,
        "target_mean_price": row.target_mean_price,
        "target_high_price": row.target_high_price,
        "analyst_count": row.analyst_count,
        "recommendation_mean": row.recommendation_mean,
        "recommendation_key": row.recommendation_key,
        "upside_pct": row.upside_pct,
    }


def save_bsf120_forecast_snapshot(
    db: Session,
    items: List[dict[str, Any]],
    snapshot_at: Optional[datetime] = None,
) -> int:
    as_of = snapshot_at or datetime.utcnow()
    snapshot_day = as_of.date()
    existing_rows = (
        db.query(models.Bsf120ForecastSnapshot)
        .filter(models.Bsf120ForecastSnapshot.snapshot_date == snapshot_day)
        .all()
    )
    existing_by_symbol = {row.symbol.upper(): row for row in existing_rows}
    current_symbols: set[str] = set()

    for item in items:
        symbol = str(item.get("symbol") or "").upper().strip()
        if not symbol:
            continue
        current_symbols.add(symbol)
        row = existing_by_symbol.get(symbol)
        if row is None:
            row = models.Bsf120ForecastSnapshot(
                snapshot_date=snapshot_day,
                symbol=symbol,
                created_at=as_of,
            )

        row.snapshot_at = as_of
        row.name = item.get("name")
        row.currency = item.get("currency")
        row.price = item.get("price")
        row.target_low_price = item.get("target_low_price")
        row.target_mean_price = item.get("target_mean_price")
        row.target_high_price = item.get("target_high_price")
        row.analyst_count = item.get("analyst_count")
        row.recommendation_mean = item.get("recommendation_mean")
        row.recommendation_key = item.get("recommendation_key")
        row.upside_pct = item.get("upside_pct")
        row.updated_at = datetime.utcnow()
        db.add(row)

    for symbol, row in existing_by_symbol.items():
        if symbol not in current_symbols:
            db.delete(row)

    db.commit()
    return len(current_symbols)


def get_latest_bsf120_forecast_snapshot(
    db: Session,
) -> tuple[List[dict[str, Any]], datetime] | None:
    latest_row = (
        db.query(models.Bsf120ForecastSnapshot)
        .order_by(
            models.Bsf120ForecastSnapshot.snapshot_at.desc(),
            models.Bsf120ForecastSnapshot.id.desc(),
        )
        .first()
    )
    if latest_row is None:
        return None

    rows = (
        db.query(models.Bsf120ForecastSnapshot)
        .filter(models.Bsf120ForecastSnapshot.snapshot_date == latest_row.snapshot_date)
        .order_by(models.Bsf120ForecastSnapshot.symbol.asc())
        .all()
    )
    if not rows:
        return None

    latest_at = max((row.snapshot_at for row in rows), default=latest_row.snapshot_at)
    return [_bsf120_row_to_item(row) for row in rows], latest_at


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
