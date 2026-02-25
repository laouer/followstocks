"""
talk_to_my_chatbot.py

Refactor: ReAct-style supervisor/tools loop  ->  Plan-and-Execute (Planner -> Executor -> Replanner).

- Planner + Replanner use ChatOpenAI structured output (Plan / Act)
- Executor is a SQL Agent created with:
    llm = OpenAI(temperature=TEMPERATURE, model="azure.gpt-4o", max_tokens=1024)
    create_sql_agent(...)

Checkpointing: AsyncSqliteSaver (as in your current code).

Requirements (example):
    pip install langgraph langchain-core langchain-community langchain-openai
    pip install langgraph-checkpoint-postgres psycopg[binary] psycopg-pool  # only if you switch to Postgres
"""

from typing import Literal
from langchain_core.messages import HumanMessage, AIMessage
from typing import Annotated, List, Tuple, Dict
from langchain_community.utilities import SQLDatabase
from langgraph.graph.message import add_messages
from langchain_community.tools.yahoo_finance_news import YahooFinanceNewsTool

import logging
import operator
from dotenv import load_dotenv
from typing import Annotated, List, Tuple, Any, Dict
from typing_extensions import TypedDict
from pathlib import Path
import aiosqlite
import json
import os
import asyncio
import yfinance as yf
from pydantic import BaseModel, Field

from langchain_core.messages import HumanMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from langchain_openai import ChatOpenAI, OpenAI
from langchain_community.agent_toolkits import SQLDatabaseToolkit, create_sql_agent

from langgraph.graph import START, END, StateGraph
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langchain_community.callbacks.manager import get_openai_callback

from ..database import DATABASE_URL
from .yahoo_tools import YAHOO_FINANCE_TOOLS
from .python_repl_tool import python_repl, repl_prompt_context

CHATBOT_DB_PATH = Path(__file__).resolve().parent / "chatbot.db"


# IMPORTANT: you must provide these from your project
# from .Agents.supervisor import generate_supervisor_prompt  # not used in plan/execute version
# from ..db.sql import get_sql_db  # you must provide a SQLDatabase instance somehow

load_dotenv(override=True)
logger = logging.getLogger(__name__)

llm_model = os.getenv("OPENAI_MODEL", "azure.gpt-5.1")


# langgraph-checkpoint-sqlite expects aiosqlite.Connection.is_alive (missing in 0.22.x)
if not hasattr(aiosqlite.Connection, "is_alive"):
    def _is_alive(self) -> bool:
        return getattr(self, "_connection", None) is not None and getattr(self, "_running", False)

    aiosqlite.Connection.is_alive = _is_alive

# --------------------------------------------------------------------------- #
# Plan-and-Execute models (structured outputs)
# --------------------------------------------------------------------------- #


class Route(BaseModel):
    route: Literal["db", "chat"]
    chat_response: str | None = None  # only when route="chat"


class Plan(BaseModel):
    """Plan to follow in future."""

    steps: List[str] = Field(
        description="Different steps to follow, should be in sorted order"
    )


class Response(BaseModel):
    """Response to user."""

    response: str


class Act(BaseModel):
    """Action to perform."""

    action: Response | Plan = Field(
        description=(
            "Action to perform. If you want to respond to user, use Response. "
            "If you need to further use tools to get the answer, use Plan."
        )
    )


# --------------------------------------------------------------------------- #
# LangGraph State (based on Plan-and-Execute tutorial) + messages for streaming
# --------------------------------------------------------------------------- #


class State(TypedDict):
    # Keep messages so you can preserve chat context and stream like your current code
    # (append-only reducer like your existing setup)
    # reducer is supplied via add_messages in graph setup
    messages: Annotated[list, Any]

    # Plan-and-execute fields
    input: str
    plan: List[str]
    past_steps: Annotated[List[Tuple[str, str]], operator.add]
    response: str
    language: str


