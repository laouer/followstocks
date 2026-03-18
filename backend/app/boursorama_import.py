from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import auth, crud, models, schemas
from .boursorama_cash_sync import capture_session_state, get_session_status
from .core.config import BOURSORAMA_LOGIN_URL
from .database import SessionLocal

LOGIN_URL_HINTS = ("connexion", "/login", "mot-de-passe-oublie")
BOURSORAMA_HOME_URL = "https://clients.boursobank.com/"
LOGIN_TEXT_HINTS = (
    "mot de passe",
    "identifiant",
    "se connecter",
    "connexion",
    "code de securite",
    "valider mon appareil",
)
MONEY_RE = re.compile(
    r"(?:(?P<prefix>EUR|USD|CHF|GBP|€|\$|£)\s*)?"
    r"(?P<amount>[+-]?\d{1,3}(?:[ \u00a0]\d{3})*(?:,\d{2})?|[+-]?\d+(?:,\d{2})?)"
    r"(?:\s*(?P<suffix>EUR|USD|CHF|GBP|€|\$|£))?",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"[+-]?\d{1,3}(?:[ \u00a0]\d{3})*(?:,\d+)?|[+-]?\d+(?:,\d+)?")
PERCENT_RE = re.compile(r"[+-]?\d+(?:,\d+)?%")
SECURITY_ACCOUNT_TYPES = {"PEA", "PEA-PME", "Compte titres"}
PLACEMENT_ACCOUNT_TYPES = {
    "Assurance vie",
    "Livret A",
    "LDDS",
    "PEL",
    "CEL",
    "Compte a terme",
    "PER",
}
CASH_ACCOUNT_TYPES = {"Compte courant", "Compte bancaire"}
ACCOUNT_TYPE_RULES = (
    ("PEA-PME", ("pea pme", "pea-pme")),
    ("PEA", ("pea",)),
    ("Compte titres", ("ord", "cto", "compte titres", "compte-titres", "compte bourse")),
    ("Assurance vie", ("assurance vie",)),
    ("Livret A", ("livret a",)),
    ("LDDS", ("ldds", "ldd")),
    ("PEL", ("pel",)),
    ("CEL", ("cel",)),
    ("Compte a terme", ("compte a terme", "compte a terme", "cat")),
    ("PER", ("per",)),
    ("Compte courant", ("compte courant", "compte joint", "carte", "banque", "cb")),
    ("Compte bancaire", ("compte bancaire",)),
)
CASH_KEYWORDS = (
    "especes",
    "liquidites",
    "solde especes",
    "disponibilites",
    "disponible",
)
TOTAL_KEYWORDS = (
    "valorisation",
    "encours",
    "montant total",
    "solde",
    "total",
    "portefeuille",
)


@dataclass
class MoneyValue:
    amount: float
    currency: str


@dataclass
class ImportHolding:
    symbol: str
    name: str
    shares: float
    cost_basis: float
    currency: str
    tracker_symbol: str | None = None
    href: str | None = None
    last_price: float | None = None
    market_value: float | None = None
    price_tracker: str = "boursorama"
    asset_type: str | None = None


@dataclass
class ImportPlacement:
    name: str
    placement_type: str
    current_value: float
    currency: str
    notes: str | None = None


@dataclass
class DiscoveredAccount:
    name: str
    account_type: str | None
    kind: str
    page_url: str
    liquidity: float = 0.0
    liquidity_currency: str = "EUR"
    total_value: float | None = None
    total_currency: str = "EUR"
    holdings: list[ImportHolding] = field(default_factory=list)
    placements: list[ImportPlacement] = field(default_factory=list)
    reference: str | None = None
    source_hint: str | None = None
    detail_url: str | None = None


@dataclass
class AccountImportResult:
    name: str
    account_type: str | None
    kind: str
    account_id: int
    holdings_created: int = 0
    holdings_updated: int = 0
    placements_created: int = 0
    placements_updated: int = 0
    liquidity: float = 0.0
    page_url: str | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class ImportSummary:
    user_id: int
    user_email: str
    session_captured: bool
    imported_at: str
    accounts_created: int
    accounts_updated: int
    holdings_created: int
    holdings_updated: int
    placements_created: int
    placements_updated: int
    history_captured: bool
    discovered_accounts: int
    results: list[AccountImportResult] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class BrowserUseHoldingOutput(BaseModel):
    name: str
    symbol: str | None = None
    tracker_symbol: str | None = None
    shares: float | None = None
    cost_basis: float | None = None
    currency: str | None = "EUR"
    href: str | None = None
    last_price: float | None = None
    market_value: float | None = None
    asset_type: str | None = None


class BrowserUsePlacementOutput(BaseModel):
    name: str
    placement_type: str | None = None
    current_value: float | None = None
    currency: str | None = "EUR"
    notes: str | None = None


class BrowserUseAccountOutput(BaseModel):
    name: str
    account_type: str | None = None
    kind: str | None = None
    reference: str | None = None
    page_url: str | None = None
    detail_url: str | None = None
    liquidity: float | None = None
    liquidity_currency: str | None = "EUR"
    total_value: float | None = None
    total_currency: str | None = "EUR"
    holdings: list[BrowserUseHoldingOutput] = Field(default_factory=list)
    placements: list[BrowserUsePlacementOutput] = Field(default_factory=list)
    source_hint: str | None = None
    notes: list[str] = Field(default_factory=list)


class BrowserUseDiscoveryOutput(BaseModel):
    accounts: list[BrowserUseAccountOutput] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


def _normalize_spaces(value: str) -> str:
    return " ".join(str(value or "").replace("\u00a0", " ").split())


def _fold_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", _normalize_spaces(value))
    return "".join(ch for ch in normalized if not unicodedata.combining(ch)).casefold()


def _currency_code(prefix: str | None, suffix: str | None) -> str | None:
    token = (suffix or prefix or "").strip().upper()
    if token == "€":
        return "EUR"
    if token == "$":
        return "USD"
    if token == "£":
        return "GBP"
    return token or None


def _extract_all_money(text: str, require_currency: bool = True) -> list[MoneyValue]:
    values: list[MoneyValue] = []
    for match in MONEY_RE.finditer(text or ""):
        currency = _currency_code(match.group("prefix"), match.group("suffix"))
        if require_currency and not currency:
            continue
        raw_amount = match.group("amount")
        if not raw_amount:
            continue
        try:
            amount = float(raw_amount.replace("\u00a0", " ").replace(" ", "").replace(",", "."))
        except ValueError:
            continue
        values.append(MoneyValue(amount=amount, currency=currency or "EUR"))
    return values


def _first_money(text: str, require_currency: bool = True) -> MoneyValue | None:
    values = _extract_all_money(text, require_currency=require_currency)
    return values[0] if values else None


