from datetime import datetime

from sqlalchemy import Column, Date, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship

from .database import Base


class Holding(Base):
    __tablename__ = "holdings"

    id = Column(Integer, primary_key=True, index=True)
    symbol = Column(String, unique=True, index=True, nullable=False)
    shares = Column(Float, nullable=False)
    cost_basis = Column(Float, nullable=False)  # per share
    currency = Column(String, default="USD", nullable=False)
    isin = Column(String, index=True, nullable=True)
    acquired_at = Column(Date, nullable=True)
    mic = Column(String, nullable=True)
    name = Column(String, nullable=True)
    href = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

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
