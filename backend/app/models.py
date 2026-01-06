from datetime import datetime

from sqlalchemy import Column, Date, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=True)
    hashed_password = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    holdings = relationship("Holding", back_populates="user", cascade="all, delete-orphan")
    accounts = relationship("Account", back_populates="user", cascade="all, delete-orphan")
    transactions = relationship("Transaction", back_populates="user", cascade="all, delete-orphan")
    cash_transactions = relationship(
        "CashTransaction", back_populates="user", cascade="all, delete-orphan"
    )
    placements = relationship("Placement", back_populates="user", cascade="all, delete-orphan")


class Account(Base):
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    account_type = Column(String, nullable=True)
    liquidity = Column(Float, default=0.0, nullable=False)
    manual_invested = Column(Float, default=0.0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="accounts")
    holdings = relationship("Holding", back_populates="account", cascade="all, delete-orphan")
    placements = relationship("Placement", back_populates="account", cascade="all, delete-orphan")
    transactions = relationship("Transaction", back_populates="account", cascade="all, delete-orphan")
    cash_transactions = relationship(
        "CashTransaction", back_populates="account", cascade="all, delete-orphan"
    )

    __table_args__ = (UniqueConstraint("user_id", "name", name="uix_account_user_name"),)


class Holding(Base):
    __tablename__ = "holdings"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False, index=True)
    symbol = Column(String, index=True, nullable=False)
    shares = Column(Float, nullable=False)
    cost_basis = Column(Float, nullable=False)  # per share
    acquisition_fee_value = Column(Float, default=0.0, nullable=False)
    fx_rate = Column(Float, nullable=True)
    currency = Column(String, default="USD", nullable=False)
    last_price = Column(Float, nullable=True)
    last_snapshot_at = Column(DateTime, nullable=True)
    sector = Column(String, nullable=True)
    industry = Column(String, nullable=True)
    asset_type = Column(String, nullable=True)
    isin = Column(String, index=True, nullable=True)
    acquired_at = Column(Date, nullable=True)
    mic = Column(String, nullable=True)
    name = Column(String, nullable=True)
    href = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="holdings")
    account = relationship("Account", back_populates="holdings")


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False, index=True)
    symbol = Column(String, index=True, nullable=False)
    side = Column(String, nullable=False)  # BUY or SELL
    shares = Column(Float, nullable=False)
    price = Column(Float, nullable=False)
    fee_value = Column(Float, default=0.0, nullable=False)
    currency = Column(String, default="USD", nullable=False)
    executed_at = Column(Date, nullable=True)
    realized_gain = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="transactions")
    account = relationship("Account", back_populates="transactions")


class CashTransaction(Base):
    __tablename__ = "cash_transactions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False, index=True)
    amount = Column(Float, nullable=False)
    direction = Column(String, nullable=False)  # ADD or WITHDRAW
    reason = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="cash_transactions")
    account = relationship("Account", back_populates="cash_transactions")


class Placement(Base):
    __tablename__ = "placements"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True, index=True)
    name = Column(String, nullable=False)
    placement_type = Column(String, nullable=True)
    sector = Column(String, nullable=True)
    industry = Column(String, nullable=True)
    currency = Column(String, default="EUR", nullable=False)
    initial_value = Column(Float, nullable=True)
    initial_recorded_at = Column(DateTime, nullable=True)
    total_contributions = Column(Float, nullable=True)
    total_withdrawals = Column(Float, nullable=True)
    total_interests = Column(Float, nullable=True)
    total_fees = Column(Float, nullable=True)
    current_value = Column(Float, nullable=True)
    last_snapshot_at = Column(DateTime, nullable=True)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="placements")
    account = relationship("Account", back_populates="placements")
    snapshots = relationship(
        "PlacementSnapshot", back_populates="placement", cascade="all, delete-orphan"
    )


class PlacementSnapshot(Base):
    __tablename__ = "placement_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    placement_id = Column(Integer, ForeignKey("placements.id"), nullable=False, index=True)
    entry_kind = Column(String, default="VALUE", nullable=False)
    value = Column(Float, nullable=False)
    recorded_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    placement = relationship("Placement", back_populates="snapshots")
