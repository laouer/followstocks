import asyncio
import json
import logging
import os
import statistics
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime
from pathlib import Path
from threading import Lock
from typing import Any, List

import httpx
from uuid import uuid4

import yfinance as yf
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, status
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import auth, crud, models, schemas
from .database import Base, SessionLocal, engine, get_session, db_session, ensure_holdings_columns
from .chatbot.main import ChatBot
from .core.config import (
    AUTO_REFRESH_SECONDS,
    AUTO_REFRESH_ENABLED,
    CAC40_CACHE_TTL_SECONDS,
    SBF120_CACHE_TTL_SECONDS,
    CORS_ALLOW_ORIGINS,
    CORS_ALLOW_ALL_ORIGINS,
    PRICE_TRACKER_YAHOO,
    PRICE_TRACKER_BOURSORAMA,
    PRICE_TRACKERS,
    BOURSORAMA_QUOTE_URL,
    YFINANCE_UNREACHABLE_MESSAGE,
    CAC40_TICKERS,
    CAC40_METRICS,
    SBF120_EXTRA_TICKERS,
)
from .core.cache import (
    set_yfinance_error,
    set_yfinance_ok,
    get_yfinance_status,
    get_cac40_cache,
    get_sbf120_cache,
    get_cac40_cache_lock,
    get_sbf120_cache_lock,
)
from .utils.price_trackers import normalize_price_tracker, resolve_tracker_symbol
from .utils.market_data import safe_float, safe_int
from .utils.ticker_utils import parse_ticker_list, build_sbf120_tickers, normalize_dividend_yield

log = logging.getLogger("followstocks")
logging.basicConfig(level=logging.INFO)

chatbot = ChatBot(verbose=False)

Base.metadata.create_all(bind=engine)
ensure_holdings_columns()

# Global variables
_refresh_task: asyncio.Task | None = None

# Convenience references to cache objects (imported from core.cache)
_cac40_cache = get_cac40_cache()
_cac40_cache_lock = get_cac40_cache_lock()
_sbf120_cache = get_sbf120_cache()
_sbf120_cache_lock = get_sbf120_cache_lock()


async def _fetch_yfinance_quote(symbol: str) -> dict:
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


async def _fetch_boursorama_quote(symbol: str) -> dict:
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
        "timestamp": datetime.utcnow().isoformat(),
        "source": PRICE_TRACKER_BOURSORAMA,
    }


async def _fetch_tracker_quote(tracker: str, symbol: str) -> dict:
    tracker = normalize_price_tracker(tracker)
    if tracker == PRICE_TRACKER_BOURSORAMA:
        return await _fetch_boursorama_quote(symbol)
    return await _fetch_yfinance_quote(symbol)


async def _fetch_fx_rate(base: str, quote: str) -> float | None:
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


async def _search_yfinance(query: str) -> list[dict]:
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


def _fetch_cac40_symbol(symbol: str, fallback_name: str | None) -> dict | None:
    try:
        info = yf.Ticker(symbol).get_info()
    except Exception as exc:  # noqa: BLE001
        log.warning("CAC40 fetch failed for %s: %s", symbol, exc)
        return None

    name = (
        info.get("longName")
        or info.get("shortName")
        or fallback_name
        or symbol
    )
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
    # Keep a stable row even when Yahoo data is missing for a symbol.
    empty = {
        "symbol": symbol,
        "name": fallback_name or symbol,
        "currency": None,
        "price": None,
        "target_low_price": None,
        "target_mean_price": None,
        "target_high_price": None,
        "analyst_count": None,
        "recommendation_mean": None,
        "recommendation_key": None,
        "upside_pct": None,
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
        "symbol": symbol,
        "name": name,
        "currency": info.get("currency"),
        "price": price,
        "target_low_price": safe_float(info.get("targetLowPrice")),
        "target_mean_price": target_mean,
        "target_high_price": safe_float(info.get("targetHighPrice")),
        "analyst_count": safe_int(info.get("numberOfAnalystOpinions")),
        "recommendation_mean": safe_float(info.get("recommendationMean")),
        "recommendation_key": info.get("recommendationKey"),
        "upside_pct": upside_pct,
    }


async def _load_cac40_snapshot() -> tuple[list[dict], datetime]:
    now = datetime.utcnow()
    cached_at = _cac40_cache.get("timestamp")
    if cached_at and (now - cached_at).total_seconds() < CAC40_CACHE_TTL_SECONDS:
        cached_items = _cac40_cache.get("items") or []
        return cached_items, cached_at

    async with _cac40_cache_lock:
        cached_at = _cac40_cache.get("timestamp")
        if cached_at and (now - cached_at).total_seconds() < CAC40_CACHE_TTL_SECONDS:
            cached_items = _cac40_cache.get("items") or []
            return cached_items, cached_at

        semaphore = asyncio.Semaphore(6)

        async def _runner(entry: dict) -> dict | None:
            async with semaphore:
                return await asyncio.to_thread(
                    _fetch_cac40_symbol, entry["symbol"], entry.get("name")
                )

        results = await asyncio.gather(*[_runner(entry) for entry in CAC40_TICKERS])
        items = [item for item in results if item]
        _cac40_cache["timestamp"] = now
        _cac40_cache["items"] = items
        return items, now


