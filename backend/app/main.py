from datetime import datetime
from typing import Any, List

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from . import crud, models, schemas
from .database import Base, engine, get_session

Base.metadata.create_all(bind=engine)

app = FastAPI(title="FollowStocks API", version="0.1.0")

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


@app.post("/holdings", response_model=schemas.Holding)
def create_holding(holding: schemas.HoldingCreate, db: Session = Depends(get_session)):
    existing = crud.get_holding_by_symbol(db, holding.symbol)
    if existing:
        raise HTTPException(status_code=400, detail="Holding already exists for that symbol")
    return crud.create_holding(db, holding)


@app.get("/holdings", response_model=List[schemas.HoldingStats])
def list_holdings(db: Session = Depends(get_session)):
    return crud.get_holdings_with_stats(db)


@app.put("/holdings/{holding_id}", response_model=schemas.Holding)
def update_holding(holding_id: int, payload: schemas.HoldingUpdate, db: Session = Depends(get_session)):
    holding = crud.get_holding(db, holding_id)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    return crud.update_holding(db, holding, payload)


@app.delete("/holdings/{holding_id}")
def remove_holding(holding_id: int, db: Session = Depends(get_session)):
    deleted = crud.delete_holding(db, holding_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Holding not found")
    return {"status": "deleted"}


@app.post("/prices", response_model=schemas.PriceSnapshot)
def add_price(snapshot: schemas.PriceSnapshotCreate, db: Session = Depends(get_session)):
    holding = crud.get_holding_by_symbol(db, snapshot.symbol)
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found for that symbol")
    return crud.add_price_snapshot(db, holding, snapshot)


@app.get("/prices/{symbol}", response_model=List[schemas.PriceSnapshot])
def get_prices(symbol: str, limit: int = Query(default=24, ge=1, le=500), db: Session = Depends(get_session)):
    prices = crud.get_snapshots_for_symbol(db, symbol, limit=limit)
    if not prices:
        raise HTTPException(status_code=404, detail="No price snapshots found")
    return prices


@app.get("/portfolio", response_model=schemas.PortfolioResponse)
def get_portfolio(db: Session = Depends(get_session)):
    return crud.portfolio_summary(db)


EURONEXT_SEARCH_URL = "https://live.euronext.com/fr/instrumentSearch/searchJSON"
EURONEXT_INTRADAY_URL = "https://live.euronext.com/fr/ajax/getIntradayPriceFilteredData/{isin}-{mic}"


@app.get("/search", response_model=Any)
async def search_instruments(q: str = Query(..., min_length=1, description="Symbol/ISIN search term")):
    try:
        async with httpx.AsyncClient(timeout=6.0, headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "fr"}) as client:
            resp = await client.get(EURONEXT_SEARCH_URL, params={"q": q})
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail="Upstream search error")
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="Search service unavailable")


@app.get("/quotes/euronext")
async def euronext_quote(
    isin: str = Query(..., min_length=3, description="ISIN code"),
    mic: str = Query(..., min_length=3, description="Market identifier code"),
) -> dict:
    isin = isin.upper()
    mic = mic.upper()
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(EURONEXT_INTRADAY_URL.format(isin=isin, mic=mic))
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail="Euronext quote error")
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="Quote service unavailable")

    try:
        rows = data.get("rows") or []
        if not rows:
            raise ValueError("No trades found")
        latest = rows[0]
        raw_price = str(latest.get("price") or "").strip().replace(" ", "").replace(",", ".")
        price: float | None
        try:
            price = float(raw_price)
        except ValueError:
            price = None
        date_raw = str(data.get("date") or "").replace("\\/", "/")
        time_str = str(latest.get("time") or "00:00:00")
        ts_iso: str | None = None
        for fmt in ("%d/%m/%YT%H:%M:%S", "%d-%m-%YT%H:%M:%S"):
            try:
                ts_iso = datetime.strptime(f"{date_raw}T{time_str}", fmt).isoformat()
                break
            except ValueError:
                continue
        return {"isin": isin, "mic": mic, "price": price, "timestamp": ts_iso, "source": "euronext"}
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Invalid quote data") from exc
