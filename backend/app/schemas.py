from datetime import date, datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

CurrencyCode = Literal["USD", "EUR"]


class HoldingBase(BaseModel):
    symbol: str = Field(..., description="Ticker symbol", examples=["AAPL"])
    shares: float = Field(..., gt=0, description="Number of shares owned")
    cost_basis: float = Field(..., gt=0, description="Cost per share at purchase")
    currency: CurrencyCode = Field("USD", description="Currency code for the holding (USD or EUR)")
    name: Optional[str] = Field(None, description="Instrument name")
    href: Optional[str] = Field(None, description="Euronext instrument link")
    isin: Optional[str] = Field(None, description="ISIN identifier if available")
    mic: Optional[str] = Field(None, description="Market identifier code")
    acquired_at: Optional[date] = Field(None, description="Acquisition date")

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, v: str) -> CurrencyCode:
        upper = v.upper()
        if upper not in {"USD", "EUR"}:
            raise ValueError("Currency must be USD or EUR")
        return upper  # type: ignore[return-value]

    @field_validator("name", "href", mode="before")
    @classmethod
    def strip_text(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = str(v).strip()
        return v or None


class HoldingCreate(HoldingBase):
    @field_validator("isin", mode="before")
    @classmethod
    def normalize_isin(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return v.strip().upper() or None

    @field_validator("mic", mode="before")
    @classmethod
    def normalize_mic(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return v.strip().upper() or None


class HoldingUpdate(BaseModel):
    symbol: Optional[str] = Field(None, description="Ticker symbol")
    shares: Optional[float] = Field(None, gt=0)
    cost_basis: Optional[float] = Field(None, gt=0)
    currency: Optional[CurrencyCode] = Field(None, description="Currency code (USD or EUR)")
    isin: Optional[str] = Field(None, description="ISIN identifier")
    mic: Optional[str] = Field(None, description="Market identifier code")
    name: Optional[str] = Field(None, description="Instrument name")
    href: Optional[str] = Field(None, description="Euronext link")
    acquired_at: Optional[date] = Field(None, description="Acquisition date")

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, v: Optional[str]) -> Optional[CurrencyCode]:
        if v is None:
            return None
        upper = v.upper()
        if upper not in {"USD", "EUR"}:
            raise ValueError("Currency must be USD or EUR")
        return upper  # type: ignore[return-value]

    @field_validator("isin", mode="before")
    @classmethod
    def normalize_isin(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return v.strip().upper() or None

    @field_validator("mic", mode="before")
    @classmethod
    def normalize_mic(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return v.strip().upper() or None

    @field_validator("name", "href", mode="before")
    @classmethod
    def strip_text_optional(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = str(v).strip()
        return v or None


class Holding(HoldingBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PriceSnapshotBase(BaseModel):
    price: float = Field(..., gt=0, description="Price per share at timestamp")
    recorded_at: Optional[datetime] = Field(None, description="When the price was observed")


class PriceSnapshotCreate(PriceSnapshotBase):
    symbol: str = Field(..., description="Ticker symbol for the snapshot")


class PriceSnapshot(PriceSnapshotBase):
    id: int
    holding_id: int
    recorded_at: datetime

    model_config = ConfigDict(from_attributes=True)


class HoldingStats(Holding):
    last_price: Optional[float] = None
    last_snapshot_at: Optional[datetime] = None
    market_value: Optional[float] = None
    gain_abs: Optional[float] = None
    gain_pct: Optional[float] = None
    hourly_change: Optional[float] = None
    hourly_change_pct: Optional[float] = None


class PortfolioSummary(BaseModel):
    total_cost: float
    total_value: Optional[float] = None
    total_gain_abs: Optional[float] = None
    total_gain_pct: Optional[float] = None
    hourly_change_abs: Optional[float] = None
    hourly_change_pct: Optional[float] = None


class PortfolioResponse(BaseModel):
    summary: PortfolioSummary
    holdings: List[HoldingStats]