async def _load_sbf120_snapshot() -> tuple[list[dict], datetime]:
    now = datetime.utcnow()
    cached_at = _sbf120_cache.get("timestamp")
    if cached_at and (now - cached_at).total_seconds() < SBF120_CACHE_TTL_SECONDS:
        cached_items = _sbf120_cache.get("items") or []
        return cached_items, cached_at

    try:
        with SessionLocal() as db:
            persisted = crud.get_latest_bsf120_forecast_snapshot(db)
    except Exception as exc:  # noqa: BLE001
        log.warning("SBF120 DB read failed: %s", exc)
        persisted = None

    if persisted:
        persisted_items, persisted_at = persisted
        if (now - persisted_at).total_seconds() < SBF120_CACHE_TTL_SECONDS:
            _sbf120_cache["timestamp"] = persisted_at
            _sbf120_cache["items"] = persisted_items
            return persisted_items, persisted_at

    async with _sbf120_cache_lock:
        now = datetime.utcnow()
        cached_at = _sbf120_cache.get("timestamp")
        if cached_at and (now - cached_at).total_seconds() < SBF120_CACHE_TTL_SECONDS:
            cached_items = _sbf120_cache.get("items") or []
            return cached_items, cached_at

        try:
            with SessionLocal() as db:
                persisted = crud.get_latest_bsf120_forecast_snapshot(db)
        except Exception as exc:  # noqa: BLE001
            log.warning("SBF120 DB read failed under lock: %s", exc)
            persisted = None

        if persisted:
            persisted_items, persisted_at = persisted
            if (now - persisted_at).total_seconds() < SBF120_CACHE_TTL_SECONDS:
                _sbf120_cache["timestamp"] = persisted_at
                _sbf120_cache["items"] = persisted_items
                return persisted_items, persisted_at

        tickers = build_sbf120_tickers()
        semaphore = asyncio.Semaphore(6)

        async def _runner(entry: dict[str, str]) -> dict:
            async with semaphore:
                return await asyncio.to_thread(
                    _fetch_sbf120_symbol, entry["symbol"], entry.get("name")
                )

        items = await asyncio.gather(*[_runner(entry) for entry in tickers])
        try:
            with SessionLocal() as db:
                crud.save_bsf120_forecast_snapshot(db, items, snapshot_at=now)
        except Exception as exc:  # noqa: BLE001
            log.warning("SBF120 DB save failed: %s", exc)
        _sbf120_cache["timestamp"] = now
        _sbf120_cache["items"] = items
        return items, now


def _apply_cac40_metric(items: list[dict], metric: str) -> list[dict]:
    scored_items: list[dict] = []
    pe_values = [
        item.get("trailing_pe")
        for item in items
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
        sector: statistics.median(values)
        for sector, values in sector_pe_values.items()
        if values
    }

    def _analyst_score(entry: dict) -> float | None:
        price = entry.get("price")
        target = entry.get("target_mean_price")
        if price and target and price > 0:
            return (target - price) / price
        return None

    def _pe_discount(entry: dict, *, sector_adjusted: bool) -> float | None:
        pe = entry.get("trailing_pe")
        if pe is None or pe <= 0:
            return None
        if sector_adjusted:
            sector = entry.get("sector")
            sector_median = sector_median_pe.get(sector)
            if sector_median and sector_median > 0:
                return (sector_median - pe) / sector_median
        if median_pe and median_pe > 0:
            return (median_pe - pe) / median_pe
        return None

    def _rank_scores(values: list[tuple[str, float]]) -> dict[str, float]:
        if not values:
            return {}
        sorted_values = sorted(values, key=lambda entry: entry[1], reverse=True)
        total = len(sorted_values)
        if total == 1:
            return {sorted_values[0][0]: 1.0}
        return {
            symbol: 1 - (index / (total - 1))
            for index, (symbol, _value) in enumerate(sorted_values)
        }

    composite_scores: dict[str, float] = {}
    if metric == "composite":
        analyst_values: list[tuple[str, float]] = []
        pe_values_rank: list[tuple[str, float]] = []
        dividend_values: list[tuple[str, float]] = []
        for item in items:
            analyst_score = _analyst_score(item)
            if analyst_score is not None:
                analyst_values.append((item["symbol"], analyst_score))
            pe_score = _pe_discount(item, sector_adjusted=True)
            if pe_score is not None:
                pe_values_rank.append((item["symbol"], pe_score))
            dividend_score = item.get("dividend_yield")
            if dividend_score is not None:
                dividend_values.append((item["symbol"], dividend_score))

        analyst_rank = _rank_scores(analyst_values)
        pe_rank = _rank_scores(pe_values_rank)
        dividend_rank = _rank_scores(dividend_values)

        for item in items:
            parts = [
                score
                for score in (
                    analyst_rank.get(item["symbol"]),
                    pe_rank.get(item["symbol"]),
                    dividend_rank.get(item["symbol"]),
                )
                if score is not None
            ]
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

    scored_items.sort(
        key=lambda entry: (entry.get("score") is None, -(entry.get("score") or 0)),
    )
    return scored_items


def _upsert_snapshot_from_quote(
    db: Session, holding: models.Holding, price: float | None, timestamp: str | None
) -> bool:
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


