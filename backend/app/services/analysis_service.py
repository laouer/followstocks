"""
Service layer for CAC40 and SBF120 market analysis.
"""
import asyncio
import logging
import statistics
from datetime import datetime, timezone

import yfinance as yf

from .. import crud
from ..core.cache import (
    get_cac40_cache,
    get_cac40_cache_lock,
    get_sbf120_cache,
    get_sbf120_cache_lock,
)
from ..core.config import (
    CAC40_CACHE_TTL_SECONDS,
    CAC40_TICKERS,
    SBF120_CACHE_TTL_SECONDS,
)
from ..database import SessionLocal
from ..utils.market_data import safe_float, safe_int
from ..utils.ticker_utils import build_sbf120_tickers, normalize_dividend_yield

log = logging.getLogger("followstocks")


def _ensure_aware(dt: datetime) -> datetime:
    """If *dt* is naive, assume it is UTC and make it aware."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt

_cac40_cache = get_cac40_cache()
_cac40_cache_lock = get_cac40_cache_lock()
_sbf120_cache = get_sbf120_cache()
_sbf120_cache_lock = get_sbf120_cache_lock()


def _fetch_cac40_symbol(symbol: str, fallback_name: str | None) -> dict | None:
    try:
        info = yf.Ticker(symbol).get_info()
    except Exception as exc:  # noqa: BLE001
        log.warning("CAC40 fetch failed for %s: %s", symbol, exc)
        return None

    name = info.get("longName") or info.get("shortName") or fallback_name or symbol
    price = (
        safe_float(info.get("regularMarketPrice"))
        or safe_float(info.get("currentPrice"))
        or safe_float(info.get("previousClose"))
    )
    dividend_rate = safe_float(info.get("trailingAnnualDividendRate"))
    if dividend_rate is None:
        dividend_rate = safe_float(info.get("dividendRate"))
    computed_yield = (
        dividend_rate / price
        if dividend_rate is not None and price is not None and price > 0
        else None
    )
    normalized_yield = normalize_dividend_yield(
        info.get("dividendYield") or info.get("trailingAnnualDividendYield")
    )
    return {
        "symbol": symbol,
        "name": name,
        "currency": info.get("currency"),
        "price": price,
        "target_mean_price": safe_float(info.get("targetMeanPrice")),
        "trailing_pe": safe_float(info.get("trailingPE")),
        "price_to_book": safe_float(info.get("priceToBook")),
        "dividend_yield": computed_yield if computed_yield is not None else normalized_yield,
        "market_cap": safe_float(info.get("marketCap")),
        "sector": info.get("sector"),
    }


def _fetch_sbf120_symbol(symbol: str, fallback_name: str | None) -> dict:
    empty = {
        "symbol": symbol, "name": fallback_name or symbol, "currency": None,
        "price": None, "target_low_price": None, "target_mean_price": None,
        "target_high_price": None, "analyst_count": None, "recommendation_mean": None,
        "recommendation_key": None, "upside_pct": None,
    }
    try:
        info = yf.Ticker(symbol).get_info()
    except Exception as exc:  # noqa: BLE001
        log.warning("SBF120 fetch failed for %s: %s", symbol, exc)
        return empty

    name = info.get("longName") or info.get("shortName") or fallback_name or symbol
    price = (
        safe_float(info.get("regularMarketPrice"))
        or safe_float(info.get("currentPrice"))
        or safe_float(info.get("previousClose"))
    )
    target_mean = safe_float(info.get("targetMeanPrice"))
    upside_pct = (
        (target_mean - price) / price
        if price is not None and price > 0 and target_mean is not None
        else None
    )
    return {
        "symbol": symbol, "name": name, "currency": info.get("currency"),
        "price": price, "target_low_price": safe_float(info.get("targetLowPrice")),
        "target_mean_price": target_mean,
        "target_high_price": safe_float(info.get("targetHighPrice")),
        "analyst_count": safe_int(info.get("numberOfAnalystOpinions")),
        "recommendation_mean": safe_float(info.get("recommendationMean")),
        "recommendation_key": info.get("recommendationKey"),
        "upside_pct": upside_pct,
    }


async def load_cac40_snapshot() -> tuple[list[dict], datetime]:
    now = datetime.now(timezone.utc)
    cached_at = _cac40_cache.get("timestamp")
    if cached_at and (now - cached_at).total_seconds() < CAC40_CACHE_TTL_SECONDS:
        return _cac40_cache.get("items") or [], cached_at

    async with _cac40_cache_lock:
        cached_at = _cac40_cache.get("timestamp")
        if cached_at and (now - cached_at).total_seconds() < CAC40_CACHE_TTL_SECONDS:
            return _cac40_cache.get("items") or [], cached_at

        semaphore = asyncio.Semaphore(6)

        async def _runner(entry: dict) -> dict | None:
            async with semaphore:
                return await asyncio.to_thread(_fetch_cac40_symbol, entry["symbol"], entry.get("name"))

        results = await asyncio.gather(*[_runner(e) for e in CAC40_TICKERS])
        items = [item for item in results if item]
        _cac40_cache["timestamp"] = now
        _cac40_cache["items"] = items
        return items, now


async def load_sbf120_snapshot() -> tuple[list[dict], datetime]:
    now = datetime.now(timezone.utc)
    cached_at = _sbf120_cache.get("timestamp")
    if cached_at and (now - cached_at).total_seconds() < SBF120_CACHE_TTL_SECONDS:
        return _sbf120_cache.get("items") or [], cached_at

    try:
        with SessionLocal() as db:
            persisted = crud.get_latest_bsf120_forecast_snapshot(db)
    except Exception as exc:  # noqa: BLE001
        log.warning("SBF120 DB read failed: %s", exc)
        persisted = None

    if persisted:
        persisted_items, persisted_at = persisted
        persisted_at = _ensure_aware(persisted_at)
        if (now - persisted_at).total_seconds() < SBF120_CACHE_TTL_SECONDS:
            _sbf120_cache["timestamp"] = persisted_at
            _sbf120_cache["items"] = persisted_items
            return persisted_items, persisted_at

    async with _sbf120_cache_lock:
        now = datetime.now(timezone.utc)
        cached_at = _sbf120_cache.get("timestamp")
        if cached_at and (now - cached_at).total_seconds() < SBF120_CACHE_TTL_SECONDS:
            return _sbf120_cache.get("items") or [], cached_at

        try:
            with SessionLocal() as db:
                persisted = crud.get_latest_bsf120_forecast_snapshot(db)
        except Exception as exc:  # noqa: BLE001
            log.warning("SBF120 DB read failed under lock: %s", exc)
            persisted = None

        if persisted:
            persisted_items, persisted_at = persisted
            persisted_at = _ensure_aware(persisted_at)
            if (now - persisted_at).total_seconds() < SBF120_CACHE_TTL_SECONDS:
                _sbf120_cache["timestamp"] = persisted_at
                _sbf120_cache["items"] = persisted_items
                return persisted_items, persisted_at

        tickers = build_sbf120_tickers()
        semaphore = asyncio.Semaphore(6)

        async def _runner(entry: dict[str, str]) -> dict:
            async with semaphore:
                return await asyncio.to_thread(_fetch_sbf120_symbol, entry["symbol"], entry.get("name"))

        items = await asyncio.gather(*[_runner(e) for e in tickers])
        try:
            with SessionLocal() as db:
                crud.save_bsf120_forecast_snapshot(db, items, snapshot_at=now)
        except Exception as exc:  # noqa: BLE001
            log.warning("SBF120 DB save failed: %s", exc)
        _sbf120_cache["timestamp"] = now
        _sbf120_cache["items"] = items
        return items, now


def apply_cac40_metric(items: list[dict], metric: str) -> list[dict]:
    scored_items: list[dict] = []
    pe_values = [
        item.get("trailing_pe") for item in items
        if item.get("trailing_pe") is not None and item.get("trailing_pe") > 0
    ]
    median_pe = statistics.median(pe_values) if pe_values else None

    sector_pe_values: dict[str, list[float]] = {}
    for item in items:
        sector = item.get("sector")
        pe = item.get("trailing_pe")
        if sector and pe is not None and pe > 0:
            sector_pe_values.setdefault(sector, []).append(pe)
    sector_median_pe = {
        sector: statistics.median(values) for sector, values in sector_pe_values.items() if values
    }

    def _analyst_score(entry: dict) -> float | None:
        price, target = entry.get("price"), entry.get("target_mean_price")
        if price and target and price > 0:
            return (target - price) / price
        return None

    def _pe_discount(entry: dict, *, sector_adjusted: bool) -> float | None:
        pe = entry.get("trailing_pe")
        if pe is None or pe <= 0:
            return None
        if sector_adjusted:
            sector = entry.get("sector")
            sm = sector_median_pe.get(sector)
            if sm and sm > 0:
                return (sm - pe) / sm
        if median_pe and median_pe > 0:
            return (median_pe - pe) / median_pe
        return None

    def _rank_scores(values: list[tuple[str, float]]) -> dict[str, float]:
        if not values:
            return {}
        sorted_values = sorted(values, key=lambda e: e[1], reverse=True)
        total = len(sorted_values)
        if total == 1:
            return {sorted_values[0][0]: 1.0}
        return {sym: 1 - (idx / (total - 1)) for idx, (sym, _) in enumerate(sorted_values)}

    composite_scores: dict[str, float] = {}
    if metric == "composite":
        analyst_vals = [(i["symbol"], s) for i in items if (s := _analyst_score(i)) is not None]
        pe_vals = [(i["symbol"], s) for i in items if (s := _pe_discount(i, sector_adjusted=True)) is not None]
        div_vals = [(i["symbol"], s) for i in items if (s := i.get("dividend_yield")) is not None]
        ar, pr, dr = _rank_scores(analyst_vals), _rank_scores(pe_vals), _rank_scores(div_vals)
        for item in items:
            parts = [s for s in (ar.get(item["symbol"]), pr.get(item["symbol"]), dr.get(item["symbol"])) if s is not None]
            if parts:
                composite_scores[item["symbol"]] = sum(parts) / len(parts)

    for item in items:
        score = None
        if metric == "analyst_discount":
            score = _analyst_score(item)
        elif metric == "pe_discount":
            score = _pe_discount(item, sector_adjusted=False)
        elif metric == "sector_pe_discount":
            score = _pe_discount(item, sector_adjusted=True)
        elif metric == "dividend_yield":
            score = item.get("dividend_yield")
        elif metric == "composite":
            score = composite_scores.get(item["symbol"])
        scored_items.append({**item, "score": score})

    scored_items.sort(key=lambda e: (e.get("score") is None, -(e.get("score") or 0)))
    return scored_items
