from datetime import date, datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

CurrencyCode = Literal["USD", "EUR"]


class UserBase(BaseModel):
    email: str = Field(..., min_length=3, description="Email address")
    name: Optional[str] = Field(None, description="Display name")

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        if v is None:
            raise ValueError("Email is required")
        email = str(v).strip().lower()
        if not email:
            raise ValueError("Email is required")
        return email

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        name = str(v).strip()
        return name or None


class UserCreate(UserBase):
    password: str = Field(..., min_length=8, description="Account password")


class UserPublic(UserBase):
    id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=3)
    password: str = Field(..., min_length=8)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_login_email(cls, v: str) -> str:
        if v is None:
            raise ValueError("Email is required")
        email = str(v).strip().lower()
        if not email:
            raise ValueError("Email is required")
        return email


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


class AccountBase(BaseModel):
    name: str = Field(..., min_length=1, description="Account name")
    account_type: Optional[str] = Field(None, description="Account type")
    liquidity: float = Field(0, ge=0, description="Cash available in the account currency")
    manual_invested: float = Field(0, ge=0, description="Manual cash injected into the account")

    @field_validator("name", "account_type", mode="before")
    @classmethod
    def strip_account_text(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = str(v).strip()
        return v or None


class AccountCreate(AccountBase):
    created_at: Optional[datetime] = Field(
        None,
        description="Account creation date",
    )


class AccountUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1)
    account_type: Optional[str] = Field(None)
    liquidity: Optional[float] = Field(None, ge=0)
    manual_invested: Optional[float] = Field(None, ge=0)
    created_at: Optional[datetime] = Field(None)

    @field_validator("name", "account_type", mode="before")
    @classmethod
    def strip_account_text_optional(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = str(v).strip()
        return v or None


class Account(AccountBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class HoldingBase(BaseModel):
    account_id: Optional[int] = Field(
        None,
        description="Account id that holds this position",
    )
    symbol: str = Field(..., description="Ticker symbol", examples=["AAPL"])
    shares: float = Field(..., gt=0, description="Number of shares owned")
    cost_basis: float = Field(..., gt=0, description="Cost per share at purchase")
    acquisition_fee_value: float = Field(
        0,
        ge=0,
        description="Acquisition fee amount in the holding currency",
    )
    fx_rate: Optional[float] = Field(
        None,
        gt=0,
        description="FX rate to EUR at purchase (only for non-EUR holdings)",
    )
    currency: CurrencyCode = Field("USD", description="Currency code for the holding (USD or EUR)")
    sector: Optional[str] = Field(None, description="Sector classification")
    industry: Optional[str] = Field(None, description="Industry classification")
    asset_type: Optional[str] = Field(
        None,
        description="Asset type (e.g. Equity, ETF, Livret A, LDD)",
    )
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

    @field_validator("name", "href", "sector", "industry", "asset_type", mode="before")
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
    account_id: Optional[int] = Field(None, description="Account id")
    symbol: Optional[str] = Field(None, description="Ticker symbol")
    shares: Optional[float] = Field(None, gt=0)
    cost_basis: Optional[float] = Field(None, gt=0)
    acquisition_fee_value: Optional[float] = Field(None, ge=0)
    fx_rate: Optional[float] = Field(None, gt=0, description="FX rate to EUR at purchase")
    currency: Optional[CurrencyCode] = Field(None, description="Currency code (USD or EUR)")
    sector: Optional[str] = Field(None, description="Sector classification")
    industry: Optional[str] = Field(None, description="Industry classification")
    asset_type: Optional[str] = Field(None, description="Asset type")
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

    @field_validator("name", "href", "sector", "industry", "asset_type", mode="before")
    @classmethod
    def strip_text_optional(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = str(v).strip()
        return v or None


class HoldingSellRequest(BaseModel):
    shares: float = Field(..., gt=0)
    price: float = Field(..., gt=0)
    fee_value: float = Field(0, ge=0)
    executed_at: Optional[date] = Field(None, description="Sell date")
    fx_rate: Optional[float] = Field(
        None,
        gt=0,
        description="FX rate to EUR for non-EUR holdings",
    )


class HoldingRefundRequest(BaseModel):
    fx_rate: Optional[float] = Field(
        None,
        gt=0,
        description="FX rate to EUR for non-EUR holdings",
    )


class HoldingSellResult(BaseModel):
    status: str
    realized_gain: Optional[float] = None
    remaining_shares: float = 0
    account_liquidity: Optional[float] = None


class Holding(HoldingBase):
    id: int
    created_at: datetime
    updated_at: datetime
    account: Optional[Account] = None

    model_config = ConfigDict(from_attributes=True)


class PriceSnapshotBase(BaseModel):
    price: float = Field(..., gt=0, description="Price per share at timestamp")
    recorded_at: Optional[datetime] = Field(None, description="When the price was observed")


class PriceSnapshotCreate(PriceSnapshotBase):
    holding_id: int = Field(..., description="Holding id for the snapshot")


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
    accounts: List[Account] = []


class TransactionBase(BaseModel):
    account_id: int
    symbol: str
    side: str = Field(..., description="BUY or SELL")
    shares: float = Field(..., gt=0)
    price: float = Field(..., gt=0)
    fee_value: float = Field(0, ge=0)
    currency: CurrencyCode = Field("USD", description="Currency code (USD or EUR)")
    executed_at: Optional[date] = None

    @field_validator("symbol", mode="before")
    @classmethod
    def normalize_symbol(cls, v: str) -> str:
        return str(v).strip().upper()

    @field_validator("side", mode="before")
    @classmethod
    def normalize_side(cls, v: str) -> str:
        upper = str(v).strip().upper()
        if upper not in {"BUY", "SELL"}:
            raise ValueError("Side must be BUY or SELL")
        return upper

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency_base(cls, v: str) -> CurrencyCode:
        upper = v.upper()
        if upper not in {"USD", "EUR"}:
            raise ValueError("Currency must be USD or EUR")
        return upper  # type: ignore[return-value]


class TransactionCreate(TransactionBase):
    pass


class Transaction(TransactionBase):
    id: int
    realized_gain: Optional[float] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class HoldingsImportResult(BaseModel):
    created: int
    skipped: int
    errors: List[str]


class Cac40Item(BaseModel):
    symbol: str
    name: Optional[str] = None
    currency: Optional[str] = None
    price: Optional[float] = None
    target_mean_price: Optional[float] = None
    trailing_pe: Optional[float] = None
    price_to_book: Optional[float] = None
    dividend_yield: Optional[float] = None
    market_cap: Optional[float] = None
    score: Optional[float] = None


class Cac40AnalysisResponse(BaseModel):
    metric: str
    updated_at: datetime
    items: List[Cac40Item]
