from __future__ import annotations

import asyncio
import json
from datetime import date, datetime
from typing import Any, Dict, Optional

import pandas as pd
import yfinance as yf
from langchain_core.tools import tool
from yfinance.search import Search
from yfinance.scrapers.funds import FundsData


def _coerce_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, pd.Timedelta):
        return str(value)
    if isinstance(value, dict):
        return {key: _coerce_value(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [_coerce_value(val) for val in value]
    if hasattr(value, "item") and not isinstance(value, (str, bytes, list, dict)):
        try:
            return value.item()
        except Exception:
            return value
    return value


def _stringify_cell(value: Any, max_len: int = 64) -> str:
    if value is None:
        text = ""
    elif isinstance(value, (dict, list, tuple)):
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    else:
        text = str(value)
    text = text.replace("|", "\\|").replace("\n", " ").strip()
    if len(text) > max_len:
        return text[: max_len - 1] + "…"
    return text


def _table_from_rows(rows: list[dict[str, Any]], columns: list[str], max_rows: int = 20) -> str | None:
    if not rows or not columns:
        return None
    limited = rows[:max_rows]
    header = "| " + " | ".join(columns) + " |"
    sep = "| " + " | ".join(["---"] * len(columns)) + " |"
    body_lines = []
    for row in limited:
        body_lines.append(
            "| " + " | ".join(_stringify_cell(row.get(col, "")) for col in columns) + " |"
        )
    return "\n".join([header, sep, *body_lines])


def _table_from_data(data: Any, max_rows: int = 20) -> str | None:
    if isinstance(data, dict) and data.get("type") == "dataframe":
        rows = data.get("rows") or []
        columns = data.get("columns") or []
        return _table_from_rows(rows, columns, max_rows=max_rows)
    if isinstance(data, list) and data and isinstance(data[0], dict):
        columns = list(data[0].keys())
        return _table_from_rows(data, columns, max_rows=max_rows)
    if isinstance(data, dict):
        rows = [{"key": k, "value": v} for k, v in list(data.items())[:max_rows]]
        return _table_from_rows(rows, ["key", "value"], max_rows=max_rows)
    if isinstance(data, list):
        rows = [{"value": v} for v in data[:max_rows]]
        return _table_from_rows(rows, ["value"], max_rows=max_rows)
    return None


def _attach_table(payload: Dict[str, Any], data_key: str = "data", table_key: str = "table") -> Dict[str, Any]:
    data = payload.get(data_key)
    table = _table_from_data(data)
    if table:
        payload[table_key] = table
    return payload


def _normalize_dataframe(df: pd.DataFrame, max_rows: int) -> Dict[str, Any]:
    if df is None:
        return {"type": "dataframe", "rows": [], "columns": []}
    if max_rows and len(df) > max_rows:
        df = df.head(max_rows)

    df = df.copy()
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.strftime("%Y-%m-%dT%H:%M:%S%z")
    if pd.api.types.is_datetime64_any_dtype(df.index):
        df = df.reset_index()
        df.iloc[:, 0] = df.iloc[:, 0].astype(str)
    else:
        df = df.reset_index(drop=True)

    records = []
    for row in df.to_dict(orient="records"):
        records.append({key: _coerce_value(val) for key, val in row.items()})

    return {"type": "dataframe", "rows": records, "columns": list(df.columns)}


def _normalize_series(series: pd.Series, max_rows: int) -> Dict[str, Any]:
    if series is None:
        return {"type": "series", "rows": []}
    if max_rows and len(series) > max_rows:
        series = series.head(max_rows)
    df = series.to_frame(name=series.name or "value").reset_index()
    return _normalize_dataframe(df, max_rows)


def _serialize(value: Any, max_rows: int = 200) -> Any:
    if isinstance(value, pd.DataFrame):
        return _normalize_dataframe(value, max_rows)
    if isinstance(value, pd.Series):
        return _normalize_series(value, max_rows)
    if isinstance(value, FundsData):
        return _serialize_funds_data(value, max_rows)
    return _coerce_value(value)


def _serialize_funds_data(funds: FundsData, max_rows: int) -> Dict[str, Any]:
    def safe_get(attr: str) -> Any:
        try:
            return _serialize(getattr(funds, attr), max_rows)
        except Exception as exc:
            return {"error": str(exc)}

    return {
        "quote_type": safe_get("quote_type"),
        "description": safe_get("description"),
        "fund_overview": safe_get("fund_overview"),
        "fund_operations": safe_get("fund_operations"),
        "asset_classes": safe_get("asset_classes"),
        "top_holdings": safe_get("top_holdings"),
        "equity_holdings": safe_get("equity_holdings"),
        "bond_holdings": safe_get("bond_holdings"),
        "bond_ratings": safe_get("bond_ratings"),
        "sector_weightings": safe_get("sector_weightings"),
    }


def _symbol(value: str) -> str:
    return value.strip().upper()


def _parse_symbols(symbols: Any) -> list[str]:
    if isinstance(symbols, str):
        raw = symbols.replace(";", ",").replace("\n", ",")
        parts = [p.strip() for p in raw.replace(",", " ").split() if p.strip()]
        return [p.upper() for p in parts]
    if isinstance(symbols, (list, tuple, set)):
        return [str(s).strip().upper() for s in symbols if str(s).strip()]
    return [str(symbols).strip().upper()] if symbols else []


def _run_batch_fast_info(symbols: Any, fields: Optional[list[str]] = None) -> Dict[str, Any]:
    symbols_list = _parse_symbols(symbols)
    if not symbols_list:
        return {"symbols": [], "error": "No symbols provided."}
    default_fields = [
        "last_price",
        "previous_close",
        "open",
        "day_high",
        "day_low",
        "year_high",
        "year_low",
        "market_cap",
        "currency",
        "exchange",
        "quote_type",
        "last_volume",
    ]
    use_fields = fields or default_fields
    try:
        tickers = yf.Tickers(" ".join(symbols_list))
        results = []
        for symbol, ticker in tickers.tickers.items():
            try:
                fast = ticker.fast_info
                payload = {"symbol": _symbol(symbol)}
                for key in use_fields:
                    payload[key] = fast.get(key)
                results.append(payload)
            except Exception as exc:
                results.append({"symbol": _symbol(symbol), "error": str(exc)})
        return _attach_table({"symbols": symbols_list, "data": results})
    except Exception as exc:
        return {"symbols": symbols_list, "error": str(exc)}


@tool
async def yahoo_batch_fast_info(symbols: Any, fields: Optional[list[str]] = None) -> dict:
    """Get fast_info for multiple tickers in one call.

    Args:
        symbols: List of tickers or a single string (comma/space separated).
        fields: Optional list of fast_info fields to return. If omitted, uses
            a default set (last_price, previous_close, day range, market_cap, etc.).

    Returns:
        dict with keys:
          - symbols: normalized list of tickers
          - data: list of {symbol, <field>: value, ...} per ticker
          - table (optional): markdown table of data
          - error (optional): error message if the batch call fails

    Use this when the user provides a list of tickers (e.g., CAC 40 list) and
    you need quick quote-like data for all of them.
    """
    return await asyncio.to_thread(_run_batch_fast_info, symbols, fields)


def _run_search(query: str, max_results: int, news_count: int) -> Dict[str, Any]:
    try:
        search = Search(query, max_results=max_results, news_count=news_count)
        quotes = []
        for quote in search.quotes or []:
            quotes.append(
                {
                    "symbol": quote.get("symbol"),
                    "shortname": quote.get("shortname"),
                    "longname": quote.get("longname"),
                    "exchange": quote.get("exchDisp") or quote.get("exchange"),
                    "quote_type": quote.get("quoteType"),
                }
            )
        news = []
        for item in search.news or []:
            news.append(
                {
                    "title": item.get("title"),
                    "publisher": item.get("publisher"),
                    "link": item.get("link"),
                    "published_at": item.get("providerPublishTime"),
                }
            )
        payload = {"query": query, "quotes": quotes, "news": news}
        quotes_table = _table_from_data(quotes)
        if quotes_table:
            payload["quotes_table"] = quotes_table
        news_table = _table_from_data(news)
        if news_table:
            payload["news_table"] = news_table
        return payload
    except Exception as exc:
        return {"query": query, "error": str(exc)}


def _run_stock_price(symbol: str, history: int, period: str) -> Dict[str, Any]:
    ticker = yf.Ticker(symbol)
    try:
        df = ticker.history(period=period)
        if df is None or df.empty:
            return {"symbol": _symbol(symbol), "error": "No price history found."}
        cols = [c for c in ["Close", "Volume"] if c in df.columns]
        if cols:
            df = df[cols]
        df = df.tail(history)
        df.index = df.index.map(lambda x: str(x).split()[0])
        df.index.rename("Date", inplace=True)
        return _attach_table({"symbol": _symbol(symbol), "data": _serialize(df, max_rows=history)})
    except Exception as exc:
        return {"symbol": _symbol(symbol), "error": str(exc)}


def _run_financial_statements(symbol: str) -> Dict[str, Any]:
    ticker = yf.Ticker(symbol)
    try:
        balance_sheet = ticker.balance_sheet
        if balance_sheet is None or balance_sheet.empty:
            return {"symbol": _symbol(symbol), "error": "No balance sheet data found."}
        if balance_sheet.shape[1] >= 3:
            balance_sheet = balance_sheet.iloc[:, :3]
        balance_sheet = balance_sheet.dropna(how="any")
        return _attach_table({"symbol": _symbol(symbol), "data": _serialize(balance_sheet, max_rows=200)})
    except Exception as exc:
        return {"symbol": _symbol(symbol), "error": str(exc)}


def _run_recent_news(symbol_or_name: str, count: int) -> Dict[str, Any]:
    try:
        search = Search(symbol_or_name, max_results=6, news_count=count)
        news = []
        for item in search.news or []:
            news.append(
                {
                    "title": item.get("title"),
                    "publisher": item.get("publisher"),
                    "link": item.get("link"),
                    "published_at": item.get("providerPublishTime"),
                }
            )
        if news:
            payload = {"query": symbol_or_name, "news": news}
            news_table = _table_from_data(news)
            if news_table:
                payload["news_table"] = news_table
            return payload
        ticker = yf.Ticker(symbol_or_name)
        return _attach_table(
            {"query": symbol_or_name, "data": _serialize(ticker.news, max_rows=count)},
            table_key="news_table",
        )
    except Exception as exc:
        return {"query": symbol_or_name, "error": str(exc)}


@tool
async def yahoo_search(query: str, max_results: int = 8, news_count: int = 6) -> dict:
    """Search Yahoo Finance for ticker symbols and related news.

    Args:
        query: Company name or partial ticker to search.
        max_results: Max number of quote matches to return.
        news_count: Max number of news items to return.

    Returns:
        dict with keys:
          - query: original query
          - quotes: list[{symbol, shortname, longname, exchange, quote_type}]
          - news: list[{title, publisher, link, published_at}]
          - quotes_table (optional): markdown table of quotes
          - news_table (optional): markdown table of news
          - error (optional): error message if search failed

    Use this when the user provides a company name or ambiguous ticker. Best
    for ticker discovery before calling price/history or fundamentals tools.
    """
    return await asyncio.to_thread(_run_search, query, max_results, news_count)


@tool
async def yahoo_stock_price(symbol: str, history: int = 5, period: str = "1y") -> dict:
    """Get recent Close/Volume history for a ticker.

    Args:
        symbol: Yahoo ticker (e.g., AAPL, MC.PA).
        history: Number of rows to return from the end.
        period: Yahoo period string (e.g., 1y, 6mo, 5d).

    Returns:
        dict with keys:
          - symbol: normalized symbol
          - data: table of Date/Close/Volume (last `history` rows)
          - table (optional): markdown table of data
          - error (optional): error message if history lookup failed

    Ideal for quick price snapshots and short-term trends.
    """
    return await asyncio.to_thread(_run_stock_price, symbol, history, period)


@tool
async def yahoo_financial_statements(symbol: str) -> dict:
    """Get a compact balance sheet snapshot for a ticker.

    Args:
        symbol: Yahoo ticker.

    Returns:
        dict with keys:
          - symbol: normalized symbol
          - data: balance sheet table (up to last 3 periods)
          - table (optional): markdown table of data
          - error (optional): error message if data not available

    Use this for quick fundamentals checks (assets/liabilities snapshot).
    """
    return await asyncio.to_thread(_run_financial_statements, symbol)


@tool
async def yahoo_recent_news(query: str, count: int = 5) -> dict:
    """Get recent news for a company name or ticker.

    Args:
        query: Company name or ticker.
        count: Max number of news items to return.

    Returns:
        dict with keys:
          - query: original query
          - news: list[{title, publisher, link, published_at}]
          - news_table (optional): markdown table of news
          - error (optional): error message if news lookup failed

    Uses Yahoo Finance search news (falls back to ticker news).
    """
    return await asyncio.to_thread(_run_recent_news, query, count)


def _run_property(symbol: str, prop: str, max_rows: int = 200) -> Dict[str, Any]:
    ticker = yf.Ticker(symbol)
    try:
        value = getattr(ticker, prop)
        return _attach_table({"symbol": _symbol(symbol), "data": _serialize(value, max_rows)})
    except Exception as exc:
        return {"symbol": _symbol(symbol), "error": str(exc)}


def _run_method(symbol: str, method: str, max_rows: int = 200, **kwargs: Any) -> Dict[str, Any]:
    ticker = yf.Ticker(symbol)
    try:
        fn = getattr(ticker, method)
        value = fn(**kwargs)
        return _attach_table({"symbol": _symbol(symbol), "data": _serialize(value, max_rows)})
    except Exception as exc:
        return {"symbol": _symbol(symbol), "error": str(exc)}


@tool
async def yahoo_info(symbol: str, max_rows: int = 200) -> dict:
    """Get the full Yahoo Finance info dictionary for a ticker.

    Args:
        symbol: Yahoo ticker.
        max_rows: Maximum rows when value is a table-like structure.

    Returns:
        dict with keys:
          - symbol: normalized symbol
          - data: info dictionary (company profile + metadata)
          - table (optional): markdown table if data is tabular
          - error (optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "info", max_rows)


@tool
async def yahoo_fast_info(symbol: str) -> dict:
    """Get the fast_info snapshot for a ticker.

    Args:
        symbol: Yahoo ticker.

    Returns:
        dict with keys:
          - symbol: normalized symbol
          - data: fast_info dict (last price, prev close, ranges, etc.)
          - table (optional): markdown table if data is tabular
          - error (optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "fast_info", 200)


@tool
async def yahoo_isin(symbol: str) -> dict:
    """Get the ISIN for a ticker (if available).

    Args:
        symbol: Yahoo ticker.

    Returns:
        dict with keys:
          - symbol: normalized symbol
          - data: ISIN string (or null)
          - table (optional): markdown table if data is tabular
          - error (optional)
    """
    return await asyncio.to_thread(_run_method, symbol, "get_isin", 200)


@tool
async def yahoo_history(
    symbol: str,
    period: str = "1mo",
    interval: str = "1d",
    start: str | None = None,
    end: str | None = None,
    auto_adjust: bool = True,
    prepost: bool = False,
    actions: bool = True,
    max_rows: int = 200,
) -> dict:
    """Get full OHLCV price history for a ticker.

    Args:
        symbol: Yahoo ticker.
        period: Period string (e.g., 1y, 6mo, 5d).
        interval: Interval string (e.g., 1d, 1h).
        start: Optional start date (YYYY-MM-DD).
        end: Optional end date (YYYY-MM-DD).
        auto_adjust: Adjust OHLC for splits/dividends.
        prepost: Include pre/post market data.
        actions: Include actions (dividends/splits).
        max_rows: Max rows to return.

    Returns:
        dict with keys:
          - symbol
          - data: OHLCV table with optional actions
          - table (optional): markdown table of data
          - error (optional)

    Use this for detailed price series (not just Close/Volume).
    """
    return await asyncio.to_thread(
        _run_method,
        symbol,
        "history",
        max_rows,
        period=period,
        interval=interval,
        start=start,
        end=end,
        auto_adjust=auto_adjust,
        prepost=prepost,
        actions=actions,
    )


@tool
async def yahoo_actions(symbol: str, max_rows: int = 200) -> dict:
    """Get corporate actions (dividends, splits).

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.

    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "actions", max_rows)


@tool
async def yahoo_dividends(symbol: str, max_rows: int = 200) -> dict:
    """Get dividend history.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "dividends", max_rows)


@tool
async def yahoo_capital_gains(symbol: str, max_rows: int = 200) -> dict:
    """Get capital gains distributions (funds/ETFs).

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "capital_gains", max_rows)


@tool
async def yahoo_splits(symbol: str, max_rows: int = 200) -> dict:
    """Get stock split history.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "splits", max_rows)


