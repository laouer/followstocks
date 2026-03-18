from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from . import crud, models
from .core.config import BOURSORAMA_IDENTIFIER, BOURSORAMA_LOGIN_URL, BOURSORAMA_STORAGE_DIR
from .database import SessionLocal

LOGIN_URL_HINTS = ("connexion", "/login", "mot-de-passe-oublie")
LOGIN_TEXT_HINTS = (
    "mot de passe",
    "identifiant",
    "se connecter",
    "connexion",
    "code de securite",
    "valider mon appareil",
)
CASH_KEYWORDS = (
    "especes",
    "liquidites",
    "solde",
    "disponible",
    "disponibilites",
    "compte courant",
    "compte bancaire",
    "livret",
    "pea",
    "pea-pme",
    "compte titres",
    "compte-titres",
    "cto",
    "carte",
)
GENERIC_LABELS = {
    "especes",
    "especes disponibles",
    "liquidites",
    "solde",
    "solde especes",
    "disponible",
    "disponibilites",
}
MONEY_RE = re.compile(
    r"(?:(?P<prefix>EUR|USD|CHF|GBP|€|\$|£)\s*)?"
    r"(?P<amount>[+-]?\d{1,3}(?:[ \u00a0]\d{3})*(?:,\d{2})?|[+-]?\d+(?:,\d{2})?)"
    r"(?:\s*(?P<suffix>EUR|USD|CHF|GBP|€|\$|£))?",
    re.IGNORECASE,
)


@dataclass
class SessionStatus:
    available: bool
    state_path: str
    metadata_path: str
    captured_at: str | None = None
    landing_url: str | None = None
    login_url: str | None = None


@dataclass
class CashAccount:
    name: str
    amount: float
    currency: str
    match_reason: str


@dataclass
class CashPreview:
    session: SessionStatus
    extracted_at: str
    page_url: str
    accounts: list[CashAccount]


@dataclass
class CashSyncItem:
    name: str
    amount: float
    currency: str
    action: str
    account_id: int | None = None
    message: str | None = None


@dataclass
class CashSyncResult:
    session: SessionStatus
    extracted_at: str
    page_url: str
    updated_count: int
    created_count: int
    unchanged_count: int
    skipped_count: int
    history_captured: bool
    items: list[CashSyncItem]


def _normalize_spaces(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split())


def _fold_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch)).casefold()


def _normalize_label(value: str) -> str:
    return _fold_text(_normalize_spaces(value))


def _normalize_text_lines(value: str) -> list[str]:
    lines: list[str] = []
    for raw_line in value.splitlines():
        line = _normalize_spaces(raw_line)
        if line:
            lines.append(line)
    return lines


def _currency_code(prefix: str | None, suffix: str | None) -> str | None:
    token = (suffix or prefix or "").strip().upper()
    if token == "€":
        return "EUR"
    if token == "$":
        return "USD"
    if token == "£":
        return "GBP"
    return token or None


def _parse_money(text: str, require_currency: bool = True) -> tuple[float, str] | None:
    for match in MONEY_RE.finditer(text):
        currency = _currency_code(match.group("prefix"), match.group("suffix"))
        if require_currency and not currency:
            continue
        raw_amount = match.group("amount")
        if not raw_amount:
            continue
        try:
            value = float(raw_amount.replace("\u00a0", " ").replace(" ", "").replace(",", "."))
        except ValueError:
            continue
        return value, currency or "EUR"
    return None


def _contains_keyword(text: str) -> bool:
    lowered = _fold_text(text)
    return any(keyword in lowered for keyword in CASH_KEYWORDS)


def _strip_money_tokens(text: str) -> str:
    stripped = MONEY_RE.sub(" ", text)
    return _normalize_spaces(stripped)


def _best_label(lines: list[str], anchor_index: int) -> str:
    current = _strip_money_tokens(lines[anchor_index])
    current_key = _normalize_label(current)
    if current and current_key not in GENERIC_LABELS and not _contains_keyword(current):
        return current

    for offset in range(1, 4):
        previous_index = anchor_index - offset
        if previous_index < 0:
            break
        candidate = _strip_money_tokens(lines[previous_index])
        candidate_key = _normalize_label(candidate)
        if not candidate:
            continue
        if candidate_key in GENERIC_LABELS:
            continue
        if _parse_money(candidate, require_currency=False):
            continue
        return candidate

    for offset in range(1, 3):
        next_index = anchor_index + offset
        if next_index >= len(lines):
            break
        candidate = _strip_money_tokens(lines[next_index])
        candidate_key = _normalize_label(candidate)
        if not candidate or candidate_key in GENERIC_LABELS:
            continue
        if _parse_money(candidate, require_currency=False):
            continue
        return candidate

    return current or lines[anchor_index]