PORTFOLIO_AGENT_PREFIX = (
    """
You are a portfolio analyst assistant.

You have access to:
1) A SQL database (dialect: {dialect}) containing the user’s:
   - Accounts
   - Holdings
   - Transactions
   - Historical price snapshots

2) Yahoo Finance tools for:
   - Market prices (non–real-time)
   - Company profiles
   - Financials
   - Index data
   - News

GENERAL DATA RULES
- Use the SQL database **exclusively** for user-specific portfolio data.
- Use Yahoo Finance tools **only** for external market data or company information.
- Never fabricate prices, returns, dates, tickers, or financial metrics.
- If data is missing, unavailable, or stale, state this explicitly.

DATABASE USAGE RULES
- Query the database whenever the question involves the user’s portfolio.
- Unless explicitly requested otherwise, limit queries to **at most {top_k} rows**.
- Select only the columns required to answer the question.
- Prefer aggregated queries over raw transaction dumps.
- Do not guess portfolio values without database confirmation.

MARKET DATA RULES (Yahoo Finance)
- Quotes are not real-time; use the latest available Yahoo Finance data.
- If the user provides a company name without a ticker:
  → First call `yahoo_search` to resolve the symbol.
- When market data is requested, **always call the appropriate Yahoo Finance tool**.
- Do not respond with “I cannot access market data” if a tool exists.
- If a tool fails or returns no data:
  → Say so briefly and continue with any partial data available.

INDEX DATA RULES
- If the user asks for index quotes but does not specify which indices:
  → Ask once for the list and stop.

TOOL DISCIPLINE
- Available Yahoo Finance tools:
  {{'\n'.join([tool.name for tool in YAHOO_FINANCE_TOOLS ])}}
- Use tools deliberately and only when needed.
- Do not call multiple tools if a single tool suffices.
- You may use the Python REPL (`python_repl`) for:
  - Portfolio metrics
  - Return calculations
  - Allocations
  - Risk or performance summaries

RESPONSE STYLE
- Keep responses factual, concise, and neutral.
- Prefer:
  - Tables
  - Bullet points
  - Short declarative sentences
- Avoid speculation, hype, opinions, or long explanations.
- Combine sources only when necessary.
- Clearly label assumptions and data sources when used.

EXECUTION PRIORITY
1) Database (for user data)
2) Yahoo Finance tools (for market data)
3) Python REPL (for calculations)

{{repl_prompt_context}}
    """

)

PORTFOLIO_AGENT_SUFFIX = (
    "Use the available tools to gather facts. "
    "Return concise, structured results that can be summarized later."
)


# --------------------------------------------------------------------------- #
# ChatBot
# --------------------------------------------------------------------------- #

db = SQLDatabase.from_uri(DATABASE_URL)
"""
talk_to_my_chatbot.py

Plan-and-Execute LangGraph:
START -> planner -> execute_step -> replanner -> (execute_step | END)

- Planner/Replanner: ChatOpenAI structured output
- Executor: SQL agent created with OpenAI(...) + create_sql_agent(...)
- Checkpointing: AsyncSqliteSaver
"""


load_dotenv(override=True)
logger = logging.getLogger(__name__)


# -----------------------------
# Structured outputs
# -----------------------------
class Plan(BaseModel):
    steps: List[str] = Field(description="Steps to follow in order")


class Response(BaseModel):
    response: str


class Act(BaseModel):
    action: Response | Plan = Field(
        description="If done, return Response. Otherwise return Plan with remaining steps."
    )


# -----------------------------
# LangGraph state with VALID reducers
# -----------------------------
class State(TypedDict):
    # ✅ reducer is add_messages (binary reducer)
    messages: Annotated[list, add_messages]
    input: str
    plan: List[str]
    past_steps: Annotated[List[Tuple[str, str]],
                          operator.add]  # ✅ operator.add is binary
    response: str
    language: str


