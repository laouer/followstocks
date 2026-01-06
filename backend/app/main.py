import asyncio
import json
import logging
import os
import statistics
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime
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
from .database import Base, SessionLocal, engine, get_session, db_session
from .chatbot.main import ChatBot

log = logging.getLogger("followstocks")
logging.basicConfig(level=logging.INFO)

chatbot = ChatBot(verbose=False)

Base.metadata.create_all(bind=engine)


AUTO_REFRESH_SECONDS = int(os.getenv("AUTO_REFRESH_SECONDS", "300"))
AUTO_REFRESH_ENABLED = os.getenv("AUTO_REFRESH_ENABLED", "true").lower() not in {"0", "false", "no"}
_refresh_task: asyncio.Task | None = None
CAC40_CACHE_TTL_SECONDS = int(os.getenv("CAC40_CACHE_TTL_SECONDS", "1800"))

CAC40_TICKERS = [
    {"symbol": "AC.PA", "name": "Accor"},
    {"symbol": "AI.PA", "name": "Air Liquide"},
    {"symbol": "AIR.PA", "name": "Airbus"},
    {"symbol": "ALO.PA", "name": "Alstom"},
    {"symbol": "MT.AS", "name": "ArcelorMittal"},
    {"symbol": "CS.PA", "name": "AXA"},
    {"symbol": "BNP.PA", "name": "BNP Paribas"},
    {"symbol": "EN.PA", "name": "Bouygues"},
    {"symbol": "CAP.PA", "name": "Capgemini"},
    {"symbol": "CA.PA", "name": "Carrefour"},
    {"symbol": "ACA.PA", "name": "Credit Agricole"},
    {"symbol": "BN.PA", "name": "Danone"},
    {"symbol": "DSY.PA", "name": "Dassault Systemes"},
    {"symbol": "EDEN.PA", "name": "Edenred"},
    {"symbol": "ENGI.PA", "name": "Engie"},
    {"symbol": "EL.PA", "name": "EssilorLuxottica"},
    {"symbol": "RMS.PA", "name": "Hermes"},
    {"symbol": "KER.PA", "name": "Kering"},
    {"symbol": "OR.PA", "name": "L'Oreal"},
    {"symbol": "LR.PA", "name": "Legrand"},
    {"symbol": "MC.PA", "name": "LVMH"},
    {"symbol": "ML.PA", "name": "Michelin"},
    {"symbol": "ORA.PA", "name": "Orange"},
    {"symbol": "RI.PA", "name": "Pernod Ricard"},
    {"symbol": "PUB.PA", "name": "Publicis"},
    {"symbol": "RNO.PA", "name": "Renault"},
    {"symbol": "SAF.PA", "name": "Safran"},
    {"symbol": "SGO.PA", "name": "Saint-Gobain"},
    {"symbol": "SAN.PA", "name": "Sanofi"},
    {"symbol": "SU.PA", "name": "Schneider Electric"},
    {"symbol": "GLE.PA", "name": "Societe Generale"},
    {"symbol": "STLAP.PA", "name": "Stellantis"},
    {"symbol": "STM.PA", "name": "STMicroelectronics"},
    {"symbol": "TTE.PA", "name": "TotalEnergies"},
    {"symbol": "URW.AS", "name": "Unibail-Rodamco-Westfield"},
    {"symbol": "VIE.PA", "name": "Veolia"},
    {"symbol": "DG.PA", "name": "Vinci"},
    {"symbol": "VIV.PA", "name": "Vivendi"},
    {"symbol": "WLN.PA", "name": "Worldline"},
    {"symbol": "HO.PA", "name": "Thales"},
]

CAC40_METRICS = {
    "analyst_discount": "Analyst discount",
    "pe_discount": "P/E discount",
    "sector_pe_discount": "Sector P/E discount",
    "dividend_yield": "Dividend yield",
    "composite": "Composite score",
}

_cac40_cache: dict[str, Any] = {"timestamp": None, "items": None}
_cac40_cache_lock = asyncio.Lock()
_yfinance_status_lock = Lock()
_yfinance_status: dict[str, Any] = {
    "ok": True,
    "message": None,
    "last_error_at": None,
}
YFINANCE_UNREACHABLE_MESSAGE = (
    "Last prices are not updated because Yahoo Finance is unreachable "
    "(connection lost or blocked)."
)


def _set_yfinance_error(message: str) -> None:
    now = datetime.utcnow()
    with _yfinance_status_lock:
        if _yfinance_status.get("ok") or _yfinance_status.get("message") != message:
            _yfinance_status["last_error_at"] = now
        _yfinance_status["ok"] = False
        _yfinance_status["message"] = message


def _set_yfinance_ok() -> None:
    with _yfinance_status_lock:
        _yfinance_status["ok"] = True
        _yfinance_status["message"] = None
        _yfinance_status["last_error_at"] = None


def _get_yfinance_status() -> schemas.YahooFinanceStatus:
    with _yfinance_status_lock:
        return schemas.YahooFinanceStatus(
            ok=bool(_yfinance_status.get("ok")),
            message=_yfinance_status.get("message"),
            last_error_at=_yfinance_status.get("last_error_at"),
        )


