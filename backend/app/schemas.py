from datetime import date, datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

CurrencyCode = Literal["USD", "EUR"]
PlacementEntryKind = Literal["VALUE", "INITIAL", "INTEREST", "FEE", "CONTRIBUTION", "WITHDRAWAL"]


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


class PlacementBase(BaseModel):
    name: str = Field(..., min_length=1, description="Placement name")
    account_id: Optional[int] = Field(None, description="Account id linked to this placement")
    placement_type: Optional[str] = Field(None, description="Placement type")
    sector: Optional[str] = Field(None, description="Placement sector")
    industry: Optional[str] = Field(None, description="Placement industry")
    currency: CurrencyCode = Field("EUR", description="Currency code (USD or EUR)")
    notes: Optional[str] = Field(None, description="Optional notes")

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency_placement(cls, v: str) -> CurrencyCode:
        upper = v.upper()
        if upper not in {"USD", "EUR"}:
            raise ValueError("Currency must be USD or EUR")
        return upper  # type: ignore[return-value]

    @field_validator("name", "placement_type", "sector", "industry", "notes", mode="before")
    @classmethod
    def strip_text_placement(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = str(v).strip()
        return v or None


class PlacementCreate(PlacementBase):
    initial_value: Optional[float] = Field(None, ge=0, description="Initial placement value")
    recorded_at: Optional[datetime] = Field(None, description="Snapshot timestamp")


class PlacementUpdate(BaseModel):
    account_id: Optional[int] = Field(None, description="Account id")
    name: Optional[str] = Field(None, min_length=1)
    placement_type: Optional[str] = Field(None)
    sector: Optional[str] = Field(None)
    industry: Optional[str] = Field(None)
    currency: Optional[CurrencyCode] = Field(None)
    notes: Optional[str] = Field(None)

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency_placement_update(cls, v: Optional[str]) -> Optional[CurrencyCode]:
        if v is None:
            return None
        upper = v.upper()
        if upper not in {"USD", "EUR"}:
            raise ValueError("Currency must be USD or EUR")
        return upper  # type: ignore[return-value]

    @field_validator("name", "placement_type", "sector", "industry", "notes", mode="before")
    @classmethod
    def strip_text_placement_update(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = str(v).strip()
        return v or None


class Placement(PlacementBase):
    id: int
    initial_value: Optional[float] = None
    initial_recorded_at: Optional[datetime] = None
    total_contributions: Optional[float] = None
    total_withdrawals: Optional[float] = None
    total_interests: Optional[float] = None
    total_fees: Optional[float] = None
    current_value: Optional[float] = None
    last_snapshot_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PlacementSnapshotBase(BaseModel):
    entry_kind: PlacementEntryKind = Field(
        "VALUE", description="VALUE, INITIAL, INTEREST, FEE, CONTRIBUTION, or WITHDRAWAL"
    )
    value: float = Field(..., ge=0, description="Amount for this entry")
    recorded_at: Optional[datetime] = Field(None, description="Snapshot timestamp")


class PlacementSnapshotCreate(PlacementSnapshotBase):
    pass


class PlacementSnapshotUpdate(BaseModel):
    entry_kind: Optional[PlacementEntryKind] = None
    value: Optional[float] = Field(None, ge=0)
    recorded_at: Optional[datetime] = None


class PlacementSnapshot(PlacementSnapshotBase):
    id: int
    placement_id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PortfolioSummary(BaseModel):
    total_cost: float
    total_value: Optional[float] = None
    total_gain_abs: Optional[float] = None
    total_gain_pct: Optional[float] = None
    hourly_change_abs: Optional[float] = None
    hourly_change_pct: Optional[float] = None


class YahooFinanceStatus(BaseModel):
    ok: bool = True
    message: Optional[str] = None
    last_error_at: Optional[datetime] = None


class PortfolioResponse(BaseModel):
    summary: PortfolioSummary
    holdings: List[HoldingStats]
    accounts: List[Account] = []
    placements: List[Placement] = []
    yfinance_status: Optional[YahooFinanceStatus] = None


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


class CashMovementRequest(BaseModel):
    amount: float = Field(..., gt=0, description="Cash amount in account currency")
    direction: Literal["ADD", "WITHDRAW"] = Field(..., description="ADD or WITHDRAW")
    reason: str = Field(..., min_length=1, description="Reason for the cash movement")

    @field_validator("direction", mode="before")
    @classmethod
    def normalize_direction(cls, v: str) -> str:
        upper = str(v).strip().upper()
        if upper not in {"ADD", "WITHDRAW"}:
            raise ValueError("Direction must be ADD or WITHDRAW")
        return upper

    @field_validator("reason", mode="before")
    @classmethod
    def normalize_reason(cls, v: Optional[str]) -> str:
        if v is None:
            raise ValueError("Reason is required")
        reason = str(v).strip()
        if not reason:
            raise ValueError("Reason is required")
        return reason


class CashTransaction(BaseModel):
    id: int
    account_id: int
    amount: float
    direction: Literal["ADD", "WITHDRAW"]
    reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BackupAccount(BaseModel):
    id: int
    name: str
    account_type: Optional[str] = None
    liquidity: float
    manual_invested: float
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BackupHolding(BaseModel):
    id: int
    account_id: int
    symbol: str
    shares: float
    cost_basis: float
    acquisition_fee_value: float
    fx_rate: Optional[float] = None
    currency: str
    last_price: Optional[float] = None
    last_snapshot_at: Optional[datetime] = None
    sector: Optional[str] = None
    industry: Optional[str] = None
    asset_type: Optional[str] = None
    isin: Optional[str] = None
    acquired_at: Optional[date] = None
    mic: Optional[str] = None
    name: Optional[str] = None
    href: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BackupTransaction(BaseModel):
    id: int
    account_id: int
    symbol: str
    side: str
    shares: float
    price: float
    fee_value: float
    currency: CurrencyCode
    executed_at: Optional[date] = None
    realized_gain: Optional[float] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BackupCashTransaction(BaseModel):
    id: int
    account_id: int
    amount: float
    direction: Literal["ADD", "WITHDRAW"]
    reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BackupPayload(BaseModel):
    version: int = 1
    exported_at: datetime
    accounts: List[BackupAccount]
    holdings: List[BackupHolding]
    transactions: List[BackupTransaction]
    cash_transactions: List[BackupCashTransaction]


class BackupImportResult(BaseModel):
    accounts: int
    holdings: int
    transactions: int
    cash_transactions: int


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

class ChatRequest(BaseModel):
    session_id: Optional[str] = None
    message: str
    language: Optional[str] = Field(
        None, description="UI language code (e.g., 'en' or 'fr')")
