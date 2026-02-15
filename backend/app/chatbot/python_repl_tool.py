from __future__ import annotations

import ast
import asyncio
import contextlib
import io
import json
import math
import importlib
import textwrap
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf
from langchain_core.tools import tool
import logging

logger = logging.getLogger(__name__)
SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "getattr": getattr,
    "isinstance": isinstance,
    "hasattr": hasattr,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "print": print,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
}

ALLOWED_IMPORTS = {
    "yfinance",
    "pandas",
    "numpy",
    "math",
    "json",
    "datetime",
}

def _safe_import(name: str, globals=None, locals=None, fromlist=(), level: int = 0):
    base = name.split(".")[0]
    if base not in ALLOWED_IMPORTS:
        raise ImportError(f"Import '{name}' is not allowed.")
    return importlib.import_module(name)

BASE_ENV = {
    "__builtins__": SAFE_BUILTINS,
    "yf": yf,
    "pd": pd,
    "np": np,
    "math": math,
    "json": json,
    "datetime": datetime,
    "date": date,
    "timedelta": timedelta,
}
SAFE_BUILTINS["__import__"] = _safe_import


def repl_prompt_context() -> str:
    allowed_imports = ", ".join(sorted(ALLOWED_IMPORTS))
    builtins_list = sorted(k for k in SAFE_BUILTINS.keys() if k != "__import__")
    allowed_builtins = ", ".join(builtins_list)
    preloaded = ", ".join(
        sorted([key for key in BASE_ENV.keys() if key not in {"__builtins__"}])
    )
    return (
        "Python REPL environment:\n"
        f"- Preloaded: {preloaded}.\n"
        f"- Allowed imports: {allowed_imports}.\n"
        f"- Allowed builtins: {allowed_builtins}.\n"
    )


def _format_result(result: Any, max_chars: int = 4000, max_rows: int = 50) -> str:
    if isinstance(result, pd.DataFrame):
        text = result.head(max_rows).to_string()
    elif isinstance(result, pd.Series):
        text = result.head(max_rows).to_string()
    elif isinstance(result, (dict, list, tuple)):
        try:
            text = json.dumps(result, ensure_ascii=True, default=str)
        except Exception:
            text = str(result)
    else:
        text = str(result)

    if len(text) > max_chars:
        return text[:max_chars] + "..."
    return text


def _run_python(code: str) -> str:
    code = textwrap.dedent(code).strip()
    if not code:
        return "No code provided."

    parsed = ast.parse(code, mode="exec")
    body = parsed.body
    last_expr = body[-1] if body else None
    exec_body = body
    eval_expr = None
    if last_expr and isinstance(last_expr, ast.Expr):
        exec_body = body[:-1]
        eval_expr = ast.Expression(last_expr.value)

    env = dict(BASE_ENV)
    stdout = io.StringIO()
    result = None
    try:
        with contextlib.redirect_stdout(stdout):
            if exec_body:
                exec(
                    compile(ast.Module(exec_body, type_ignores=[]), "<python_repl>", "exec"),
                    env,
                    env,
                )
            if eval_expr is not None:
                result = eval(compile(eval_expr, "<python_repl>", "eval"), env, env)
    except Exception as exc:
        logger.exception("python_repl execution failed: %s", str(code))
        logger.exception("python_repl execution failed: %s", exc)
        return f"Error: {exc}"

    output = stdout.getvalue().strip()
    result_text = _format_result(result) if result is not None else ""

    if output and result_text:
        return f"{output}\n{result_text}"
    if result_text:
        return result_text
    if output:
        return output
    return "OK"


@tool
async def python_repl(code: str) -> str:
    """Run Python code and return stdout plus the last expression result.

    Environment provides: yf (yfinance), pd (pandas), np (numpy), math, json,
    datetime/date/timedelta. Imports are limited to a safe allowlist.
    Note: yfinance does NOT provide index constituents (no `.constituents`).
    """
    return await asyncio.to_thread(_run_python, code)