async def _fetch_yfinance_quote(symbol: str) -> dict:
    symbol = symbol.upper().strip()

    def _sync_fetch():
        ticker = yf.Ticker(symbol)
        try:
            hist = ticker.history(period="1d", interval="1m")
            if hist is None or hist.empty:
                hist = ticker.history(period="5d", interval="1d")
            if hist is None or hist.empty:
                _set_yfinance_ok()
                return {"price": None, "timestamp": None, "source": "yfinance"}
            last_row = hist.tail(1)
            price = float(last_row["Close"].iloc[0])
            ts = last_row.index[-1].to_pydatetime().isoformat()
            _set_yfinance_ok()
            return {"price": price, "timestamp": ts, "source": "yfinance"}
        except Exception as exc:
            log.warning("yfinance quote failed for %s: %s", symbol, exc)
            _set_yfinance_error(YFINANCE_UNREACHABLE_MESSAGE)
            return {"price": None, "timestamp": None, "source": "yfinance"}

    return await asyncio.to_thread(_sync_fetch)


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
                _set_yfinance_ok()
                return None
            last_row = hist.tail(1)
            _set_yfinance_ok()
            return float(last_row["Close"].iloc[0])
        except Exception as exc:
            log.warning("yfinance FX failed for %s: %s", symbol, exc)
            _set_yfinance_error(YFINANCE_UNREACHABLE_MESSAGE)
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
            _set_yfinance_ok()
            return data.get("quotes", []) or []
    except Exception as exc:  # noqa: BLE001
        log.warning("yfinance search failed for %s: %s", query, exc)
        _set_yfinance_error(YFINANCE_UNREACHABLE_MESSAGE)
        return []


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_dividend_yield(value: Any) -> float | None:
    dividend_yield = _safe_float(value)
    if dividend_yield is None:
        return None
    if dividend_yield < 0:
        return None
    if dividend_yield > 1:
        return dividend_yield / 100
    if dividend_yield > 0.2:
        return dividend_yield / 100
    return dividend_yield


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
        _safe_float(info.get("regularMarketPrice"))
        or _safe_float(info.get("currentPrice"))
        or _safe_float(info.get("previousClose"))
    )
    dividend_rate = _safe_float(info.get("trailingAnnualDividendRate"))
    if dividend_rate is None:
        dividend_rate = _safe_float(info.get("dividendRate"))
    computed_yield = (
        dividend_rate / price
        if dividend_rate is not None and price is not None and price > 0
        else None
    )
    normalized_yield = _normalize_dividend_yield(
        info.get("dividendYield") or info.get("trailingAnnualDividendYield")
    )
    return {
        "symbol": symbol,
        "name": name,
        "currency": info.get("currency"),
        "price": price,
        "target_mean_price": _safe_float(info.get("targetMeanPrice")),
        "trailing_pe": _safe_float(info.get("trailingPE")),
        "price_to_book": _safe_float(info.get("priceToBook")),
        "dividend_yield": computed_yield if computed_yield is not None else normalized_yield,
        "market_cap": _safe_float(info.get("marketCap")),
        "sector": info.get("sector"),
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


def _group_holdings_by_symbol(
    holdings: list[models.Holding],
) -> dict[str, list[models.Holding]]:
    grouped: dict[str, list[models.Holding]] = {}
    for holding in holdings:
        symbol = (holding.symbol or "").upper().strip()
        if not symbol:
            continue
        grouped.setdefault(symbol, []).append(holding)
    return grouped


async def _refresh_grouped_holdings(
    db: Session, grouped: dict[str, list[models.Holding]]
) -> None:
    for symbol, symbol_holdings in grouped.items():
        try:
            quote = await _fetch_yfinance_quote(symbol)
        except Exception as exc:  # broad catch to keep the loop running
            log.warning("Auto-refresh: failed to fetch %s: %s", symbol, exc)
            continue

        price = quote.get("price")
        if price is None:
            log.warning("Auto-refresh: no price returned for %s", symbol)
            continue

        stored_any = False
        for holding in symbol_holdings:
            try:
                ts_str = quote.get("timestamp")
                stored = _upsert_snapshot_from_quote(db, holding, price, ts_str)
                stored_any = stored_any or stored
            except IntegrityError as exc:
                db.rollback()
                log.warning("Auto-refresh: integrity issue for %s: %s", symbol, exc)
            except Exception as exc:  # broad catch to keep processing
                db.rollback()
                log.warning("Auto-refresh: failed to store snapshot for %s: %s", symbol, exc)

        if stored_any:
            log.info("Auto-refresh: stored price for %s (%d holdings)", symbol, len(symbol_holdings))


async def refresh_holdings_prices_once() -> None:
    with SessionLocal() as db:
        holdings = db.query(models.Holding).all()

        if not holdings:
            log.info("Auto-refresh: no holdings to refresh.")
            return

        grouped = _group_holdings_by_symbol(holdings)
        await _refresh_grouped_holdings(db, grouped)


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
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
    created = crud.create_holding(db, current_user.id, holding)
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
        grouped = _group_holdings_by_symbol(holdings)
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
    if missing_account_refs:
        missing = ", ".join(str(account_id) for account_id in sorted(missing_account_refs))
        raise HTTPException(status_code=400, detail=f"Missing accounts in backup: {missing}")

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

    db.commit()

    return schemas.BackupImportResult(
        accounts=len(payload.accounts),
        holdings=len(payload.holdings),
        transactions=len(payload.transactions),
        cash_transactions=len(payload.cash_transactions),
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
    return crud.build_holding_stats(db, updated)


@app.get("/portfolio", response_model=schemas.PortfolioResponse)
def get_portfolio(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        response = crud.portfolio_summary(db, current_user.id)
        response.yfinance_status = _get_yfinance_status()
        return response
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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

@app.post("/api/chat")
async def chat_endpoint(payload: schemas.ChatRequest, db=Depends(db_session)):
    """
    Stream a response from the LangGraph home agent (read-only SQL over the SQLite DB).
    """

    session_id = payload.session_id or str(uuid4())
    return StreamingResponse(
        chatbot.response_llm(
            thread_id=session_id,
            question=payload.message,
            language=(payload.language or "en").lower(),
        ),
        media_type="text/plain",
    )