def _parse_number(text: str) -> float | None:
    clean = _normalize_spaces(text)
    if not clean or PERCENT_RE.search(clean):
        return None
    match = NUMBER_RE.search(clean)
    if not match:
        return None
    try:
        return float(match.group(0).replace("\u00a0", " ").replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def _extract_named_money(lines: list[str], keywords: tuple[str, ...]) -> MoneyValue | None:
    candidates: list[MoneyValue] = []
    for index, line in enumerate(lines):
        folded = _fold_text(line)
        if not any(keyword in folded for keyword in keywords):
            continue
        for probe in range(index, min(index + 3, len(lines))):
            candidates.extend(_extract_all_money(lines[probe]))
    if not candidates:
        return None
    return max(candidates, key=lambda item: abs(item.amount))


def _extract_reference(text: str) -> str | None:
    digits = "".join(ch for ch in str(text or "") if ch.isdigit())
    if len(digits) >= 4:
        return digits[-4:]
    return None


def _normalize_account_type(text: str | None) -> str | None:
    folded = _fold_text(text or "")
    for account_type, patterns in ACCOUNT_TYPE_RULES:
        if any(pattern in folded for pattern in patterns):
            return account_type
    return None


def _classify_account_kind(account_type: str | None) -> str:
    if account_type in SECURITY_ACCOUNT_TYPES:
        return "security"
    if account_type in PLACEMENT_ACCOUNT_TYPES:
        return "placement"
    if account_type in CASH_ACCOUNT_TYPES:
        return "cash"
    return "unknown"


def _build_account_name(raw_text: str, account_type: str | None, fallback_index: int) -> str:
    clean = MONEY_RE.sub(" ", raw_text or "")
    clean = _normalize_spaces(clean)
    reference = _extract_reference(clean)
    if account_type:
        if reference:
            return f"{account_type} {reference}"
        if clean and _fold_text(clean) != _fold_text(account_type):
            return clean[:120]
        return account_type
    if clean:
        return clean[:120]
    return f"Boursorama account {fallback_index}"


def _looks_like_login_url(url: str) -> bool:
    lowered = (url or "").casefold()
    return any(hint in lowered for hint in LOGIN_URL_HINTS)


def _safe_body_text(page) -> str:
    try:
        return page.locator("body").inner_text()
    except Exception:  # noqa: BLE001
        return ""


def _debug_enabled() -> bool:
    return os.getenv("BOURSORAMA_DEBUG", "").strip().lower() not in {"", "0", "false", "no"}


def _debug(message: str) -> None:
    if _debug_enabled():
        print(f"[boursorama-import] {message}", file=sys.stderr)


def _has_visible_password_input(page) -> bool:
    selectors = (
        "input[type='password']",
        "input[name*='password' i]",
        "input[autocomplete='current-password']",
    )
    for selector in selectors:
        try:
            if page.locator(selector).count() > 0:
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def _page_looks_like_login(page, url: str, body_text: str | None = None) -> bool:
    if _has_visible_password_input(page):
        return True
    folded = _fold_text(body_text or _safe_body_text(page))
    login_text_hits = sum(1 for hint in LOGIN_TEXT_HINTS if hint in folded)
    if login_text_hits >= 2:
        return True
    if _looks_like_login_url(url) and login_text_hits >= 1:
        return True
    return False


def _wait_for_page(page, timeout_ms: int, label: str = "page") -> None:
    body_timeout = max(1000, min(timeout_ms, 2_500))
    settle_timeout = max(500, min(timeout_ms, 3_000))
    _debug(f"{label}: wait_for_selector(body) start timeout_ms={body_timeout}")
    try:
        page.wait_for_selector("body", state="attached", timeout=body_timeout)
        _debug(f"{label}: wait_for_selector(body) done")
    except Exception:  # noqa: BLE001
        _debug(f"{label}: wait_for_selector(body) failed")
    try:
        _debug(f"{label}: wait_for_load_state(networkidle) start timeout_ms={settle_timeout}")
        page.wait_for_load_state("networkidle", timeout=settle_timeout)
        _debug(f"{label}: wait_for_load_state(networkidle) done")
    except Exception:  # noqa: BLE001
        _debug(f"{label}: wait_for_load_state(networkidle) timed out or failed")
    sleep_seconds = 0.35
    _debug(f"{label}: sleep start seconds={sleep_seconds}")
    time.sleep(sleep_seconds)
    _debug(f"{label}: sleep done seconds={sleep_seconds}")


def _context_root_url(url: str) -> str | None:
    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}/"


def _candidate_urls(*urls: str | None) -> list[str]:
    seen: set[str] = set()
    values: list[str] = []
    for raw_url in urls:
        clean = str(raw_url or "").strip()
        if not clean:
            continue
        if clean not in seen:
            seen.add(clean)
            values.append(clean)
        root_url = _context_root_url(clean)
        if root_url and root_url not in seen:
            seen.add(root_url)
            values.append(root_url)
    return values


def _open_best_authenticated_page(context, timeout_ms: int, *urls: str | None):
    last_body = ""
    last_url = ""
    for candidate_url in _candidate_urls(*urls):
        page = context.new_page()
        page.set_default_timeout(timeout_ms)
        try:
            _debug(f"root candidate open: {candidate_url}")
            page.goto(candidate_url, wait_until="domcontentloaded", timeout=timeout_ms)
            _wait_for_page(page, timeout_ms, label="root")
            current_url = page.url
            body_text = _safe_body_text(page)
            last_url = current_url
            last_body = body_text
            if not _page_looks_like_login(page, current_url, body_text):
                return page
        except Exception:  # noqa: BLE001
            pass
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass
    raise RuntimeError(
        "Unable to open an authenticated Boursorama page with the saved session."
        if not last_url
        else "Saved Boursorama session appears to have expired."
    )


def _resolve_landing_url(user_id: int) -> str:
    session = get_session_status(user_id)
    metadata_path = Path(session.metadata_path)
    if metadata_path.exists():
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            landing_url = str(payload.get("landing_url") or "").strip()
            if landing_url:
                return landing_url
        except Exception:  # noqa: BLE001
            pass
    return BOURSORAMA_LOGIN_URL