def _extract_cash_accounts_from_lines(lines: list[str]) -> list[CashAccount]:
    results: list[CashAccount] = []
    seen: set[tuple[str, int, str]] = set()

    def add_candidate(label: str, amount: float, currency: str, reason: str) -> None:
        clean_label = _normalize_spaces(label)
        if not clean_label:
            clean_label = "Boursorama"
        dedupe_key = (_normalize_label(clean_label), int(round(amount * 100)), currency.upper())
        if dedupe_key in seen:
            return
        seen.add(dedupe_key)
        results.append(
            CashAccount(
                name=clean_label,
                amount=amount,
                currency=currency.upper(),
                match_reason=reason,
            )
        )

    for index, line in enumerate(lines):
        line_has_keyword = _contains_keyword(line)
        direct_money = _parse_money(line)
        if direct_money and line_has_keyword:
            label = _best_label(lines, index)
            add_candidate(label, direct_money[0], direct_money[1], "keyword_line")
            continue

        if not line_has_keyword:
            continue

        for offset in range(0, 4):
            next_index = index + offset
            if next_index >= len(lines):
                break
            nearby_money = _parse_money(lines[next_index])
            if nearby_money:
                label = _best_label(lines, index if offset == 0 else next_index)
                add_candidate(label, nearby_money[0], nearby_money[1], "keyword_window")
                break

    return sorted(results, key=lambda item: item.name.casefold())


def _metadata_path_for(state_path: Path) -> Path:
    if state_path.suffix:
        return state_path.with_name(f"{state_path.stem}.meta{state_path.suffix}")
    return state_path.with_name(f"{state_path.name}.meta.json")


def _ensure_private_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    _ensure_private_parent(path)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _looks_like_login_url(url: str) -> bool:
    lowered = (url or "").casefold()
    return any(hint in lowered for hint in LOGIN_URL_HINTS)


def _context_root_url(url: str) -> str | None:
    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}/"


def _candidate_urls(*urls: str | None) -> list[str]:
    seen: set[str] = set()
    candidates: list[str] = []
    for raw_url in urls:
        clean = str(raw_url or "").strip()
        if not clean:
            continue
        if clean not in seen:
            seen.add(clean)
            candidates.append(clean)
        root_url = _context_root_url(clean)
        if root_url and root_url not in seen:
            seen.add(root_url)
            candidates.append(root_url)
    return candidates


def _safe_body_text(page) -> str:
    try:
        return page.locator("body").inner_text()
    except Exception:  # noqa: BLE001
        return ""


def _debug_enabled() -> bool:
    return os.getenv("BOURSORAMA_DEBUG", "").strip().lower() not in {"", "0", "false", "no"}


def _debug(message: str) -> None:
    if _debug_enabled():
        print(f"[boursorama] {message}", file=sys.stderr)


def _try_fill_first_visible(page, selectors: tuple[str, ...], value: str) -> bool:
    for selector in selectors:
        try:
            locator = page.locator(selector)
            count = min(locator.count(), 5)
        except Exception:  # noqa: BLE001
            continue
        for index in range(count):
            candidate = locator.nth(index)
            try:
                if not candidate.is_visible():
                    continue
                candidate.fill(value)
                return True
            except Exception:  # noqa: BLE001
                continue
    return False


def _prefill_identifier(page, identifier: str) -> bool:
    clean_identifier = identifier.strip()
    if not clean_identifier:
        return False
    preferred_selectors = (
        "input[autocomplete='username']",
        "input[name='login']",
        "input[name*='ident' i]",
        "input[id*='ident' i]",
        "input[name*='user' i]",
        "input[id*='user' i]",
        "input[type='email']",
    )
    fallback_selectors = (
        "form input[type='text']",
        "form input[type='tel']",
        "form input:not([type])",
    )
    if _try_fill_first_visible(page, preferred_selectors, clean_identifier):
        return True
    return _try_fill_first_visible(page, fallback_selectors, clean_identifier)