@tool
async def yahoo_shares(symbol: str, max_rows: int = 200, as_dict: bool = False) -> dict:
    """Get shares outstanding history.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
        as_dict: Return dict instead of DataFrame.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(
        _run_method, symbol, "get_shares", max_rows, as_dict=as_dict
    )


@tool
async def yahoo_shares_full(
    symbol: str,
    start: str | None = None,
    end: str | None = None,
    max_rows: int = 200,
) -> dict:
    """Get full shares outstanding history over a date range.

    Args:
        symbol: Yahoo ticker.
        start: Optional start date.
        end: Optional end date.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(
        _run_method, symbol, "get_shares_full", max_rows, start=start, end=end
    )


@tool
async def yahoo_major_holders(symbol: str, max_rows: int = 200) -> dict:
    """Get major holders (insiders/institutional snapshot).

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "major_holders", max_rows)


@tool
async def yahoo_institutional_holders(symbol: str, max_rows: int = 200) -> dict:
    """Get institutional holders list.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "institutional_holders", max_rows)


@tool
async def yahoo_mutualfund_holders(symbol: str, max_rows: int = 200) -> dict:
    """Get mutual fund holders list.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "mutualfund_holders", max_rows)


@tool
async def yahoo_insider_purchases(symbol: str, max_rows: int = 200) -> dict:
    """Get insider purchases.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "insider_purchases", max_rows)