def _dump_page(path: Path, *, url: str, title: str, body_text: str, html: str, anchors: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_suffix(".json").write_text(
        json.dumps(
            {
                "url": url,
                "title": title,
                "body_lines": [_normalize_spaces(line) for line in body_text.splitlines() if _normalize_spaces(line)],
                "anchors": anchors,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    path.with_suffix(".html").write_text(html, encoding="utf-8")


def _collect_page_anchors(page) -> list[dict[str, str]]:
    anchors = page.evaluate(
        """() => Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
            href: anchor.href || '',
            text: (anchor.innerText || anchor.textContent || '').trim(),
        }))"""
    )
    results: list[dict[str, str]] = []
    for item in anchors or []:
        href = str(item.get("href") or "").strip()
        text = _normalize_spaces(item.get("text") or "")
        if not href or href.startswith("javascript:"):
            continue
        results.append({"href": href, "text": text})
    return results


def _normalize_currency(value: str | None, fallback: str = "EUR") -> str:
    token = str(value or "").strip().upper()
    if token in {"EUR", "USD", "CHF", "GBP"}:
        return token
    if token == "€":
        return "EUR"
    if token == "$":
        return "USD"
    if token == "£":
        return "GBP"
    return fallback


def _normalize_url(value: str | None) -> str | None:
    clean = str(value or "").strip()
    if not clean:
        return None
    if clean.startswith(("http://", "https://")):
        return clean
    return urljoin(BOURSORAMA_HOME_URL, clean)


def _normalize_browser_use_kind(kind: str | None, account_type: str | None) -> str:
    folded = _fold_text(kind or "")
    if folded in {"cash", "liquidites", "liquidity"}:
        return "cash"
    if folded in {"placement", "savings", "saving"}:
        return "placement"
    if folded in {"security", "securities", "titres", "portfolio"}:
        return "security"
    if folded in {"unknown", ""}:
        return _classify_account_kind(account_type)
    return _classify_account_kind(account_type)


def _configure_browser_use_env() -> Path:
    config_dir = Path(__file__).resolve().parents[1] / "private" / "browseruse"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "profiles").mkdir(parents=True, exist_ok=True)
    (config_dir / "extensions").mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("BROWSER_USE_CONFIG_DIR", str(config_dir))
    os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
    return config_dir


def _build_browser_use_llm():
    _configure_browser_use_env()
    try:
        from browser_use import ChatAzureOpenAI, ChatOpenAI
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            "browser-use is not installed. Run `pipenv install browser-use` inside backend/ first."
        ) from exc

    azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
    azure_api_key = os.getenv("AZURE_OPENAI_API_KEY", os.getenv("AZURE_OPENAI_KEY", "")).strip()
    azure_api_version = os.getenv("AZURE_OPENAI_API_VERSION", "").strip() or None
    azure_deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "").strip() or None
    explicit_model = os.getenv("BOURSORAMA_BROWSER_USE_MODEL", "").strip()
    raw_model = explicit_model or os.getenv("OPENAI_MODEL", "gpt-4.1-mini").strip()
    model = raw_model or "gpt-4.1-mini"
    openai_base_url = os.getenv("OPENAI_BASE_URL", os.getenv("OPENAI_API_BASE", "")).strip()

    if azure_endpoint and azure_api_key:
        kwargs: dict[str, Any] = {
            "model": model,
            "api_key": azure_api_key,
            "azure_endpoint": azure_endpoint,
            "temperature": 0,
        }
        if azure_api_version:
            kwargs["api_version"] = azure_api_version
        if azure_deployment:
            kwargs["azure_deployment"] = azure_deployment
        _debug(f"browser-use llm provider=azure model={model} endpoint={azure_endpoint}")
        return ChatAzureOpenAI(**kwargs)

    kwargs = {
        "model": model,
        "temperature": 0,
    }
    openai_api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if openai_api_key:
        kwargs["api_key"] = openai_api_key
    if openai_base_url:
        kwargs["base_url"] = openai_base_url
    _debug(
        "browser-use llm provider=openai-compatible "
        f"model={model} base_url={openai_base_url or 'default'}"
    )
    return ChatOpenAI(**kwargs)


def _build_browser_use_task() -> str:
    return (
        "You are extracting authenticated Boursorama/Boursobank account data for FollowStocks.\n"
        "Start at https://clients.boursobank.com/ and reuse the existing authenticated session.\n"
        "Rules:\n"
        "- Stay only on clients.boursobank.com and boursorama.com.\n"
        "- On the landing page, identify accounts from div.c-panel__body blocks only.\n"
        "- Create one output account per real financial account visible on the landing page.\n"
        "- Prefer dashboard values for totals and liquidity.\n"
        "- Open a detail page only when needed:\n"
        "  * the account is PEA, PEA-PME, ORD, CTO, or Compte titres\n"
        "  * or the landing panel does not expose enough money values.\n"
        "- Do not browse settings, profile, RIB, transfers, help, subscriptions, or logout.\n"
        "- For cash and savings accounts, stop after the landing panel unless a detail page is required to get the amount.\n"
        "- For securities accounts, extract holdings when visible with name, symbol or tracker symbol, shares, PRU/cost basis, last price, market value, currency, and href.\n"
        "- Preserve a differentiator in the account name or reference when multiple accounts share the same type.\n"
        "- Include page_url and detail_url when known.\n"
        "- Return exhaustive structured output and include warnings for anything ambiguous.\n"
    )


def _coerce_browser_use_output(history) -> BrowserUseDiscoveryOutput:
    structured_output = getattr(history, "structured_output", None)
    if structured_output is None and hasattr(history, "final_result"):
        structured_output = history.final_result()
    if structured_output is None:
        errors = [str(item) for item in (history.errors() if hasattr(history, "errors") else []) if item]
        if errors:
            raise RuntimeError(f"browser-use did not return structured output. Last agent error: {errors[-1]}")
        raise RuntimeError("browser-use did not return structured output.")
    if isinstance(structured_output, BrowserUseDiscoveryOutput):
        return structured_output
    if isinstance(structured_output, str):
        return BrowserUseDiscoveryOutput.model_validate_json(structured_output)
    return BrowserUseDiscoveryOutput.model_validate(structured_output)


def _browser_use_holding_to_import(item: BrowserUseHoldingOutput) -> ImportHolding | None:
    shares = float(item.shares or 0.0)
    if shares <= 0:
        return None
    href = _normalize_url(item.href)
    tracker_symbol = item.tracker_symbol or _extract_tracker_symbol_from_href(href)
    market_value = float(item.market_value) if item.market_value is not None else None
    last_price = float(item.last_price) if item.last_price is not None else None
    cost_basis = float(item.cost_basis) if item.cost_basis is not None else None
    if cost_basis is None and last_price is not None and last_price > 0:
        cost_basis = last_price
    if cost_basis is None and market_value is not None and shares > 0:
        cost_basis = market_value / shares
    if cost_basis is None or cost_basis <= 0:
        return None

    name = _normalize_spaces(item.name or tracker_symbol or "Boursorama holding")
    currency = _normalize_currency(item.currency)
    return ImportHolding(
        symbol=_sanitize_symbol(item.symbol or tracker_symbol, name),
        name=name,
        shares=shares,
        cost_basis=cost_basis,
        currency=currency,
        tracker_symbol=tracker_symbol,
        href=href,
        last_price=last_price,
        market_value=market_value,
        asset_type=_normalize_spaces(item.asset_type or "") or None,
    )


def _browser_use_placement_to_import(
    item: BrowserUsePlacementOutput,
    *,
    fallback_name: str,
    fallback_type: str | None,
    fallback_currency: str,
) -> ImportPlacement | None:
    current_value = float(item.current_value or 0.0)
    if current_value <= 0:
        return None
    return ImportPlacement(
        name=_normalize_spaces(item.name or fallback_name),
        placement_type=_normalize_spaces(item.placement_type or fallback_type or "Placement"),
        current_value=current_value,
        currency=_normalize_currency(item.currency, fallback_currency),
        notes=_normalize_spaces(item.notes or "") or None,
    )


def _finalize_discovered_account(account: DiscoveredAccount) -> DiscoveredAccount:
    if account.kind == "unknown":
        if account.holdings:
            account.kind = "security"
        elif account.total_value is not None and account.total_value > max(account.liquidity, 0.0):
            account.kind = "placement"
        elif account.total_value is not None:
            account.kind = "cash"

    if account.kind == "cash":
        account.total_value = account.liquidity if account.total_value is None else account.total_value
        account.total_currency = account.total_currency or account.liquidity_currency

    if account.kind == "placement" and not account.placements:
        current_value = account.total_value if account.total_value is not None else account.liquidity
        if current_value > 0:
            account.placements.append(
                ImportPlacement(
                    name=account.name,
                    placement_type=account.account_type or "Placement",
                    current_value=current_value,
                    currency=account.total_currency,
                    notes="Imported from browser-use structured output.",
                )
            )
            account.liquidity = 0.0

    if account.kind == "security" and not account.holdings and not account.placements and account.total_value is not None:
        invested_value = max(account.total_value - account.liquidity, 0.0)
        if invested_value > 0:
            account.placements.append(
                ImportPlacement(
                    name=f"{account.name} portfolio",
                    placement_type=account.account_type or "Placement",
                    current_value=invested_value,
                    currency=account.total_currency,
                    notes="Fallback aggregate value imported from browser-use structured output.",
                )
            )
    return account


def _browser_use_account_to_discovered(item: BrowserUseAccountOutput, fallback_index: int) -> DiscoveredAccount:
    raw_name = _normalize_spaces(item.name or "")
    account_type = _normalize_account_type(" ".join(filter(None, [item.account_type, raw_name, item.reference]))) or (
        _normalize_spaces(item.account_type or "") or None
    )
    reference = _normalize_spaces(item.reference or "") or _extract_reference(
        f"{raw_name} {item.page_url or ''} {item.detail_url or ''}"
    )
    name = raw_name or _build_account_name(" ".join(filter(None, [item.account_type or "", reference or ""])), account_type, fallback_index)
    if reference and account_type and _fold_text(name) == _fold_text(account_type):
        name = f"{account_type} {reference}"

    detail_url = _normalize_url(item.detail_url)
    page_url = _normalize_url(item.page_url) or detail_url or BOURSORAMA_HOME_URL
    liquidity_currency = _normalize_currency(item.liquidity_currency, _normalize_currency(item.total_currency))
    total_currency = _normalize_currency(item.total_currency, liquidity_currency)
    holdings = [holding for holding in (_browser_use_holding_to_import(entry) for entry in item.holdings) if holding is not None]
    placements = [
        placement
        for placement in (
            _browser_use_placement_to_import(
                entry,
                fallback_name=name,
                fallback_type=account_type,
                fallback_currency=total_currency,
            )
            for entry in item.placements
        )
        if placement is not None
    ]

    account = DiscoveredAccount(
        name=name,
        account_type=account_type,
        kind=_normalize_browser_use_kind(item.kind, account_type),
        page_url=page_url,
        liquidity=float(item.liquidity or 0.0),
        liquidity_currency=liquidity_currency,
        total_value=float(item.total_value) if item.total_value is not None else None,
        total_currency=total_currency,
        holdings=holdings,
        placements=placements,
        reference=reference,
        source_hint=_normalize_spaces(item.source_hint or raw_name) or None,
        detail_url=detail_url,
    )
    return _finalize_discovered_account(account)


def _dump_browser_use_history(history, output: BrowserUseDiscoveryOutput, dump_dir: Path) -> None:
    dump_dir.mkdir(parents=True, exist_ok=True)
    final_result = history.final_result() if hasattr(history, "final_result") else None
    payload = {
        "structured_output": output.model_dump(),
        "urls": history.urls() if hasattr(history, "urls") else [],
        "action_names": history.action_names() if hasattr(history, "action_names") else [],
        "errors": [str(item) for item in (history.errors() if hasattr(history, "errors") else []) if item],
        "final_result": final_result if isinstance(final_result, (dict, list, str, int, float, bool)) or final_result is None else str(final_result),
    }
    (dump_dir / "browser-use-history.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _collect_panel_payloads(page) -> list[dict[str, Any]]:
    panels = page.evaluate(
        """() => {
            const textOf = (node) => (node && (node.innerText || node.textContent || '') || '').replace(/\\s+/g, ' ').trim();
            return Array.from(document.querySelectorAll('div.c-panel__body')).map((panel, index) => {
                const root = panel.closest('.c-panel') || panel.parentElement || panel;
                const titleNode = root.querySelector('.c-panel__title, h1, h2, h3, h4, [class*="title"]');
                const anchors = Array.from(root.querySelectorAll('a[href]')).map((anchor) => ({
                    href: anchor.href || '',
                    text: textOf(anchor),
                })).filter((item) => item.href);
                return {
                    index,
                    title: textOf(titleNode),
                    panelText: textOf(panel),
                    rootText: textOf(root),
                    anchors,
                };
            });
        }"""
    )
    results: list[dict[str, Any]] = []
    for item in panels or []:
        title = _normalize_spaces(item.get("title") or "")
        panel_text = _normalize_spaces(item.get("panelText") or "")
        root_text = _normalize_spaces(item.get("rootText") or "")
        anchors = [
            {
                "href": str(anchor.get("href") or "").strip(),
                "text": _normalize_spaces(anchor.get("text") or ""),
            }
            for anchor in item.get("anchors") or []
            if str(anchor.get("href") or "").strip()
        ]
        if not panel_text and not title:
            continue
        results.append(
            {
                "title": title,
                "panel_text": panel_text,
                "root_text": root_text,
                "anchors": anchors,
            }
        )
    return results


def _select_detail_href(anchors: list[dict[str, str]], reference: str | None, account_type: str | None) -> str | None:
    banned_tokens = ("deconnexion", "profil", "parametre", "preference", "virement", "rib", "aide")
    preferred_tokens = ("detail", "voir", "acceder", "consulter", "portefeuille", "compte", "pea", "ord", "cto")
    preferred_patterns: list[str] = []
    if reference:
        preferred_patterns.append(reference)
    if account_type:
        preferred_patterns.append(_fold_text(account_type))

    best_href: str | None = None
    best_score = -1
    for anchor in anchors:
        href = str(anchor.get("href") or "").strip()
        text = _normalize_spaces(anchor.get("text") or "")
        if not href or href.startswith("javascript:"):
            continue
        folded = _fold_text(f"{text} {href}")
        if any(token in folded for token in banned_tokens):
            continue
        score = 0
        if href.startswith(BOURSORAMA_HOME_URL):
            score += 1
        if any(token in folded for token in preferred_tokens):
            score += 3
        if any(pattern and pattern in folded for pattern in preferred_patterns):
            score += 5
        if "/cours/" in href:
            score -= 2
        if score > best_score:
            best_score = score
            best_href = href
    return best_href


def _discover_account_links(page) -> list[dict[str, str | None]]:
    anchors = _collect_page_anchors(page)
    candidates: list[dict[str, str | None]] = []
    seen: set[str] = set()
    banned_tokens = ("deconnexion", "profil", "parametre", "preference", "virement", "rib", "aide")
    for anchor in anchors:
        combined = f"{anchor['text']} {anchor['href']}"
        account_type = _normalize_account_type(combined)
        folded = _fold_text(combined)
        if any(token in folded for token in banned_tokens):
            continue
        if account_type is None and "compte" not in folded:
            continue
        if account_type is None and _first_money(anchor["text"]) is None and _extract_reference(anchor["text"]) is None:
            continue
        href = anchor["href"]
        if href in seen:
            continue
        seen.add(href)
        candidates.append(
            {
                "href": href,
                "text": anchor["text"],
                "account_type": account_type,
                "reference": _extract_reference(anchor["text"]),
            }
        )
    return candidates


def _extract_headings(page) -> list[str]:
    headings = page.evaluate(
        """() => Array.from(document.querySelectorAll('h1,h2,h3')).map((node) => (
            (node.innerText || node.textContent || '').trim()
        ))"""
    )
    return [_normalize_spaces(item) for item in headings or [] if _normalize_spaces(item)]


def _extract_account_total(lines: list[str], account_type: str | None) -> MoneyValue | None:
    candidates: list[MoneyValue] = []
    candidates.extend(_extract_all_money("\n".join(lines[:20])))
    named = _extract_named_money(lines, TOTAL_KEYWORDS)
    if named:
        candidates.append(named)
    if account_type in SECURITY_ACCOUNT_TYPES:
        named_security = _extract_named_money(lines, ("portefeuille", "valorisation", "encours"))
        if named_security:
            candidates.append(named_security)
    if not candidates:
        return None
    return max(candidates, key=lambda item: abs(item.amount))


def _extract_liquidity(lines: list[str]) -> MoneyValue | None:
    named = _extract_named_money(lines, CASH_KEYWORDS)
    if named:
        return named
    return None


def _extract_tracker_symbol_from_href(href: str | None) -> str | None:
    if not href:
        return None
    match = re.search(r"/cours/([^/?#]+)/?", href)
    if not match:
        return None
    return match.group(1).strip() or None


def _sanitize_symbol(value: str | None, fallback_name: str) -> str:
    clean = _normalize_spaces(value or "").upper().replace(" ", "")
    clean = re.sub(r"[^A-Z0-9._-]", "", clean)
    if clean:
        return clean[:32]
    folded_name = _fold_text(fallback_name).upper()
    folded_name = re.sub(r"[^A-Z0-9]+", "", folded_name)
    return (folded_name or "BOURSORAMA")[:32]


def _parse_named_number(text: str, keywords: tuple[str, ...]) -> float | None:
    lines = [_normalize_spaces(line) for line in str(text or "").splitlines() if _normalize_spaces(line)]
    for index, line in enumerate(lines):
        folded = _fold_text(line)
        if not any(keyword in folded for keyword in keywords):
            continue
        number = _parse_number(line)
        if number is not None:
            return number
        for probe in range(index + 1, min(index + 3, len(lines))):
            number = _parse_number(lines[probe])
            if number is not None:
                return number
    return None


def _parse_named_money(text: str, keywords: tuple[str, ...]) -> MoneyValue | None:
    lines = [_normalize_spaces(line) for line in str(text or "").splitlines() if _normalize_spaces(line)]
    return _extract_named_money(lines, keywords)


def _find_row_container_payloads(page) -> list[dict[str, Any]]:
    payloads = page.evaluate(
        """() => {
            const textOf = (node) => (node && (node.innerText || node.textContent || '') || '').replace(/\\s+/g, ' ').trim();
            const linkNodes = Array.from(document.querySelectorAll("a[href*='/cours/']"));
            return linkNodes.map((link) => {
                let container = link;
                while (container && container !== document.body) {
                    const role = container.getAttribute && container.getAttribute('role');
                    if (['TR', 'LI', 'ARTICLE', 'SECTION'].includes(container.tagName) || role === 'row') {
                        break;
                    }
                    container = container.parentElement;
                }
                if (!container || container === document.body) {
                    container = link.parentElement || link;
                }
                const cells = Array.from(container.querySelectorAll("td,th,[role='cell'],[role='gridcell']")).map(textOf).filter(Boolean);
                const hrefs = Array.from(container.querySelectorAll("a[href]")).map((anchor) => ({
                    href: anchor.href || '',
                    text: textOf(anchor),
                })).filter((item) => item.href);
                return {
                    containerText: textOf(container),
                    primaryHref: link.href || '',
                    primaryText: textOf(link),
                    cells,
                    hrefs,
                };
            });
        }"""
    )
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in payloads or []:
        primary_href = str(item.get("primaryHref") or "").strip()
        container_text = _normalize_spaces(item.get("containerText") or "")
        key = f"{primary_href}|{container_text}"
        if not primary_href or key in seen or len(container_text) > 1200:
            continue
        seen.add(key)
        results.append(
            {
                "primary_href": primary_href,
                "primary_text": _normalize_spaces(item.get("primaryText") or ""),
                "container_text": container_text,
                "cells": [_normalize_spaces(cell) for cell in item.get("cells") or [] if _normalize_spaces(cell)],
                "hrefs": [
                    {
                        "href": str(link.get("href") or "").strip(),
                        "text": _normalize_spaces(link.get("text") or ""),
                    }
                    for link in item.get("hrefs") or []
                    if str(link.get("href") or "").strip()
                ],
            }
        )
    return results


def _choose_market_value(cells: list[str], container_text: str) -> MoneyValue | None:
    for source in cells:
        money = _parse_named_money(source, ("valorisation", "montant", "valeur", "solde"))
        if money:
            return money
    money_values: list[MoneyValue] = []
    for cell in cells:
        money_values.extend(_extract_all_money(cell))
    if not money_values:
        money_values.extend(_extract_all_money(container_text))
    if not money_values:
        return None
    return max(money_values, key=lambda item: abs(item.amount))


def _choose_last_price(cells: list[str], container_text: str, shares: float | None, market_value: MoneyValue | None) -> MoneyValue | None:
    for source in cells:
        money = _parse_named_money(source, ("cours", "dernier", "prix", "last"))
        if money:
            return money
    money_values: list[MoneyValue] = []
    for cell in cells:
        money_values.extend(_extract_all_money(cell))
    if shares and shares > 0 and market_value is not None:
        implied = market_value.amount / shares
        for item in money_values:
            if item.amount <= 0:
                continue
            if abs(item.amount - implied) / max(implied, 1.0) < 0.2:
                return item
        return MoneyValue(amount=implied, currency=market_value.currency)
    return money_values[0] if money_values else None


def _choose_cost_basis(cells: list[str], container_text: str, last_price: MoneyValue | None) -> MoneyValue | None:
    for source in cells:
        money = _parse_named_money(source, ("pru", "revient", "prix moyen"))
        if money:
            return money
    money_values: list[MoneyValue] = []
    for cell in cells:
        money_values.extend(_extract_all_money(cell))
    if last_price is not None:
        for item in money_values:
            if item.amount > 0 and abs(item.amount - last_price.amount) / max(last_price.amount, 1.0) > 0.02:
                return item
        return last_price
    return money_values[0] if money_values else None


def _choose_shares(cells: list[str], container_text: str) -> float | None:
    for source in cells:
        value = _parse_named_number(source, ("quantite", "nombre", "parts", "titres"))
        if value and value > 0:
            return value
    for cell in cells:
        if _first_money(cell):
            continue
        value = _parse_number(cell)
        if value and value > 0:
            return value
    return _parse_named_number(container_text, ("quantite", "nombre", "parts", "titres"))


def _parse_holding_payload(payload: dict[str, Any]) -> ImportHolding | None:
    primary_href = payload.get("primary_href")
    cells = payload.get("cells") or []
    container_text = payload.get("container_text") or ""
    tracker_symbol = _extract_tracker_symbol_from_href(primary_href)
    shares = _choose_shares(cells, container_text)
    market_value = _choose_market_value(cells, container_text)
    last_price = _choose_last_price(cells, container_text, shares, market_value)
    cost_basis = _choose_cost_basis(cells, container_text, last_price)
    if shares is None or shares <= 0:
        return None
    if last_price is None and market_value is None:
        return None

    name_candidates = [payload.get("primary_text") or ""]
    for link in payload.get("hrefs") or []:
        text = _normalize_spaces(link.get("text") or "")
        href = str(link.get("href") or "")
        if href == primary_href and text:
            name_candidates.insert(0, text)
        elif text and "/cours/" in href:
            name_candidates.append(text)
    name_candidates.extend(cells[:2])
    name = next((candidate for candidate in name_candidates if candidate and not _first_money(candidate, require_currency=False)), "")
    name = _normalize_spaces(name or tracker_symbol or "Boursorama holding")

    asset_type = None
    folded = _fold_text(container_text)
    if "etf" in folded:
        asset_type = "ETF"
    elif "track" in folded:
        asset_type = "Tracker"
    elif "opcvm" in folded or "fonds" in folded:
        asset_type = "Fund"
    else:
        asset_type = "Equity"

    final_price = last_price.amount if last_price is not None else (market_value.amount / shares if market_value else None)
    final_currency = (
        (last_price.currency if last_price else None)
        or (market_value.currency if market_value else None)
        or (cost_basis.currency if cost_basis else None)
        or "EUR"
    )
    final_cost_basis = cost_basis.amount if cost_basis is not None and cost_basis.amount > 0 else None
    if final_cost_basis is None and final_price is not None and final_price > 0:
        final_cost_basis = final_price
    if final_cost_basis is None:
        return None

    return ImportHolding(
        symbol=_sanitize_symbol(tracker_symbol, name),
        name=name,
        shares=shares,
        cost_basis=final_cost_basis,
        currency=final_currency,
        tracker_symbol=tracker_symbol,
        href=primary_href,
        last_price=final_price,
        market_value=market_value.amount if market_value else None,
        asset_type=asset_type,
    )


def _extract_holdings(page) -> list[ImportHolding]:
    holdings: list[ImportHolding] = []
    seen: set[tuple[str, str]] = set()
    for payload in _find_row_container_payloads(page):
        holding = _parse_holding_payload(payload)
        if holding is None:
            continue
        dedupe_key = (holding.tracker_symbol or "", holding.name.casefold())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        holdings.append(holding)
    return holdings


def _build_discovered_account(
    *,
    combined_text: str,
    primary_name_text: str,
    page_url: str,
    fallback_index: int,
    liquidity_money: MoneyValue | None,
    total_money: MoneyValue | None,
    holdings: list[ImportHolding] | None = None,
    detail_url: str | None = None,
    note: str | None = None,
) -> DiscoveredAccount:
    account_type = _normalize_account_type(combined_text)
    kind = _classify_account_kind(account_type)
    name = _build_account_name(primary_name_text, account_type, fallback_index)
    reference = _extract_reference(f"{primary_name_text} {combined_text} {page_url}")

    if kind == "cash":
        liquidity = liquidity_money.amount if liquidity_money else (total_money.amount if total_money else 0.0)
        total_value = liquidity
        total_currency = liquidity_money.currency if liquidity_money else (total_money.currency if total_money else "EUR")
    else:
        liquidity = liquidity_money.amount if liquidity_money else 0.0
        total_value = total_money.amount if total_money else None
        total_currency = total_money.currency if total_money else "EUR"

    holdings = holdings or []
    if kind == "unknown":
        if holdings:
            kind = "security"
        elif total_value is not None and total_value > 0 and abs(total_value - liquidity) <= 1e-6:
            kind = "cash"
        elif total_value is not None and total_value > max(liquidity, 0.0):
            kind = "placement"

    placements: list[ImportPlacement] = []
    if kind == "placement":
        current_value = total_value if total_value is not None else liquidity
        if current_value > 0:
            placements.append(
                ImportPlacement(
                    name=name,
                    placement_type=account_type or "Placement",
                    current_value=current_value,
                    currency=total_currency,
                    notes=note or "Imported from Boursorama account summary.",
                )
            )
            liquidity = 0.0
    elif kind == "security" and not holdings and total_value is not None:
        invested_value = max(total_value - liquidity, 0.0)
        if invested_value > 0 and not detail_url:
            placements.append(
                ImportPlacement(
                    name=f"{name} portfolio",
                    placement_type=account_type or "Placement",
                    current_value=invested_value,
                    currency=total_currency,
                    notes=note or "Fallback aggregate value imported because detailed holdings could not be parsed.",
                )
            )

    return DiscoveredAccount(
        name=name,
        account_type=account_type,
        kind=kind,
        page_url=page_url,
        liquidity=liquidity,
        liquidity_currency=liquidity_money.currency if liquidity_money else ("EUR" if kind != "cash" else total_currency),
        total_value=total_value,
        total_currency=total_currency,
        holdings=holdings,
        placements=placements,
        reference=reference,
        source_hint=_normalize_spaces(primary_name_text) or None,
        detail_url=detail_url,
    )


def _parse_account_panel(payload: dict[str, Any], fallback_index: int, page_url: str) -> DiscoveredAccount | None:
    title = _normalize_spaces(payload.get("title") or "")
    panel_text = _normalize_spaces(payload.get("panel_text") or "")
    root_text = _normalize_spaces(payload.get("root_text") or "")
    anchors = payload.get("anchors") or []
    combined_text = " ".join(part for part in [title, panel_text, root_text] if part)
    if not combined_text:
        return None

    account_type = _normalize_account_type(combined_text)
    reference = _extract_reference(combined_text)
    total_money = _extract_account_total([panel_text, root_text, title], account_type)
    liquidity_money = _extract_liquidity([panel_text, root_text, title])
    detail_url = _select_detail_href(anchors, reference, account_type)

    if account_type is None and total_money is None and liquidity_money is None:
        return None

    return _build_discovered_account(
        combined_text=combined_text,
        primary_name_text=" ".join(part for part in [title, panel_text[:80]] if part),
        page_url=page_url,
        fallback_index=fallback_index,
        liquidity_money=liquidity_money,
        total_money=total_money,
        detail_url=detail_url,
        note="Imported from Boursorama dashboard panel.",
    )


def _merge_discovered_account(base: DiscoveredAccount, detail: DiscoveredAccount) -> DiscoveredAccount:
    merged = DiscoveredAccount(
        name=base.name or detail.name,
        account_type=base.account_type or detail.account_type,
        kind=base.kind if base.kind != "unknown" else detail.kind,
        page_url=detail.page_url or base.page_url,
        liquidity=detail.liquidity if detail.liquidity > 0 or base.liquidity == 0 else base.liquidity,
        liquidity_currency=detail.liquidity_currency or base.liquidity_currency,
        total_value=detail.total_value if detail.total_value is not None else base.total_value,
        total_currency=detail.total_currency or base.total_currency,
        holdings=detail.holdings or base.holdings,
        placements=detail.placements or base.placements,
        reference=base.reference or detail.reference,
        source_hint=base.source_hint or detail.source_hint,
        detail_url=base.detail_url or detail.detail_url,
    )
    if merged.kind == "security" and not merged.holdings and merged.total_value is not None and not merged.placements:
        invested_value = max(merged.total_value - merged.liquidity, 0.0)
        if invested_value > 0:
            merged.placements.append(
                ImportPlacement(
                    name=f"{merged.name} portfolio",
                    placement_type=merged.account_type or "Placement",
                    current_value=invested_value,
                    currency=merged.total_currency,
                    notes="Fallback aggregate value imported because detailed holdings could not be parsed.",
                )
            )
    return merged


def _needs_detail_page(account: DiscoveredAccount) -> bool:
    if account.kind in {"security", "unknown"}:
        return True
    return account.total_value is None and account.liquidity <= 0 and bool(account.detail_url)


def _parse_account_page(page, hint: dict[str, str | None], fallback_index: int) -> DiscoveredAccount:
    body_text = _safe_body_text(page)
    lines = [_normalize_spaces(line) for line in body_text.splitlines() if _normalize_spaces(line)]
    headings = _extract_headings(page)
    combined_text = " ".join([hint.get("text") or "", " ".join(headings[:3]), " ".join(lines[:20])])
    hint_text = _normalize_spaces(hint.get("text") or "")
    detail_url = str(hint.get("href") or "").strip() or None
    account_type = _normalize_account_type(combined_text) or hint.get("account_type")
    kind = _classify_account_kind(account_type)
    total_money = _extract_account_total(lines, account_type)
    liquidity_money = _extract_liquidity(lines)
    holdings = _extract_holdings(page) if kind in {"security", "unknown"} else []
    return _build_discovered_account(
        combined_text=combined_text,
        primary_name_text=" ".join(filter(None, [hint_text, headings[0] if headings else ""])),
        page_url=page.url,
        fallback_index=fallback_index,
        liquidity_money=liquidity_money,
        total_money=total_money,
        holdings=holdings,
        detail_url=detail_url,
        note="Imported from Boursorama account detail page.",
    )


def _discover_accounts_from_boursorama(
    user_id: int,
    *,
    timeout_ms: int,
    headless: bool,
    dump_dir: Path | None,
) -> tuple[list[DiscoveredAccount], list[str]]:
    from playwright.sync_api import sync_playwright

    session = get_session_status(user_id)
    state_path = Path(session.state_path)
    if not state_path.exists():
        raise FileNotFoundError(f"No saved Boursorama session for user {user_id}. Run auth first.")

    warnings: list[str] = []
    landing_url = _resolve_landing_url(user_id)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        context = browser.new_context(storage_state=str(state_path), locale="fr-FR")
        root_page = _open_best_authenticated_page(
            context,
            timeout_ms,
            BOURSORAMA_HOME_URL,
            landing_url,
            BOURSORAMA_LOGIN_URL,
        )
        root_body = _safe_body_text(root_page)
        root_anchors = _collect_page_anchors(root_page)
        if dump_dir is not None:
            _dump_page(
                dump_dir / "landing",
                url=root_page.url,
                title=root_page.title(),
                body_text=root_body,
                html=root_page.content(),
                anchors=root_anchors,
            )

        discovered: list[DiscoveredAccount] = []
        seen_accounts: set[tuple[str, str | None]] = set()
        panel_payloads = _collect_panel_payloads(root_page)
        _debug(f"landing panel payloads={len(panel_payloads)} url={root_page.url}")

        panel_accounts: list[DiscoveredAccount] = []
        seen_panel_accounts: set[tuple[str, str | None]] = set()
        for index, payload in enumerate(panel_payloads, start=1):
            account = _parse_account_panel(payload, index, root_page.url)
            if account is None:
                continue
            dedupe_key = (
                account.name.casefold(),
                account.reference or account.detail_url or account.page_url,
            )
            if dedupe_key in seen_panel_accounts:
                continue
            seen_panel_accounts.add(dedupe_key)
            panel_accounts.append(account)

        _debug(f"landing parsed accounts={len(panel_accounts)}")

        if panel_accounts:
            for index, account in enumerate(panel_accounts, start=1):
                dedupe_key = (
                    account.name.casefold(),
                    account.reference or account.detail_url or account.page_url,
                )
                if not _needs_detail_page(account) or not account.detail_url:
                    if dedupe_key in seen_accounts:
                        continue
                    seen_accounts.add(dedupe_key)
                    discovered.append(account)
                    _debug(
                        "account "
                        f"{index}/{len(panel_accounts)} dashboard-only name={account.name} "
                        f"kind={account.kind} holdings={len(account.holdings)} "
                        f"placements={len(account.placements)}"
                    )
                    continue

                _debug(
                    "account "
                    f"{index}/{len(panel_accounts)} detail open start name={account.name} "
                    f"href={account.detail_url}"
                )
                page = context.new_page()
                page.set_default_timeout(timeout_ms)
                try:
                    page.goto(account.detail_url, wait_until="domcontentloaded", timeout=timeout_ms)
                    _wait_for_page(page, timeout_ms, label=f"account {index}")
                    if _page_looks_like_login(page, page.url):
                        warnings.append(f"Account page redirected to login: {account.detail_url}")
                        _debug(f"account {index}/{len(panel_accounts)} redirected to login")
                        if dedupe_key not in seen_accounts:
                            seen_accounts.add(dedupe_key)
                            discovered.append(account)
                        continue

                    detail_account = _parse_account_page(
                        page,
                        {
                            "text": account.source_hint or account.name,
                            "account_type": account.account_type,
                            "href": account.detail_url,
                        },
                        index,
                    )
                    discovered_account = _merge_discovered_account(account, detail_account)
                    merged_key = (
                        discovered_account.name.casefold(),
                        discovered_account.reference or discovered_account.detail_url or discovered_account.page_url,
                    )
                    if merged_key in seen_accounts:
                        _debug(f"account {index}/{len(panel_accounts)} duplicate skip name={discovered_account.name}")
                        continue
                    seen_accounts.add(merged_key)
                    discovered.append(discovered_account)
                    _debug(
                        "account "
                        f"{index}/{len(panel_accounts)} parsed name={discovered_account.name} "
                        f"kind={discovered_account.kind} holdings={len(discovered_account.holdings)} "
                        f"placements={len(discovered_account.placements)}"
                    )
                    if dump_dir is not None:
                        account_stem = (
                            re.sub(r"[^a-zA-Z0-9._-]+", "-", discovered_account.name.lower()).strip("-")
                            or f"account-{index}"
                        )
                        _dump_page(
                            dump_dir / account_stem,
                            url=page.url,
                            title=page.title(),
                            body_text=_safe_body_text(page),
                            html=page.content(),
                            anchors=_collect_page_anchors(page),
                        )
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"Failed to parse account page {account.detail_url}: {exc}")
                    _debug(f"account {index}/{len(panel_accounts)} failed exc={exc}")
                    if dedupe_key not in seen_accounts:
                        seen_accounts.add(dedupe_key)
                        discovered.append(account)
                finally:
                    try:
                        page.close()
                    except Exception:  # noqa: BLE001
                        pass
        else:
            account_links = _discover_account_links(root_page)
            _debug(f"fallback account link candidates={len(account_links)}")
            if not account_links:
                browser.close()
                raise RuntimeError("No Boursorama accounts were detected on the authenticated page.")

            for index, link in enumerate(account_links, start=1):
                href = str(link.get("href") or "").strip()
                if not href:
                    continue
                label = _normalize_spaces(link.get("text") or "") or href
                _debug(f"account {index}/{len(account_links)} fallback open start label={label} href={href}")
                page = context.new_page()
                page.set_default_timeout(timeout_ms)
                try:
                    page.goto(href, wait_until="domcontentloaded", timeout=timeout_ms)
                    _wait_for_page(page, timeout_ms, label=f"account {index}")
                    if _page_looks_like_login(page, page.url):
                        warnings.append(f"Account page redirected to login: {href}")
                        _debug(f"account {index}/{len(account_links)} redirected to login")
                        continue
                    discovered_account = _parse_account_page(page, link, index)
                    dedupe_key = (
                        discovered_account.name.casefold(),
                        discovered_account.reference or discovered_account.page_url,
                    )
                    if dedupe_key in seen_accounts:
                        _debug(f"account {index}/{len(account_links)} duplicate skip name={discovered_account.name}")
                        continue
                    seen_accounts.add(dedupe_key)
                    discovered.append(discovered_account)
                    _debug(
                        "account "
                        f"{index}/{len(account_links)} parsed name={discovered_account.name} "
                        f"kind={discovered_account.kind} holdings={len(discovered_account.holdings)} "
                        f"placements={len(discovered_account.placements)}"
                    )
                    if dump_dir is not None:
                        account_stem = (
                            re.sub(r"[^a-zA-Z0-9._-]+", "-", discovered_account.name.lower()).strip("-")
                            or f"account-{index}"
                        )
                        _dump_page(
                            dump_dir / account_stem,
                            url=page.url,
                            title=page.title(),
                            body_text=_safe_body_text(page),
                            html=page.content(),
                            anchors=_collect_page_anchors(page),
                        )
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"Failed to parse account page {href}: {exc}")
                    _debug(f"account {index}/{len(account_links)} failed exc={exc}")
                finally:
                    try:
                        page.close()
                    except Exception:  # noqa: BLE001
                        pass

        try:
            root_page.close()
        except Exception:  # noqa: BLE001
            pass
        browser.close()

    return discovered, warnings


