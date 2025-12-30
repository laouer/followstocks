import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from typing import Any, List

import httpx
import yfinance as yf
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import auth, crud, models, schemas
from .database import Base, SessionLocal, engine, get_session

log = logging.getLogger("followstocks")
logging.basicConfig(level=logging.INFO)

Base.metadata.create_all(bind=engine)


AUTO_REFRESH_SECONDS = int(os.getenv("AUTO_REFRESH_SECONDS", "3600"))
AUTO_REFRESH_ENABLED = os.getenv("AUTO_REFRESH_ENABLED", "true").lower() not in {"0", "false", "no"}
_refresh_task: asyncio.Task | None = None


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


async def refresh_holdings_prices_once() -> None:
    with SessionLocal() as db:
        holdings = (
            db.query(models.Holding)
            .all()
        )

        if not holdings:
            log.info("Auto-refresh: no holdings to refresh.")
            return

        for holding in holdings:
            try:
                quote = await _fetch_yfinance_quote(holding.symbol)
            except Exception as exc:  # broad catch to keep the loop running
                log.warning("Auto-refresh: failed to fetch %s: %s", holding.symbol, exc)
                continue

            price = quote.get("price")
            try:
                ts_str = quote.get("timestamp")
                stored = _upsert_snapshot_from_quote(db, holding, price, ts_str)
                if stored:
                    log.info("Auto-refresh: stored price for %s", holding.symbol)
                else:
                    log.warning("Auto-refresh: no price returned for %s", holding.symbol)
            except IntegrityError as exc:
                db.rollback()
                log.warning("Auto-refresh: integrity issue for %s: %s", holding.symbol, exc)
            except Exception as exc:  # broad catch to keep processing
                db.rollback()
                log.warning("Auto-refresh: failed to store snapshot for %s: %s", holding.symbol, exc)


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
    token = auth.create_access_token(user)
    return {"access_token": token, "token_type": "bearer", "user": user}


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
    created = crud.create_holding(db, current_user.id, holding)
    try:
        quote = await _fetch_yfinance_quote(created.symbol)
        price = quote.get("price")
        ts_str = quote.get("timestamp")
        stored = _upsert_snapshot_from_quote(db, created, price, ts_str)
        if stored:
            log.info("Initial price stored for %s after creation", created.symbol)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to fetch/store initial price for %s: %s", created.symbol, exc)
    return created


@app.get("/holdings", response_model=List[schemas.HoldingStats])
def list_holdings(
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    return crud.get_holdings_with_stats(db, current_user.id)


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