class ChatBot:
    def __init__(
        self,
        *,
        verbose: bool = True,
        TEMPERATURE: float = 0.0,
    ) -> None:
        self.verbose = verbose

        # ---- checkpointing
        self._checkpointer_cm = AsyncSqliteSaver.from_conn_string(
            CHATBOT_DB_PATH)
        self._checkpointer = None
        self.memory = None

        # ---- per-thread chat models (planner/replanner)
        self.planner_llm: Dict[str, ChatOpenAI] = {}
        self.replanner_llm: Dict[str, ChatOpenAI] = {}

        # ---- SQL agent executor (as requested)
        exec_llm = ChatOpenAI(
            model=llm_model,
            temperature=TEMPERATURE,
            max_tokens=1024,
            streaming=True,
        )

        toolkit = SQLDatabaseToolkit(db=db, llm=exec_llm)
        extra_tools = [*YAHOO_FINANCE_TOOLS, python_repl]

        self.sql_agent_executor = create_sql_agent(
            llm=exec_llm,
            toolkit=toolkit,
            agent_type="tool-calling",
            verbose=self.verbose,
            agent_executor_kwargs={"handle_parsing_errors": True},
            extra_tools=extra_tools,
            prefix=PORTFOLIO_AGENT_PREFIX,
            suffix=PORTFOLIO_AGENT_SUFFIX,
        )

        # ---- prompts
        self.planner_prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are a planning module.\n"
                    "Goal: produce steps to answer questions about the user's portfolio and/or market data.\n"
                    "You can use the portfolio database for user-specific holdings and Yahoo Finance tools for market data,\n"
                    "fundamentals, holders, options, earnings, and news.\n\n"
                    "HARD CONSTRAINTS (must follow):\n"
                    "A) Output ONLY JSON matching Plan {{\"steps\": [..]}}.\n"
                    "B) Each step is a SINGLE executable lookup or question in plain English.\n"
                    "C) No meta reasoning words: analyze, think, inspect, consider, decide, determine, plan, check.\n"
                    "D) No references to SQL, schema, tables, columns, joins. You may mention 'portfolio database' or 'Yahoo Finance tools'.\n"
                    "E) 1–3 steps preferred; 4 max.\n"
                    "F) If you cannot confidently form a specific lookup, write a first step that searches the portfolio "
                    "database for the minimum set of relevant records using the user keywords.\n\n"
                    "Tool selection guidance:\n"
                    "- Use portfolio database when the question depends on the user's holdings, accounts, cash, or transactions.\n"
                    "- If a company name is given without ticker, use yahoo_search first to resolve the symbol.\n"
                    "- Use yahoo_stock_price for recent Close/Volume history.\n"
                    "- Use yahoo_batch_fast_info for multiple tickers at once.\n"
                    "- Use yahoo_financial_statements for balance sheet snapshots.\n"
                    "- Use yahoo_recent_news for latest headlines.\n"
                    "- Use other Yahoo Finance tools for quotes, fundamentals, holders, earnings, options, or news.\n"
                    "- Use the Python REPL tool only for custom yfinance queries or calculations when no direct tool fits.\n"
                    "- Note: yfinance does NOT provide index constituents; require an explicit list of tickers.\n"
                    "- Combine both if portfolio context + market data are needed.\n\n"
                    "Examples of GOOD steps:\n"
                    "- \"Get the user's top 5 holdings by market value from the portfolio database.\"\n"
                    "- \"Search Yahoo Finance for Tesla to get the ticker.\"\n"
                    "- \"Get recent Close/Volume history for TSLA with yahoo_stock_price.\"\n"
                    "- \"Get the latest analyst price targets for NVDA.\"\n"
                    "- \"Fetch recent news for AAPL with yahoo_recent_news.\"\n"
                    "Examples of BAD steps:\n"
                    "- \"Inspect the schema\" / \"Figure out the tables\" / \"Write SQL\".\n",
                ),
                ("placeholder", "{messages}"),
            ]
        )

        self.replanner_prompt = ChatPromptTemplate.from_template(
            "Objective:\n{input}\n\n"
            "User language: {language}\n"
            "Completed steps (step, result):\n{past_steps}\n\n"
            "If you can answer now, return a final response in the user language. "
            "If the user request is not data-related, return Response directly in that language. "
            "If more information is needed from the portfolio database, Yahoo Finance tools, or Python REPL, "
            "return ONLY the remaining steps (do not repeat completed steps). "
            "Do NOT ask the user to pick from a list unless the request is ambiguous or a required ticker list is missing. "
            "Prefer to proceed with the required tool steps to answer the question, "
            "and do not instruct the user to manually visit external sites. "
            "Final response must be factual, concise, and simple (short sentences or bullets). "
            "Do NOT claim you cannot access market data; use the tools and only report tool errors if they occur."
        )

        self.router_prompt = ChatPromptTemplate.from_messages([
            ("system",
             "Classify the user message.\n"
             "- If it requires portfolio data, market data, or financial analysis, route='db'.\n"
             "- If it's smalltalk/chitchat/meta/help, route='chat' and provide a short helpful reply.\n"
             "Return ONLY JSON matching Route.\n"
             "Always write chat_response in the user's language: {language}."),
            ("placeholder", "{messages}")
        ])

        # ---- build graph (ONE graph only)
        self.workflow = StateGraph(State)

        self.workflow.add_node("router", self.router_node)
        self.workflow.add_node("planner", self.planner_node)
        self.workflow.add_node("execute_step", self.execute_step_node)
        self.workflow.add_node("replanner", self.replanner_node)

        self.workflow.add_edge(START, "router")
        self.workflow.add_edge("planner", "execute_step")
        self.workflow.add_edge("execute_step", "replanner")

        def route_after_router(state: State) -> str:
            return "end" if state.get("response") else "db"

        self.workflow.add_conditional_edges(
            "router",
            route_after_router,
            {"end": END, "db": "planner"},
        )

        self.app = None

    async def initialize(self) -> None:
        self._checkpointer = await self._checkpointer_cm.__aenter__()
        self.memory = self._checkpointer
        self.app = self.workflow.compile(
            checkpointer=self.memory, debug=self.verbose)

    async def close(self) -> None:
        if getattr(self, "_checkpointer_cm", None) is not None:
            await self._checkpointer_cm.__aexit__(None, None, None)

    # -----------------------------
    # router
    # -----------------------------
    def should_continue(self, state: State) -> str:
        if state.get("response"):
            return "end"
        if state.get("plan"):
            return "execute"
        return "end"

    # -----------------------------
    # nodes
    # -----------------------------

    async def router_node(self, state: State, config: RunnableConfig) -> dict:
        thread_id = (
            config.get("configurable", {}).get("thread_id")
            or config.get("metadata", {}).get("thread_id")
            or "default"
        )

        # Reuse planner_llm or create a dedicated one
        llm = self.planner_llm.get(thread_id)
        if llm is None:
            llm = ChatOpenAI(model=llm_model, temperature=0, streaming=True)
            self.planner_llm[thread_id] = llm

        router = self.router_prompt | llm.with_structured_output(
            Route, strict=True)
        r: Route = await router.ainvoke(
            {"messages": state["messages"],
                "language": state.get("language", "en")},
            config,
        )

        if r.route == "chat":
            lang = (state.get("language") or "en").lower()
            fallback = "Salut ! Comment puis-je vous aider ?" if lang.startswith(
                "fr") else "Hi! How can I help?"
            text = r.chat_response or fallback
            return {"response": text, "plan": [], "messages": [AIMessage(content=text)]}

        return {}  # continue to planner

    async def planner_node(self, state: State, config: RunnableConfig) -> dict:
        thread_id = (
            config.get("configurable", {}).get("thread_id")
            or config.get("metadata", {}).get("thread_id")
            or "default"
        )

        if thread_id not in self.planner_llm:
            self.planner_llm[thread_id] = ChatOpenAI(
                model=llm_model, temperature=0, streaming=True
            )

        planner = (self.planner_prompt
                   | self.planner_llm[thread_id].with_structured_output(
                       Plan,
                       strict=True,  # 🔐 interdit toute sortie non conforme
                   )
                   )

        plan_obj: Plan = await planner.ainvoke(
            {"messages": state["messages"],
                "language": state.get("language", "en")},
            config,
        )

        return {"plan": plan_obj.steps, "response": ""}

    async def execute_step_node(self, state: State, config: RunnableConfig) -> dict:
        if not state.get("plan"):
            return {}

        step = state["plan"][0]
        remaining = state["plan"][1:]

        question_for_agent = f"""User question (language={state.get('language', 'en')}):
        {state['input']}

        Context:
        - Use the portfolio database for user-specific holdings, accounts, cash, or transactions.
        - Use Yahoo Finance tools for market data, fundamentals, holders, options, earnings, or news.
        - If a company name is provided without a ticker, use yahoo_search first.
        - For multiple tickers, prefer yahoo_batch_fast_info.
        - Use Python REPL only when no direct tool fits, and obey its allowed imports/builtins.
        - yfinance does NOT provide index constituents; require an explicit ticker list if missing.

        Subtask:
        {step}
        """

        result = await self.sql_agent_executor.ainvoke({"input": question_for_agent}, config)

        # AgentExecutor may return a dict or an AgentFinish-like object depending on runtime versions.
        if isinstance(result, dict):
            output_text = (
                result.get("output")
                or result.get("final")
                or result.get("text")
            )
        else:
            output_text = None
            return_values = getattr(result, "return_values", None)
            if isinstance(return_values, dict):
                output_text = (
                    return_values.get("output")
                    or return_values.get("final")
                    or return_values.get("text")
                )
            if not output_text:
                output_attr = getattr(result, "output", None)
                if isinstance(output_attr, str) and output_attr.strip():
                    output_text = output_attr

        if not output_text:
            output_text = str(result)

        return {
            "plan": remaining,
            "past_steps": [(step, output_text)],
            # optional: add trace message
            "messages": [AIMessage(content=f"[Step]\n{step}\n\n[Result]\n{output_text}")],
        }

    async def replanner_node(self, state: State, config: RunnableConfig) -> dict:
        thread_id = (
            config.get("configurable", {}).get("thread_id")
            or config.get("metadata", {}).get("thread_id")
            or "default"
        )

        if thread_id not in self.replanner_llm:
            self.replanner_llm[thread_id] = ChatOpenAI(
                model=llm_model, temperature=0, streaming=True
            )

        replanner = self.replanner_prompt | self.replanner_llm[thread_id].with_structured_output(
            Act)

        act: Act = await replanner.ainvoke(
            {
                "input": state["input"],
                "past_steps": state.get("past_steps", []),
                "language": state.get("language", "en"),
            },
            config,
        )

        if isinstance(act.action, Response):
            final_text = act.action.response
            return {"response": final_text, "plan": [], "messages": [AIMessage(content=final_text)]}

        return {"plan": act.action.steps, "response": ""}

    # -----------------------------
    # public streaming API
    # -----------------------------
    async def response_llm(self, thread_id: str, question: str, language: str = "en"):
        if self.app is None:
            raise RuntimeError(
                "ChatBot not initialized. Call await bot.initialize() first.")

        config = {"configurable": {"thread_id": thread_id},
                  "metadata": {"thread_id": thread_id}}

        initial_state = {
            "messages": [HumanMessage(content=[{"type": "text", "text": question}])],
            "input": question,
            "plan": [],
            "past_steps": [],
            "response": "",
            "language": language or "en",
        }

        def _shorten(value: object, limit: int = 600) -> str:
            text = str(value)
            return text if len(text) <= limit else text[:limit] + "..."

        def _as_json(value: object) -> str:
            try:
                return json.dumps(value, ensure_ascii=True)
            except Exception:
                return _shorten(value)

        def _format_state_event(event: dict) -> str | None:
            event_type = event.get("event")
            meta = event.get("metadata") or {}
            node = meta.get("langgraph_node")
            data = event.get("data") or {}

            if event_type == "on_chain_start" and node:
                return f"\n[state] {node}: start\n"

            if event_type == "on_chain_end" and node:
                output = data.get("output") if isinstance(data, dict) else None
                if node == "planner" and isinstance(output, dict):
                    steps = output.get("plan")
                    if steps:
                        return f"\n[planning] steps: {_as_json(steps)}\n"
                if node == "execute_step" and isinstance(output, dict):
                    past_steps = output.get("past_steps") or []
                    if past_steps:
                        step, result = past_steps[-1]
                        return (
                            f"\n[execute_step] {step}\n"
                            f"[result] {_shorten(result)}\n"
                        )
                if node == "replanner" and isinstance(output, dict):
                    remaining = output.get("plan")
                    if remaining:
                        return f"\n[replanner] remaining steps: {_as_json(remaining)}\n"
                return f"\n[state] {node}: end\n"

            if event_type == "on_tool_start":
                tool_name = event.get("name") or meta.get(
                    "name") or meta.get("tool_name")
                tool_input = data.get("input") if isinstance(
                    data, dict) else data
                return f"\n[tool:start] {tool_name} input={_shorten(tool_input)}\n"

            if event_type == "on_tool_end":
                tool_name = event.get("name") or meta.get(
                    "name") or meta.get("tool_name")
                tool_output = data.get("output") if isinstance(
                    data, dict) else data
                return f"\n[tool:end] {tool_name} output={_shorten(tool_output)}\n"

            if event_type == "on_tool_error":
                tool_name = event.get("name") or meta.get(
                    "name") or meta.get("tool_name")
                error = data.get("error") if isinstance(data, dict) else data
                return f"\n[tool:error] {tool_name} error={_shorten(error)}\n"

            return None

        def _extract_text(value: object) -> str | None:
            if value is None:
                return None
            if isinstance(value, str):
                text = value.strip()
                return text or None
            if isinstance(value, dict):
                return (
                    _extract_text(value.get("text"))
                    or _extract_text(value.get("content"))
                )
            if isinstance(value, list):
                parts: list[str] = []
                for item in value:
                    if isinstance(item, str):
                        parts.append(item)
                        continue
                    if isinstance(item, dict):
                        maybe_text = item.get("text")
                        if not maybe_text:
                            maybe_text = item.get("content")
                        if maybe_text:
                            parts.append(str(maybe_text))
                joined = "".join(parts).strip()
                return joined or None
            return None

        emitted_chunks = 0
        stream_event_count = 0
        observed_nodes: set[str] = set()
        final_response: str | None = None
        model_stream_active = False
        model_stream_probe = ""
        model_stream_blocked = False

        async for event in self.app.astream_events(initial_state, config, version="v2"):
            event_type = event.get("event")
            metadata = event.get("metadata") or {}
            node = metadata.get("langgraph_node")
            if node:
                observed_nodes.add(node)

            if event_type == "on_chat_model_stream":
                if node not in {"replanner"}:
                    continue
                data = event.get("data") or {}
                model_chunk = data.get("chunk") if isinstance(data, dict) else None
                token_text: str | None = None
                if model_chunk is not None:
                    token_text = _extract_text(getattr(model_chunk, "content", None))
                    if not token_text and isinstance(model_chunk, dict):
                        token_text = _extract_text(
                            model_chunk.get("content") or model_chunk.get("text")
                        )
                if token_text:
                    if model_stream_blocked:
                        continue
                    model_stream_probe += token_text
                    probe = model_stream_probe.lstrip()
                    # Structured-output chunks start with JSON; don't stream that to end users.
                    if probe and probe[0] in "{[":
                        model_stream_blocked = True
                        continue
                    model_stream_active = True
                    emitted_chunks += 1
                    yield token_text
                    continue

            if event_type == "on_chain_stream":
                if model_stream_active:
                    continue
                if node not in {"router", "replanner"}:
                    continue
                stream_event_count += 1
                data = event.get("data") or {}
                chunk = data.get("chunk") if isinstance(data, dict) else None
                streamed_text: str | None = None

                if isinstance(chunk, dict):
                    streamed_text = _extract_text(chunk.get("response"))
                    if not streamed_text:
                        messages = chunk.get("messages")
                        if isinstance(messages, list) and messages:
                            last_msg = messages[-1]
                            streamed_text = _extract_text(getattr(last_msg, "content", None))
                elif chunk is not None:
                    streamed_text = _extract_text(chunk)

                if streamed_text:
                    emitted_chunks += 1
                    yield streamed_text
                    continue

            if event_type == "on_chain_end":
                data = event.get("data") or {}
                output = data.get("output") if isinstance(data, dict) else None
                if isinstance(output, dict):
                    maybe_final = _extract_text(output.get("response"))
                    if maybe_final:
                        final_response = maybe_final

        if emitted_chunks == 0:
            if final_response:
                logger.info(
                    "chatbot stream fallback thread_id=%s stream_events=%s nodes=%s chars=%s",
                    thread_id,
                    stream_event_count,
                    ",".join(sorted(observed_nodes)),
                    len(final_response),
                )
                yield final_response
            else:
                logger.warning(
                    "chatbot stream empty thread_id=%s stream_events=%s nodes=%s",
                    thread_id,
                    stream_event_count,
                    ",".join(sorted(observed_nodes)),
                )
                yield (
                    "Desole, je n'ai pas pu generer une reponse pour le moment."
                    if (language or "en").lower().startswith("fr")
                    else "Sorry, I could not generate a response right now."
                )