async def _discover_accounts_with_browser_use_async(
    user_id: int,
    *,
    headless: bool,
    dump_dir: Path | None,
    max_steps: int,
) -> tuple[list[DiscoveredAccount], list[str]]:
    _configure_browser_use_env()
    try:
        from browser_use import Agent, Browser
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            "browser-use is not installed. Run `pipenv install browser-use` inside backend/ first."
        ) from exc

    session = get_session_status(user_id)
    state_path = Path(session.state_path)
    if not state_path.exists():
        raise FileNotFoundError(f"No saved Boursorama session for user {user_id}. Run auth first.")

    browser = Browser(
        headless=headless,
        storage_state=str(state_path),
        allowed_domains=["clients.boursobank.com", "*.boursorama.com"],
        enable_default_extensions=False,
        user_data_dir=tempfile.mkdtemp(prefix="tmp-browser-use-profile-"),
    )
    history = None
    try:
        agent = Agent(
            task=_build_browser_use_task(),
            llm=_build_browser_use_llm(),
            browser=browser,
            use_vision=False,
            output_model_schema=BrowserUseDiscoveryOutput,
            max_actions_per_step=2,
            max_failures=3,
            use_judge=False,
            use_thinking=False,
        )
        history = await agent.run(max_steps=max_steps)
        output = _coerce_browser_use_output(history)
        warnings = [_normalize_spaces(item) for item in output.warnings if _normalize_spaces(item)]
        if history is not None and hasattr(history, "errors"):
            warnings.extend(str(item) for item in history.errors() if item and str(item).strip())

        discovered: list[DiscoveredAccount] = []
        seen_accounts: set[tuple[str, str | None]] = set()
        for index, item in enumerate(output.accounts, start=1):
            account = _browser_use_account_to_discovered(item, index)
            dedupe_key = (
                account.name.casefold(),
                account.reference or account.detail_url or account.page_url,
            )
            if dedupe_key in seen_accounts:
                continue
            seen_accounts.add(dedupe_key)
            discovered.append(account)

        if dump_dir is not None and history is not None:
            _dump_browser_use_history(history, output, dump_dir)

        if not discovered:
            raise RuntimeError("browser-use completed but did not return any accounts.")
        return discovered, warnings
    finally:
        close = getattr(browser, "close", None)
        if close is not None:
            result = close()
            if inspect.isawaitable(result):
                await result