def _has_visible_password_input(page) -> bool:
    if page is None:
        return False
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


def _wait_for_post_login_settle(page, timeout_ms: int) -> None:
    settle_timeout = max(1000, min(timeout_ms, 15_000))
    try:
        _debug(f"wait_for_load_state(networkidle) start timeout_ms={settle_timeout}")
        page.wait_for_load_state("networkidle", timeout=settle_timeout)
        _debug("wait_for_load_state(networkidle) done")
    except Exception:  # noqa: BLE001
        _debug("wait_for_load_state(networkidle) timed out or failed")
        pass
    _debug("sleep start seconds=1.2")
    time.sleep(1.2)
    _debug("sleep done seconds=1.2")


def _open_authenticated_page(context, timeout_ms: int, *candidate_urls: str | None) -> tuple[str, str]:
    last_url = ""
    last_body_text = ""
    for candidate_url in _candidate_urls(*candidate_urls):
        page = context.new_page()
        page.set_default_timeout(timeout_ms)
        try:
            page.goto(candidate_url, wait_until="domcontentloaded", timeout=timeout_ms)
            _wait_for_post_login_settle(page, timeout_ms)
            current_url = page.url
            body_text = _safe_body_text(page)
            last_url = current_url
            last_body_text = body_text
            if not _page_looks_like_login(page, current_url, body_text):
                return current_url, body_text
        except Exception:  # noqa: BLE001
            continue
        finally:
            try:
                page.close()
            except Exception:  # noqa: BLE001
                pass
    return last_url, last_body_text


def _resolve_target_url(state_path: Path, override_url: str | None) -> str:
    if override_url:
        return override_url
    metadata = _read_json(_metadata_path_for(state_path))
    landing_url = str(metadata.get("landing_url") or "").strip()
    if landing_url:
        return landing_url
    return BOURSORAMA_LOGIN_URL


def default_storage_state_path(user_id: int) -> Path:
    return Path(BOURSORAMA_STORAGE_DIR) / f"user-{user_id}-storage-state.json"


def get_session_status(user_id: int) -> SessionStatus:
    state_path = default_storage_state_path(user_id)
    metadata_path = _metadata_path_for(state_path)
    metadata = _read_json(metadata_path)
    return SessionStatus(
        available=state_path.exists(),
        state_path=str(state_path),
        metadata_path=str(metadata_path),
        captured_at=metadata.get("captured_at"),
        landing_url=metadata.get("landing_url"),
        login_url=metadata.get("login_url"),
    )


def capture_session_state(
    user_id: int,
    *,
    login_url: str = BOURSORAMA_LOGIN_URL,
    timeout_ms: int = 300_000,
) -> SessionStatus:
    from playwright.sync_api import sync_playwright

    state_path = default_storage_state_path(user_id)
    metadata_path = _metadata_path_for(state_path)
    _ensure_private_parent(state_path)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context(locale="fr-FR")
        page = context.new_page()
        page.set_default_timeout(timeout_ms)
        page.goto(login_url, wait_until="domcontentloaded", timeout=timeout_ms)
        _wait_for_post_login_settle(page, timeout_ms)

        identifier_prefilled = _prefill_identifier(page, BOURSORAMA_IDENTIFIER)

        print(
            "Complete the Boursorama login in the opened browser, then press Enter here to save the session.",
            file=sys.stderr,
        )
        if BOURSORAMA_IDENTIFIER and not identifier_prefilled:
            print(
                "BOURSORAMA_IDENTIFIER is set in .env but no visible identifier field was found to prefill.",
                file=sys.stderr,
            )
        try:
            input()
        except EOFError as exc:
            raise RuntimeError("Interactive terminal required to capture the Boursorama session") from exc

        _wait_for_post_login_settle(page, timeout_ms)
        landing_url = page.url

        context.storage_state(path=str(state_path))

        verification_context = browser.new_context(storage_state=str(state_path), locale="fr-FR")
        verified_url, verified_body_text = _open_authenticated_page(
            verification_context,
            timeout_ms,
            landing_url,
            login_url,
        )
        verification_context.close()
        if not verified_url:
            context.close()
            browser.close()
            raise RuntimeError(
                "Unable to verify the saved session after login. Wait for the client area to load, then try again."
            )
        if _page_looks_like_login(None, verified_url, verified_body_text):
            context.close()
            browser.close()
            raise RuntimeError(
                "Saved session still resolves to a login form. Complete authentication, wait for the client area to load, then press Enter."
            )

        if verified_url:
            landing_url = verified_url

        context.close()
        browser.close()

    try:
        os.chmod(state_path, 0o600)
    except OSError:
        pass

    captured_at = datetime.utcnow().isoformat()
    _write_json(
        metadata_path,
        {
            "captured_at": captured_at,
            "login_url": login_url,
            "landing_url": landing_url,
        },
    )
    return get_session_status(user_id)


