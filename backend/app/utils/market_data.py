"""
Utility functions for market data processing and safe type conversions.
"""
from typing import Any


def safe_float(value: Any) -> float | None:
    """Safely convert value to float, returning None on error."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def safe_int(value: Any) -> int | None:
    """Safely convert value to int, returning None on error."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