def _discover_accounts_with_browser_use(
    user_id: int,
    *,
    headless: bool,
    dump_dir: Path | None,
    max_steps: int,
) -> tuple[list[DiscoveredAccount], list[str]]:
    return asyncio.run(
        _discover_accounts_with_browser_use_async(
            user_id,
            headless=headless,
            dump_dir=dump_dir,
            max_steps=max_steps,
        )
    )


def _find_account(db: Session, user_id: int, name: str) -> models.Account | None:
    return (
        db.query(models.Account)
        .filter(models.Account.user_id == user_id, models.Account.name == name)
        .first()
    )


def _upsert_account(db: Session, user_id: int, discovered: DiscoveredAccount) -> tuple[models.Account, str]:
    account = _find_account(db, user_id, discovered.name)
    if account is None:
        account = models.Account(
            user_id=user_id,
            name=discovered.name,
            account_type=discovered.account_type,
            liquidity=discovered.liquidity if discovered.liquidity_currency == "EUR" else 0.0,
            manual_invested=0.0,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(account)
        db.flush()
        return account, "created"

    account.account_type = discovered.account_type or account.account_type
    if discovered.liquidity_currency == "EUR":
        account.liquidity = discovered.liquidity
    account.updated_at = datetime.utcnow()
    db.add(account)
    db.flush()
    return account, "updated"


def _find_existing_holding(
    db: Session,
    *,
    user_id: int,
    account_id: int,
    symbol: str,
    tracker_symbol: str | None,
) -> models.Holding | None:
    query = db.query(models.Holding).filter(
        models.Holding.user_id == user_id,
        models.Holding.account_id == account_id,
    )
    if tracker_symbol:
        existing = query.filter(models.Holding.tracker_symbol == tracker_symbol).first()
        if existing is not None:
            return existing
    return query.filter(models.Holding.symbol == symbol.upper()).first()


def _upsert_holding(
    db: Session,
    *,
    user_id: int,
    account_id: int,
    holding: ImportHolding,
) -> str:
    existing = _find_existing_holding(
        db,
        user_id=user_id,
        account_id=account_id,
        symbol=holding.symbol,
        tracker_symbol=holding.tracker_symbol,
    )
    now = datetime.utcnow()
    if existing is None:
        db.add(
            models.Holding(
                user_id=user_id,
                account_id=account_id,
                symbol=holding.symbol.upper(),
                price_tracker="boursorama",
                tracker_symbol=holding.tracker_symbol,
                shares=holding.shares,
                cost_basis=holding.cost_basis,
                acquisition_fee_value=0.0,
                currency=holding.currency,
                last_price=holding.last_price,
                last_snapshot_at=now if holding.last_price is not None else None,
                asset_type=holding.asset_type,
                name=holding.name,
                href=holding.href,
                created_at=now,
                updated_at=now,
            )
        )
        db.flush()
        return "created"

    existing.symbol = holding.symbol.upper()
    existing.price_tracker = "boursorama"
    existing.tracker_symbol = holding.tracker_symbol
    existing.shares = holding.shares
    existing.cost_basis = holding.cost_basis
    existing.currency = holding.currency
    existing.last_price = holding.last_price
    existing.last_snapshot_at = now if holding.last_price is not None else existing.last_snapshot_at
    existing.asset_type = holding.asset_type or existing.asset_type
    existing.name = holding.name or existing.name
    existing.href = holding.href or existing.href
    existing.updated_at = now
    db.add(existing)
    db.flush()
    return "updated"


def _find_existing_placement(db: Session, *, user_id: int, account_id: int | None, name: str) -> models.Placement | None:
    return (
        db.query(models.Placement)
        .filter(
            models.Placement.user_id == user_id,
            models.Placement.account_id == account_id,
            models.Placement.name == name,
        )
        .first()
    )


def _upsert_placement(
    db: Session,
    *,
    user_id: int,
    account_id: int | None,
    placement: ImportPlacement,
) -> str:
    existing = _find_existing_placement(db, user_id=user_id, account_id=account_id, name=placement.name)
    recorded_at = datetime.utcnow()
    if existing is None:
        crud.create_placement(
            db,
            user_id,
            schemas.PlacementCreate(
                account_id=account_id,
                name=placement.name,
                placement_type=placement.placement_type,
                currency=placement.currency,
                notes=placement.notes,
                initial_value=placement.current_value,
                recorded_at=recorded_at,
            ),
        )
        return "created"

    crud.update_placement(
        db,
        existing,
        schemas.PlacementUpdate(
            account_id=account_id,
            name=placement.name,
            placement_type=placement.placement_type,
            currency=placement.currency,
            notes=placement.notes,
        ),
    )
    crud.add_placement_snapshot(
        db,
        existing,
        schemas.PlacementSnapshotCreate(
            entry_kind="VALUE",
            value=placement.current_value,
            recorded_at=recorded_at,
        ),
    )
    return "updated"


def _import_discovered_accounts(db: Session, user: models.User, discovered_accounts: list[DiscoveredAccount]) -> ImportSummary:
    accounts_created = 0
    accounts_updated = 0
    holdings_created = 0
    holdings_updated = 0
    placements_created = 0
    placements_updated = 0
    results: list[AccountImportResult] = []
    warnings: list[str] = []

    for discovered in discovered_accounts:
        account, account_action = _upsert_account(db, user.id, discovered)
        if account_action == "created":
            accounts_created += 1
        else:
            accounts_updated += 1

        result = AccountImportResult(
            name=discovered.name,
            account_type=discovered.account_type,
            kind=discovered.kind,
            account_id=account.id,
            liquidity=account.liquidity or 0.0,
            page_url=discovered.page_url,
        )

        for holding in discovered.holdings:
            try:
                action = _upsert_holding(db, user_id=user.id, account_id=account.id, holding=holding)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Failed to import holding {holding.name} in {discovered.name}: {exc}")
                result.notes.append(f"Holding import failed for {holding.name}")
                continue
            if action == "created":
                holdings_created += 1
                result.holdings_created += 1
            else:
                holdings_updated += 1
                result.holdings_updated += 1

        for placement in discovered.placements:
            try:
                action = _upsert_placement(
                    db,
                    user_id=user.id,
                    account_id=account.id,
                    placement=placement,
                )
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Failed to import placement {placement.name} in {discovered.name}: {exc}")
                result.notes.append(f"Placement import failed for {placement.name}")
                continue
            if action == "created":
                placements_created += 1
                result.placements_created += 1
            else:
                placements_updated += 1
                result.placements_updated += 1

        if discovered.kind == "security" and not discovered.holdings and discovered.placements:
            result.notes.append("Imported fallback aggregate placement because detailed holdings were not parsed.")
        elif discovered.kind == "security" and not discovered.holdings:
            result.notes.append("No holdings were parsed from this security account.")

        results.append(result)

    db.commit()
    history_captured = False
    if discovered_accounts:
        crud.capture_daily_history(db, user.id)
        history_captured = True

    return ImportSummary(
        user_id=user.id,
        user_email=user.email,
        session_captured=False,
        imported_at=datetime.utcnow().isoformat(),
        accounts_created=accounts_created,
        accounts_updated=accounts_updated,
        holdings_created=holdings_created,
        holdings_updated=holdings_updated,
        placements_created=placements_created,
        placements_updated=placements_updated,
        history_captured=history_captured,
        discovered_accounts=len(discovered_accounts),
        results=results,
        warnings=warnings,
    )


def _resolve_user(
    db: Session,
    *,
    user_id: int | None,
    email: str | None,
    password: str | None,
    name: str | None,
) -> tuple[models.User, bool]:
    if user_id is not None:
        user = crud.get_user(db, user_id)
        if user is None:
            raise ValueError(f"FollowStocks user {user_id} does not exist.")
        return user, False

    clean_email = (email or "").strip().lower()
    if not clean_email:
        raise ValueError("Provide either --user-id or --email.")

    existing = crud.get_user_by_email(db, clean_email)
    if existing is not None:
        return existing, False

    if not password:
        raise ValueError("User does not exist. Provide --password to create it.")

    payload = schemas.UserCreate(email=clean_email, password=password, name=name)
    user = crud.create_user(db, payload, auth.hash_password(payload.password))
    return user, True


def _needs_session_refresh(exc: Exception) -> bool:
    message = _fold_text(str(exc))
    return (
        "session appears to have expired" in message
        or "saved boursorama session" in message
        or "redirected to login" in message
        or "authenticated boursorama page" in message
    )


def _reset_user_portfolio_data(db: Session, user_id: int) -> dict[str, int]:
    placement_snapshot_count = db.query(models.PlacementSnapshot).filter(
        models.PlacementSnapshot.placement_id.in_(
            db.query(models.Placement.id).filter(models.Placement.user_id == user_id)
        )
    ).delete(synchronize_session=False)
    holding_daily_snapshot_count = db.query(models.HoldingDailySnapshot).filter(
        models.HoldingDailySnapshot.user_id == user_id
    ).delete(synchronize_session=False)
    portfolio_daily_snapshot_count = db.query(models.PortfolioDailySnapshot).filter(
        models.PortfolioDailySnapshot.user_id == user_id
    ).delete(synchronize_session=False)
    placement_count = db.query(models.Placement).filter(models.Placement.user_id == user_id).delete(
        synchronize_session=False
    )
    holding_count = db.query(models.Holding).filter(models.Holding.user_id == user_id).delete(
        synchronize_session=False
    )
    transaction_count = db.query(models.Transaction).filter(models.Transaction.user_id == user_id).delete(
        synchronize_session=False
    )
    cash_transaction_count = db.query(models.CashTransaction).filter(
        models.CashTransaction.user_id == user_id
    ).delete(synchronize_session=False)
    account_count = db.query(models.Account).filter(models.Account.user_id == user_id).delete(
        synchronize_session=False
    )
    db.commit()
    return {
        "accounts": account_count,
        "holdings": holding_count,
        "placements": placement_count,
        "transactions": transaction_count,
        "cash_transactions": cash_transaction_count,
        "holding_daily_snapshots": holding_daily_snapshot_count,
        "portfolio_daily_snapshots": portfolio_daily_snapshot_count,
        "placement_snapshots": placement_snapshot_count,
    }


def run_import(
    *,
    user_id: int | None,
    email: str | None,
    password: str | None,
    name: str | None,
    capture_session: bool,
    timeout_ms: int,
    headless: bool,
    dump_dir: Path | None,
    engine: str,
    browser_use_max_steps: int,
    reset_user_data: bool,
) -> ImportSummary:
    with SessionLocal() as db:
        user, _created = _resolve_user(
            db,
            user_id=user_id,
            email=email,
            password=password,
            name=name,
        )
        session_captured = False
        reset_counts: dict[str, int] | None = None
        if reset_user_data:
            reset_counts = _reset_user_portfolio_data(db, user.id)
        session = get_session_status(user.id)
        if capture_session or not session.available:
            capture_session_state(user.id, login_url=BOURSORAMA_LOGIN_URL, timeout_ms=max(timeout_ms, 300_000))
            session_captured = True

        try:
            if engine == "browser-use":
                discovered_accounts, discovery_warnings = _discover_accounts_with_browser_use(
                    user.id,
                    headless=headless,
                    dump_dir=dump_dir,
                    max_steps=browser_use_max_steps,
                )
            else:
                discovered_accounts, discovery_warnings = _discover_accounts_from_boursorama(
                    user.id,
                    timeout_ms=timeout_ms,
                    headless=headless,
                    dump_dir=dump_dir,
                )
        except RuntimeError as exc:
            if not _needs_session_refresh(exc):
                raise
            print(
                f"Boursorama session expired for user {user.id}. Reopening authentication.",
                file=sys.stderr,
            )
            capture_session_state(
                user.id,
                login_url=BOURSORAMA_LOGIN_URL,
                timeout_ms=max(timeout_ms, 300_000),
            )
            session_captured = True
            if engine == "browser-use":
                discovered_accounts, discovery_warnings = _discover_accounts_with_browser_use(
                    user.id,
                    headless=headless,
                    dump_dir=dump_dir,
                    max_steps=browser_use_max_steps,
                )
            else:
                discovered_accounts, discovery_warnings = _discover_accounts_from_boursorama(
                    user.id,
                    timeout_ms=timeout_ms,
                    headless=headless,
                    dump_dir=dump_dir,
                )
        summary = _import_discovered_accounts(db, user, discovered_accounts)
        summary.session_captured = session_captured
        summary.warnings.extend(discovery_warnings)
        if reset_counts is not None:
            summary.warnings.insert(
                0,
                "Reset existing user data before import: "
                + ", ".join(f"{key}={value}" for key, value in reset_counts.items()),
            )
        return summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create or resolve a FollowStocks user, reuse a Boursorama session, and import accounts/holdings/placements."
    )
    parser.add_argument("--user-id", type=int, default=None, help="Existing FollowStocks user id")
    parser.add_argument("--email", default=None, help="FollowStocks user email")
    parser.add_argument("--password", default=None, help="FollowStocks password used only when creating a new user")
    parser.add_argument("--name", default=None, help="Optional display name when creating a new user")
    parser.add_argument(
        "--capture-session",
        action="store_true",
        help="Open Boursorama login in a browser before importing to capture or refresh the session",
    )
    parser.add_argument(
        "--engine",
        choices=("playwright", "browser-use"),
        default="playwright",
        help="Discovery engine: deterministic Playwright parser or browser-use agent",
    )
    parser.add_argument(
        "--browser-use-max-steps",
        type=int,
        default=20,
        help="Maximum browser-use agent steps when --engine browser-use is selected",
    )
    parser.add_argument(
        "--reset-user-data",
        action="store_true",
        help="Delete all existing portfolio data for the target user before importing. Keeps the user and saved Boursorama session.",
    )
    parser.add_argument("--timeout", type=int, default=30_000, help="Timeout in milliseconds for each page")
    parser.add_argument("--headed", action="store_true", help="Run the import browser in headed mode")
    parser.add_argument(
        "--dump-dir",
        default=None,
        help="Optional directory where landing/account HTML and normalized text dumps are written",
    )
    args = parser.parse_args()

    dump_dir = Path(args.dump_dir).expanduser().resolve() if args.dump_dir else None
    summary = run_import(
        user_id=args.user_id,
        email=args.email,
        password=args.password,
        name=args.name,
        capture_session=args.capture_session,
        timeout_ms=args.timeout,
        headless=not args.headed,
        dump_dir=dump_dir,
        engine=args.engine,
        browser_use_max_steps=args.browser_use_max_steps,
        reset_user_data=args.reset_user_data,
    )
    print(json.dumps(asdict(summary), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