def _group_holdings_by_tracker(
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


async def _refresh_grouped_holdings(
    db: Session, grouped: dict[tuple[str, str], list[models.Holding]]
) -> None:
    for (tracker, symbol), symbol_holdings in grouped.items():
        try:
            quote = await _fetch_tracker_quote(tracker, symbol)
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
                stored = _upsert_snapshot_from_quote(db, holding, price, ts_str)
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
    with SessionLocal() as db:
        user_ids = [row[0] for row in db.query(models.User.id).all()]
        if not user_ids:
            log.info("Auto-refresh: no users to refresh.")
            return

        holdings = db.query(models.Holding).all()

        if holdings:
            grouped = _group_holdings_by_tracker(holdings)
            await _refresh_grouped_holdings(db, grouped)
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
        start = datetime.utcnow()
        try:
            await refresh_holdings_prices_once()
        except Exception as exc:
            log.exception("Auto-refresh loop error: %s", exc)
        elapsed = (datetime.utcnow() - start).total_seconds()
        sleep_for = max(1, AUTO_REFRESH_SECONDS - int(elapsed))
        await asyncio.sleep(sleep_for)


_refresh_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _refresh_task
    await chatbot.initialize()
    if AUTO_REFRESH_ENABLED:
        log.info("Starting auto-refresh task (interval: %ss)", AUTO_REFRESH_SECONDS)
        _refresh_task = asyncio.create_task(auto_refresh_loop())
    else:
        log.info("Auto-refresh is disabled.")
    try:
        yield
    finally:
        if _refresh_task:
            _refresh_task.cancel()
            with suppress(asyncio.CancelledError):
                await _refresh_task
        await chatbot.close()


app = FastAPI(title="FollowStocks API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if CORS_ALLOW_ALL_ORIGINS else CORS_ALLOW_ORIGINS,
    allow_credentials=not CORS_ALLOW_ALL_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
log.info(
    "CORS configured with allow_all=%s origins=%s",
    CORS_ALLOW_ALL_ORIGINS,
    CORS_ALLOW_ORIGINS,
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/auth/register", response_model=schemas.TokenResponse)
def register_user(payload: schemas.UserCreate, db: Session = Depends(get_session)):
    existing = crud.get_user_by_email(db, payload.email)
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user = crud.create_user(db, payload, auth.hash_password(payload.password))
    crud.get_or_create_default_account(db, user.id)
    token = auth.create_access_token(user)
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.get("/accounts", response_model=List[schemas.Account])
def list_accounts(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    accounts = crud.get_accounts(db, current_user.id)
    for account in accounts:
        if (account.liquidity or 0.0) < 0:
            raise HTTPException(
                status_code=400,
                detail=f"Account {account.name} has negative liquidity. Please adjust it.",
            )
    return accounts


@app.post("/accounts", response_model=schemas.Account)
def create_account(
    payload: schemas.AccountCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    existing = crud.get_account_by_name(db, current_user.id, payload.name)
    if existing:
        raise HTTPException(status_code=400, detail="Account already exists")
    try:
        return crud.create_account(db, current_user.id, payload)
    except IntegrityError as exc:
        raise HTTPException(status_code=400, detail="Account already exists") from exc


@app.put("/accounts/{account_id}", response_model=schemas.Account)
def update_account(
    account_id: int,
    payload: schemas.AccountUpdate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    account = crud.get_account(db, current_user.id, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    try:
        return crud.update_account(db, account, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(status_code=400, detail="Account already exists") from exc


@app.post("/accounts/{account_id}/cash", response_model=schemas.Account)
def move_account_cash(
    account_id: int,
    payload: schemas.CashMovementRequest,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    account = crud.get_account(db, current_user.id, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    try:
        return crud.apply_cash_movement(db, account, current_user.id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/accounts/{account_id}")
def delete_account(
    account_id: int,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    account = crud.get_account(db, current_user.id, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    deleted_holdings = len(account.holdings)
    crud.delete_account(db, account)
    return {"status": "deleted", "deleted_holdings": deleted_holdings}


@app.get("/integrations/boursorama/session", response_model=schemas.BoursoramaSessionStatus)
def get_boursorama_session_status(
    current_user: models.User = Depends(auth.get_current_user),
):
    from .boursorama_cash_sync import get_session_status

    return get_session_status(current_user.id)


@app.post(
    "/integrations/boursorama/cash/preview",
    response_model=schemas.BoursoramaCashPreviewResponse,
)
def preview_boursorama_cash(
    payload: schemas.BoursoramaCashPreviewRequest,
    current_user: models.User = Depends(auth.get_current_user),
):
    from .boursorama_cash_sync import fetch_cash_preview

    try:
        preview = fetch_cash_preview(
            current_user.id,
            url=payload.url,
            timeout_ms=payload.timeout_ms,
            headless=payload.headless,
        )
        return jsonable_encoder(preview)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Failed to preview Boursorama cash") from exc


@app.post(
    "/integrations/boursorama/cash/sync",
    response_model=schemas.BoursoramaCashSyncResponse,
)
def sync_boursorama_cash(
    payload: schemas.BoursoramaCashSyncRequest,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    from .boursorama_cash_sync import fetch_cash_preview, sync_cash_accounts

    try:
        preview = fetch_cash_preview(
            current_user.id,
            url=payload.url,
            timeout_ms=payload.timeout_ms,
            headless=payload.headless,
        )
        result = sync_cash_accounts(
            db,
            current_user.id,
            preview,
            create_missing_accounts=payload.create_missing_accounts,
            capture_daily_history=payload.capture_daily_history,
        )
        return jsonable_encoder(result)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to sync Boursorama cash") from exc


@app.post("/auth/login", response_model=schemas.TokenResponse)
def login_user(payload: schemas.LoginRequest, db: Session = Depends(get_session)):
    user = crud.get_user_by_email(db, payload.email)
    if not user or not auth.verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    token = auth.create_access_token(user)
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.get("/auth/me", response_model=schemas.UserPublic)
def get_me(current_user: models.User = Depends(auth.get_current_user)):
    return current_user


@app.post("/holdings", response_model=schemas.Holding)
async def create_holding(
    holding: schemas.HoldingCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    if holding.account_id is None:
        account = crud.get_or_create_default_account(db, current_user.id)
        holding = holding.model_copy(update={"account_id": account.id})
    else:
        account = crud.get_account(db, current_user.id, holding.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
    buy_total = holding.shares * holding.cost_basis + (holding.acquisition_fee_value or 0.0)
    rate = 1.0
    if holding.currency.upper() != "EUR":
        if holding.fx_rate:
            rate = holding.fx_rate
        else:
            raise HTTPException(status_code=400, detail="FX rate is required for non-EUR holdings")
    buy_total_eur = buy_total * rate
    available_liquidity = account.liquidity or 0.0
    new_liquidity = available_liquidity - buy_total_eur
    if new_liquidity < 0:
        if abs(new_liquidity) <= 1e-6:
            new_liquidity = 0.0
        else:
            raise HTTPException(status_code=400, detail="Insufficient account liquidity for this buy")
    try:
        created = crud.create_holding(db, current_user.id, holding)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        account.liquidity = new_liquidity
        account.updated_at = datetime.utcnow()
        db.add(account)
        db.commit()
        db.refresh(account)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to update account liquidity for %s: %s", holding.symbol, exc)
    try:
        transaction = schemas.TransactionCreate(
            account_id=holding.account_id,
            symbol=holding.symbol,
            side="BUY",
            shares=holding.shares,
            price=holding.cost_basis,
            fee_value=holding.acquisition_fee_value,
            currency=holding.currency,
            executed_at=holding.acquired_at,
        )
        crud.create_transaction(db, current_user.id, transaction)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to record BUY transaction for %s: %s", holding.symbol, exc)
    try:
        holdings = (
            db.query(models.Holding)
            .filter(models.Holding.symbol == created.symbol)
            .all()
        )
        grouped = _group_holdings_by_tracker(holdings)
        await _refresh_grouped_holdings(db, grouped)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to fetch/store initial price for %s: %s", created.symbol, exc)
    return created


def _placement_cash_delta(entry_kind: str | None, value: float) -> float:
    kind = (entry_kind or "VALUE").upper()
    if kind == "INITIAL":
        return -value
    if kind == "WITHDRAWAL":
        return value
    return 0.0


def _placement_contribution_delta(entry_kind: str | None, value: float) -> float:
    kind = (entry_kind or "VALUE").upper()
    if kind == "CONTRIBUTION":
        return value
    return 0.0


def _compute_new_liquidity(account: models.Account, delta: float) -> float:
    current = account.liquidity or 0.0
    new_liquidity = current + delta
    if new_liquidity < 0:
        if abs(new_liquidity) <= 1e-6:
            return 0.0
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient account liquidity for {account.name}",
        )
    return new_liquidity


def _compute_new_manual_invested(account: models.Account, delta: float) -> float:
    current = account.manual_invested or 0.0
    new_manual = current + delta
    if new_manual < 0:
        if abs(new_manual) <= 1e-6:
            return 0.0
        raise HTTPException(
            status_code=400,
            detail="Capital contributed cannot go below zero",
        )
    return new_manual


def _apply_account_liquidity(db: Session, account: models.Account, new_liquidity: float) -> None:
    account.liquidity = new_liquidity
    account.updated_at = datetime.utcnow()
    db.add(account)
    db.commit()
    db.refresh(account)


def _apply_account_manual_invested(
    db: Session, account: models.Account, new_manual_invested: float
) -> None:
    account.manual_invested = new_manual_invested
    account.updated_at = datetime.utcnow()
    db.add(account)
    db.commit()
    db.refresh(account)


@app.post("/holdings/{holding_id}/sell", response_model=schemas.HoldingSellResult)
def sell_holding(
    holding_id: int,
    payload: schemas.HoldingSellRequest,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    if holding.shares <= 0:
        raise HTTPException(status_code=400, detail="Holding has no shares to sell")
    epsilon = 1e-6
    if payload.shares > holding.shares + epsilon:
        raise HTTPException(status_code=400, detail="Not enough shares to sell")
    account = crud.get_account(db, current_user.id, holding.account_id)
    if not account:
        raise HTTPException(status_code=400, detail="Account not found")

    fee_value = payload.fee_value or 0.0
    total_cost = holding.shares * holding.cost_basis + (holding.acquisition_fee_value or 0.0)
    cost_per_share = total_cost / holding.shares
    proceeds = payload.price * payload.shares - fee_value
    realized_gain = (payload.price - cost_per_share) * payload.shares - fee_value

    rate = 1.0
    if holding.currency.upper() != "EUR":
        if payload.fx_rate:
            rate = payload.fx_rate
        else:
            log.warning("Missing FX rate for %s sell; using 1.0", holding.currency)
    account.liquidity = (account.liquidity or 0.0) + (proceeds * rate)
    account.updated_at = datetime.utcnow()

    remaining_shares = holding.shares - payload.shares
    if remaining_shares <= epsilon:
        db.delete(holding)
        remaining_shares = 0.0
    else:
        holding.shares = remaining_shares
        holding.cost_basis = cost_per_share
        holding.acquisition_fee_value = 0.0
        holding.updated_at = datetime.utcnow()
        db.add(holding)

    transaction = models.Transaction(
        user_id=current_user.id,
        account_id=account.id,
        symbol=holding.symbol,
        side="SELL",
        shares=payload.shares,
        price=payload.price,
        fee_value=fee_value,
        currency=holding.currency,
        executed_at=payload.executed_at,
        realized_gain=realized_gain,
    )
    db.add(account)
    db.add(transaction)
    db.commit()
    db.refresh(account)

    return schemas.HoldingSellResult(
        status="sold",
        realized_gain=realized_gain,
        remaining_shares=remaining_shares,
        account_liquidity=account.liquidity,
    )


@app.get("/holdings", response_model=List[schemas.HoldingStats])
def list_holdings(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    return crud.get_holdings_with_stats(db, current_user.id)


@app.get("/placements", response_model=List[schemas.Placement])
def list_placements(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    return crud.get_placements(db, current_user.id)


@app.post("/placements", response_model=schemas.Placement)
def create_placement(
    payload: schemas.PlacementCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    if payload.account_id is None:
        account = crud.get_or_create_default_account(db, current_user.id)
        payload = payload.model_copy(update={"account_id": account.id})
    else:
        account = crud.get_account(db, current_user.id, payload.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
    new_liquidity = None
    if payload.initial_value is not None:
        initial_delta = _placement_cash_delta("INITIAL", payload.initial_value)
        if abs(initial_delta) > 1e-9:
            new_liquidity = _compute_new_liquidity(account, initial_delta)
    placement = crud.create_placement(db, current_user.id, payload)
    if new_liquidity is not None:
        try:
            _apply_account_liquidity(db, account, new_liquidity)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account liquidity for placement %s: %s",
                placement.name,
                exc,
            )
    return placement


@app.put("/placements/{placement_id}", response_model=schemas.Placement)
def update_placement(
    placement_id: int,
    payload: schemas.PlacementUpdate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    if payload.account_id is not None:
        account = crud.get_account(db, current_user.id, payload.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
    return crud.update_placement(db, placement, payload)


@app.delete("/placements/{placement_id}")
def delete_placement(
    placement_id: int,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    crud.delete_placement(db, placement)
    return {"status": "deleted"}


@app.get("/placements/{placement_id}/snapshots", response_model=List[schemas.PlacementSnapshot])
def list_placement_snapshots(
    placement_id: int,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    return crud.get_placement_snapshots(db, placement.id, limit=limit)


@app.post("/placements/{placement_id}/snapshots", response_model=schemas.Placement)
def add_placement_snapshot(
    placement_id: int,
    payload: schemas.PlacementSnapshotCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    entry_kind = (payload.entry_kind or "VALUE").upper()
    delta = _placement_cash_delta(entry_kind, payload.value)
    contribution_delta = _placement_contribution_delta(entry_kind, payload.value)
    account = None
    new_liquidity = None
    new_manual_invested = None
    if abs(delta) > 1e-9 or abs(contribution_delta) > 1e-9:
        if placement.account_id is None:
            raise HTTPException(
                status_code=400,
                detail="Placement must be linked to an account to record cash movements",
            )
        account = crud.get_account(db, current_user.id, placement.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
        if abs(delta) > 1e-9:
            new_liquidity = _compute_new_liquidity(account, delta)
        if abs(contribution_delta) > 1e-9:
            new_manual_invested = _compute_new_manual_invested(account, contribution_delta)
    try:
        crud.add_placement_snapshot(db, placement, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if new_liquidity is not None and account is not None:
        try:
            _apply_account_liquidity(db, account, new_liquidity)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account liquidity for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    if new_manual_invested is not None and account is not None:
        try:
            _apply_account_manual_invested(db, account, new_manual_invested)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account contribution for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    db.refresh(placement)
    return placement


@app.put("/placements/{placement_id}/snapshots/{snapshot_id}", response_model=schemas.Placement)
def update_placement_snapshot(
    placement_id: int,
    snapshot_id: int,
    payload: schemas.PlacementSnapshotUpdate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    snapshot = (
        db.query(models.PlacementSnapshot)
        .filter(
            models.PlacementSnapshot.id == snapshot_id,
            models.PlacementSnapshot.placement_id == placement.id,
        )
        .first()
    )
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    entry_kind_prev = (snapshot.entry_kind or "VALUE").upper()
    entry_kind_next = (payload.entry_kind or entry_kind_prev).upper()
    value_next = snapshot.value if payload.value is None else payload.value
    delta = _placement_cash_delta(entry_kind_next, value_next) - _placement_cash_delta(
        entry_kind_prev, snapshot.value
    )
    contribution_delta = _placement_contribution_delta(
        entry_kind_next, value_next
    ) - _placement_contribution_delta(entry_kind_prev, snapshot.value)
    account = None
    new_liquidity = None
    new_manual_invested = None
    if abs(delta) > 1e-9 or abs(contribution_delta) > 1e-9:
        if placement.account_id is None:
            raise HTTPException(
                status_code=400,
                detail="Placement must be linked to an account to record cash movements",
            )
        account = crud.get_account(db, current_user.id, placement.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
        if abs(delta) > 1e-9:
            new_liquidity = _compute_new_liquidity(account, delta)
        if abs(contribution_delta) > 1e-9:
            new_manual_invested = _compute_new_manual_invested(account, contribution_delta)
    try:
        crud.update_placement_snapshot(db, placement, snapshot, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if new_liquidity is not None and account is not None:
        try:
            _apply_account_liquidity(db, account, new_liquidity)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account liquidity for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    if new_manual_invested is not None and account is not None:
        try:
            _apply_account_manual_invested(db, account, new_manual_invested)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account contribution for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    db.refresh(placement)
    return placement


@app.delete("/placements/{placement_id}/snapshots/{snapshot_id}")
def delete_placement_snapshot(
    placement_id: int,
    snapshot_id: int,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    placement = crud.get_placement(db, current_user.id, placement_id)
    if not placement:
        raise HTTPException(status_code=404, detail="Placement not found")
    snapshot = (
        db.query(models.PlacementSnapshot)
        .filter(
            models.PlacementSnapshot.id == snapshot_id,
            models.PlacementSnapshot.placement_id == placement.id,
        )
        .first()
    )
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    delta = -_placement_cash_delta(snapshot.entry_kind, snapshot.value)
    contribution_delta = -_placement_contribution_delta(snapshot.entry_kind, snapshot.value)
    account = None
    new_liquidity = None
    new_manual_invested = None
    if abs(delta) > 1e-9 or abs(contribution_delta) > 1e-9:
        if placement.account_id is None:
            raise HTTPException(
                status_code=400,
                detail="Placement must be linked to an account to record cash movements",
            )
        account = crud.get_account(db, current_user.id, placement.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
        if abs(delta) > 1e-9:
            new_liquidity = _compute_new_liquidity(account, delta)
        if abs(contribution_delta) > 1e-9:
            new_manual_invested = _compute_new_manual_invested(account, contribution_delta)
    crud.delete_placement_snapshot(db, placement, snapshot)
    if new_liquidity is not None and account is not None:
        try:
            _apply_account_liquidity(db, account, new_liquidity)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account liquidity for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    if new_manual_invested is not None and account is not None:
        try:
            _apply_account_manual_invested(db, account, new_manual_invested)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Failed to update account contribution for placement snapshot %s: %s",
                placement.name,
                exc,
            )
    return {"status": "deleted"}


@app.get("/backup/export", response_model=schemas.BackupPayload)
def export_backup(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    accounts = crud.get_accounts(db, current_user.id)
    holdings = (
        db.query(models.Holding)
        .filter(models.Holding.user_id == current_user.id)
        .all()
    )
    transactions = (
        db.query(models.Transaction)
        .filter(models.Transaction.user_id == current_user.id)
        .all()
    )
    cash_transactions = (
        db.query(models.CashTransaction)
        .filter(models.CashTransaction.user_id == current_user.id)
        .all()
    )
    placements = (
        db.query(models.Placement)
        .filter(models.Placement.user_id == current_user.id)
        .all()
    )
    placement_snapshots = (
        db.query(models.PlacementSnapshot)
        .join(models.Placement, models.Placement.id == models.PlacementSnapshot.placement_id)
        .filter(models.Placement.user_id == current_user.id)
        .all()
    )
    holding_daily_snapshots = (
        db.query(models.HoldingDailySnapshot)
        .filter(models.HoldingDailySnapshot.user_id == current_user.id)
        .all()
    )
    portfolio_daily_snapshots = (
        db.query(models.PortfolioDailySnapshot)
        .filter(models.PortfolioDailySnapshot.user_id == current_user.id)
        .all()
    )
    payload = schemas.BackupPayload(
        exported_at=datetime.utcnow(),
        accounts=[schemas.BackupAccount.model_validate(account) for account in accounts],
        holdings=[schemas.BackupHolding.model_validate(holding) for holding in holdings],
        transactions=[
            schemas.BackupTransaction.model_validate(transaction) for transaction in transactions
        ],
        cash_transactions=[
            schemas.BackupCashTransaction.model_validate(transaction)
            for transaction in cash_transactions
        ],
        placements=[schemas.BackupPlacement.model_validate(placement) for placement in placements],
        placement_snapshots=[
            schemas.BackupPlacementSnapshot.model_validate(snapshot)
            for snapshot in placement_snapshots
        ],
        holding_daily_snapshots=[
            schemas.BackupHoldingDailySnapshot.model_validate(snapshot)
            for snapshot in holding_daily_snapshots
        ],
        portfolio_daily_snapshots=[
            schemas.BackupPortfolioDailySnapshot.model_validate(snapshot)
            for snapshot in portfolio_daily_snapshots
        ],
    )
    filename = f"backup-{datetime.utcnow().strftime('%Y%m%d')}.json"
    return JSONResponse(
        content=jsonable_encoder(payload),
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/backup/import", response_model=schemas.BackupImportResult)
async def import_backup(
    file: UploadFile = File(...),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    content = await file.read()
    try:
        payload = schemas.BackupPayload.model_validate(json.loads(content))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON file") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid backup payload: {exc}") from exc

    if payload.version != 1:
        raise HTTPException(status_code=400, detail="Unsupported backup version")

    account_ids = {account.id for account in payload.accounts}
    missing_account_refs = {
        holding.account_id for holding in payload.holdings if holding.account_id not in account_ids
    }
    missing_account_refs.update(
        transaction.account_id
        for transaction in payload.transactions
        if transaction.account_id not in account_ids
    )
    missing_account_refs.update(
        transaction.account_id
        for transaction in payload.cash_transactions
        if transaction.account_id not in account_ids
    )
    missing_account_refs.update(
        placement.account_id
        for placement in payload.placements
        if placement.account_id is not None and placement.account_id not in account_ids
    )
    if missing_account_refs:
        missing = ", ".join(str(account_id) for account_id in sorted(missing_account_refs))
        raise HTTPException(status_code=400, detail=f"Missing accounts in backup: {missing}")

    placement_ids = {placement.id for placement in payload.placements}
    missing_placement_refs = {
        snapshot.placement_id
        for snapshot in payload.placement_snapshots
        if snapshot.placement_id not in placement_ids
    }
    if missing_placement_refs:
        missing = ", ".join(str(placement_id) for placement_id in sorted(missing_placement_refs))
        raise HTTPException(status_code=400, detail=f"Missing placements in backup: {missing}")

    db.query(models.PlacementSnapshot).filter(
        models.PlacementSnapshot.placement_id.in_(
            db.query(models.Placement.id).filter(models.Placement.user_id == current_user.id)
        )
    ).delete(synchronize_session=False)
    db.query(models.HoldingDailySnapshot).filter(
        models.HoldingDailySnapshot.user_id == current_user.id
    ).delete(synchronize_session=False)
    db.query(models.PortfolioDailySnapshot).filter(
        models.PortfolioDailySnapshot.user_id == current_user.id
    ).delete(synchronize_session=False)
    db.query(models.Placement).filter(models.Placement.user_id == current_user.id).delete(
        synchronize_session=False
    )
    db.query(models.Holding).filter(models.Holding.user_id == current_user.id).delete(
        synchronize_session=False
    )
    db.query(models.Transaction).filter(models.Transaction.user_id == current_user.id).delete(
        synchronize_session=False
    )
    db.query(models.CashTransaction).filter(
        models.CashTransaction.user_id == current_user.id
    ).delete(synchronize_session=False)
    db.query(models.Account).filter(models.Account.user_id == current_user.id).delete(
        synchronize_session=False
    )
    db.commit()

    account_id_map: dict[int, int] = {}
    for account in payload.accounts:
        created = models.Account(
            user_id=current_user.id,
            name=account.name,
            account_type=account.account_type,
            liquidity=account.liquidity,
            manual_invested=account.manual_invested,
            created_at=account.created_at,
            updated_at=account.updated_at,
        )
        db.add(created)
        db.flush()
        account_id_map[account.id] = created.id

    for holding in payload.holdings:
        account_id = account_id_map.get(holding.account_id)
        if not account_id:
            raise HTTPException(
                status_code=400,
                detail=f"Account id {holding.account_id} missing for holding {holding.symbol}",
            )
        db.add(
            models.Holding(
                user_id=current_user.id,
                account_id=account_id,
                symbol=holding.symbol,
                price_tracker=holding.price_tracker or PRICE_TRACKER_YAHOO,
                tracker_symbol=holding.tracker_symbol,
                shares=holding.shares,
                cost_basis=holding.cost_basis,
                acquisition_fee_value=holding.acquisition_fee_value,
                fx_rate=holding.fx_rate,
                currency=holding.currency,
                last_price=holding.last_price,
                last_snapshot_at=holding.last_snapshot_at,
                sector=holding.sector,
                industry=holding.industry,
                asset_type=holding.asset_type,
                isin=holding.isin,
                acquired_at=holding.acquired_at,
                mic=holding.mic,
                name=holding.name,
                href=holding.href,
                created_at=holding.created_at,
                updated_at=holding.updated_at,
            )
        )

    for transaction in payload.transactions:
        account_id = account_id_map.get(transaction.account_id)
        if not account_id:
            raise HTTPException(
                status_code=400,
                detail=f"Account id {transaction.account_id} missing for transaction",
            )
        db.add(
            models.Transaction(
                user_id=current_user.id,
                account_id=account_id,
                symbol=transaction.symbol,
                side=transaction.side,
                shares=transaction.shares,
                price=transaction.price,
                fee_value=transaction.fee_value,
                currency=transaction.currency,
                executed_at=transaction.executed_at,
                realized_gain=transaction.realized_gain,
                created_at=transaction.created_at,
                updated_at=transaction.updated_at,
            )
        )

    for transaction in payload.cash_transactions:
        account_id = account_id_map.get(transaction.account_id)
        if not account_id:
            raise HTTPException(
                status_code=400,
                detail=f"Account id {transaction.account_id} missing for cash transaction",
            )
        db.add(
            models.CashTransaction(
                user_id=current_user.id,
                account_id=account_id,
                amount=transaction.amount,
                direction=transaction.direction,
                reason=transaction.reason,
                created_at=transaction.created_at,
                updated_at=transaction.updated_at,
            )
        )

    placement_id_map: dict[int, int] = {}
    for placement in payload.placements:
        account_id = None
        if placement.account_id is not None:
            account_id = account_id_map.get(placement.account_id)
            if not account_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Account id {placement.account_id} missing for placement {placement.name}",
                )
        created = models.Placement(
            user_id=current_user.id,
            account_id=account_id,
            name=placement.name,
            placement_type=placement.placement_type,
            sector=placement.sector,
            industry=placement.industry,
            currency=placement.currency,
            initial_value=placement.initial_value,
            initial_recorded_at=placement.initial_recorded_at,
            total_contributions=placement.total_contributions,
            total_withdrawals=placement.total_withdrawals,
            total_interests=placement.total_interests,
            total_fees=placement.total_fees,
            current_value=placement.current_value,
            last_snapshot_at=placement.last_snapshot_at,
            notes=placement.notes,
            created_at=placement.created_at,
            updated_at=placement.updated_at,
        )
        db.add(created)
        db.flush()
        placement_id_map[placement.id] = created.id

    for snapshot in payload.placement_snapshots:
        placement_id = placement_id_map.get(snapshot.placement_id)
        if not placement_id:
            raise HTTPException(
                status_code=400,
                detail=f"Placement id {snapshot.placement_id} missing for placement snapshot",
            )
        db.add(
            models.PlacementSnapshot(
                placement_id=placement_id,
                entry_kind=snapshot.entry_kind,
                value=snapshot.value,
                recorded_at=snapshot.recorded_at,
                created_at=snapshot.created_at,
                updated_at=snapshot.updated_at,
            )
        )

    for snapshot in payload.holding_daily_snapshots:
        db.add(
            models.HoldingDailySnapshot(
                user_id=current_user.id,
                snapshot_date=snapshot.snapshot_date,
                symbol=snapshot.symbol,
                name=snapshot.name,
                currency=snapshot.currency,
                shares=snapshot.shares,
                close_price=snapshot.close_price,
                cost_total=snapshot.cost_total,
                market_value=snapshot.market_value,
                gain_abs=snapshot.gain_abs,
                gain_pct=snapshot.gain_pct,
                created_at=snapshot.created_at,
                updated_at=snapshot.updated_at,
            )
        )

    for snapshot in payload.portfolio_daily_snapshots:
        db.add(
            models.PortfolioDailySnapshot(
                user_id=current_user.id,
                snapshot_date=snapshot.snapshot_date,
                holdings_value=snapshot.holdings_value,
                placements_value=snapshot.placements_value,
                liquidity_value=snapshot.liquidity_value,
                total_cost=snapshot.total_cost,
                total_value=snapshot.total_value,
                total_gain_abs=snapshot.total_gain_abs,
                total_gain_pct=snapshot.total_gain_pct,
                created_at=snapshot.created_at,
                updated_at=snapshot.updated_at,
            )
        )

    db.commit()

    return schemas.BackupImportResult(
        accounts=len(payload.accounts),
        holdings=len(payload.holdings),
        transactions=len(payload.transactions),
        cash_transactions=len(payload.cash_transactions),
        placements=len(payload.placements),
        placement_snapshots=len(payload.placement_snapshots),
        holding_daily_snapshots=len(payload.holding_daily_snapshots),
        portfolio_daily_snapshots=len(payload.portfolio_daily_snapshots),
    )


@app.put("/holdings/{holding_id}", response_model=schemas.Holding)
def update_holding(
    holding_id: int,
    payload: schemas.HoldingUpdate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    if payload.account_id is not None:
        account = crud.get_account(db, current_user.id, payload.account_id)
        if not account:
            raise HTTPException(status_code=400, detail="Account not found")
    if payload.price_tracker is not None or payload.tracker_symbol is not None:
        next_tracker = normalize_price_tracker(
            payload.price_tracker or getattr(holding, "price_tracker", None)
        )
        next_symbol = (
            payload.tracker_symbol
            if payload.tracker_symbol is not None
            else getattr(holding, "tracker_symbol", None)
        )
        if next_tracker == PRICE_TRACKER_BOURSORAMA and not next_symbol:
            fallback_symbol = holding.symbol
            if not fallback_symbol:
                raise HTTPException(
                    status_code=400,
                    detail="Tracker symbol is required for Boursorama quotes",
                )
            payload = payload.model_copy(update={"tracker_symbol": fallback_symbol})
        if payload.price_tracker is not None and next_tracker == PRICE_TRACKER_YAHOO:
            payload = payload.model_copy(update={"tracker_symbol": None})
    return crud.update_holding(db, holding, payload)


@app.delete("/holdings/{holding_id}")
def remove_holding(
    holding_id: int,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    deleted = crud.delete_holding(db, current_user.id, holding_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Holding not found")
    return {"status": "deleted"}


@app.post("/holdings/{holding_id}/refund")
def remove_holding_and_refund(
    holding_id: int,
    payload: schemas.HoldingRefundRequest | None = None,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    account = crud.get_account(db, current_user.id, holding.account_id)
    if not account:
        raise HTTPException(status_code=400, detail="Account not found")
    total_cost = holding.shares * holding.cost_basis + (holding.acquisition_fee_value or 0.0)
    rate = 1.0
    if holding.currency.upper() != "EUR":
        fx_rate = payload.fx_rate if payload else None
        if fx_rate:
            rate = fx_rate
        else:
            log.warning("Missing FX rate for %s refund; using 1.0", holding.currency)
    account.liquidity = (account.liquidity or 0.0) + (total_cost * rate)
    account.updated_at = datetime.utcnow()
    db.add(account)
    db.delete(holding)
    db.commit()
    db.refresh(account)
    return {"status": "deleted", "refunded": total_cost, "account_liquidity": account.liquidity}


@app.post("/prices", response_model=schemas.HoldingStats)
def add_price(
    snapshot: schemas.PriceSnapshotCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, snapshot.holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    updated = crud.add_price_snapshot(db, holding, snapshot)
    try:
        snapshot_day = snapshot.recorded_at.date() if snapshot.recorded_at else None
        crud.capture_daily_history(db, current_user.id, snapshot_day)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        log.warning("Failed to capture daily history after manual price update: %s", exc)
    return crud.build_holding_stats(db, updated)


@app.post("/history/daily/capture", response_model=schemas.DailyHistoryCaptureResult)
def capture_daily_history(
    snapshot_date: date | None = Query(None, description="Snapshot day (YYYY-MM-DD), defaults to today"),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        holdings_saved, portfolio_saved = crud.capture_daily_history(
            db,
            current_user.id,
            snapshot_date=snapshot_date,
        )
        return schemas.DailyHistoryCaptureResult(
            status="ok",
            snapshot_date=snapshot_date or date.today(),
            holdings_saved=holdings_saved,
            portfolio_saved=portfolio_saved,
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to capture daily history") from exc


@app.get("/history/daily", response_model=schemas.DailyHistoryResponse)
def get_daily_history(
    days: int = Query(90, ge=7, le=1095, description="How many days to return"),
    symbol: str | None = Query(None, description="Optional stock symbol filter"),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    clean_symbol = symbol.upper().strip() if symbol else None
    portfolio_rows = crud.get_portfolio_daily_snapshots(db, current_user.id, days=days)
    holding_rows = crud.get_holding_daily_snapshots(
        db,
        current_user.id,
        days=days,
        symbol=clean_symbol,
    )
    return schemas.DailyHistoryResponse(
        updated_at=datetime.utcnow(),
        portfolio=portfolio_rows,
        holdings=holding_rows,
    )


@app.get("/portfolio", response_model=schemas.PortfolioResponse)
def get_portfolio(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        response = crud.portfolio_summary(db, current_user.id)
        response.yfinance_status = get_yfinance_status()
        return response
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/agents/yahoo-targets")
async def run_yahoo_targets(
    current_user: models.User = Depends(auth.get_current_user),
) -> dict:
    output_path = Path(__file__).resolve().parents[1] / "yahoo_targets.json"
    try:
        from .yahoo_finance_agent import run as run_yahoo_agent

        await asyncio.to_thread(run_yahoo_agent, output_path, None)
        return {"status": "ok", "output": str(output_path)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Failed to run Yahoo targets") from exc


@app.post("/holdings/refresh")
async def refresh_holdings_prices(
    current_user: models.User = Depends(auth.get_current_user),
) -> dict:
    try:
        await refresh_holdings_prices_once()
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Failed to refresh holdings prices") from exc


@app.get("/search", response_model=Any)
async def search_instruments(q: str = Query(..., min_length=1, description="Symbol search term")):
    try:
        results = await _search_yfinance(q)
        return {"results": results}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="Search service unavailable") from exc


@app.get("/quotes/yfinance")
async def yfinance_quote(
    symbol: str = Query(..., min_length=1, description="Ticker symbol"),
) -> dict:
    symbol = symbol.upper().strip()
    try:
        quote = await _fetch_yfinance_quote(symbol)
        if quote.get("price") is None:
            raise HTTPException(status_code=502, detail="No price returned from yfinance")
        return {**quote, "symbol": symbol}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="yfinance quote error") from exc


@app.get("/quotes/boursorama")
async def boursorama_quote(
    symbol: str = Query(..., min_length=1, description="Boursorama symbol"),
) -> dict:
    symbol = symbol.strip()
    try:
        quote = await _fetch_boursorama_quote(symbol)
        if quote.get("price") is None:
            raise HTTPException(status_code=502, detail="No price returned from boursorama")
        return {**quote, "symbol": symbol}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="boursorama quote error") from exc


@app.get("/fx")
async def fx_rate(
    base: str = Query(..., min_length=3, description="Base currency, e.g., USD"),
    quote: str = Query(..., min_length=3, description="Quote currency, e.g., EUR"),
) -> dict:
    try:
        rate = await _fetch_fx_rate(base, quote)
        if rate is None:
            raise HTTPException(status_code=502, detail="Unable to fetch FX rate")
        return {"base": base.upper(), "quote": quote.upper(), "rate": rate}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="FX service unavailable") from exc


@app.get("/analysis/cac40", response_model=schemas.Cac40AnalysisResponse)
async def cac40_analysis(
    metric: str = Query("analyst_discount", description="analysis metric"),
) -> schemas.Cac40AnalysisResponse:
    if metric not in CAC40_METRICS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown metric. Choose one of: {', '.join(CAC40_METRICS.keys())}",
        )
    items, updated_at = await _load_cac40_snapshot()
    scored = _apply_cac40_metric(items, metric)
    return schemas.Cac40AnalysisResponse(metric=metric, updated_at=updated_at, items=scored)


@app.get("/analysis/bsf120", response_model=schemas.AnalystForecastResponse)
@app.get("/analysis/sbf120", response_model=schemas.AnalystForecastResponse)
async def bsf120_analyst_forecasts(
    include_missing: bool = Query(
        False,
        description="include symbols with no analyst target mean",
    ),
) -> schemas.AnalystForecastResponse:
    items, updated_at = await _load_sbf120_snapshot()
    with_forecast = sum(1 for item in items if item.get("target_mean_price") is not None)
    visible_items = (
        items
        if include_missing
        else [item for item in items if item.get("target_mean_price") is not None]
    )
    visible_items.sort(
        key=lambda entry: (entry.get("upside_pct") is None, -(entry.get("upside_pct") or 0)),
    )
    return schemas.AnalystForecastResponse(
        universe="BSF120",
        updated_at=updated_at,
        total_symbols=len(items),
        with_forecast=with_forecast,
        items=visible_items,
    )


@app.post("/api/chat")
async def chat_endpoint(
    payload: schemas.ChatRequest,
    stream: bool = Query(
        True,
        description="When false, return a single JSON message instead of streaming chunks.",
    ),
    db=Depends(db_session),
):
    """
    Stream a response from the LangGraph home agent (read-only SQL over the SQLite DB).
    """

    session_id = payload.session_id or str(uuid4())
    language = (payload.language or "en").lower()
    message_chars = len(payload.message or "")
    mode = "stream" if stream else "sync"
    log.info(
        "chat %s request start session_id=%s language=%s message_chars=%s",
        mode,
        session_id,
        language,
        message_chars,
    )

    async def stream_with_logs():
        chunk_count = 0
        total_chars = 0
        try:
            async for chunk in chatbot.response_llm(
                thread_id=session_id,
                question=payload.message,
                language=language,
            ):
                chunk_text = chunk if isinstance(chunk, str) else str(chunk)
                chunk_count += 1
                total_chars += len(chunk_text)
                if chunk_count <= 3 or chunk_count % 10 == 0:
                    log.info(
                        "chat stream chunk session_id=%s chunk_index=%s chunk_chars=%s total_chars=%s",
                        session_id,
                        chunk_count,
                        len(chunk_text),
                        total_chars,
                    )
                yield chunk_text
            log.info(
                "chat stream request end session_id=%s chunks=%s total_chars=%s",
                session_id,
                chunk_count,
                total_chars,
            )
        except asyncio.CancelledError:
            log.warning(
                "chat stream request cancelled session_id=%s chunks=%s total_chars=%s",
                session_id,
                chunk_count,
                total_chars,
            )
            raise
        except Exception:
            log.exception(
                "chat stream request failed session_id=%s chunks=%s total_chars=%s",
                session_id,
                chunk_count,
                total_chars,
            )
            raise

    if not stream:
        message_parts: list[str] = []
        chunk_count = 0
        total_chars = 0
        try:
            async for chunk in chatbot.response_llm(
                thread_id=session_id,
                question=payload.message,
                language=language,
            ):
                chunk_text = chunk if isinstance(chunk, str) else str(chunk)
                message_parts.append(chunk_text)
                chunk_count += 1
                total_chars += len(chunk_text)
            message = "".join(message_parts).strip()
            log.info(
                "chat sync request end session_id=%s chunks=%s total_chars=%s",
                session_id,
                chunk_count,
                total_chars,
            )
            return JSONResponse(
                {"session_id": session_id, "message": message},
                headers={"Cache-Control": "no-cache, no-transform"},
            )
        except Exception:
            log.exception(
                "chat sync request failed session_id=%s chunks=%s total_chars=%s",
                session_id,
                chunk_count,
                total_chars,
            )
            raise

    return StreamingResponse(
        stream_with_logs(),
        media_type="text/plain",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
