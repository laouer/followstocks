"""
Cache management for CAC40/SBF120 data and yfinance status tracking.
"""
import asyncio
from datetime import datetime
from threading import Lock
from typing import Any

from .. import schemas
from .config import YFINANCE_UNREACHABLE_MESSAGE

# Global caches with async locks
_cac40_cache: dict[str, Any] = {"timestamp": None, "items": None}
_cac40_cache_lock = asyncio.Lock()

_sbf120_cache: dict[str, Any] = {"timestamp": None, "items": None}
_sbf120_cache_lock = asyncio.Lock()

# yfinance status tracking with thread lock
_yfinance_status_lock = Lock()
_yfinance_status: dict[str, Any] = {
    "ok": True,
    "message": None,
    "last_error_at": None,
}


def set_yfinance_error(message: str) -> None:
    """Set yfinance error status with timestamp."""
    now = datetime.utcnow()
    with _yfinance_status_lock:
        if _yfinance_status.get("ok") or _yfinance_status.get("message") != message:
            _yfinance_status["last_error_at"] = now
        _yfinance_status["ok"] = False
        _yfinance_status["message"] = message


def set_yfinance_ok() -> None:
    """Clear yfinance error status."""
    with _yfinance_status_lock:
        _yfinance_status["ok"] = True
        _yfinance_status["message"] = None
        _yfinance_status["last_error_at"] = None


def get_yfinance_status() -> schemas.YahooFinanceStatus:
    """Get current yfinance status."""
    with _yfinance_status_lock:
        return schemas.YahooFinanceStatus(
            ok=bool(_yfinance_status.get("ok")),
            message=_yfinance_status.get("message"),
            last_error_at=_yfinance_status.get("last_error_at"),
        )


def get_cac40_cache_lock():
    """Get CAC40 cache async lock."""
    return _cac40_cache_lock


def get_sbf120_cache_lock():
    """Get SBF120 cache async lock."""
    return _sbf120_cache_lock


def get_cac40_cache() -> dict[str, Any]:
    """Get CAC40 cache dictionary."""
    return _cac40_cache


def get_sbf120_cache() -> dict[str, Any]:
    """Get SBF120 cache dictionary."""
    return _sbf120_cache