@tool
async def yahoo_insider_transactions(symbol: str, max_rows: int = 200) -> dict:
    """Get insider transactions.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "insider_transactions", max_rows)


@tool
async def yahoo_insider_roster(symbol: str, max_rows: int = 200) -> dict:
    """Get insider roster holders.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "insider_roster_holders", max_rows)


@tool
async def yahoo_recommendations(symbol: str, max_rows: int = 200) -> dict:
    """Get analyst recommendations (full history).

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "recommendations", max_rows)


@tool
async def yahoo_recommendations_summary(symbol: str, max_rows: int = 200) -> dict:
    """Get analyst recommendations summary (aggregated).

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "recommendations_summary", max_rows)


@tool
async def yahoo_upgrades_downgrades(symbol: str, max_rows: int = 200) -> dict:
    """Get upgrades/downgrades history.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "upgrades_downgrades", max_rows)


@tool
async def yahoo_earnings(symbol: str, max_rows: int = 200, freq: str = "yearly") -> dict:
    """Get earnings data (yearly or quarterly).

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
        freq: yearly or quarterly.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(
        _run_method, symbol, "get_earnings", max_rows, freq=freq
    )


@tool
async def yahoo_earnings_dates(symbol: str, limit: int = 12, offset: int = 0, max_rows: int = 200) -> dict:
    """Get upcoming/past earnings dates.

    Args:
        symbol: Yahoo ticker.
        limit: Max number of rows.
        offset: Offset into the results.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(
        _run_method, symbol, "get_earnings_dates", max_rows, limit=limit, offset=offset
    )


@tool
async def yahoo_income_stmt(symbol: str, freq: str = "yearly", pretty: bool = True, max_rows: int = 200) -> dict:
    """Get income statement.

    Args:
        symbol: Yahoo ticker.
        freq: yearly, quarterly, or trailing.
        pretty: format columns with friendly names.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(
        _run_method, symbol, "get_income_stmt", max_rows, freq=freq, pretty=pretty
    )


