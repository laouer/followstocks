from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any

import warnings

import yfinance as yf

from .database import DB_PATH, ensure_holdings_columns


@dataclass
class HoldingRecord:
    id: int
    symbol: str
    name: str | None
    href: str | None
    price_tracker: str | None


@dataclass
class AnalysisResult:
    holding_id: int
    symbol: str
    name: str | None
    href: str | None
    status: str
    message: str | None = None
    target_low: float | None = None
    target_mean: float | None = None
    target_high: float | None = None

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        if self.target_low is not None or self.target_mean is not None or self.target_high is not None:
            payload["targets"] = {
                "min": self.target_low,
                "mean": self.target_mean,
                "max": self.target_high,
            }
        return payload


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _load_holdings(db_path: Path) -> list[HoldingRecord]:
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found at {db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, symbol, name, href, price_tracker FROM holdings ORDER BY id ASC"
        ).fetchall()
        return [
            HoldingRecord(
                id=row["id"],
                symbol=row["symbol"],
                name=row["name"],
                href=row["href"],
                price_tracker=row["price_tracker"],
            )
            for row in rows
        ]
    finally:
        conn.close()


def _is_yahoo_holding(holding: HoldingRecord) -> bool:
    tracker = (holding.price_tracker or "yahoo").lower()
    if tracker == "yahoo":
        return True
    if holding.href and "finance.yahoo.com" in holding.href.lower():
        return True
    return False


def analyze_holding(holding: HoldingRecord) -> AnalysisResult:
    if not holding.symbol:
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="missing_symbol",
            message="No symbol available for holding",
        )
    if not _is_yahoo_holding(holding):
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="unsupported_source",
            message="Holding is not tagged for Yahoo Finance",
        )

    try:
        info = yf.Ticker(holding.symbol).get_info()
    except Exception as exc:  # noqa: BLE001
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="error",
            message=str(exc),
        )

    if not isinstance(info, dict):
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="error",
            message="Yahoo Finance returned invalid data",
        )

    target_low = _safe_float(info.get("targetLowPrice"))
    target_mean = _safe_float(info.get("targetMeanPrice"))
    target_high = _safe_float(info.get("targetHighPrice"))

    if target_low is None and target_mean is None and target_high is None:
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="not_found",
            message="No analyst targets available",
        )

    return AnalysisResult(
        holding_id=holding.id,
        symbol=holding.symbol,
        name=holding.name,
        href=holding.href,
        status="ok",
        target_low=target_low,
        target_mean=target_mean,
        target_high=target_high,
    )


def _store_target_results(db_path: Path, results: list[AnalysisResult], parsed_at: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        for result in results:
            if result.status != "ok":
                continue
            conn.execute(
                """
                UPDATE holdings
                SET yahoo_target_low = ?,
                    yahoo_target_mean = ?,
                    yahoo_target_high = ?,
                    yahoo_target_parsed_at = ?
                WHERE id = ?
                """,
                (
                    result.target_low,
                    result.target_mean,
                    result.target_high,
                    parsed_at,
                    result.holding_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def run(output_path: Path, limit: int | None) -> None:
    _suppress_yfinance_warnings()
    ensure_holdings_columns()
    holdings = _load_holdings(DB_PATH)
    if limit:
        holdings = holdings[:limit]

    results = [analyze_holding(holding) for holding in holdings]
    parsed_at = datetime.utcnow().isoformat()
    _store_target_results(DB_PATH, results, parsed_at)

    payload = {
        "generated_at": datetime.utcnow().isoformat(),
        "source": "yahoo_finance",
        "items": [result.to_json() for result in results],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyze Yahoo Finance holdings and extract analyst targets (min/mean/max)."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("backend/yahoo_targets.json"),
        help="Output JSON file path",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of holdings to analyze",
    )

    args = parser.parse_args()
    run(args.output, args.limit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def _suppress_yfinance_warnings() -> None:
    try:
        from pandas.errors import Pandas4Warning

        warnings.filterwarnings("ignore", category=Pandas4Warning)
    except Exception:
        warnings.filterwarnings("ignore", message="Timestamp.utcnow is deprecated")
