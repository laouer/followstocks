"""CAC40 and SBF120 analysis routes."""
import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import auth, models, schemas
from ..core.config import CAC40_METRICS
from ..services.analysis_service import apply_cac40_metric, load_cac40_snapshot, load_sbf120_snapshot

router = APIRouter(prefix="/analysis", tags=["analysis"])


@router.get("/cac40", response_model=schemas.Cac40AnalysisResponse)
async def cac40_analysis(
    metric: str = Query("analyst_discount", description="analysis metric"),
) -> schemas.Cac40AnalysisResponse:
    if metric not in CAC40_METRICS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown metric. Choose one of: {', '.join(CAC40_METRICS.keys())}",
        )
    items, updated_at = await load_cac40_snapshot()
    scored = apply_cac40_metric(items, metric)
    return schemas.Cac40AnalysisResponse(metric=metric, updated_at=updated_at, items=scored)


@router.get("/bsf120", response_model=schemas.AnalystForecastResponse)
@router.get("/sbf120", response_model=schemas.AnalystForecastResponse)
async def bsf120_analyst_forecasts(
    include_missing: bool = Query(False, description="include symbols with no analyst target mean"),
) -> schemas.AnalystForecastResponse:
    items, updated_at = await load_sbf120_snapshot()
    with_forecast = sum(1 for item in items if item.get("target_mean_price") is not None)
    visible_items = (
        items if include_missing
        else [item for item in items if item.get("target_mean_price") is not None]
    )
    visible_items.sort(key=lambda e: (e.get("upside_pct") is None, -(e.get("upside_pct") or 0)))
    return schemas.AnalystForecastResponse(
        universe="BSF120", updated_at=updated_at,
        total_symbols=len(items), with_forecast=with_forecast, items=visible_items,
    )


