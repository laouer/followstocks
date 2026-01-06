from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from pathlib import Path


import sqlite3
from typing import Iterator

try:
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    SA_AVAILABLE = True
except Exception:
    SA_AVAILABLE = False
    create_engine = None  # type: ignore
    text = None  # type: ignore
    sessionmaker = None  # type: ignore


DB_PATH = Path(__file__).resolve().parent.parent / "data.db"
DATABASE_URL = f"sqlite:///{DB_PATH}"


engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def _configure_row_factory(conn) -> None:
    """Force sqlite rows to be dict-accessible even when using SQLAlchemy raw connections."""
    targets = [
        getattr(conn, "driver_connection", None),
        getattr(conn, "connection", None),
        conn,
    ]
    seen = set()
    for target in targets:
        if target is None or id(target) in seen:
            continue
        seen.add(id(target))
        try:
            target.row_factory = sqlite3.Row
        except Exception:
            continue
        
def db_session() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency yielding a SQLite connection (via SQLAlchemy engine if available)."""
    if SA_AVAILABLE and engine is not None:
        connection = engine.raw_connection()
        _configure_row_factory(connection)
    else:
        connection = sqlite3.connect(DB_PATH, check_same_thread=False)
        _configure_row_factory(connection)
    try:
        yield connection
    finally:
        connection.close()