@tool
async def yahoo_balance_sheet(symbol: str, freq: str = "yearly", pretty: bool = True, max_rows: int = 200) -> dict:
    """Get balance sheet.

    Args:
        symbol: Yahoo ticker.
        freq: yearly, quarterly, or trailing.
        pretty: format columns with friendly names.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(
        _run_method, symbol, "get_balance_sheet", max_rows, freq=freq, pretty=pretty
    )


@tool
async def yahoo_cash_flow(symbol: str, freq: str = "yearly", pretty: bool = True, max_rows: int = 200) -> dict:
    """Get cash flow statement.

    Args:
        symbol: Yahoo ticker.
        freq: yearly, quarterly, or trailing.
        pretty: format columns with friendly names.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(
        _run_method, symbol, "get_cash_flow", max_rows, freq=freq, pretty=pretty
    )


@tool
async def yahoo_analyst_price_targets(symbol: str) -> dict:
    """Get analyst price targets.

    Args:
        symbol: Yahoo ticker.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "analyst_price_targets", 200)


@tool
async def yahoo_earnings_estimate(symbol: str, max_rows: int = 200) -> dict:
    """Get analyst earnings estimates.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "earnings_estimate", max_rows)


@tool
async def yahoo_revenue_estimate(symbol: str, max_rows: int = 200) -> dict:
    """Get analyst revenue estimates.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "revenue_estimate", max_rows)


@tool
async def yahoo_earnings_history(symbol: str, max_rows: int = 200) -> dict:
    """Get earnings history.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "earnings_history", max_rows)


