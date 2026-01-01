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


class Account(Base):
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    account_type = Column(String, nullable=True)
    liquidity = Column(Float, default=0.0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="accounts")
    holdings = relationship("Holding", back_populates="account", cascade="all, delete-orphan")

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
    currency = Column(String, default="USD", nullable=False)
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
    snapshots = relationship(
        "PriceSnapshot",
        back_populates="holding",
        cascade="all, delete-orphan",
        order_by="PriceSnapshot.recorded_at.desc()",
    )



class PriceSnapshot(Base):
    __tablename__ = "price_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    holding_id = Column(Integer, ForeignKey("holdings.id"), nullable=False, index=True)
    price = Column(Float, nullable=False)
    recorded_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    holding = relationship("Holding", back_populates="snapshots")

    __table_args__ = (UniqueConstraint("holding_id", "recorded_at", name="uix_snapshot_time"),)
