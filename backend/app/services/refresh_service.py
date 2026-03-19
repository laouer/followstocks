"""
Service layer for auto-refreshing holdings prices and capturing daily history.
"""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import crud, models
from ..database import SessionLocal
from ..core.config import AUTO_REFRESH_ENABLED, AUTO_REFRESH_SECONDS
from ..utils.price_trackers import normalize_price_tracker, resolve_tracker_symbol
from .quote_service import fetch_tracker_quote

log = logging.getLogger("followstocks")


def upsert_snapshot_from_quote(
    db: Session, holding: models.Holding, price: float | None, timestamp: str | None
) -> bool:
    if price is None:
        return False
    try:
        recorded_at = datetime.fromisoformat(timestamp) if timestamp else datetime.now(timezone.utc)
    except (TypeError, ValueError):
        recorded_at = datetime.now(timezone.utc)

    holding.last_price = price
    holding.last_snapshot_at = recorded_at
    holding.updated_at = datetime.now(timezone.utc)
    db.add(holding)
    db.commit()
    return True


def group_holdings_by_tracker(
    holdings: list[models.Holding],
) -> dict[tuple[str, str], list[models.Holding]]:
    grouped: dict[tuple[str, str], list[models.Holding]] = {}
    for holding in holdings:
        tracker = normalize_price_tracker(getattr(holding, "price_tracker", None))
        symbol = resolve_tracker_symbol(holding, tracker)
        if not symbol:
            continue
        grouped.setdefault((tracker, symbol), []).append(holding)
    return grouped


async def refresh_grouped_holdings(
    db: Session, grouped: dict[tuple[str, str], list[models.Holding]]
) -> None:
    for (tracker, symbol), symbol_holdings in grouped.items():
        try:
            quote = await fetch_tracker_quote(tracker, symbol)
        except Exception as exc:
            log.warning("Auto-refresh: failed to fetch %s (%s): %s", symbol, tracker, exc)
            continue

        price = quote.get("price")
        if price is None:
            log.warning("Auto-refresh: no price returned for %s (%s)", symbol, tracker)
            continue

        stored_any = False
        for holding in symbol_holdings:
            try:
                ts_str = quote.get("timestamp")
                stored = upsert_snapshot_from_quote(db, holding, price, ts_str)
                stored_any = stored_any or stored
            except IntegrityError as exc:
                db.rollback()
                log.warning("Auto-refresh: integrity issue for %s (%s): %s", symbol, tracker, exc)
            except Exception as exc:
                db.rollback()
                log.warning("Auto-refresh: failed to store snapshot for %s (%s): %s", symbol, tracker, exc)

        if stored_any:
            log.info(
                "Auto-refresh: stored price for %s (%s) (%d holdings)",
                symbol,
                tracker,
                len(symbol_holdings),
            )


async def refresh_holdings_prices_once() -> None:
    with SessionLocal() as db:
        user_ids = [row[0] for row in db.query(models.User.id).all()]
        if not user_ids:
            log.info("Auto-refresh: no users to refresh.")
            return

        holdings = db.query(models.Holding).all()

        if holdings:
            grouped = group_holdings_by_tracker(holdings)
            await refresh_grouped_holdings(db, grouped)
        else:
            log.info("Auto-refresh: no holdings to refresh, capturing portfolio snapshots only.")

        captured_portfolio = 0
        captured_holdings = 0
        for user_id in user_ids:
            try:
                holdings_saved, portfolio_saved = crud.capture_daily_history(db, user_id)
                captured_holdings += holdings_saved
                captured_portfolio += portfolio_saved
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                log.warning("Auto-refresh: failed to capture daily history for user %s: %s", user_id, exc)
        if captured_portfolio:
            log.info(
                "Auto-refresh: updated daily history (%d portfolio rows, %d holding rows)",
                captured_portfolio,
                captured_holdings,
            )


async def auto_refresh_loop():
    while AUTO_REFRESH_ENABLED:
        start = datetime.now(timezone.utc)
        try:
            await refresh_holdings_prices_once()
        except Exception as exc:
            log.exception("Auto-refresh loop error: %s", exc)
        elapsed = (datetime.now(timezone.utc) - start).total_seconds()
        sleep_for = max(1, AUTO_REFRESH_SECONDS - int(elapsed))
        await asyncio.sleep(sleep_for)
