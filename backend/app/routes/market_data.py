"""Market data routes: quotes, FX rates, search, agents."""
import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import auth, models
from ..services.quote_service import (
    fetch_boursorama_quote,
    fetch_fx_rate,
    fetch_yfinance_quote,
    search_yfinance,
)

router = APIRouter(tags=["market_data"])


@router.get("/search", response_model=Any)
async def search_instruments(q: str = Query(..., min_length=1, description="Symbol search term")):
    try:
        results = await search_yfinance(q)
        return {"results": results}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="Search service unavailable") from exc


@router.get("/quotes/yfinance")
async def yfinance_quote(
    symbol: str = Query(..., min_length=1, description="Ticker symbol"),
) -> dict:
    symbol = symbol.upper().strip()
    try:
        quote = await fetch_yfinance_quote(symbol)
        if quote.get("price") is None:
            raise HTTPException(status_code=502, detail="No price returned from yfinance")
        return {**quote, "symbol": symbol}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="yfinance quote error") from exc


@router.get("/quotes/boursorama")
async def boursorama_quote(
    symbol: str = Query(..., min_length=1, description="Boursorama symbol"),
) -> dict:
    symbol = symbol.strip()
    try:
        quote = await fetch_boursorama_quote(symbol)
        if quote.get("price") is None:
            raise HTTPException(status_code=502, detail="No price returned from boursorama")
        return {**quote, "symbol": symbol}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="boursorama quote error") from exc


@router.get("/fx")
async def fx_rate(
    base: str = Query(..., min_length=3, description="Base currency, e.g., USD"),
    quote: str = Query(..., min_length=3, description="Quote currency, e.g., EUR"),
) -> dict:
    try:
        rate = await fetch_fx_rate(base, quote)
        if rate is None:
            raise HTTPException(status_code=502, detail="Unable to fetch FX rate")
        return {"base": base.upper(), "quote": quote.upper(), "rate": rate}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="FX service unavailable") from exc


@router.post("/agents/yahoo-targets")
async def run_yahoo_targets(
    current_user: models.User = Depends(auth.get_current_user),
) -> dict:
    output_path = Path(__file__).resolve().parents[2] / "yahoo_targets.json"
    try:
        from ..yahoo_finance_agent import run as run_yahoo_agent
        await asyncio.to_thread(run_yahoo_agent, output_path, None)
        return {"status": "ok", "output": str(output_path)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Failed to run Yahoo targets") from exc
