"""
Market data service for fetching prices from Yahoo Finance and Boursorama.
"""
import asyncio
import logging
from datetime import datetime
from typing import Any

import httpx
import yfinance as yf

from ..core.config import (
    PRICE_TRACKER_BOURSORAMA,
    BOURSORAMA_QUOTE_URL,
    YFINANCE_UNREACHABLE_MESSAGE,
)
from ..core.cache import set_yfinance_ok, set_yfinance_error
from ..utils.market_data import safe_float
from ..utils.price_trackers import normalize_price_tracker

log = logging.getLogger("followstocks")


async def fetch_yfinance_quote(symbol: str) -> dict:
    """
    Fetch stock quote from Yahoo Finance with fallback periods.

    Tries multiple periods in order: 1d/1m -> 5d/1d -> 1mo/1mo -> 3mo/1mo
    """
    symbol = symbol.upper().strip()

    def _sync_fetch():
        ticker = yf.Ticker(symbol)
        try:
            hist = ticker.history(period="1d", interval="1m")
            if hist is None or hist.empty:
                hist = ticker.history(period="5d", interval="1d")
                if hist is None or hist.empty:
                    hist = ticker.history(period="1mo", interval="1mo")
                    if hist is None or hist.empty:
                        hist = ticker.history(period="3mo", interval="1mo")
            if hist is None or hist.empty:
                set_yfinance_ok()
                return {"price": None, "timestamp": None, "source": "yfinance"}
            last_row = hist.tail(1)
            price = float(last_row["Close"].iloc[0])
            ts = last_row.index[-1].to_pydatetime().isoformat()
            set_yfinance_ok()
            return {"price": price, "timestamp": ts, "source": "yfinance"}
        except Exception as exc:
            log.warning("yfinance quote failed for %s: %s", symbol, exc)
            set_yfinance_error(YFINANCE_UNREACHABLE_MESSAGE)
            return {"price": None, "timestamp": None, "source": "yfinance"}

    return await asyncio.to_thread(_sync_fetch)


def extract_boursorama_price(payload: Any) -> float | None:
    """Extract price from Boursorama API response."""
    if not isinstance(payload, dict):
        return None
    series = payload.get("d")
    if not isinstance(series, list) or not series:
        return None
    latest = series[-1]
    if not isinstance(latest, dict):
        return None
    ticks = latest.get("qt")
    if isinstance(ticks, list) and ticks:
        last_tick = ticks[-1]
        if isinstance(last_tick, dict):
            price = safe_float(last_tick.get("c"))
            if price is not None:
                return price
    return safe_float(latest.get("c"))


async def fetch_boursorama_quote(symbol: str) -> dict:
    """Fetch stock quote from Boursorama."""
    symbol = symbol.strip()
    if not symbol:
        return {"price": None, "timestamp": None, "source": PRICE_TRACKER_BOURSORAMA}
    try:
        async with httpx.AsyncClient(timeout=6.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
            resp = await client.get(
                BOURSORAMA_QUOTE_URL,
                params={"symbol": symbol, "period": -1},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("boursorama quote failed for %s: %s", symbol, exc)
        return {"price": None, "timestamp": None, "source": PRICE_TRACKER_BOURSORAMA}

    price = extract_boursorama_price(data)
    if price is None:
        return {"price": None, "timestamp": None, "source": PRICE_TRACKER_BOURSORAMA}
    return {
        "price": price,
        "timestamp": datetime.utcnow().isoformat(),
        "source": PRICE_TRACKER_BOURSORAMA,
    }


async def fetch_tracker_quote(tracker: str, symbol: str) -> dict:
    """
    Fetch quote using the specified price tracker.

    Dispatches to the appropriate fetcher based on tracker type.
    """
    tracker = normalize_price_tracker(tracker)
    if tracker == PRICE_TRACKER_BOURSORAMA:
        return await fetch_boursorama_quote(symbol)
    return await fetch_yfinance_quote(symbol)


def fetch_fx_rate_sync(base: str, quote: str) -> float | None:
    """
    Synchronous FX rate fetcher using Yahoo Finance.

    Returns the exchange rate from base currency to quote currency.
    Example: fetch_fx_rate_sync("USD", "EUR") returns USD/EUR rate.
    """
    base = base.upper().strip()
    quote = quote.upper().strip()
    if base == quote:
        return 1.0
    symbol = f"{base}{quote}=X"

    ticker = yf.Ticker(symbol)
    try:
        hist = ticker.history(period="5d", interval="1d")
        if hist is None or hist.empty:
            set_yfinance_ok()
            return None
        last_row = hist.tail(1)
        set_yfinance_ok()
        return float(last_row["Close"].iloc[0])
    except Exception as exc:
        log.warning("yfinance FX failed for %s: %s", symbol, exc)
        set_yfinance_error(YFINANCE_UNREACHABLE_MESSAGE)
        return None


async def fetch_fx_rate(base: str, quote: str) -> float | None:
    """
    Fetch foreign exchange rate from Yahoo Finance.

    Returns the exchange rate from base currency to quote currency.
    Example: fetch_fx_rate("USD", "EUR") returns USD/EUR rate.
    """
    return await asyncio.to_thread(fetch_fx_rate_sync, base, quote)


async def search_yfinance(query: str) -> list[dict]:
    """
    Search for financial instruments on Yahoo Finance.

    Tries the official Search API first, falls back to HTTP endpoint.
    """
    def _sync_search():
        try:
            # Prefer the official Search helper when available
            search_cls = getattr(yf, "Search", None)
            if search_cls:
                search = search_cls(query)
                data = search.fetch()
                if isinstance(data, dict):
                    quotes = data.get("quotes") or []
                    if quotes:
                        return quotes
        except Exception as exc:  # noqa: BLE001
            log.debug("yfinance Search helper failed for %s: %s", query, exc)
        return None

    # Try the Search helper in a thread (it is sync); if it returns results, use them.
    helper_results = await asyncio.to_thread(_sync_search)
    if helper_results is not None:
        return helper_results

    # Fallback to Yahoo Finance search endpoint
    url = "https://query2.finance.yahoo.com/v1/finance/search"
    try:
        async with httpx.AsyncClient(timeout=6.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
            resp = await client.get(url, params={"q": query, "quotesCount": 10, "newsCount": 0})
            resp.raise_for_status()
            data = resp.json()
            set_yfinance_ok()
            return data.get("quotes", []) or []
    except Exception as exc:  # noqa: BLE001
        log.warning("yfinance search failed for %s: %s", query, exc)
        set_yfinance_error(YFINANCE_UNREACHABLE_MESSAGE)
        return []
