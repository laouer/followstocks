"""
Service layer for fetching quotes from Yahoo Finance and Boursorama.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
import yfinance as yf

from ..core.cache import set_yfinance_error, set_yfinance_ok
from ..core.config import (
    BOURSORAMA_QUOTE_URL,
    PRICE_TRACKER_BOURSORAMA,
    YFINANCE_UNREACHABLE_MESSAGE,
)
from ..utils.market_data import safe_float
from ..utils.price_trackers import normalize_price_tracker

log = logging.getLogger("followstocks")


async def fetch_yfinance_quote(symbol: str) -> dict:
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


def _extract_boursorama_price(payload: Any) -> float | None:
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

    price = _extract_boursorama_price(data)
    if price is None:
        return {"price": None, "timestamp": None, "source": PRICE_TRACKER_BOURSORAMA}
    return {
        "price": price,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": PRICE_TRACKER_BOURSORAMA,
    }


async def fetch_tracker_quote(tracker: str, symbol: str) -> dict:
    tracker = normalize_price_tracker(tracker)
    if tracker == PRICE_TRACKER_BOURSORAMA:
        return await fetch_boursorama_quote(symbol)
    return await fetch_yfinance_quote(symbol)


async def fetch_fx_rate(base: str, quote: str) -> float | None:
    base = base.upper().strip()
    quote = quote.upper().strip()
    if base == quote:
        return 1.0
    symbol = f"{base}{quote}=X"

    def _sync_fetch():
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

    return await asyncio.to_thread(_sync_fetch)


async def search_yfinance(query: str) -> list[dict]:
    def _sync_search():
        try:
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

    helper_results = await asyncio.to_thread(_sync_search)
    if helper_results is not None:
        return helper_results

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