def fetch_cash_preview(
    user_id: int,
    *,
    url: str | None = None,
    timeout_ms: int = 30_000,
    headless: bool = True,
    dump_text_path: Path | None = None,
) -> CashPreview:
    from playwright.sync_api import sync_playwright

    session = get_session_status(user_id)
    state_path = Path(session.state_path)
    if not state_path.exists():
        raise FileNotFoundError(
            f"No saved Boursorama session for user {user_id}. Run the auth capture first."
        )

    page_url = _resolve_target_url(state_path, url)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        context = browser.new_context(storage_state=str(state_path), locale="fr-FR")
        current_url, body_text = _open_authenticated_page(
            context,
            timeout_ms,
            page_url,
            BOURSORAMA_LOGIN_URL,
        )
        context.close()
        browser.close()

    if not current_url:
        raise RuntimeError("Unable to load a Boursorama page with the saved session.")
    if _page_looks_like_login(None, current_url, body_text):
        raise RuntimeError("Saved Boursorama session expired or needs re-authentication.")

    if dump_text_path is not None:
        _write_json(
            dump_text_path,
            {
                "page_url": current_url,
                "captured_at": datetime.utcnow().isoformat(),
                "lines": _normalize_text_lines(body_text),
            },
        )

    lines = _normalize_text_lines(body_text)
    accounts = _extract_cash_accounts_from_lines(lines)
    return CashPreview(
        session=session,
        extracted_at=datetime.utcnow().isoformat(),
        page_url=current_url,
        accounts=accounts,
    )


