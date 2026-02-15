from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any

import sqlite3

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from .database import DB_PATH

OBJECTIF_PATTERN = re.compile(
    r"Objectif de cours 3 mois\s*:\s*([0-9\s\u00a0]+,[0-9]+)\s*([A-Z]{3})\s*-\s*Potentiel:\s*([+-]?[0-9\s\u00a0]+,[0-9]+)%",
    re.MULTILINE,
)
CONSENSUS_DATE_PATTERN = re.compile(
    r"Consensus des analystes au\s+(\d{2}/\d{2}/\d{2,4})",
    re.MULTILINE,
)


@dataclass
class HoldingRecord:
    id: int
    symbol: str
    name: str | None
    href: str | None


@dataclass
class AnalysisResult:
    holding_id: int
    symbol: str
    name: str | None
    href: str | None
    status: str
    message: str | None = None
    objective_3m: float | None = None
    currency: str | None = None
    potential_pct: float | None = None
    consensus_date: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        if self.objective_3m is not None or self.potential_pct is not None:
            payload["projection"] = {
                "expected_progress_pct_3m": self.potential_pct,
                "target_price_3m": self.objective_3m,
                "currency": self.currency,
            }
        return payload


def _normalize_spaces(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split())


def _parse_fr_number(value: str) -> float | None:
    if not value:
        return None
    cleaned = value.replace("\u00a0", " ").replace(" ", "").replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def _parse_consensus_date(text: str) -> str | None:
    match = CONSENSUS_DATE_PATTERN.search(text)
    if not match:
        return None
    raw = match.group(1)
    try:
        if len(raw.split("/")[-1]) == 2:
            return datetime.strptime(raw, "%d/%m/%y").date().isoformat()
        return datetime.strptime(raw, "%d/%m/%Y").date().isoformat()
    except ValueError:
        return raw


def _extract_objectif(text: str) -> tuple[float | None, str | None, float | None]:
    match = OBJECTIF_PATTERN.search(text)
    if not match:
        return None, None, None
    objective_raw = match.group(1)
    currency = match.group(2)
    potential_raw = match.group(3)
    objective = _parse_fr_number(objective_raw)
    potential = _parse_fr_number(potential_raw)
    return objective, currency, potential


def _load_holdings(db_path: Path) -> list[HoldingRecord]:
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found at {db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, symbol, name, href FROM holdings ORDER BY id ASC"
        ).fetchall()
        return [
            HoldingRecord(
                id=row["id"],
                symbol=row["symbol"],
                name=row["name"],
                href=row["href"],
            )
            for row in rows
        ]
    finally:
        conn.close()


def _is_boursorama_url(url: str) -> bool:
    lowered = url.lower()
    return "boursorama.com" in lowered and "/cours/" in lowered


def analyze_holding(page, holding: HoldingRecord, timeout_ms: int) -> AnalysisResult:
    if not holding.href:
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="missing_href",
            message="No finance link saved for holding",
        )
    if not _is_boursorama_url(holding.href):
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="unsupported_source",
            message="Holding link is not a Boursorama course URL",
        )

    try:
        page.goto(holding.href, wait_until="domcontentloaded", timeout=timeout_ms)
        page.wait_for_load_state("networkidle", timeout=timeout_ms)
        page.wait_for_selector("text=Objectif de cours 3 mois", timeout=timeout_ms)
    except PlaywrightTimeoutError:
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="timeout",
            message="Timed out waiting for Boursorama target",
        )
    except Exception as exc:  # noqa: BLE001
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="error",
            message=str(exc),
        )

    body_text = _normalize_spaces(page.inner_text("body"))
    objective, currency, potential = _extract_objectif(body_text)
    consensus_date = _parse_consensus_date(body_text)

    if objective is None and potential is None:
        return AnalysisResult(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            href=holding.href,
            status="not_found",
            message="Objectif de cours 3 mois not found on page",
        )

    return AnalysisResult(
        holding_id=holding.id,
        symbol=holding.symbol,
        name=holding.name,
        href=holding.href,
        status="ok",
        objective_3m=objective,
        currency=currency,
        potential_pct=potential,
        consensus_date=consensus_date,
    )


def run(output_path: Path, limit: int | None, timeout_ms: int, headless: bool) -> None:
    holdings = _load_holdings(DB_PATH)
    if limit:
        holdings = holdings[:limit]

    results: list[AnalysisResult] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(timeout_ms)

        for holding in holdings:
            result = analyze_holding(page, holding, timeout_ms)
            results.append(result)

        context.close()
        browser.close()

    payload = {
        "generated_at": datetime.utcnow().isoformat(),
        "source": "boursorama",
        "items": [result.to_json() for result in results],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyze Boursorama holdings and extract 3-month target (Objectif de cours 3 mois)."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("backend/boursorama_forecast.json"),
        help="Output JSON file path",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of holdings to analyze",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=15000,
        help="Timeout in milliseconds for each page load",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run browser in headed mode",
    )

    args = parser.parse_args()
    run(args.output, args.limit, args.timeout, headless=not args.headed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
