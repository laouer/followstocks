"""
FollowStocks API – application entry point.

All route handlers have been moved to `app.routes.*` sub-modules.
All service logic lives in `app.services.*`.
This file is responsible only for:
  • FastAPI app creation & lifespan
  • CORS middleware
  • Health-check endpoint
  • Router registration
"""
import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .chatbot.main import ChatBot
from .core.config import (
    AUTO_REFRESH_ENABLED,
    AUTO_REFRESH_SECONDS,
    CORS_ALLOW_ALL_ORIGINS,
    CORS_ALLOW_ORIGINS,
)
from .database import Base, engine, ensure_holdings_columns
from .routes import api_router
from .services.refresh_service import auto_refresh_loop

log = logging.getLogger("followstocks")
logging.basicConfig(level=logging.INFO)

# ── Initialisation ──────────────────────────────────────────

chatbot = ChatBot(verbose=False)

Base.metadata.create_all(bind=engine)
ensure_holdings_columns()

_refresh_task: asyncio.Task | None = None


# ── Lifespan ────────────────────────────────────────────────

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


# ── App ─────────────────────────────────────────────────────

app = FastAPI(title="FollowStocks API", version="0.2.0", lifespan=lifespan)

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

# Register all route modules
app.include_router(api_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
