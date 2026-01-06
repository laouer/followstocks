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
import os
from pydantic import BaseModel, Field

from langchain_core.messages import HumanMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableConfig

from langchain_openai import ChatOpenAI, OpenAI
from langchain_community.agent_toolkits import SQLDatabaseToolkit, create_sql_agent

from langgraph.graph import START, END, StateGraph
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langchain_community.callbacks.manager import get_openai_callback
from langchain.agents import create_agent

from ..database import DATABASE_URL

CHATBOT_DB_PATH = Path(__file__).resolve().parent / "chatbot.db"


# IMPORTANT: you must provide these from your project
# from .Agents.supervisor import generate_supervisor_prompt  # not used in plan/execute version
# from ..db.sql import get_sql_db  # you must provide a SQLDatabase instance somehow

load_dotenv(override=True)
logger = logging.getLogger(__name__)

llm_model = os.getenv("OPENAI_MODEL", "azure.gpt-4o")


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
        )

        toolkit = SQLDatabaseToolkit(db=db, llm=exec_llm)
        Yahoo_tools = YahooFinanceNewsTool()

        self.sql_agent_executor = create_agent(exec_llm,
                                               toolkit.get_tools() + [Yahoo_tools],
                                               )

        # ---- prompts
        self.planner_prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are a planning module.\n"
                    "Goal: produce steps for a SQL agent to query a database and answer the user.\n\n"
                    "HARD CONSTRAINTS (must follow):\n"
                    "A) Output ONLY JSON matching Plan {{\"steps\": [..]}}.\n"
                    "B) Each step is a SINGLE executable DB question in plain English.\n"
                    "C) No meta reasoning words: analyze, think, inspect, consider, decide, determine, plan, check.\n"
                    "D) No references to SQL, tools, agents, schema, tables, columns, joins.\n"
                    "E) 1–3 steps preferred; 4 max.\n"
                    "F) If you cannot confidently form a specific DB question, write a first step that searches for the "
                    "minimum set of relevant records using the user keywords.\n\n"
                    "Examples of GOOD steps:\n"
                    "- \"What are the most recent orders for customer <name> in the last 30 days?\"\n"
                    "- \"Which properties are available in <city> between <date1> and <date2>?\"\n"
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
            "If the user request is not DB-related, return Response directly in that language. "
            "Otherwise, return ONLY the remaining steps (do not repeat completed steps)."
        )

        self.router_prompt = ChatPromptTemplate.from_messages([
            ("system",
             "Classify the user message.\n"
             "- If it requires database facts/aggregation, route='db'.\n"
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
            llm = ChatOpenAI(model=llm_model, temperature=0, streaming=False)
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
                model=llm_model, temperature=0, streaming=False
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

        question_for_agent = f"""User question:
        {state['input']}

        Subtask (answer using ONLY the database):
        {step}
        """

        result = await self.sql_agent_executor.ainvoke({"input": question_for_agent}, config)

        # AgentExecutor usually returns dict with "output"
        if isinstance(result, dict):
            output_text = (
                result.get("output")
                or result.get("final")
                or result.get("text")
                or str(result)
            )
        else:
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
                model=llm_model, temperature=0, streaming=False
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

        async for event in self.app.astream_events(initial_state, config, version="v2"):
            # This streams the messages appended by nodes (execute_step + replanner)
            if event["event"] == "on_chain_stream":
                node = event["metadata"].get("langgraph_node")
                if node in ["replanner", "router"]:
                    chunk = event["data"]["chunk"]
                    if isinstance(chunk, dict) and "messages" in chunk and chunk["messages"]:
                        last_msg = chunk["messages"][-1]
                        text = getattr(last_msg, "content", None)
                        if text:
                            yield text
