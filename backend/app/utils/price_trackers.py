"""
Price tracker utilities for normalizing tracker names and resolving symbols.
"""
from .. import models
from ..core.config import PRICE_TRACKER_YAHOO, PRICE_TRACKER_BOURSORAMA, PRICE_TRACKERS


def normalize_price_tracker(value: str | None) -> str:
    """Normalize price tracker string to 'yahoo' or 'boursorama'."""
    tracker = (value or PRICE_TRACKER_YAHOO).strip().lower()
    if tracker == "yfinance":
        tracker = PRICE_TRACKER_YAHOO
    if tracker not in PRICE_TRACKERS:
        tracker = PRICE_TRACKER_YAHOO
    return tracker


def resolve_tracker_symbol(
    holding: models.Holding,
    tracker: str | None = None,
) -> str | None:
    """
    Resolve the appropriate symbol for a holding based on the price tracker.

    For Boursorama tracker, use tracker_symbol if available, else fallback to symbol.
    For Yahoo tracker, use symbol.
    """
    tracker = normalize_price_tracker(tracker or holding.price_tracker)
    symbol = holding.tracker_symbol if tracker == PRICE_TRACKER_BOURSORAMA else holding.symbol
    symbol = (symbol or "").strip()
    if not symbol and tracker == PRICE_TRACKER_BOURSORAMA:
        symbol = (holding.symbol or "").strip()
    return symbol or None