@tool
async def yahoo_eps_trend(symbol: str, max_rows: int = 200) -> dict:
    """Get EPS trend.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "eps_trend", max_rows)


@tool
async def yahoo_eps_revisions(symbol: str, max_rows: int = 200) -> dict:
    """Get EPS revisions.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "eps_revisions", max_rows)


@tool
async def yahoo_growth_estimates(symbol: str, max_rows: int = 200) -> dict:
    """Get growth estimates.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "growth_estimates", max_rows)


@tool
async def yahoo_sustainability(symbol: str, max_rows: int = 200) -> dict:
    """Get sustainability/ESG data.

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "sustainability", max_rows)


@tool
async def yahoo_calendar(symbol: str) -> dict:
    """Get calendar events (earnings, dividends).

    Args:
        symbol: Yahoo ticker.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "calendar", 200)


@tool
async def yahoo_sec_filings(symbol: str) -> dict:
    """Get SEC filings.

    Args:
        symbol: Yahoo ticker.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "sec_filings", 200)


@tool
async def yahoo_options(symbol: str) -> dict:
    """Get option expiration dates.

    Args:
        symbol: Yahoo ticker.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "options", 200)


@tool
async def yahoo_option_chain(symbol: str, date: Optional[str] = None, max_rows: int = 200) -> dict:
    """Get the option chain for a ticker and optional expiration date.

    Args:
        symbol: Yahoo ticker.
        date: Expiration date string (YYYY-MM-DD).
        max_rows: Max rows to return per leg.
    Returns:
        dict with keys: symbol, data{calls, puts, underlying}, error(optional)
    """
    def _run() -> Dict[str, Any]:
        ticker = yf.Ticker(symbol)
        try:
            chain = ticker.option_chain(date)
            data = {
                "calls": _serialize(chain.calls, max_rows),
                "puts": _serialize(chain.puts, max_rows),
                "underlying": _serialize(chain.underlying, max_rows),
            }
            return {"symbol": _symbol(symbol), "data": data}
        except Exception as exc:
            return {"symbol": _symbol(symbol), "error": str(exc)}

    return await asyncio.to_thread(_run)


@tool
async def yahoo_news(symbol: str, count: int = 10, tab: str = "news", max_rows: int = 200) -> dict:
    """Get recent news items for a ticker (Yahoo native news).

    Args:
        symbol: Yahoo ticker.
        count: Max number of news items.
        tab: News tab ("news" or other Yahoo tabs).
        max_rows: Max rows to return when serialized.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(
        _run_method, symbol, "get_news", max_rows, count=count, tab=tab
    )


