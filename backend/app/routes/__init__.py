"""Central router registry – import and include all sub-routers here."""
from fastapi import APIRouter

from .accounts import router as accounts_router
from .analysis import router as analysis_router
from .auth import router as auth_router
from .backup import router as backup_router
from .holdings import router as holdings_router
from .market_data import router as market_data_router
from .placements import router as placements_router
from .portfolio import router as portfolio_router

api_router = APIRouter()

api_router.include_router(auth_router)
api_router.include_router(accounts_router)
api_router.include_router(holdings_router)
api_router.include_router(placements_router)
api_router.include_router(backup_router)
api_router.include_router(market_data_router)
api_router.include_router(analysis_router)
api_router.include_router(portfolio_router)
