"""
Ticker list utilities for parsing and building stock ticker lists.
"""
import os
from typing import Any

from ..core.config import CAC40_TICKERS, SBF120_EXTRA_TICKERS
from .market_data import safe_float


def parse_ticker_list(raw: str | None) -> list[dict[str, str]]:
    """
    Parse comma-separated ticker list.

    Format: "SYMBOL" or "SYMBOL:Name"
    Example: "AAPL:Apple Inc,MSFT:Microsoft,GOOGL"
    """
    if not raw:
        return []
    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    for token in raw.split(","):
        value = token.strip()
        if not value:
            continue
        symbol = value
        name = ""
        if ":" in value:
            symbol, name = value.split(":", 1)
        symbol = symbol.strip().upper()
        name = name.strip()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        entries.append({"symbol": symbol, "name": name or symbol})
    return entries


def build_sbf120_tickers() -> list[dict[str, str]]:
    """
    Build SBF120 ticker list from environment or default merged list.

    Checks SBF120_SYMBOLS or BSF120_SYMBOLS env vars, otherwise merges
    CAC40_TICKERS and SBF120_EXTRA_TICKERS.
    """
    configured = parse_ticker_list(
        os.getenv("SBF120_SYMBOLS") or os.getenv("BSF120_SYMBOLS")
    )
    if configured:
        return configured
    merged: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in [*CAC40_TICKERS, *SBF120_EXTRA_TICKERS]:
        symbol = entry["symbol"]
        if symbol in seen:
            continue
        seen.add(symbol)
        merged.append({"symbol": symbol, "name": entry.get("name") or symbol})
    return merged


def normalize_dividend_yield(value: Any) -> float | None:
    """
    Normalize dividend yield to decimal form (0.0-1.0).

    Handles both percentage (5.0 → 0.05) and decimal (0.05 → 0.05) formats.
    """
    dividend_yield = safe_float(value)
    if dividend_yield is None:
        return None
    if dividend_yield < 0:
        return None
    if dividend_yield > 1:
        return dividend_yield / 100
    if dividend_yield > 0.2:
        return dividend_yield / 100
    return dividend_yield
