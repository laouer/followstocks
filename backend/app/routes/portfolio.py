"""Portfolio, daily history, chat, and Boursorama integration routes."""
import asyncio
import logging
from datetime import date, datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import auth, crud, models, schemas
from ..core.cache import get_yfinance_status
from ..database import db_session, get_session

log = logging.getLogger("followstocks")

router = APIRouter(tags=["portfolio"])


@router.get("/portfolio", response_model=schemas.PortfolioResponse)
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


@router.post("/history/daily/capture", response_model=schemas.DailyHistoryCaptureResult)
def capture_daily_history(
    snapshot_date: date | None = Query(None, description="Snapshot day (YYYY-MM-DD), defaults to today"),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        holdings_saved, portfolio_saved = crud.capture_daily_history(
            db, current_user.id, snapshot_date=snapshot_date,
        )
        return schemas.DailyHistoryCaptureResult(
            status="ok", snapshot_date=snapshot_date or date.today(),
            holdings_saved=holdings_saved, portfolio_saved=portfolio_saved,
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to capture daily history") from exc


@router.get("/history/daily", response_model=schemas.DailyHistoryResponse)
def get_daily_history(
    days: int = Query(90, ge=7, le=1095, description="How many days to return"),
    symbol: str | None = Query(None, description="Optional stock symbol filter"),
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    clean_symbol = symbol.upper().strip() if symbol else None
    portfolio_rows = crud.get_portfolio_daily_snapshots(db, current_user.id, days=days)
    holding_rows = crud.get_holding_daily_snapshots(db, current_user.id, days=days, symbol=clean_symbol)
    return schemas.DailyHistoryResponse(
        updated_at=datetime.now(timezone.utc), portfolio=portfolio_rows, holdings=holding_rows,
    )


# ── Boursorama integrations ────────────────────────────────


@router.get("/integrations/boursorama/session", response_model=schemas.BoursoramaSessionStatus)
def get_boursorama_session_status(
    current_user: models.User = Depends(auth.get_current_user),
):
    from ..boursorama_cash_sync import get_session_status
    return get_session_status(current_user.id)


@router.post("/integrations/boursorama/cash/preview", response_model=schemas.BoursoramaCashPreviewResponse)
def preview_boursorama_cash(
    payload: schemas.BoursoramaCashPreviewRequest,
    current_user: models.User = Depends(auth.get_current_user),
):
    from ..boursorama_cash_sync import fetch_cash_preview
    try:
        preview = fetch_cash_preview(
            current_user.id, url=payload.url, timeout_ms=payload.timeout_ms, headless=payload.headless,
        )
        return jsonable_encoder(preview)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Failed to preview Boursorama cash") from exc


@router.post("/integrations/boursorama/cash/sync", response_model=schemas.BoursoramaCashSyncResponse)
def sync_boursorama_cash(
    payload: schemas.BoursoramaCashSyncRequest,
    db: Session = Depends(get_session),
    current_user: models.User = Depends(auth.get_current_user),
):
    from ..boursorama_cash_sync import fetch_cash_preview, sync_cash_accounts
    try:
        preview = fetch_cash_preview(
            current_user.id, url=payload.url, timeout_ms=payload.timeout_ms, headless=payload.headless,
        )
        result = sync_cash_accounts(
            db, current_user.id, preview,
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


# ── Chat ────────────────────────────────────────────────────


def get_chatbot():
    """Lazy import to avoid circular imports; chatbot is initialized in main.py lifespan."""
    from ..main import chatbot
    return chatbot


@router.post("/api/chat")
async def chat_endpoint(
    payload: schemas.ChatRequest,
    stream: bool = Query(True, description="When false, return a single JSON message instead of streaming chunks."),
    db=Depends(db_session),
):
    bot = get_chatbot()
    session_id = payload.session_id or str(uuid4())
    language = (payload.language or "en").lower()
    message_chars = len(payload.message or "")
    mode = "stream" if stream else "sync"
    log.info("chat %s request start session_id=%s language=%s message_chars=%s", mode, session_id, language, message_chars)

    async def stream_with_logs():
        chunk_count = 0
        total_chars = 0
        try:
            async for chunk in bot.response_llm(thread_id=session_id, question=payload.message, language=language):
                chunk_text = chunk if isinstance(chunk, str) else str(chunk)
                chunk_count += 1
                total_chars += len(chunk_text)
                if chunk_count <= 3 or chunk_count % 10 == 0:
                    log.info("chat stream chunk session_id=%s chunk_index=%s chunk_chars=%s total_chars=%s", session_id, chunk_count, len(chunk_text), total_chars)
                yield chunk_text
            log.info("chat stream request end session_id=%s chunks=%s total_chars=%s", session_id, chunk_count, total_chars)
        except asyncio.CancelledError:
            log.warning("chat stream request cancelled session_id=%s chunks=%s total_chars=%s", session_id, chunk_count, total_chars)
            raise
        except Exception:
            log.exception("chat stream request failed session_id=%s chunks=%s total_chars=%s", session_id, chunk_count, total_chars)
            raise

    if not stream:
        message_parts: list[str] = []
        chunk_count = 0
        total_chars = 0
        try:
            async for chunk in bot.response_llm(thread_id=session_id, question=payload.message, language=language):
                chunk_text = chunk if isinstance(chunk, str) else str(chunk)
                message_parts.append(chunk_text)
                chunk_count += 1
                total_chars += len(chunk_text)
            message = "".join(message_parts).strip()
            log.info("chat sync request end session_id=%s chunks=%s total_chars=%s", session_id, chunk_count, total_chars)
            return JSONResponse({"session_id": session_id, "message": message}, headers={"Cache-Control": "no-cache, no-transform"})
        except Exception:
            log.exception("chat sync request failed session_id=%s chunks=%s total_chars=%s", session_id, chunk_count, total_chars)
            raise

    return StreamingResponse(
        stream_with_logs(), media_type="text/plain",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
