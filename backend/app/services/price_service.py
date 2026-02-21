"""
Price service for refreshing and storing stock prices for holdings.
"""
import logging
from datetime import datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models
from ..database import SessionLocal
from ..utils.price_trackers import normalize_price_tracker, resolve_tracker_symbol
from .market_data_service import fetch_tracker_quote

log = logging.getLogger("followstocks")


def upsert_snapshot_from_quote(
    db: Session, holding: models.Holding, price: float | None, timestamp: str | None
) -> bool:
    """
    Update holding's last price and snapshot timestamp from quote data.

    Returns True if price was stored, False if price is None.
    """
    if price is None:
        return False
    try:
        recorded_at = datetime.fromisoformat(timestamp) if timestamp else datetime.utcnow()
    except (TypeError, ValueError):
        recorded_at = datetime.utcnow()

    holding.last_price = price
    holding.last_snapshot_at = recorded_at
    holding.updated_at = datetime.utcnow()
    db.add(holding)
    db.commit()
    return True


def group_holdings_by_tracker(
    holdings: list[models.Holding],
) -> dict[tuple[str, str], list[models.Holding]]:
    """
    Group holdings by (tracker, symbol) tuple.

    Returns a dictionary mapping (tracker, symbol) to list of holdings.
    This allows fetching a single quote for multiple holdings of the same instrument.
    """
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
    """
    Fetch and store prices for grouped holdings.

    For each (tracker, symbol) group, fetches a single quote and updates
    all holdings for that symbol.
    """
    for (tracker, symbol), symbol_holdings in grouped.items():
        try:
            quote = await fetch_tracker_quote(tracker, symbol)
        except Exception as exc:  # broad catch to keep the loop running
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
            except Exception as exc:  # broad catch to keep processing
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
    """
    Fetch and store current prices for all holdings (single refresh cycle).

    Groups holdings by tracker and symbol to minimize API calls.
    """
    with SessionLocal() as db:
        holdings = db.query(models.Holding).all()

        if not holdings:
            log.info("Auto-refresh: no holdings to refresh.")
            return

        grouped = group_holdings_by_tracker(holdings)
        await refresh_grouped_holdings(db, grouped)