def sync_cash_accounts(
    db: Session,
    user_id: int,
    preview: CashPreview,
    *,
    create_missing_accounts: bool = True,
    capture_daily_history: bool = True,
) -> CashSyncResult:
    known_accounts = {
        _normalize_label(account.name): account for account in crud.get_accounts(db, user_id)
    }
    items: list[CashSyncItem] = []
    updated_count = 0
    created_count = 0
    unchanged_count = 0
    skipped_count = 0

    for account in preview.accounts:
        if account.currency.upper() != "EUR":
            skipped_count += 1
            items.append(
                CashSyncItem(
                    name=account.name,
                    amount=account.amount,
                    currency=account.currency,
                    action="skipped",
                    message="Only EUR balances can be synced into account liquidity.",
                )
            )
            continue

        existing = known_accounts.get(_normalize_label(account.name))
        if existing is not None:
            if abs((existing.liquidity or 0.0) - account.amount) <= 1e-6:
                unchanged_count += 1
                items.append(
                    CashSyncItem(
                        name=account.name,
                        amount=account.amount,
                        currency=account.currency,
                        action="unchanged",
                        account_id=existing.id,
                    )
                )
                continue
            existing.liquidity = account.amount
            existing.updated_at = datetime.utcnow()
            db.add(existing)
            updated_count += 1
            items.append(
                CashSyncItem(
                    name=account.name,
                    amount=account.amount,
                    currency=account.currency,
                    action="updated",
                    account_id=existing.id,
                )
            )
            continue

        if not create_missing_accounts:
            skipped_count += 1
            items.append(
                CashSyncItem(
                    name=account.name,
                    amount=account.amount,
                    currency=account.currency,
                    action="skipped",
                    message="No matching local account name and create_missing_accounts is false.",
                )
            )
            continue

        created = models.Account(
            user_id=user_id,
            name=account.name,
            account_type="boursorama",
            liquidity=account.amount,
            manual_invested=0.0,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(created)
        db.flush()
        known_accounts[_normalize_label(created.name)] = created
        created_count += 1
        items.append(
            CashSyncItem(
                name=account.name,
                amount=account.amount,
                currency=account.currency,
                action="created",
                account_id=created.id,
            )
        )

    history_captured = False
    if updated_count or created_count:
        if capture_daily_history:
            crud.capture_daily_history(db, user_id)
            history_captured = True
        else:
            db.commit()
    else:
        db.rollback()

    return CashSyncResult(
        session=preview.session,
        extracted_at=preview.extracted_at,
        page_url=preview.page_url,
        updated_count=updated_count,
        created_count=created_count,
        unchanged_count=unchanged_count,
        skipped_count=skipped_count,
        history_captured=history_captured,
        items=items,
    )


def _preview_to_payload(preview: CashPreview) -> dict[str, Any]:
    return asdict(preview)


def _sync_to_payload(result: CashSyncResult) -> dict[str, Any]:
    return asdict(result)


def _parse_dump_text_path(raw_value: str | None) -> Path | None:
    if not raw_value:
        return None
    return Path(raw_value).expanduser().resolve()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Capture a Boursorama Playwright session and reuse it to fetch cash balances."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_parser = subparsers.add_parser("auth", help="Open Boursorama in a headed browser and save cookies")
    auth_parser.add_argument("--user-id", type=int, required=True, help="FollowStocks user id")
    auth_parser.add_argument(
        "--login-url",
        default=BOURSORAMA_LOGIN_URL,
        help="Boursorama login URL",
    )
    auth_parser.add_argument(
        "--timeout",
        type=int,
        default=300_000,
        help="Timeout in milliseconds before page actions fail",
    )

    fetch_parser = subparsers.add_parser("fetch", help="Read cash balances from a saved session")
    fetch_parser.add_argument("--user-id", type=int, required=True, help="FollowStocks user id")
    fetch_parser.add_argument("--url", default=None, help="Override the URL opened after restoring the session")
    fetch_parser.add_argument("--timeout", type=int, default=30_000, help="Timeout in milliseconds")
    fetch_parser.add_argument("--headed", action="store_true", help="Run the browser in headed mode")
    fetch_parser.add_argument(
        "--dump-text",
        default=None,
        help="Optional JSON file path to dump the page text lines for selector tuning",
    )

    sync_parser = subparsers.add_parser("sync", help="Read balances and sync them into local accounts")
    sync_parser.add_argument("--user-id", type=int, required=True, help="FollowStocks user id")
    sync_parser.add_argument("--url", default=None, help="Override the URL opened after restoring the session")
    sync_parser.add_argument("--timeout", type=int, default=30_000, help="Timeout in milliseconds")
    sync_parser.add_argument("--headed", action="store_true", help="Run the browser in headed mode")
    sync_parser.add_argument(
        "--no-create-missing",
        action="store_true",
        help="Skip scraped balances that do not match an existing local account name",
    )
    sync_parser.add_argument(
        "--no-history",
        action="store_true",
        help="Do not capture daily portfolio history after syncing account liquidity",
    )
    sync_parser.add_argument(
        "--dump-text",
        default=None,
        help="Optional JSON file path to dump the page text lines for selector tuning",
    )

    args = parser.parse_args()

    if args.command == "auth":
        status = capture_session_state(
            args.user_id,
            login_url=args.login_url,
            timeout_ms=args.timeout,
        )
        print(json.dumps(asdict(status), indent=2))
        return 0

    if args.command == "fetch":
        preview = fetch_cash_preview(
            args.user_id,
            url=args.url,
            timeout_ms=args.timeout,
            headless=not args.headed,
            dump_text_path=_parse_dump_text_path(args.dump_text),
        )
        print(json.dumps(_preview_to_payload(preview), indent=2))
        return 0

    if args.command == "sync":
        with SessionLocal() as db:
            preview = fetch_cash_preview(
                args.user_id,
                url=args.url,
                timeout_ms=args.timeout,
                headless=not args.headed,
                dump_text_path=_parse_dump_text_path(args.dump_text),
            )
            result = sync_cash_accounts(
                db,
                args.user_id,
                preview,
                create_missing_accounts=not args.no_create_missing,
                capture_daily_history=not args.no_history,
            )
            print(json.dumps(_sync_to_payload(result), indent=2))
        return 0

    parser.error("Unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