@tool
async def yahoo_history_metadata(symbol: str) -> dict:
    """Get history metadata (timezone, exchange, trading periods).

    Args:
        symbol: Yahoo ticker.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "history_metadata", 200)


@tool
async def yahoo_funds_data(symbol: str, max_rows: int = 200) -> dict:
    """Get ETF/fund data (top holdings, sector weights, etc.).

    Args:
        symbol: Yahoo ticker.
        max_rows: Max rows to return.
    Returns:
        dict with keys: symbol, data, error(optional)
    """
    return await asyncio.to_thread(_run_property, symbol, "funds_data", max_rows)


YAHOO_FINANCE_TOOLS = [
    yahoo_search,
    yahoo_batch_fast_info,
    yahoo_stock_price,
    yahoo_financial_statements,
    yahoo_recent_news,
    yahoo_info,
    yahoo_fast_info,
    yahoo_isin,
    yahoo_history,
    yahoo_actions,
    yahoo_dividends,
    yahoo_capital_gains,
    yahoo_splits,
    yahoo_shares,
    yahoo_shares_full,
    yahoo_major_holders,
    yahoo_institutional_holders,
    yahoo_mutualfund_holders,
    yahoo_insider_purchases,
    yahoo_insider_transactions,
    yahoo_insider_roster,
    yahoo_recommendations,
    yahoo_recommendations_summary,
    yahoo_upgrades_downgrades,
    yahoo_earnings,
    yahoo_earnings_dates,
    yahoo_income_stmt,
    yahoo_balance_sheet,
    yahoo_cash_flow,
    yahoo_analyst_price_targets,
    yahoo_earnings_estimate,
    yahoo_revenue_estimate,
    yahoo_earnings_history,
    yahoo_eps_trend,
    yahoo_eps_revisions,
    yahoo_growth_estimates,
    yahoo_sustainability,
    yahoo_calendar,
    yahoo_sec_filings,
    yahoo_options,
    yahoo_option_chain,
    yahoo_news,
    yahoo_history_metadata,
    yahoo_funds_data,
]
