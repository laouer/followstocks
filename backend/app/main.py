import asyncio
import csv
import io
import logging
import os
import statistics
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime
from typing import Any, List

import httpx
import yfinance as yf
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import auth, crud, models, schemas
from .database import Base, SessionLocal, engine, get_session

log = logging.getLogger("followstocks")
logging.basicConfig(level=logging.INFO)

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


async def _fetch_yfinance_quote(symbol: str) -> dict:
    symbol = symbol.upper().strip()

    def _sync_fetch():
        ticker = yf.Ticker(symbol)
        try:
            hist = ticker.history(period="1d", interval="1m")
            if hist is None or hist.empty:
                hist = ticker.history(period="5d", interval="1d")
            if hist is None or hist.empty:
                return {"price": None, "timestamp": None, "source": "yfinance"}
            last_row = hist.tail(1)
            price = float(last_row["Close"].iloc[0])
            ts = last_row.index[-1].to_pydatetime().isoformat()
            return {"price": price, "timestamp": ts, "source": "yfinance"}
        except Exception:
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
                return None
            last_row = hist.tail(1)
            return float(last_row["Close"].iloc[0])
        except Exception:
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
            return data.get("quotes", []) or []
    except Exception as exc:  # noqa: BLE001
        log.warning("yfinance search failed for %s: %s", query, exc)
        return []


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_csv_float(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace(" ", "")
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif text.count(",") == 1 and text.count(".") == 0:
        text = text.replace(",", ".")
    return float(text)


def _parse_csv_date(value: Any) -> date | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    with suppress(ValueError):
        parsed = datetime.fromisoformat(text)
        return parsed.date()
    with suppress(ValueError):
        return date.fromisoformat(text)
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y/%m/%d", "%m/%d/%Y"):
        with suppress(ValueError):
            return datetime.strptime(text, fmt).date()
    raise ValueError("invalid date format")


def _parse_csv_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    with suppress(ValueError):
        return datetime.fromisoformat(text)
    for fmt in (
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y %H:%M:%S",
        "%d-%m-%Y %H:%M",
        "%d-%m-%Y %H:%M:%S",
        "%d.%m.%Y %H:%M",
        "%d.%m.%Y %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y %H:%M:%S",
    ):
        with suppress(ValueError):
            return datetime.strptime(text, fmt)
    parsed_date = _parse_csv_date(text)
    return datetime.combine(parsed_date, datetime.min.time())


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

    existing = (
        db.query(models.PriceSnapshot)
        .filter(
            models.PriceSnapshot.holding_id == holding.id,
            models.PriceSnapshot.recorded_at == recorded_at,
        )
        .first()
    )
    if existing:
        existing.price = price
        holding.updated_at = datetime.utcnow()
        db.add(existing)
        db.add(holding)
        db.commit()
        return True

    crud.add_price_snapshot(
        db,
        holding,
        schemas.PriceSnapshotCreate(holding_id=holding.id, price=price, recorded_at=recorded_at),
    )
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
    return crud.get_accounts(db, current_user.id)


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
    except IntegrityError as exc:
        raise HTTPException(status_code=400, detail="Account already exists") from exc


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
    created = crud.create_holding(db, current_user.id, holding)
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


@app.get("/holdings", response_model=List[schemas.HoldingStats])
def list_holdings(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    return crud.get_holdings_with_stats(db, current_user.id)


@app.get("/holdings/export")
def export_holdings(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holdings = crud.get_holdings_with_stats(db, current_user.id)
    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    headers = [
        "symbol",
        "shares",
        "cost_basis",
        "acquisition_fee_value",
        "currency",
        "account",
        "account_type",
        "account_liquidity",
        "sector",
        "industry",
        "type",
        "isin",
        "mic",
        "name",
        "href",
        "acquired_at",
        "last_price",
        "last_price_at",
    ]
    writer.writerow(headers)
    for holding in holdings:
        account_name = holding.account.name if holding.account else ""
        account_type = holding.account.account_type if holding.account else ""
        account_liquidity = holding.account.liquidity if holding.account else ""
        writer.writerow(
            [
                holding.symbol,
                holding.shares,
                holding.cost_basis,
                holding.acquisition_fee_value,
                holding.currency,
                account_name,
                account_type or "",
                account_liquidity,
                holding.sector or "",
                holding.industry or "",
                holding.asset_type or "",
                holding.isin or "",
                holding.mic or "",
                holding.name or "",
                holding.href or "",
                holding.acquired_at.isoformat() if holding.acquired_at else "",
                holding.last_price if holding.last_price is not None else "",
                holding.last_snapshot_at.isoformat() if holding.last_snapshot_at else "",
            ]
        )
    filename = f"holdings-{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/holdings/import", response_model=schemas.HoldingsImportResult)
async def import_holdings(
    file: UploadFile = File(...),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="CSV must be UTF-8 encoded") from exc

    try:
        sample = text[:2048]
        dialect = csv.Sniffer().sniff(sample, delimiters=";,")
    except csv.Error:
        dialect = csv.excel
        dialect.delimiter = ";"

    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV missing header row")

    key_map = {
        "symbol": "symbol",
        "shares": "shares",
        "cost_basis": "cost_basis",
        "cost": "cost_basis",
        "acquisition_fee_value": "acquisition_fee_value",
        "acquisition_fee": "acquisition_fee_value",
        "fee": "acquisition_fee_value",
        "fee_value": "acquisition_fee_value",
        "currency": "currency",
        "account": "account",
        "account_name": "account",
        "account_id": "account_id",
        "account type": "account_type",
        "account_type": "account_type",
        "account liquidity": "account_liquidity",
        "account_liquidity": "account_liquidity",
        "liquidity": "account_liquidity",
        "sector": "sector",
        "industry": "industry",
        "asset_type": "asset_type",
        "asset type": "asset_type",
        "type": "asset_type",
        "isin": "isin",
        "mic": "mic",
        "name": "name",
        "href": "href",
        "acquired_at": "acquired_at",
        "last_price": "last_price",
        "price": "last_price",
        "last_price_at": "last_price_at",
        "last_snapshot_at": "last_price_at",
        "price_at": "last_price_at",
        "price_time": "last_price_at",
        "timestamp": "last_price_at",
    }
    normalized_headers = {str(name).strip().lower() for name in reader.fieldnames}
    mapped_headers = {key_map.get(name) for name in normalized_headers if key_map.get(name)}
    required_fields = {"symbol", "shares", "cost_basis"}
    if not required_fields.issubset(mapped_headers):
        missing = required_fields - mapped_headers
        raise HTTPException(
            status_code=400,
            detail=f"CSV missing required columns: {', '.join(sorted(missing))}",
        )

    created = 0
    skipped = 0
    errors: list[str] = []
    created_symbols: set[str] = set()

    for row_index, row in enumerate(reader, start=2):
        try:
            normalized: dict[str, str | None] = {}
            for raw_key, raw_value in row.items():
                if raw_key is None:
                    continue
                mapped = key_map.get(str(raw_key).strip().lower())
                if mapped:
                    normalized[mapped] = raw_value

            symbol = (normalized.get("symbol") or "").strip()
            if not symbol:
                raise ValueError("symbol is required")

            try:
                shares = _parse_csv_float(normalized.get("shares"))
            except ValueError as exc:
                raise ValueError("invalid shares") from exc
            if shares is None or shares <= 0:
                raise ValueError("shares must be > 0")

            try:
                cost_basis = _parse_csv_float(normalized.get("cost_basis"))
            except ValueError as exc:
                raise ValueError("invalid cost_basis") from exc
            if cost_basis is None or cost_basis <= 0:
                raise ValueError("cost_basis must be > 0")

            fee_value = 0.0
            if normalized.get("acquisition_fee_value") not in (None, ""):
                try:
                    fee_value = _parse_csv_float(normalized.get("acquisition_fee_value")) or 0.0
                except ValueError as exc:
                    raise ValueError("invalid acquisition_fee_value") from exc
            if fee_value < 0:
                raise ValueError("acquisition_fee_value must be >= 0")

            currency = normalized.get("currency")
            currency = currency.strip().upper() if currency else None

            account_id = None
            if normalized.get("account_id") not in (None, ""):
                try:
                    account_id = int(str(normalized.get("account_id")).strip())
                except ValueError as exc:
                    raise ValueError("invalid account_id") from exc
                if account_id <= 0:
                    raise ValueError("account_id must be > 0")

            account_name = None
            if normalized.get("account"):
                account_name = str(normalized.get("account")).strip()
                if not account_name:
                    account_name = None

            account_type = None
            if normalized.get("account_type"):
                account_type = str(normalized.get("account_type")).strip() or None

            account_liquidity = 0.0
            if normalized.get("account_liquidity") not in (None, ""):
                try:
                    account_liquidity = (
                        _parse_csv_float(normalized.get("account_liquidity")) or 0.0
                    )
                except ValueError as exc:
                    raise ValueError("invalid account_liquidity") from exc
                if account_liquidity < 0:
                    raise ValueError("account_liquidity must be >= 0")

            acquired_at = None
            if normalized.get("acquired_at"):
                try:
                    acquired_at = _parse_csv_date(normalized.get("acquired_at"))
                except ValueError as exc:
                    raise ValueError(
                        "invalid acquired_at (use YYYY-MM-DD, DD/MM/YYYY, or ISO datetime)"
                    ) from exc

            last_price = None
            if normalized.get("last_price") not in (None, ""):
                try:
                    last_price = _parse_csv_float(normalized.get("last_price"))
                except ValueError as exc:
                    raise ValueError("invalid last_price") from exc
                if last_price is None or last_price <= 0:
                    raise ValueError("last_price must be > 0")

            last_price_at = None
            if normalized.get("last_price_at"):
                try:
                    last_price_at = _parse_csv_datetime(normalized.get("last_price_at"))
                except ValueError as exc:
                    raise ValueError(
                        "invalid last_price_at (use YYYY-MM-DD, DD/MM/YYYY, or ISO datetime)"
                    ) from exc

            payload: dict[str, Any] = {
                "symbol": symbol,
                "shares": shares,
                "cost_basis": cost_basis,
                "acquisition_fee_value": fee_value,
            }
            if account_id is not None:
                account = crud.get_account(db, current_user.id, account_id)
                if not account:
                    raise ValueError("account_id not found")
                payload["account_id"] = account.id
            elif account_name:
                account = crud.get_or_create_account_by_name(
                    db,
                    current_user.id,
                    account_name,
                    account_type=account_type,
                    liquidity=account_liquidity,
                )
                payload["account_id"] = account.id
            else:
                account = crud.get_or_create_default_account(db, current_user.id)
                payload["account_id"] = account.id
            if currency:
                payload["currency"] = currency
            if normalized.get("isin"):
                payload["isin"] = str(normalized.get("isin")).strip() or None
            if normalized.get("mic"):
                payload["mic"] = str(normalized.get("mic")).strip() or None
            if normalized.get("name"):
                payload["name"] = str(normalized.get("name")).strip() or None
            if normalized.get("href"):
                payload["href"] = str(normalized.get("href")).strip() or None
            if acquired_at:
                payload["acquired_at"] = acquired_at
            if normalized.get("sector"):
                payload["sector"] = str(normalized.get("sector")).strip() or None
            if normalized.get("industry"):
                payload["industry"] = str(normalized.get("industry")).strip() or None
            if normalized.get("asset_type"):
                payload["asset_type"] = str(normalized.get("asset_type")).strip() or None

            holding = schemas.HoldingCreate(**payload)
            created_holding = crud.create_holding(db, current_user.id, holding)
            if last_price is not None:
                recorded_at = last_price_at or datetime.utcnow()
                crud.add_price_snapshot(
                    db,
                    created_holding,
                    schemas.PriceSnapshotCreate(
                        holding_id=created_holding.id,
                        price=last_price,
                        recorded_at=recorded_at,
                    ),
                )
            created_symbols.add(created_holding.symbol)
            created += 1
        except Exception as exc:  # noqa: BLE001
            skipped += 1
            errors.append(f"Row {row_index}: {exc}")

    if created_symbols:
        try:
            holdings = (
                db.query(models.Holding)
                .filter(models.Holding.symbol.in_(created_symbols))
                .all()
            )
            grouped = _group_holdings_by_symbol(holdings)
            await _refresh_grouped_holdings(db, grouped)
        except Exception as exc:  # noqa: BLE001
            log.warning("Import refresh failed: %s", exc)

    return schemas.HoldingsImportResult(created=created, skipped=skipped, errors=errors)


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


@app.post("/prices", response_model=schemas.PriceSnapshot)
def add_price(
    snapshot: schemas.PriceSnapshotCreate,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    holding = crud.get_holding(db, current_user.id, snapshot.holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    return crud.add_price_snapshot(db, holding, snapshot)


@app.get("/prices/{holding_id}", response_model=List[schemas.PriceSnapshot])
def get_prices(
    holding_id: int,
    limit: int = Query(default=24, ge=1, le=500),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    prices = crud.get_snapshots_for_holding(db, current_user.id, holding_id, limit=limit)
    if not prices:
        raise HTTPException(status_code=404, detail="No price snapshots found")
    return prices


@app.get("/portfolio", response_model=schemas.PortfolioResponse)
def get_portfolio(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    return crud.portfolio_summary(db, current_user.id)


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
