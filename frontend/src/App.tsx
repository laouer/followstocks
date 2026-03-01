import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject } from "react";
import Highcharts from "highcharts/highstock";
import HighchartsDrilldown from "highcharts/modules/drilldown";
import HighchartsReact from "highcharts-react-official";
import { useNavigate } from "react-router-dom";
import ChatWidget from "./chat/ChatWidget";
import {
  PortfolioResponse,
  DailyHistoryResponse,
  HoldingStats,
  Placement,
  PlacementSnapshot,
  Account,
  AuthUser,
  API_BASE,
  loginUser,
  registerUser,
  fetchCurrentUser,
  storeAuthToken,
  clearAuthToken,
  getStoredAuthToken,
  fetchPortfolio,
  fetchDailyHistory,
  exportBackupJson,
  importBackupJson,
  createAccount,
  updateAccount,
  moveAccountCash,
  deleteAccount,
  createHolding,
  updateHolding,
  searchInstruments,
  deleteHolding,
  addPriceSnapshot,
  fetchFxRate,
  sellHolding,
  refundHolding,
  createPlacement,
  updatePlacement,
  deletePlacement,
  fetchPlacementSnapshots,
  addPlacementSnapshot,
  updatePlacementSnapshot,
  deletePlacementSnapshot,
  runYahooTargetsAgent,
  refreshHoldingsPrices,
} from "./api";

const applyDrilldown =
  (HighchartsDrilldown as unknown as { default?: (hc: typeof Highcharts) => void })
    .default || (HighchartsDrilldown as unknown as (hc: typeof Highcharts) => void);
if (typeof applyDrilldown === "function") {
  applyDrilldown(Highcharts);
}

type Status = {
  kind: "idle" | "loading" | "success" | "error";
  message?: string;
};

type SearchItem = {
  symbol: string;
  name: string;
  isin?: string;
  mic?: string;
  href?: string;
  exchange?: string;
  sector?: string;
  industry?: string;
  typeDisp?: string;
  quoteType?: string;
};

type SortField =
  | "instrument"
  | "account"
  | "acquired_at"
  | "shares"
  | "cost"
  | "last_price"
  | "value"
  | "pl";
type AccountSortField =
  | "name"
  | "type"
  | "manual_invested"
  | "holdings"
  | "liquidity"
  | "total"
  | "performance";
type AccountRow = {
  account: Account;
  holdingsValue: number;
  placementsValue: number;
  allocationValue: number;
  allocationPercent: number | null;
  totalValue: number;
  holdingsCount: number;
  placementsCount: number;
  manualInvested: number;
  performance: number;
  performanceRatio: number | null;
};
type AuthMode = "login" | "register";
type ChartGroupBy = "holding" | "account" | "asset_type" | "sector" | "industry";
type HelpTargetRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};
type TourStep = {
  id: string;
  title: string;
  body: string;
  targetRef: RefObject<HTMLElement>;
  requiresAccountModal?: boolean;
  requiresAddHoldingModal?: boolean;
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const BAR_VALUE_LABEL_ROTATION = -45;
const CHAT_API_BASE = API_BASE;
const CHAT_TRANSLATOR = (value: string) => value;
const resolveChatLang = () => {
  if (typeof navigator === "undefined" || !navigator.language) return "en";
  return navigator.language.split("-")[0] || "en";
};
const ALLOCATION_COLORS = [
  "#22c55e",
  "#0ea5e9",
  "#a855f7",
  "#f97316",
  "#fcd34d",
  "#38bdf8",
  "#34d399",
  "#ef4444",
  "#10b981",
  "#3b82f6",
  "#ec4899",
  "#6366f1",
  "#14b8a6",
  "#f59e0b",
  "#8b5cf6",
  "#22d3ee",
  "#84cc16",
  "#fb7185",
  "#c084fc",
  "#f43f5e",
  "#fda4af",
  "#fb7185",
  "#f87171",
  "#fbbf24",
  "#f472b6",
  "#eab308",
  "#a3e635",
  "#4ade80",
  "#34d399",
  "#2dd4bf",
  "#5eead4",
  "#38bdf8",
  "#60a5fa",
  "#818cf8",
  "#a78bfa",
  "#c4b5fd",
  "#f0abfc",
  "#fda4af",
  "#fb923c",
  "#fdba74",
  "#bef264",
  "#86efac",
  "#93c5fd",
  "#c7d2fe",
  "#f9a8d4",
  "#fde047",
  "#7dd3fc",
  "#67e8f9",
  "#5eead4",
  "#facc15",
];
const CHART_GROUP_OPTIONS: Array<{ value: ChartGroupBy; label: string }> = [
  { value: "holding", label: "Holding" },
  { value: "account", label: "Account" },
  { value: "asset_type", label: "Type" },
  { value: "sector", label: "Sector" },
  { value: "industry", label: "Industry" },
];
const CASH_REASON_OPTIONS = {
  add: [
    "Contribution",
    "Dividend",
    "Interest",
    "Refund",
    "Transfer in",
    "Correction",
    "Other",
  ],
  withdraw: [
    "Withdrawal",
    "Fee",
    "Tax",
    "Transfer out",
    "Correction",
    "Other",
  ],
} as const;
const CASH_REASON_DEFAULT = {
  add: "Contribution",
  withdraw: "Withdrawal",
} as const;
const PLACEMENT_TYPE_OPTIONS = ["Assurance vie", "Livret A", "LDD", "Compte a terme"];
const LOSS_COLOR = "#fb7185";
const YFINANCE_WARNING_FALLBACK =
  "Last prices are not updated because Yahoo Finance is unreachable (connection lost or blocked).";
const HISTORY_DAY_OPTIONS = [30, 90, 180, 365];
const HISTORY_SERIES_GLOBAL = "global";
const HISTORY_SERIES_PREFIX = "stock:";

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(2)}%`;
};

const formatPercentSigned = (value?: number | null) => {
  if (value === null || value === undefined) return "—";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(value) * 100).toFixed(2)}%`;
};

const formatMoney = (value?: number | null, currency = "EUR") => {
  if (value === null || value === undefined) return "—";
  if (currency === "EUR") {
    return `${value.toLocaleString("fr-FR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })} €`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
};

const formatMoneySigned = (value?: number | null, currency = "EUR") => {
  if (value === null || value === undefined) return formatMoney(value, currency);
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatMoney(Math.abs(value), currency)}`;
};

const formatDateTime = (value?: string | null) => {
  if (!value) return "—";
  return new Date(value).toLocaleString();
};

const formatDateTimeLocal = (value = new Date()) => {
  const pad = (num: number) => String(num).padStart(2, "0");
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hours = pad(value.getHours());
  const minutes = pad(value.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const formatDateInput = (value = new Date()) => {
  const pad = (num: number) => String(num).padStart(2, "0");
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  return `${year}-${month}-${day}`;
};

const formatDate = (value?: string | null) => {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
};

const getInitials = (email?: string | null) => {
  const base = (email || "User").split("@")[0];
  const parts = base.split(/[.\s_-]+/).filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "U";
};

function App() {
  const navigate = useNavigate();
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [dailyHistory, setDailyHistory] = useState<DailyHistoryResponse | null>(null);
  const [dailyHistoryLoading, setDailyHistoryLoading] = useState(false);
  const [dailyHistoryDays, setDailyHistoryDays] = useState(180);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [authToken, setAuthToken] = useState<string | null>(() => getStoredAuthToken());
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [authStatus, setAuthStatus] = useState<Status>({ kind: "idle" });
  const [holdingForm, setHoldingForm] = useState({
    symbol: "",
    price_tracker: "yahoo",
    tracker_symbol: "",
    shares: "",
    cost_basis: "",
    acquisition_fee_value: "",
    currency: "EUR",
    fx_rate: "",
    sector: "",
    industry: "",
    asset_type: "",
    account_id: "",
    isin: "",
    mic: "",
    name: "",
    href: "",
    acquired_at: "",
    manualPriceEnabled: false,
    manualLastPrice: "",
    manualLastPriceAt: formatDateTimeLocal(),
  });
  const [shareEditForm, setShareEditForm] = useState({
    holdingId: "",
    shares: "",
  });
  const [symbolResults, setSymbolResults] = useState<SearchItem[]>([]);
  const [symbolSearchStatus, setSymbolSearchStatus] = useState<Status>({
    kind: "idle",
  });
  const chatLang = resolveChatLang();
  const [chatOpen, setChatOpen] = useState(false);
  const [chatToggleToken, setChatToggleToken] = useState(0);

  useEffect(() => {
    if (status.kind === "success" || status.kind === "error") {
      const timer = window.setTimeout(() => {
        setStatus({ kind: "idle" });
      }, 5000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [status.kind, status.message]);

  const [showSymbolModal, setShowSymbolModal] = useState(false);
  const [showAddHoldingModal, setShowAddHoldingModal] = useState(false);
  const [isTourActive, setIsTourActive] = useState(false);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [tourTargetRect, setTourTargetRect] = useState<HelpTargetRect | null>(null);
  const [symbolSearchTerm, setSymbolSearchTerm] = useState("");
  const [editingHoldingId, setEditingHoldingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [openTooltipId, setOpenTooltipId] = useState<number | null>(null);
  const [sortField, setSortField] = useState<SortField>("instrument");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [accountSortField, setAccountSortField] = useState<AccountSortField>("name");
  const [accountSortDir, setAccountSortDir] = useState<"asc" | "desc">("asc");
  const [fxRates, setFxRates] = useState<Record<string, number>>({});
  const DISPLAY_CURRENCY = "EUR";
  const [zoomedChart, setZoomedChart] = useState<"allocation" | "pl" | "history" | null>(null);
  const [allocationChartType, setAllocationChartType] = useState<"donut" | "bar">("donut");
  const [plChartType, setPlChartType] = useState<"donut" | "bar">("bar");
  const [chartGroupBy, setChartGroupBy] = useState<ChartGroupBy>("holding");
  const [summaryChartView, setSummaryChartView] = useState<"history" | "portfolio">("history");
  const [historySeriesFilter, setHistorySeriesFilter] = useState(HISTORY_SERIES_GLOBAL);
  const [accountForm, setAccountForm] = useState({
    name: "",
    account_type: "",
    liquidity: "",
    manual_invested: "",
    created_at: formatDateInput(),
  });
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [showAccounts, setShowAccounts] = useState(false);
  const [accountDeleteTarget, setAccountDeleteTarget] = useState<Account | null>(null);
  const [cashTargetAccount, setCashTargetAccount] = useState<Account | null>(null);
  const [holdingActionsTarget, setHoldingActionsTarget] = useState<HoldingStats | null>(null);
  const [holdingAccountFilter, setHoldingAccountFilter] = useState<string>("all");
  const [holdingConfirmTarget, setHoldingConfirmTarget] = useState<{
    holding: HoldingStats;
    mode: "delete" | "refund";
  } | null>(null);
  const [holdingActionsReturnId, setHoldingActionsReturnId] = useState<number | null>(null);
  const [cashForm, setCashForm] = useState<{
    amount: string;
    mode: "add" | "withdraw";
    reasonPreset: string;
    reasonCustom: string;
  }>({
    amount: "",
    mode: "add",
    reasonPreset: CASH_REASON_DEFAULT.add,
    reasonCustom: "",
  });
  const [buyHoldingTarget, setBuyHoldingTarget] = useState<HoldingStats | null>(null);
  const [buyForm, setBuyForm] = useState({
    shares: "",
    price: "",
    fee_value: "",
    acquired_at: formatDateInput(),
    fx_rate: "",
  });
  const [sellHoldingTarget, setSellHoldingTarget] = useState<HoldingStats | null>(null);
  const [sellForm, setSellForm] = useState({
    shares: "",
    price: "",
    fee_value: "",
    executed_at: formatDateInput(),
    fx_rate: "",
  });
  const [placementForm, setPlacementForm] = useState({
    account_id: "",
    name: "",
    placement_type: "",
    sector: "",
    industry: "",
    currency: "EUR",
    initial_value: "",
    recorded_at: formatDateTimeLocal(),
  });
  const [showPlacementModal, setShowPlacementModal] = useState(false);
  const [editingPlacementId, setEditingPlacementId] = useState<number | null>(null);
  const [placementDeleteTarget, setPlacementDeleteTarget] = useState<Placement | null>(null);
  const [placementHistoryTarget, setPlacementHistoryTarget] = useState<Placement | null>(null);
  const [placementSnapshots, setPlacementSnapshots] = useState<PlacementSnapshot[]>([]);
  const [placementSnapshotsLoading, setPlacementSnapshotsLoading] = useState(false);
  const [placementChartTarget, setPlacementChartTarget] = useState<Placement | null>(null);
  const [placementChartSnapshots, setPlacementChartSnapshots] = useState<PlacementSnapshot[]>([]);
  const [placementChartLoading, setPlacementChartLoading] = useState(false);
  const [placementSnapshotForm, setPlacementSnapshotForm] = useState({
    value: "",
    recorded_at: formatDateTimeLocal(),
    entry_kind: "INTEREST" as
      | "VALUE"
      | "INITIAL"
      | "INTEREST"
      | "FEE"
      | "CONTRIBUTION"
      | "WITHDRAWAL",
  });
  const [editingPlacementSnapshotId, setEditingPlacementSnapshotId] = useState<number | null>(null);
  const [deletingPlacementSnapshotId, setDeletingPlacementSnapshotId] = useState<number | null>(null);
  const [deletingPlacementId, setDeletingPlacementId] = useState<number | null>(null);
  const addAccountButtonRef = useRef<HTMLButtonElement | null>(null);
  const accountSelectRef = useRef<HTMLSelectElement | null>(null);
  const accountNameInputRef = useRef<HTMLInputElement | null>(null);
  const accountTypeInputRef = useRef<HTMLInputElement | null>(null);
  const accountOpenedAtInputRef = useRef<HTMLInputElement | null>(null);
  const accountLiquidityInputRef = useRef<HTMLInputElement | null>(null);
  const accountContributedInputRef = useRef<HTMLInputElement | null>(null);
  const accountSaveButtonRef = useRef<HTMLButtonElement | null>(null);
  const symbolInputRef = useRef<HTMLInputElement | null>(null);
  const searchShareButtonRef = useRef<HTMLButtonElement | null>(null);
  const sharesInputRef = useRef<HTMLInputElement | null>(null);
  const costBasisInputRef = useRef<HTMLInputElement | null>(null);
  const acquisitionFeeInputRef = useRef<HTMLInputElement | null>(null);
  const currencySelectRef = useRef<HTMLSelectElement | null>(null);
  const manualPriceToggleRef = useRef<HTMLInputElement | null>(null);
  const manualLastPriceInputRef = useRef<HTMLInputElement | null>(null);
  const manualLastPriceAtInputRef = useRef<HTMLInputElement | null>(null);
  const saveHoldingButtonRef = useRef<HTMLButtonElement | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const yfinanceStatusRef = useRef<string | null>(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [backupImportTarget, setBackupImportTarget] = useState<File | null>(null);
  const tourOpenedHoldingModalRef = useRef(false);
  const tourOpenedAccountModalRef = useRef(false);
  const tourSteps: TourStep[] = [
    {
      id: "account-create-start",
      title: "Create an account",
      body: "Click + Add in Accounts to open the account creation form.",
      targetRef: addAccountButtonRef,
    },
    {
      id: "account-name",
      title: "Name the account",
      body: "Give the account a clear name (Brokerage, PEA, etc.).",
      targetRef: accountNameInputRef,
      requiresAccountModal: true,
    },
    {
      id: "account-type",
      title: "Pick a type",
      body: "Optional: choose an account type for grouping.",
      targetRef: accountTypeInputRef,
      requiresAccountModal: true,
    },
    {
      id: "account-opened",
      title: "Set the opened date",
      body: "This date is used for performance calculations.",
      targetRef: accountOpenedAtInputRef,
      requiresAccountModal: true,
    },
    {
      id: "account-cash",
      title: "Add available cash",
      body: "Enter enough cash to cover your purchase.",
      targetRef: accountLiquidityInputRef,
      requiresAccountModal: true,
    },
    {
      id: "account-contributed",
      title: "Add contributions",
      body: "Optional: track total contributions for better performance metrics.",
      targetRef: accountContributedInputRef,
      requiresAccountModal: true,
    },
    {
      id: "account-save",
      title: "Save the account",
      body: "Save to make it available for new holdings.",
      targetRef: accountSaveButtonRef,
      requiresAccountModal: true,
    },
    {
      id: "account-select",
      title: "Select the account",
      body: "Choose the account that will hold the shares, or create one with enough cash.",
      targetRef: accountSelectRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "symbol",
      title: "Pick a symbol",
      body: "Type a ticker like AAPL or search for the instrument name.",
      targetRef: symbolInputRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "search",
      title: "Search the instrument",
      body: "Click Search share to fetch symbol suggestions.",
      targetRef: searchShareButtonRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "shares",
      title: "Enter shares",
      body: "Enter the number of shares for this lot.",
      targetRef: sharesInputRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "cost-basis",
      title: "Enter cost per share",
      body: "Add the purchase price per share.",
      targetRef: costBasisInputRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "fees",
      title: "Add fees",
      body: "Optional: add fees to compute the PRU for this lot.",
      targetRef: acquisitionFeeInputRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "currency",
      title: "Select currency",
      body: "Choose the holding currency.",
      targetRef: currencySelectRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "manual-price",
      title: "Manual last price",
      body: "Enable this for instruments without live quotes, then enter the last price and update time.",
      targetRef: manualPriceToggleRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "manual-last-price",
      title: "Enter last price",
      body: "Add the latest known price per share.",
      targetRef: manualLastPriceInputRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "manual-last-price-at",
      title: "Set the last update time",
      body: "Use the time of the price you entered.",
      targetRef: manualLastPriceAtInputRef,
      requiresAddHoldingModal: true,
    },
    {
      id: "save",
      title: "Save the holding",
      body: "Click Save holding to add the position to your portfolio.",
      targetRef: saveHoldingButtonRef,
      requiresAddHoldingModal: true,
    },
  ];

  useEffect(() => {
    if (!isUserMenuOpen) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (!userMenuRef.current) return;
      if (!userMenuRef.current.contains(event.target as Node)) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isUserMenuOpen]);

  const holdings = useMemo(() => portfolio?.holdings ?? [], [portfolio]);
  const placements = useMemo(() => portfolio?.placements ?? [], [portfolio]);
  const accounts = useMemo<Account[]>(() => portfolio?.accounts ?? [], [portfolio]);
  const portfolioHistoryRows = useMemo(() => dailyHistory?.portfolio ?? [], [dailyHistory]);
  const holdingHistoryRows = useMemo(() => dailyHistory?.holdings ?? [], [dailyHistory]);
  const historySeriesFilterOptions = useMemo(() => {
    const namesBySymbol = new Map<string, string>();
    holdings.forEach((holding) => {
      const symbol = (holding.symbol || "").trim().toUpperCase();
      const name = (holding.name || "").trim();
      if (symbol && name) namesBySymbol.set(symbol, name);
    });
    holdingHistoryRows.forEach((row) => {
      const symbol = (row.symbol || "").trim().toUpperCase();
      const name = (row.name || "").trim();
      if (symbol && name && !namesBySymbol.has(symbol)) {
        namesBySymbol.set(symbol, name);
      }
    });
    const symbols = Array.from(
      new Set(
        holdingHistoryRows
          .map((row) => (row.symbol || "").trim().toUpperCase())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    return [
      { value: HISTORY_SERIES_GLOBAL, label: "Global portfolio" },
      ...symbols.map((symbol) => {
        const name = namesBySymbol.get(symbol);
        return {
          value: `${HISTORY_SERIES_PREFIX}${symbol}`,
          label: name ? `${symbol} · ${name}` : symbol,
        };
      }),
    ];
  }, [holdingHistoryRows, holdings]);
  const selectedHistorySymbol = useMemo(() => {
    if (!historySeriesFilter.startsWith(HISTORY_SERIES_PREFIX)) return null;
    const symbol = historySeriesFilter.slice(HISTORY_SERIES_PREFIX.length).trim().toUpperCase();
    return symbol || null;
  }, [historySeriesFilter]);
  const selectedHistoryFilterLabel = useMemo(
    () =>
      historySeriesFilterOptions.find((option) => option.value === historySeriesFilter)?.label ||
      "Global portfolio",
    [historySeriesFilter, historySeriesFilterOptions]
  );
  useEffect(() => {
    const exists = historySeriesFilterOptions.some(
      (option) => option.value === historySeriesFilter
    );
    if (!exists) {
      setHistorySeriesFilter(HISTORY_SERIES_GLOBAL);
    }
  }, [historySeriesFilter, historySeriesFilterOptions]);
  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  );
  useEffect(() => {
    if (holdingAccountFilter === "all") return;
    const exists = accounts.some((account) => String(account.id) === holdingAccountFilter);
    if (!exists) {
      setHoldingAccountFilter("all");
    }
  }, [accounts, holdingAccountFilter]);
  const defaultAccountId = useMemo(() => {
    if (!accounts.length) return null;
    const main = accounts.find((account) => account.name.toLowerCase() === "main");
    return main?.id || accounts[0]?.id || null;
  }, [accounts]);
  const selectedAccount = useMemo(() => {
    const accountId = holdingForm.account_id
      ? Number(holdingForm.account_id)
      : defaultAccountId;
    if (!accountId) return null;
    return accounts.find((account) => account.id === accountId) || null;
  }, [accounts, holdingForm.account_id, defaultAccountId]);
  const chartHoldings = useMemo(() => {
    if (holdingAccountFilter === "all") {
      return holdings;
    }
    const accountId = Number(holdingAccountFilter);
    if (!Number.isFinite(accountId)) {
      return holdings;
    }
    return holdings.filter((holding) => {
      const holdingAccountId = holding.account_id ?? holding.account?.id ?? null;
      return holdingAccountId === accountId;
    });
  }, [holdings, holdingAccountFilter]);
  const chartPlacements = useMemo(() => {
    if (holdingAccountFilter === "all") {
      return placements;
    }
    const accountId = Number(holdingAccountFilter);
    if (!Number.isFinite(accountId)) {
      return placements;
    }
    return placements.filter((placement) => {
      const placementAccountId = placement.account_id ?? null;
      return placementAccountId === accountId;
    });
  }, [placements, holdingAccountFilter]);
  const summary = portfolio?.summary;
  const totalCurrency = DISPLAY_CURRENCY;
  const isAuthed = Boolean(authToken);
  const userDisplayEmail = currentUser?.email || "Signed in";
  const userInitials = getInitials(currentUser?.email);
  const currentTourStep = isTourActive ? tourSteps[tourStepIndex] : null;

  useEffect(() => {
    if (!placementHistoryTarget) {
      setPlacementSnapshots([]);
      setPlacementSnapshotsLoading(false);
      return;
    }
    let active = true;
    const loadSnapshots = async () => {
      setPlacementSnapshotsLoading(true);
      try {
        const res = await fetchPlacementSnapshots(placementHistoryTarget.id);
        if (!active) return;
        setPlacementSnapshots(res.data);
      } catch (err) {
        if (!active) return;
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
          "Failed to load placement history";
        setPlacementSnapshots([]);
        setStatus({ kind: "error", message: detail });
      } finally {
        if (active) {
          setPlacementSnapshotsLoading(false);
        }
      }
    };
    loadSnapshots();
    return () => {
      active = false;
    };
  }, [placementHistoryTarget]);

  useEffect(() => {
    if (!placementChartTarget) {
      setPlacementChartSnapshots([]);
      setPlacementChartLoading(false);
      return;
    }
    let active = true;
    const loadSnapshots = async () => {
      setPlacementChartLoading(true);
      try {
        const res = await fetchPlacementSnapshots(placementChartTarget.id, 500);
        if (!active) return;
        setPlacementChartSnapshots(res.data);
      } catch (err) {
        if (!active) return;
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
          "Failed to load placement history";
        setPlacementChartSnapshots([]);
        setStatus({ kind: "error", message: detail });
      } finally {
        if (active) {
          setPlacementChartLoading(false);
        }
      }
    };
    loadSnapshots();
    return () => {
      active = false;
    };
  }, [placementChartTarget]);

  useEffect(() => {
    if (!placementHistoryTarget) return;
    const latest = placements.find((placement) => placement.id === placementHistoryTarget.id);
    if (latest && latest !== placementHistoryTarget) {
      setPlacementHistoryTarget(latest);
    }
  }, [placements, placementHistoryTarget]);

  const startTour = () => {
    tourOpenedHoldingModalRef.current = false;
    tourOpenedAccountModalRef.current = false;
    setTourStepIndex(0);
    setIsTourActive(true);
  };

  const endTour = () => {
    setIsTourActive(false);
    setTourStepIndex(0);
    setTourTargetRect(null);
    if (tourOpenedHoldingModalRef.current) {
      setShowAddHoldingModal(false);
    }
    if (tourOpenedAccountModalRef.current) {
      setShowAccountModal(false);
    }
    tourOpenedHoldingModalRef.current = false;
    tourOpenedAccountModalRef.current = false;
  };

  const goToTourStep = (nextIndex: number) => {
    const clamped = Math.min(Math.max(nextIndex, 0), tourSteps.length - 1);
    setTourStepIndex(clamped);
  };

  useEffect(() => {
    if (!isAuthed && isTourActive) {
      endTour();
    }
  }, [isAuthed, isTourActive]);

  useEffect(() => {
    if (!isTourActive) return;
    const step = tourSteps[tourStepIndex];
    const shouldEnableManualPrice =
      step?.id === "manual-price" ||
      step?.id === "manual-last-price" ||
      step?.id === "manual-last-price-at";
    if (step?.requiresAccountModal && !showAccountModal) {
      tourOpenedAccountModalRef.current = true;
      setAccountForm({
        name: "",
        account_type: "",
        liquidity: "",
        manual_invested: "",
        created_at: formatDateInput(),
      });
      setEditingAccountId(null);
      setShowAccountModal(true);
    } else if (
      !step?.requiresAccountModal &&
      tourOpenedAccountModalRef.current &&
      showAccountModal
    ) {
      setShowAccountModal(false);
      tourOpenedAccountModalRef.current = false;
    }
    if (step?.requiresAddHoldingModal && !showAddHoldingModal) {
      tourOpenedHoldingModalRef.current = true;
      setShowAddHoldingModal(true);
    } else if (
      !step?.requiresAddHoldingModal &&
      tourOpenedHoldingModalRef.current &&
      showAddHoldingModal
    ) {
      setShowAddHoldingModal(false);
      tourOpenedHoldingModalRef.current = false;
    }
    if (shouldEnableManualPrice && !holdingForm.manualPriceEnabled) {
      setHoldingForm((prev) => ({
        ...prev,
        manualPriceEnabled: true,
      }));
    }
  }, [isTourActive, tourStepIndex, showAddHoldingModal, showAccountModal, holdingForm.manualPriceEnabled]);

  useEffect(() => {
    if (!isTourActive) {
      setTourTargetRect(null);
      return;
    }
    const step = tourSteps[tourStepIndex];
    const update = () => {
      const rect = step?.targetRef.current?.getBoundingClientRect();
      if (!rect) {
        setTourTargetRect(null);
        return;
      }
      setTourTargetRect({
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        endTour();
      }
    };
    step?.targetRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const raf = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isTourActive, tourStepIndex, showAddHoldingModal, showAccountModal, holdingForm.manualPriceEnabled]);

  const tourCardStyle = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const padding = 16;
    const cardWidth = Math.min(320, window.innerWidth - padding * 2);
    const cardHeight = 210;
    if (!tourTargetRect) {
      return {
        top: Math.max(padding, (window.innerHeight - cardHeight) / 2),
        left: Math.max(padding, (window.innerWidth - cardWidth) / 2),
        width: cardWidth,
      };
    }
    const spaceBelow = window.innerHeight - tourTargetRect.bottom;
    const top =
      spaceBelow > cardHeight
        ? tourTargetRect.bottom + 12
        : Math.max(padding, tourTargetRect.top - cardHeight - 12);
    const leftPreferred = tourTargetRect.right - cardWidth;
    const left = Math.min(
      Math.max(padding, leftPreferred),
      window.innerWidth - padding - cardWidth
    );
    return { top, left, width: cardWidth };
  }, [tourTargetRect]);

  const tourHighlightStyle = useMemo(() => {
    if (!tourTargetRect) return undefined;
    const padding = 6;
    return {
      top: tourTargetRect.top - padding,
      left: tourTargetRect.left - padding,
      width: tourTargetRect.width + padding * 2,
      height: tourTargetRect.height + padding * 2,
    };
  }, [tourTargetRect]);

  const convertAmount = (
    value: number | null | undefined,
    currency: string,
    fallbackRate?: number | null,
    preferFallback = false
  ) => {
    if (value === null || value === undefined) return null;
    const curr = (currency || "").toUpperCase();
    if (curr === DISPLAY_CURRENCY) return value;
    const key = `${curr}->${DISPLAY_CURRENCY}`;
    const rate = preferFallback ? fallbackRate ?? fxRates[key] : fxRates[key] ?? fallbackRate;
    return rate ? value * rate : value;
  };

  const displayMoney = (value: number | null | undefined, currency: string) => {
    const converted = convertAmount(value, currency);
    return formatMoney(converted, DISPLAY_CURRENCY);
  };

  const displayMoneySigned = (value: number | null | undefined, currency: string) => {
    const converted = convertAmount(value, currency);
    return formatMoneySigned(converted, DISPLAY_CURRENCY);
  };

  const renderAmount = (value: number | null | undefined, currency: string) => {
    const converted = convertAmount(value, currency);
    const isConverted =
      currency.toUpperCase() !== DISPLAY_CURRENCY && converted !== null && converted !== undefined;
    const primary = isConverted
      ? formatMoney(converted, DISPLAY_CURRENCY)
      : formatMoney(value, currency);
    const secondary = isConverted ? formatMoney(value, currency) : null;
    return { primary, secondary };
  };

  const getHoldingFeeValue = (holding: HoldingStats) =>
    holding.acquisition_fee_value ?? 0;
  const getHoldingTotalCost = (holding: HoldingStats) =>
    holding.shares * holding.cost_basis + getHoldingFeeValue(holding);

const computeAnnualizedReturn = (gainPct?: number | null, acquired_at?: string | null) => {
  if (gainPct === null || gainPct === undefined) return null;
  if (!acquired_at) return null;
  const acquired = new Date(acquired_at).getTime();
  if (Number.isNaN(acquired)) return null;
  const days = (Date.now() - acquired) / (1000 * 60 * 60 * 24);
  if (days <= 0) return null;
  const annualized = Math.pow(1 + gainPct, 365 / days) - 1;
  return annualized;
};

const computeAnnualizedReturnBetween = (
  gainPct?: number | null,
  startAt?: string | null,
  endAt?: string | null
) => {
  if (gainPct === null || gainPct === undefined) return null;
  if (!startAt || !endAt) return null;
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const days = (end - start) / (1000 * 60 * 60 * 24);
  if (days <= 0) return null;
  return Math.pow(1 + gainPct, 365 / days) - 1;
};

  const enhancedSummary = useMemo(() => {
    const total_cost = chartHoldings.reduce(
      (sum, h) =>
        sum +
        (convertAmount(getHoldingTotalCost(h), h.currency, h.fx_rate, true) || 0),
      0
    );
    const marketValues: number[] = [];
    chartHoldings.forEach((h) => {
      const lastPrice = h.last_price ?? null;
      const mvRaw =
        h.market_value !== null && h.market_value !== undefined
          ? h.market_value
          : lastPrice !== null
            ? lastPrice * h.shares
            : null;
      const mv = convertAmount(mvRaw, h.currency);
      if (mv !== null && mv !== undefined) {
        marketValues.push(mv);
      }
    });
    const placementValues: number[] = [];
    const placementCosts: number[] = [];
    chartPlacements.forEach((placement) => {
      const convertedValue = convertAmount(placement.current_value, placement.currency);
      if (convertedValue !== null && convertedValue !== undefined) {
        placementValues.push(convertedValue);
        const base =
          placement.initial_value !== null && placement.initial_value !== undefined
            ? placement.initial_value
            : placement.current_value;
        const contributions = placement.total_contributions ?? 0;
        const withdrawals = placement.total_withdrawals ?? 0;
        const costBase = base + contributions - withdrawals;
        const convertedCost = convertAmount(costBase, placement.currency);
        if (convertedCost !== null && convertedCost !== undefined) {
          placementCosts.push(convertedCost);
        }
      }
    });
    const placementsTotal = placementValues.length
      ? placementValues.reduce((a, b) => a + b, 0)
      : null;
    const placementsCostTotal = placementCosts.length
      ? placementCosts.reduce((a, b) => a + b, 0)
      : null;
    const holdingsTotal = marketValues.length ? marketValues.reduce((a, b) => a + b, 0) : null;
    const total_value =
      holdingsTotal !== null || placementsTotal !== null
        ? (holdingsTotal ?? 0) + (placementsTotal ?? 0)
        : null;
    const total_gain_abs =
      total_value !== null ? total_value - (total_cost + (placementsCostTotal ?? 0)) : null;
    const total_gain_pct =
      total_gain_abs !== null && total_cost + (placementsCostTotal ?? 0) > 0
        ? total_gain_abs / (total_cost + (placementsCostTotal ?? 0))
        : null;

    return {
      total_cost: total_cost + (placementsCostTotal ?? 0),
      total_value,
      total_gain_abs,
      total_gain_pct,
      hourly_change_abs: summary?.hourly_change_abs ?? null,
      hourly_change_pct: summary?.hourly_change_pct ?? null,
    };
  }, [chartHoldings, fxRates, summary, chartPlacements]);

  const selectedLiquidity = useMemo(() => {
    if (!accounts.length) return null;
    return accounts.reduce((sum, account) => sum + (account.liquidity || 0), 0);
  }, [accounts]);
  const selectedCapitalContributed = useMemo(() => {
    if (!accounts.length) return null;
    return accounts.reduce(
      (sum, account) => sum + (account.manual_invested || 0),
      0
    );
  }, [accounts]);
  const cashPreview = useMemo(() => {
    if (!cashTargetAccount) return null;
    const amount = cashForm.amount === "" ? null : Number(cashForm.amount);
    if (amount === null || Number.isNaN(amount) || amount <= 0) return null;
    const delta = cashForm.mode === "add" ? amount : -amount;
    return (cashTargetAccount.liquidity || 0) + delta;
  }, [cashForm.amount, cashForm.mode, cashTargetAccount]);

  const resolvePlacementGroupLabel = (placement: Placement) => {
    switch (chartGroupBy) {
      case "account":
        return (
          (placement.account_id
            ? accountsById.get(placement.account_id)?.name
            : null) || "Uncategorized"
        );
      case "asset_type":
        return placement.placement_type || "Uncategorized";
      case "sector":
        return placement.sector || "Uncategorized";
      case "industry":
        return placement.industry || "Uncategorized";
      default:
        return placement.name || "Placement";
    }
  };

  const allocationData = useMemo(() => {
    const resolveGroupLabel = (holding: HoldingStats) => {
      switch (chartGroupBy) {
        case "account":
          return holding.account?.name || "Uncategorized";
        case "asset_type":
          return holding.asset_type || "Uncategorized";
        case "sector":
          return holding.sector || "Uncategorized";
        case "industry":
          return holding.industry || "Uncategorized";
        default:
          return holding.name || holding.symbol || holding.isin || "Holding";
      }
    };
    const slugify = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

    if (chartGroupBy === "holding") {
      const grouped = new Map<
        string,
        {
          symbol: string;
          label: string;
          y: number;
          lots: Array<{ name: string; y: number; displayName: string }>;
          detailCount?: number;
          detailLabel?: string;
        }
      >();

      chartHoldings.forEach((holding) => {
        const price = holding.last_price ?? holding.cost_basis ?? 0;
        const nativeValue =
          price !== null && price !== undefined ? price * holding.shares : 0;
        const value = convertAmount(nativeValue, holding.currency, holding.fx_rate) ?? 0;
        if (!value || Number.isNaN(value) || value <= 0) return;

        const symbol =
          (holding.symbol || holding.name || holding.isin || `holding-${holding.id}`)
            .toString()
            .toUpperCase();
        const label = holding.name || holding.symbol || holding.isin || symbol;
        const key = symbol.toLowerCase();
        const lotLabel = holding.acquired_at ? holding.acquired_at : `Lot ${holding.id}`;
        const lotDisplay = `${label} - ${lotLabel} - ${holding.shares.toFixed(2)} sh`;
        const entry =
          grouped.get(key) ||
          ({
            symbol,
            label,
            y: 0,
            lots: [],
          } as {
            symbol: string;
            label: string;
            y: number;
            lots: Array<{ name: string; y: number; displayName: string }>;
          });
        entry.y += value;
        entry.lots.push({
          name: lotLabel,
          y: Number(value.toFixed(2)),
          displayName: lotDisplay,
        });
        grouped.set(key, entry);
      });

      chartPlacements.forEach((placement) => {
        const value = convertAmount(placement.current_value, placement.currency) ?? 0;
        if (!value || Number.isNaN(value) || value <= 0) return;
        const placementName = placement.name || "Placement";
        const placementLabel = placement.placement_type
          ? `${placementName} · ${placement.placement_type}`
          : placementName;
        const key = `placement-${placement.id}`;
        const entry =
          grouped.get(key) ||
          ({
            symbol: placementName,
            label: placementLabel,
            y: 0,
            lots: [],
            detailCount: 1,
            detailLabel: "placement",
          } as {
            symbol: string;
            label: string;
            y: number;
            lots: Array<{ name: string; y: number; displayName: string }>;
            detailCount?: number;
            detailLabel?: string;
          });
        entry.y += value;
        entry.detailCount = 1;
        entry.detailLabel = "placement";
        grouped.set(key, entry);
      });

      const points = Array.from(grouped.values()).map((entry) => ({
        name: entry.symbol,
        label: entry.label,
        y: Number(entry.y.toFixed(2)),
        currency: totalCurrency,
        drilldown: entry.lots.length > 1 ? `allocation-${entry.symbol}` : undefined,
        detailCount: entry.detailCount ?? entry.lots.length,
        detailLabel: entry.detailLabel ?? (entry.lots.length === 1 ? "lot" : "lots"),
      }));

      const drilldownSeriesPie = Array.from(grouped.values())
        .filter((entry) => entry.lots.length > 1)
        .map(
          (entry) =>
            ({
              type: "pie",
              id: `allocation-${entry.symbol}`,
              name: entry.label,
              data: entry.lots.map((lot) => ({
                name: lot.name,
                y: Number(lot.y.toFixed(2)),
                currency: totalCurrency,
                displayName: lot.displayName,
                rawValue: lot.y,
              })),
            }) as Highcharts.SeriesOptionsType
        );
      const drilldownSeriesBar = Array.from(grouped.values())
        .filter((entry) => entry.lots.length > 1)
        .map(
          (entry) =>
            ({
              type: "bar",
              id: `allocation-${entry.symbol}`,
              name: entry.label,
              data: entry.lots.map((lot, idx) => ({
                name: lot.name,
                y: Number(lot.y.toFixed(2)),
                color: ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
                currency: totalCurrency,
                displayName: lot.displayName,
                rawValue: lot.y,
              })),
            }) as Highcharts.SeriesOptionsType
        );

      const total = points.reduce((sum, p) => sum + p.y, 0);
      return { points, total, drilldownSeriesPie, drilldownSeriesBar };
    }

    const grouped = new Map<
      string,
      {
        label: string;
        y: number;
        items: Map<string, { name: string; y: number; displayName: string }>;
      }
    >();
    chartHoldings.forEach((holding) => {
      const price = holding.last_price ?? holding.cost_basis ?? 0;
      const nativeValue =
        price !== null && price !== undefined ? price * holding.shares : 0;
      const value = convertAmount(nativeValue, holding.currency, holding.fx_rate) ?? 0;
      if (!value || Number.isNaN(value) || value <= 0) return;
      const label = resolveGroupLabel(holding) || "Uncategorized";
      const key = label.toLowerCase();
      const entry =
        grouped.get(key) ||
        ({
          label,
          y: 0,
          items: new Map<string, { name: string; y: number; displayName: string }>(),
        } as {
          label: string;
          y: number;
          items: Map<string, { name: string; y: number; displayName: string }>;
        });
      entry.y += value;
      const symbol =
        (holding.symbol || holding.name || holding.isin || `holding-${holding.id}`)
          .toString()
          .toUpperCase();
      const holdingLabel = holding.name || holding.symbol || holding.isin || symbol;
      const holdingKey = symbol.toLowerCase();
      const holdingEntry =
        entry.items.get(holdingKey) ||
        ({
          name: symbol,
          y: 0,
          displayName: holdingLabel,
        } as { name: string; y: number; displayName: string });
      holdingEntry.y += value;
      entry.items.set(holdingKey, holdingEntry);
      grouped.set(key, entry);
    });
    chartPlacements.forEach((placement) => {
      const value = convertAmount(placement.current_value, placement.currency) ?? 0;
      if (!value || Number.isNaN(value) || value <= 0) return;
      const label = resolvePlacementGroupLabel(placement) || "Uncategorized";
      const key = label.toLowerCase();
      const entry =
        grouped.get(key) ||
        ({
          label,
          y: 0,
          items: new Map<string, { name: string; y: number; displayName: string }>(),
        } as {
          label: string;
          y: number;
          items: Map<string, { name: string; y: number; displayName: string }>;
        });
      entry.y += value;
      const placementName = placement.name || "Placement";
      const placementLabel = placement.placement_type
        ? `${placementName} · ${placement.placement_type}`
        : placementName;
      const placementKey = `placement-${placement.id}`;
      const placementEntry =
        entry.items.get(placementKey) ||
        ({
          name: placementName,
          y: 0,
          displayName: placementLabel,
        } as { name: string; y: number; displayName: string });
      placementEntry.y += value;
      entry.items.set(placementKey, placementEntry);
      grouped.set(key, entry);
    });

    const points = Array.from(grouped.values()).map((entry) => {
      const itemCount = entry.items.size;
      return {
        name: entry.label,
        label: entry.label,
        y: Number(entry.y.toFixed(2)),
        currency: totalCurrency,
        drilldown: itemCount >= 1 ? `allocation-group-${slugify(entry.label)}` : undefined,
        detailCount: itemCount,
        detailLabel: itemCount === 1 ? "position" : "positions",
      };
    });
    const drilldownSeriesPie = Array.from(grouped.values()).map(
      (entry) =>
        ({
          type: "pie",
          id: `allocation-group-${slugify(entry.label)}`,
          name: entry.label,
          data: Array.from(entry.items.values()).map((item) => ({
            name: item.name,
            y: Number(item.y.toFixed(2)),
            currency: totalCurrency,
            displayName: item.displayName,
            rawValue: item.y,
          })),
        }) as Highcharts.SeriesOptionsType
    );
    const drilldownSeriesBar = Array.from(grouped.values()).map(
      (entry) =>
        ({
          type: "bar",
          id: `allocation-group-${slugify(entry.label)}`,
          name: entry.label,
          data: Array.from(entry.items.values()).map((item, idx) => ({
            name: item.name,
            y: Number(item.y.toFixed(2)),
            color: ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
            currency: totalCurrency,
            displayName: item.displayName,
            rawValue: item.y,
          })),
        }) as Highcharts.SeriesOptionsType
    );
    const total = points.reduce((sum, p) => sum + p.y, 0);
    return { points, total, drilldownSeriesPie, drilldownSeriesBar };
  }, [chartGroupBy, chartHoldings, chartPlacements, accountsById, fxRates, totalCurrency]);

  const plData = useMemo(() => {
    const slugify = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
    const resolveGroupLabel = (holding: HoldingStats) => {
      switch (chartGroupBy) {
        case "account":
          return holding.account?.name || "Uncategorized";
        case "asset_type":
          return holding.asset_type || "Uncategorized";
        case "sector":
          return holding.sector || "Uncategorized";
        case "industry":
          return holding.industry || "Uncategorized";
        default:
          return holding.name || holding.symbol || holding.isin || "Holding";
      }
    };

    if (chartGroupBy === "holding") {
      const grouped = new Map<
        string,
        { name: string; label: string; gain: number; lots: Array<{ name: string; label: string; gain: number }> }
      >();
      chartHoldings.forEach((holding) => {
        const price = holding.last_price ?? null;
        const marketValueNative =
          price !== null && price !== undefined
            ? price * holding.shares
            : holding.market_value;
        const marketValue = convertAmount(marketValueNative, holding.currency);
        const totalCost = getHoldingTotalCost(holding);
        const totalCostConverted = convertAmount(
          totalCost,
          holding.currency,
          holding.fx_rate,
          true
        );
        const gainAbs =
          marketValue !== null && marketValue !== undefined
            ? marketValue - (totalCostConverted || 0)
            : convertAmount(holding.gain_abs, holding.currency);
        if (gainAbs === null || gainAbs === undefined || gainAbs === 0) return;
        if (Number.isNaN(gainAbs)) return;
        const symbol = (holding.symbol || holding.isin || `holding-${holding.id}`)
          .toString()
          .toUpperCase();
        const label = holding.name || holding.symbol || holding.isin || symbol;
        const key = symbol.toLowerCase();
        const entry =
          grouped.get(key) || { name: symbol, label, gain: 0, lots: [] };
        entry.gain += gainAbs;
        const lotLabel = holding.acquired_at ? holding.acquired_at : `Lot ${holding.id}`;
        const lotDisplay = `${label} - ${lotLabel}`;
        entry.lots.push({ name: lotLabel, label: lotDisplay, gain: gainAbs });
        grouped.set(key, entry);
      });
      const holdingPoints = Array.from(grouped.values())
        .map((entry) => {
          const amount = Math.abs(entry.gain);
          if (!amount || Number.isNaN(amount)) return null;
          return {
            name: entry.name,
            label: entry.label,
            gain: Number(entry.gain.toFixed(2)),
            y: Number(amount.toFixed(2)),
            currency: totalCurrency,
            isLoss: entry.gain < 0,
            drilldown: entry.lots.length > 1 ? `pl-${entry.name}` : undefined,
            detailCount: entry.lots.length,
            detailLabel: entry.lots.length === 1 ? "lot" : "lots",
          };
        })
        .filter(Boolean) as Array<{
        name: string;
        label: string;
        gain: number;
        y: number;
        currency: string;
        isLoss: boolean;
        drilldown?: string;
        detailCount?: number;
        detailLabel?: string;
      }>;
      const drilldownSeriesPie = Array.from(grouped.values())
        .filter((entry) => entry.lots.length > 1)
        .map(
          (entry) =>
            ({
              type: "pie",
              id: `pl-${entry.name}`,
              name: entry.label,
              data: entry.lots
                .map((lot) => ({
                  name: lot.name,
                  y: Number(Math.abs(lot.gain).toFixed(2)),
                  currency: totalCurrency,
                  displayName: lot.label,
                  rawGain: lot.gain,
                  isLoss: lot.gain < 0,
                }))
                .filter((lot) => lot.y > 0),
            }) as Highcharts.SeriesOptionsType
        );
      const drilldownSeriesBar = Array.from(grouped.values())
        .filter((entry) => entry.lots.length > 1)
        .map(
          (entry) =>
            ({
              type: "bar",
              id: `pl-${entry.name}`,
              name: entry.label,
              data: entry.lots
                .map((lot, idx) => ({
                  name: lot.name,
                  y: Number(lot.gain.toFixed(2)),
                  color: lot.gain < 0 ? LOSS_COLOR : ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
                  currency: totalCurrency,
                  displayName: lot.label,
                  rawGain: lot.gain,
                }))
                .filter((lot) => lot.y !== 0),
            }) as Highcharts.SeriesOptionsType
        );
      const placementPoints = chartPlacements
        .map((placement) => {
          const currentValue = placement.current_value;
          const baseValue =
            placement.initial_value !== null && placement.initial_value !== undefined
              ? placement.initial_value
              : placement.current_value;
          if (currentValue === null || currentValue === undefined) return null;
          if (baseValue === null || baseValue === undefined) return null;
          const contributions = placement.total_contributions ?? 0;
          const withdrawals = placement.total_withdrawals ?? 0;
          const base = baseValue + contributions - withdrawals;
          const gainRaw = currentValue - base;
          const gainAbs = convertAmount(gainRaw, placement.currency);
          if (gainAbs === null || gainAbs === undefined || gainAbs === 0) return null;
          if (Number.isNaN(gainAbs)) return null;
          const placementName = placement.name || "Placement";
          const placementLabel = placement.placement_type
            ? `${placementName} · ${placement.placement_type}`
            : placementName;
          const amount = Math.abs(gainAbs);
          if (!amount || Number.isNaN(amount)) return null;
          return {
            name: placementName,
            label: placementLabel,
            gain: Number(gainAbs.toFixed(2)),
            y: Number(amount.toFixed(2)),
            currency: totalCurrency,
            isLoss: gainAbs < 0,
            drilldown: undefined,
            detailCount: 1,
            detailLabel: "placement",
          };
        })
        .filter(Boolean) as Array<{
        name: string;
        label: string;
        gain: number;
        y: number;
        currency: string;
        isLoss: boolean;
        drilldown?: string;
        detailCount?: number;
        detailLabel?: string;
      }>;
      const points = [...holdingPoints, ...placementPoints];
      const total = points.reduce((sum, p) => sum + p.y, 0);
      return { points, total, drilldownSeriesPie, drilldownSeriesBar };
    }

    const grouped = new Map<
      string,
      {
        id: string;
        label: string;
        gain: number;
        items: Map<string, { name: string; label: string; gain: number }>;
      }
    >();
    chartHoldings.forEach((holding) => {
      const price = holding.last_price ?? null;
      const marketValueNative =
        price !== null && price !== undefined ? price * holding.shares : holding.market_value;
      const marketValue = convertAmount(marketValueNative, holding.currency);
      const totalCost = getHoldingTotalCost(holding);
      const totalCostConverted = convertAmount(
        totalCost,
        holding.currency,
        holding.fx_rate,
        true
      );
      const gainAbs =
        marketValue !== null && marketValue !== undefined
          ? marketValue - (totalCostConverted || 0)
          : convertAmount(holding.gain_abs, holding.currency);
      if (gainAbs === null || gainAbs === undefined || gainAbs === 0) return;
      if (Number.isNaN(gainAbs)) return;
      const label = resolveGroupLabel(holding) || "Uncategorized";
      const key = label.toLowerCase();
      const groupId = `pl-group-${chartGroupBy}-${slugify(label)}`;
      const entry =
        grouped.get(key) ||
        ({
          id: groupId,
          label,
          gain: 0,
          items: new Map<string, { name: string; label: string; gain: number }>(),
        } as {
          id: string;
          label: string;
          gain: number;
          items: Map<string, { name: string; label: string; gain: number }>;
        });
      entry.gain += gainAbs;
      const symbol = (holding.symbol || holding.isin || `holding-${holding.id}`)
        .toString()
        .toUpperCase();
      const holdingLabel = holding.name || holding.symbol || holding.isin || symbol;
      const holdingKey = symbol.toLowerCase();
      const holdingEntry =
        entry.items.get(holdingKey) ||
        ({
          name: symbol,
          label: holdingLabel,
          gain: 0,
        } as { name: string; label: string; gain: number });
      holdingEntry.gain += gainAbs;
      entry.items.set(holdingKey, holdingEntry);
      grouped.set(key, entry);
    });
    chartPlacements.forEach((placement) => {
      const currentValue = placement.current_value;
      const baseValue =
        placement.initial_value !== null && placement.initial_value !== undefined
          ? placement.initial_value
          : placement.current_value;
      if (currentValue === null || currentValue === undefined) return;
      if (baseValue === null || baseValue === undefined) return;
      const contributions = placement.total_contributions ?? 0;
      const withdrawals = placement.total_withdrawals ?? 0;
      const base = baseValue + contributions - withdrawals;
      const gainRaw = currentValue - base;
      const gainAbs = convertAmount(gainRaw, placement.currency);
      if (gainAbs === null || gainAbs === undefined || gainAbs === 0) return;
      if (Number.isNaN(gainAbs)) return;
      const label = resolvePlacementGroupLabel(placement) || "Uncategorized";
      const key = label.toLowerCase();
      const groupId = `pl-group-${chartGroupBy}-${slugify(label)}`;
      const entry =
        grouped.get(key) ||
        ({
          id: groupId,
          label,
          gain: 0,
          items: new Map<string, { name: string; label: string; gain: number }>(),
        } as {
          id: string;
          label: string;
          gain: number;
          items: Map<string, { name: string; label: string; gain: number }>;
        });
      entry.gain += gainAbs;
      const placementName = placement.name || "Placement";
      const placementLabel = placement.placement_type
        ? `${placementName} · ${placement.placement_type}`
        : placementName;
      const placementKey = `placement-${placement.id}`;
      const placementEntry =
        entry.items.get(placementKey) ||
        ({
          name: placementName,
          label: placementLabel,
          gain: 0,
        } as { name: string; label: string; gain: number });
      placementEntry.gain += gainAbs;
      entry.items.set(placementKey, placementEntry);
      grouped.set(key, entry);
    });

    const points = Array.from(grouped.values())
      .map((entry) => {
        const amount = Math.abs(entry.gain);
        if (!amount || Number.isNaN(amount)) return null;
        return {
          name: entry.label,
          label: entry.label,
          gain: Number(entry.gain.toFixed(2)),
          y: Number(amount.toFixed(2)),
          currency: totalCurrency,
          isLoss: entry.gain < 0,
          drilldown: entry.items.size >= 1 ? entry.id : undefined,
          detailCount: entry.items.size,
          detailLabel: entry.items.size === 1 ? "position" : "positions",
        };
      })
      .filter(Boolean) as Array<{
      name: string;
      label: string;
      gain: number;
      y: number;
      currency: string;
      isLoss: boolean;
      drilldown?: string;
      detailCount?: number;
      detailLabel?: string;
    }>;
    const drilldownSeriesPie = Array.from(grouped.values()).map(
      (entry) =>
        ({
          type: "pie",
          id: entry.id,
          name: entry.label,
          data: Array.from(entry.items.values())
            .map((item, idx) => ({
              name: item.name,
              y: Number(Math.abs(item.gain).toFixed(2)),
              color:
                item.gain < 0
                  ? LOSS_COLOR
                  : ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
              currency: totalCurrency,
              displayName: item.label,
              rawGain: item.gain,
              isLoss: item.gain < 0,
            }))
            .filter((item) => item.y > 0),
        }) as Highcharts.SeriesOptionsType
    );
    const drilldownSeriesBar = Array.from(grouped.values()).map(
      (entry) =>
        ({
          type: "bar",
          id: entry.id,
          name: entry.label,
          data: Array.from(entry.items.values())
            .map((item, idx) => ({
              name: item.name,
              y: Number(item.gain.toFixed(2)),
              color:
                item.gain < 0
                  ? LOSS_COLOR
                  : ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
              currency: totalCurrency,
              displayName: item.label,
              rawGain: item.gain,
            }))
            .filter((item) => item.y !== 0),
        }) as Highcharts.SeriesOptionsType
    );
    const total = points.reduce((sum, p) => sum + p.y, 0);
    return { points, total, drilldownSeriesPie, drilldownSeriesBar };
  }, [chartGroupBy, chartHoldings, chartPlacements, accountsById, fxRates, totalCurrency]);

  const chartGainAbs = useMemo(() => {
    let total = 0;
    let hasValue = false;
    chartHoldings.forEach((holding) => {
      const price = holding.last_price ?? null;
      const marketValueNative =
        price !== null && price !== undefined ? price * holding.shares : holding.market_value;
      const marketValue = convertAmount(marketValueNative, holding.currency);
      const totalCost = getHoldingTotalCost(holding);
      const totalCostConverted = convertAmount(
        totalCost,
        holding.currency,
        holding.fx_rate,
        true
      );
      const gainAbs =
        marketValue !== null && marketValue !== undefined
          ? marketValue - (totalCostConverted || 0)
          : convertAmount(holding.gain_abs, holding.currency);
      if (gainAbs === null || gainAbs === undefined || Number.isNaN(gainAbs)) return;
      total += gainAbs;
      hasValue = true;
    });
    chartPlacements.forEach((placement) => {
      const currentValue = placement.current_value;
      const baseValue =
        placement.initial_value !== null && placement.initial_value !== undefined
          ? placement.initial_value
          : placement.current_value;
      if (currentValue === null || currentValue === undefined) return;
      if (baseValue === null || baseValue === undefined) return;
      const contributions = placement.total_contributions ?? 0;
      const withdrawals = placement.total_withdrawals ?? 0;
      const base = baseValue + contributions - withdrawals;
      const gainRaw = currentValue - base;
      const gainAbs = convertAmount(gainRaw, placement.currency);
      if (gainAbs === null || gainAbs === undefined || Number.isNaN(gainAbs)) return;
      total += gainAbs;
      hasValue = true;
    });
    return hasValue ? total : null;
  }, [chartHoldings, chartPlacements, fxRates]);

  const placementEvolution = useMemo(() => {
    if (!placementChartTarget) {
      return { points: [] as Array<{ x: number; y: number; rawValue: number }>, currency: "EUR" };
    }
    const currency = (placementChartTarget.currency || "EUR").toUpperCase();
    const sorted = [...placementChartSnapshots]
      .filter((snapshot) => snapshot.recorded_at || snapshot.created_at)
      .sort((a, b) => {
        const aTime = new Date(a.recorded_at || a.created_at).getTime();
        const bTime = new Date(b.recorded_at || b.created_at).getTime();
        return aTime - bTime;
      });
    let currentValue: number | null = null;
    const points: Array<{ x: number; y: number; rawValue: number }> = [];
    sorted.forEach((snapshot) => {
      const timestamp = new Date(snapshot.recorded_at || snapshot.created_at).getTime();
      if (Number.isNaN(timestamp)) return;
      const kind = (snapshot.entry_kind || "VALUE").toUpperCase();
      if (kind === "VALUE" || kind === "INITIAL") {
        currentValue = snapshot.value;
      } else if (kind === "INTEREST" || kind === "CONTRIBUTION") {
        currentValue = (currentValue ?? 0) + snapshot.value;
      } else if (kind === "FEE" || kind === "WITHDRAWAL") {
        currentValue = (currentValue ?? 0) - snapshot.value;
      }
      if (currentValue === null || currentValue === undefined) return;
      const converted = convertAmount(currentValue, currency);
      const displayValue = converted ?? currentValue;
      points.push({
        x: timestamp,
        y: Number(displayValue.toFixed(2)),
        rawValue: currentValue,
      });
    });
    return { points, currency };
  }, [placementChartTarget, placementChartSnapshots, fxRates]);

  const placementChartOptions = useMemo<Highcharts.Options>(() => {
    if (!placementChartTarget) return {};
    const seriesData = placementEvolution.points;
    const placementCurrency = placementEvolution.currency;
    const hasData = seriesData.length > 0;
    return {
      chart: {
        type: "line",
        backgroundColor: "transparent",
        height: 360,
        zoomType: "x",
      },
      title: { text: null },
      xAxis: {
        type: "datetime",
        tickColor: "rgba(255, 255, 255, 0.15)",
        lineColor: "rgba(255, 255, 255, 0.15)",
        labels: { style: { color: "#cbd5f5" } },
      },
      yAxis: {
        title: { text: null },
        gridLineColor: "rgba(255, 255, 255, 0.08)",
        labels: {
          style: { color: "#cbd5f5" },
          formatter: function (this: Highcharts.AxisLabelsFormatterContextObject) {
            return formatMoney(this.value as number, DISPLAY_CURRENCY);
          },
        },
      },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        formatter: function (this: Highcharts.Point) {
          const point = this as Highcharts.Point & { rawValue?: number };
          const x = typeof point.x === "number" ? point.x : 0;
          const dateLabel = x ? new Date(x).toLocaleString() : "—";
          const primary = formatMoney(point.y as number, DISPLAY_CURRENCY);
          const rawValue = point.rawValue ?? point.y ?? 0;
          const secondary =
            placementCurrency !== DISPLAY_CURRENCY
              ? ` (${formatMoney(rawValue, placementCurrency)})`
              : "";
          return `<strong>${placementChartTarget.name}</strong><br/>${dateLabel}<br/>${primary}${secondary}`;
        },
      },
      plotOptions: {
        line: {
          marker: { enabled: seriesData.length <= 1 },
          lineWidth: 2,
        },
        series: {
          states: {
            hover: {
              halo: { size: 6, opacity: 0.25 },
            },
          },
        },
      },
      legend: { enabled: false },
      credits: { enabled: false },
      series: hasData
        ? [
            {
              type: "line",
              name: "Value",
              color: "#38bdf8",
              data: seriesData,
            },
          ]
        : [],
    };
  }, [placementChartTarget, placementEvolution, DISPLAY_CURRENCY]);

  const allocationOptions = useMemo<Highcharts.Options>(() => {
    const hasData = allocationData.total > 0 && allocationData.points.length > 0;
    const buildAllocationTitle = (value: number) =>
      `<div class="donut-center"><strong>${formatMoney(Math.ceil(value), totalCurrency)}</strong></div>`;
    const totalTitle = buildAllocationTitle(allocationData.total);
    const data = hasData
      ? allocationData.points.map((p, idx) => ({
          name: p.name,
          y: Math.ceil(p.y),
          rawValue: p.y,
          color: ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
          currency: DISPLAY_CURRENCY,
          displayName: p.label,
          drilldown: p.drilldown,
          detailCount: p.detailCount,
          detailLabel: p.detailLabel,
        }))
      : [
          {
            name: "Add holdings or placements",
            y: 1,
            color: "rgba(255, 255, 255, 0.06)",
            isDummy: true,
          },
        ];

    return {
      chart: {
        type: "pie",
        backgroundColor: "transparent",
        height: 300,
        events: {
          drilldown: function (
            this: Highcharts.Chart,
            e: Highcharts.DrilldownEventObject
          ) {
            if (!e.point) return;
            const options = e.point.options as Highcharts.PointOptionsObject & {
              rawValue?: number;
            };
            const value =
              typeof options.rawValue === "number"
                ? options.rawValue
                : (e.point.y as number) ?? 0;
            this.setTitle({ text: buildAllocationTitle(value) });
          },
          drillup: function (this: Highcharts.Chart) {
            this.setTitle({ text: totalTitle });
          },
        },
      },
      drilldown: {
        series: allocationData.drilldownSeriesPie,
        drillUpButton: {
          theme: {
            fill: "rgba(15, 23, 42, 0.85)",
            stroke: "rgba(255, 255, 255, 0.12)",
            r: 8,
            style: { color: "#e9ecf4" },
          },
        },
      },
      title: {
        useHTML: true,
        align: "center",
        verticalAlign: "middle",
        floating: true,
        style: { color: "#e9ecf4" },
        text: totalTitle,
      },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        formatter: function (this: Highcharts.Point) {
          const point = this as Highcharts.Point & {
            currency?: string;
            displayName?: string;
            isDummy?: boolean;
            detailCount?: number;
            detailLabel?: string;
          };
          const options = point.options as Highcharts.PointOptionsObject & {
            currency?: string;
            displayName?: string;
            isDummy?: boolean;
            detailCount?: number;
            detailLabel?: string;
          };
          if (options.isDummy) {
            return "Add holdings or placements to see allocation";
          }
          const currency = options.currency || totalCurrency;
          const displayName = options.displayName || point.name;
          const value = formatMoney(point.y ?? 0, currency);
          const percentage = (point.percentage || 0).toFixed(1);
          const detailCount = options.detailCount ?? point.detailCount ?? 0;
          const detailLabel = options.detailLabel || "items";
          const detailLine =
            detailCount > 1 || detailCount === 1
              ? `<br/>${detailCount} ${detailLabel}`
              : "";
          return `<strong>${displayName}</strong><br/>${value}<br/>${percentage}% of portfolio${detailLine}`;
        },
      },
      plotOptions: {
        pie: {
          innerSize: "65%",
          size: "78%",
          borderWidth: 0,
          dataLabels: {
            enabled: hasData,
            distance: 12,
            connectorColor: "rgba(255, 255, 255, 0.35)",
            connectorWidth: 1.2,
            style: { color: "#e9ecf4", textOutline: "none", fontWeight: "600", textTransform: "uppercase", fontSize: "12px", letterSpacing: "0.02em" },
            crop: false,
            overflow: "allow",
            formatter: function (this: Highcharts.Point) {
              const point = this as Highcharts.Point & {
                options: Highcharts.PointOptionsObject & { currency?: string };
              };
              const currency =
                (point.options && (point.options as any).currency) || totalCurrency;
              const value = formatMoney(point.y as number, currency);
              const pct = (point.percentage || 0).toFixed(1);
              return `${point.name}<br/>${value} • ${pct}%`;
            },
          },
          states: {
            hover: { brightness: 0.08 },
          },
        },
      },
      legend: {
        enabled: true,
        itemStyle: { color: "#e9ecf4", fontWeight: "500" },
      },
      credits: { enabled: false },
      series: [
        {
          type: "pie",
          name: "Portfolio",
          data,
        },
      ],
    };
  }, [allocationData, totalCurrency]);

  const allocationBarOptions = useMemo<Highcharts.Options>(() => {
    const hasData = allocationData.total > 0 && allocationData.points.length > 0;
    const data = hasData
      ? allocationData.points.map((point, idx) => ({
          name: point.name || point.label,
          y: Number(point.y.toFixed(2)),
          color: ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
          currency: DISPLAY_CURRENCY,
          displayName: point.label,
          share: allocationData.total > 0 ? point.y / allocationData.total : 0,
          drilldown: point.drilldown,
          detailCount: point.detailCount,
          detailLabel: point.detailLabel,
        }))
      : [];

    return {
      chart: {
        type: "bar",
        backgroundColor: "transparent",
        height: 300,
      },
      title: { text: null },
      xAxis: {
        type: "category",
        lineColor: "rgba(255, 255, 255, 0.15)",
        tickColor: "rgba(255, 255, 255, 0.15)",
        labels: {
          style: { color: "#e9ecf4", fontWeight: "600", fontSize: "11px" },
        },
      },
      yAxis: {
        title: { text: null },
        gridLineColor: "rgba(255, 255, 255, 0.08)",
        labels: {
          style: { color: "#9fb0d4", fontSize: "11px" },
          rotation: BAR_VALUE_LABEL_ROTATION,
          formatter: function (this: Highcharts.AxisLabelsFormatterContextObject) {
            return formatMoney(this.value as number, totalCurrency);
          },
        },
      },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        formatter: function (this: Highcharts.Point) {
          const point = this as Highcharts.Point;
          const options = point.options as Highcharts.PointOptionsObject & {
            currency?: string;
            displayName?: string;
            share?: number;
            detailCount?: number;
            detailLabel?: string;
          };
          const currency = options.currency || totalCurrency;
          const value = formatMoney(point.y as number, currency);
          const share =
            options.share !== undefined
              ? `${(options.share * 100).toFixed(1)}% of portfolio`
              : null;
          const detailCount = options.detailCount ?? 0;
          const detailLabel = options.detailLabel || "items";
          const detailLine =
            detailCount > 1 || detailCount === 1 ? `${detailCount} ${detailLabel}` : null;
          return `<strong>${options.displayName || point.name}</strong><br/>${value}${
            share ? `<br/>${share}` : ""
          }${detailLine ? `<br/>${detailLine}` : ""}`;
        },
      },
      plotOptions: {
        bar: {
          borderWidth: 0,
          groupPadding: 0.1,
          pointPadding: 0.08,
          dataLabels: {
            enabled: hasData,
            style: {
              color: "#e9ecf4",
              textOutline: "none",
              fontWeight: "600",
              fontSize: "11px",
            },
            formatter: function (this: Highcharts.Point) {
              return formatMoney(this.y as number, totalCurrency);
            },
          },
        },
      },
      legend: { enabled: false },
      credits: { enabled: false },
      drilldown: {
        series: allocationData.drilldownSeriesBar,
        drillUpButton: {
          theme: {
            fill: "rgba(15, 23, 42, 0.85)",
            stroke: "rgba(255, 255, 255, 0.12)",
            r: 8,
            style: { color: "#e9ecf4" },
          },
        },
      },
      series: [
        {
          type: "bar",
          name: "Allocation",
          data,
        },
      ],
    };
  }, [allocationData, totalCurrency]);

  const plDonutOptions = useMemo<Highcharts.Options>(() => {
    const hasData = plData.total > 0 && plData.points.length > 0;
    const buildPlTitle = (value?: number | null) =>
      `<div class="donut-center"><strong>${formatMoneySigned(value, totalCurrency)}</strong></div>`;
    const data = hasData
      ? plData.points.map((p, idx) => ({
          name: p.name,
          y: Math.ceil(p.y),
          color: p.isLoss
            ? LOSS_COLOR
            : ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
          currency: DISPLAY_CURRENCY,
          displayName: p.label,
          rawGain: p.gain,
          isLoss: p.isLoss,
          drilldown: p.drilldown,
          detailCount: p.detailCount,
          detailLabel: p.detailLabel,
        }))
      : [
          {
            name: "No P/L yet",
            y: 1,
            color: "rgba(255, 255, 255, 0.06)",
            isDummy: true,
          },
        ];

    return {
      chart: {
        type: "pie",
        backgroundColor: "transparent",
        height: 300,
        events: {
          drilldown: function (this: Highcharts.Chart, event: Highcharts.DrilldownEventObject) {
            const seriesOptions = event.seriesOptions as Highcharts.SeriesOptionsType | undefined;
            if (!seriesOptions || !("data" in seriesOptions)) return;
            const seriesData =
              (seriesOptions as { data?: Array<{ rawGain?: number; y?: number }> }).data || [];
            const total = seriesData.reduce((sum, point) => {
              if (typeof point.rawGain === "number") return sum + point.rawGain;
              if (typeof point.y === "number") return sum + point.y;
              return sum;
            }, 0);
            this.setTitle({ text: buildPlTitle(total) });
          },
          drillup: function (this: Highcharts.Chart) {
            this.setTitle({ text: buildPlTitle(chartGainAbs) });
          },
        },
      },
      drilldown: {
        series: plData.drilldownSeriesPie,
        drillUpButton: {
          theme: {
            fill: "rgba(15, 23, 42, 0.85)",
            stroke: "rgba(255, 255, 255, 0.12)",
            r: 8,
            style: { color: "#e9ecf4" },
          },
        },
      },
      title: {
        useHTML: true,
        align: "center",
        verticalAlign: "middle",
        floating: true,
        text: buildPlTitle(chartGainAbs),
      },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        formatter: function (this: Highcharts.Point) {
          const point = this as Highcharts.Point & {
            isLoss?: boolean;
            rawGain?: number;
          };
          const options = point.options as Highcharts.PointOptionsObject & {
            currency?: string;
            displayName?: string;
            isDummy?: boolean;
            rawGain?: number;
            detailCount?: number;
            detailLabel?: string;
          };
          if (options.isDummy) {
            return "Add holdings/prices to see P/L mix";
          }
          const currency = options.currency || totalCurrency;
          const rawGain = options.rawGain ?? 0;
          const value = `${rawGain >= 0 ? "+" : "-"}${formatMoney(Math.abs(rawGain), currency)}`;
          const percentage = (point.percentage || 0).toFixed(1);
          const detailCount = options.detailCount ?? 0;
          const detailLabel = options.detailLabel || "lots";
          const detailLine =
            detailCount > 1 || detailCount === 1 ? `<br/>${detailCount} ${detailLabel}` : "";
          return `<strong>${options.displayName || point.name}</strong><br/>${value}<br/>${percentage}% of total P/L${detailLine}`;
        },
      },
      plotOptions: {
        pie: {
          innerSize: "65%",
          size: "78%",
          borderWidth: 0,
          dataLabels: {
            enabled: hasData,
            distance: 12,
            connectorColor: "rgba(255, 255, 255, 0.35)",
            connectorWidth: 1.2,
            style: { color: "#e9ecf4", textOutline: "none", fontWeight: "600", textTransform: "uppercase", fontSize: "12px", letterSpacing: "0.02em" },
            crop: false,
            overflow: "allow",
            formatter: function (this: Highcharts.Point) {
              const point = this as Highcharts.Point;
              const options = point.options as Highcharts.PointOptionsObject & {
                currency?: string;
                rawGain?: number;
              };
              const currency = options.currency || totalCurrency;
              const rawGain = options.rawGain ?? 0;
              const value = `${rawGain >= 0 ? "+" : "-"}${formatMoney(Math.abs(rawGain), currency)}`;
              const pct = (point.percentage || 0).toFixed(1);
              return `${point.name}<br/>${value} • ${pct}%`;
            },
          },
          states: {
            hover: { brightness: 0.08 },
          },
        },
      },
      legend: {
        enabled: true,
        itemStyle: { color: "#e9ecf4", fontWeight: "500" },
      },
      credits: { enabled: false },
      series: [
        {
          type: "pie",
          name: "P/L mix",
          data,
        },
      ],
    };
  }, [plData, totalCurrency, chartGainAbs]);

  const plBarOptions = useMemo<Highcharts.Options>(() => {
    const hasData = plData.total > 0 && plData.points.length > 0;
    const data = hasData
      ? plData.points.map((p, idx) => ({
          name: p.name || p.label,
          y: Number(p.gain.toFixed(2)),
          color: p.isLoss
            ? LOSS_COLOR
            : ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
          currency: DISPLAY_CURRENCY,
          displayName: p.label,
          rawGain: p.gain,
          share: plData.total > 0 ? Math.abs(p.gain) / plData.total : 0,
          drilldown: p.drilldown,
          detailCount: p.detailCount,
          detailLabel: p.detailLabel,
        }))
      : [];

    return {
      chart: {
        type: "bar",
        backgroundColor: "transparent",
        height: 300,
      },
      drilldown: {
        series: plData.drilldownSeriesBar,
        drillUpButton: {
          theme: {
            fill: "rgba(15, 23, 42, 0.85)",
            stroke: "rgba(255, 255, 255, 0.12)",
            r: 8,
            style: { color: "#e9ecf4" },
          },
        },
      },
      title: { text: null },
      xAxis: {
        type: "category",
        lineColor: "rgba(255, 255, 255, 0.15)",
        tickColor: "rgba(255, 255, 255, 0.15)",
        labels: {
          style: { color: "#e9ecf4", fontWeight: "600", fontSize: "11px" },
        },
      },
      yAxis: {
        title: { text: null },
        gridLineColor: "rgba(255, 255, 255, 0.08)",
        labels: {
          style: { color: "#9fb0d4", fontSize: "11px" },
          rotation: BAR_VALUE_LABEL_ROTATION,
          formatter: function (this: Highcharts.AxisLabelsFormatterContextObject) {
            return formatMoneySigned(this.value as number, totalCurrency);
          },
        },
        plotLines: [
          {
            value: 0,
            color: "rgba(255, 255, 255, 0.28)",
            width: 1,
          },
        ],
      },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        formatter: function (this: Highcharts.Point) {
          const point = this as Highcharts.Point;
          const options = point.options as Highcharts.PointOptionsObject & {
            currency?: string;
            displayName?: string;
            rawGain?: number;
            share?: number;
            detailCount?: number;
            detailLabel?: string;
          };
          const currency = options.currency || totalCurrency;
          const rawGain = options.rawGain ?? (point.y as number) ?? 0;
          const value = formatMoneySigned(rawGain, currency);
          const share =
            options.share !== undefined
              ? `${(options.share * 100).toFixed(1)}% of total P/L`
              : null;
          const detailCount = options.detailCount ?? 0;
          const detailLabel = options.detailLabel || "lots";
          const detailLine =
            detailCount > 1 || detailCount === 1 ? `${detailCount} ${detailLabel}` : null;
          return `<strong>${options.displayName || point.name}</strong><br/>${value}${
            share ? `<br/>${share}` : ""
          }${detailLine ? `<br/>${detailLine}` : ""}`;
        },
      },
      plotOptions: {
        bar: {
          borderWidth: 0,
          groupPadding: 0.1,
          pointPadding: 0.08,
          dataLabels: {
            enabled: hasData,
            style: {
              color: "#e9ecf4",
              textOutline: "none",
              fontWeight: "600",
              fontSize: "11px",
            },
            formatter: function (this: Highcharts.Point) {
              const point = this as Highcharts.Point;
              const options = point.options as Highcharts.PointOptionsObject & {
                currency?: string;
                rawGain?: number;
              };
              const currency = options.currency || totalCurrency;
              const rawGain = options.rawGain ?? (point.y as number) ?? 0;
              return formatMoneySigned(rawGain, currency);
            },
          },
        },
      },
      legend: { enabled: false },
      credits: { enabled: false },
      series: [
        {
          type: "bar",
          name: "P/L mix",
          data,
        },
      ],
    };
  }, [plData, totalCurrency]);

  const portfolioEvolutionSeries = useMemo(() => {
    const rows = [...portfolioHistoryRows].sort((a, b) => {
      const aTime = Date.parse(`${a.snapshot_date}T00:00:00Z`);
      const bTime = Date.parse(`${b.snapshot_date}T00:00:00Z`);
      return aTime - bTime;
    });

    const totalValue: Array<[number, number]> = [];
    const portfolioCosts: Array<[number, number]> = [];
    rows.forEach((row) => {
      const timestamp = Date.parse(`${row.snapshot_date}T00:00:00Z`);
      if (Number.isNaN(timestamp)) return;
      const trackedPortfolioValue = (row.holdings_value ?? 0) + (row.placements_value ?? 0);
      totalValue.push([timestamp, Number(trackedPortfolioValue.toFixed(2))]);
      if (row.total_cost !== null && row.total_cost !== undefined) {
        portfolioCosts.push([timestamp, Number(row.total_cost.toFixed(2))]);
      }
    });

    return { totalValue, portfolioCosts };
  }, [portfolioHistoryRows]);

  const holdingEvolutionSeriesBySymbol = useMemo(() => {
    const symbolBuckets = new Map<
      string,
      Map<number, { marketValue: number; costTotal: number }>
    >();

    holdingHistoryRows.forEach((row) => {
      const symbol = (row.symbol || "").trim().toUpperCase();
      if (!symbol) return;
      const timestamp = Date.parse(`${row.snapshot_date}T00:00:00Z`);
      if (Number.isNaN(timestamp)) return;
      const marketRaw =
        row.market_value ?? (row.close_price !== null && row.close_price !== undefined
          ? row.close_price * row.shares
          : null);
      const marketValue = convertAmount(marketRaw, row.currency);
      const costTotal = convertAmount(row.cost_total, row.currency);
      if (
        (marketValue === null || marketValue === undefined) &&
        (costTotal === null || costTotal === undefined)
      ) {
        return;
      }
      const symbolSeries = symbolBuckets.get(symbol) || new Map<number, { marketValue: number; costTotal: number }>();
      const existing = symbolSeries.get(timestamp) || { marketValue: 0, costTotal: 0 };
      symbolSeries.set(timestamp, {
        marketValue:
          existing.marketValue + (marketValue !== null && marketValue !== undefined ? marketValue : 0),
        costTotal:
          existing.costTotal + (costTotal !== null && costTotal !== undefined ? costTotal : 0),
      });
      symbolBuckets.set(symbol, symbolSeries);
    });

    const result = new Map<string, { marketValue: Array<[number, number]>; costTotal: Array<[number, number]> }>();
    symbolBuckets.forEach((series, symbol) => {
      const sorted = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
      const marketValue: Array<[number, number]> = [];
      const costTotal: Array<[number, number]> = [];
      sorted.forEach(([timestamp, values]) => {
        marketValue.push([timestamp, Number(values.marketValue.toFixed(2))]);
        costTotal.push([timestamp, Number(values.costTotal.toFixed(2))]);
      });
      result.set(symbol, { marketValue, costTotal });
    });

    return result;
  }, [holdingHistoryRows, fxRates]);

  const portfolioEvolutionStockOptions = useMemo<Highcharts.Options>(() => {
    const isStockView = Boolean(selectedHistorySymbol);
    const selectedStockSeries = selectedHistorySymbol
      ? holdingEvolutionSeriesBySymbol.get(selectedHistorySymbol)
      : null;
    const valueSeries = isStockView
      ? selectedStockSeries?.marketValue || []
      : portfolioEvolutionSeries.totalValue;
    const costSeries = isStockView
      ? selectedStockSeries?.costTotal || []
      : portfolioEvolutionSeries.portfolioCosts;
    const valueSeriesName = isStockView
      ? `${selectedHistorySymbol || "Stock"} value`
      : "Portfolio value";
    const costSeriesName = isStockView
      ? `${selectedHistorySymbol || "Stock"} costs`
      : "Portfolio costs";
    const hasData = valueSeries.length > 0;
    const formatKValue = (rawValue: number) => {
      const valueK = (Number(rawValue) || 0) / 1000;
      const absValueK = Math.abs(valueK);
      const maxDigits = absValueK >= 100 ? 0 : absValueK >= 10 ? 1 : 2;
      return `${valueK.toLocaleString("fr-FR", {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDigits,
      })} k€`;
    };
    const lastPortfolioValue = hasData ? valueSeries[valueSeries.length - 1]?.[1] : null;
    return {
      chart: {
        backgroundColor: "transparent",
        height: 360,
      },
      title: { text: null },
      credits: { enabled: false },
      legend: {
        enabled: true,
        itemStyle: { color: "#e9ecf4", fontWeight: "500", fontSize: "11px" },
      },
      rangeSelector: {
        selected: 0,
        inputEnabled: false,
        buttonTheme: {
          fill: "rgba(255, 255, 255, 0.06)",
          stroke: "rgba(255, 255, 255, 0.1)",
          r: 8,
          style: { color: "#cbd5f5" },
          states: {
            select: {
              fill: "rgba(14, 165, 233, 0.2)",
              style: { color: "#e9ecf4" },
            },
          },
        },
        labelStyle: { color: "#9fb0d4" },
      },
      navigator: {
        enabled: hasData,
        maskFill: "rgba(14, 165, 233, 0.14)",
        series: {
          type: "areaspline",
          color: "rgba(56, 189, 248, 0.6)",
          fillOpacity: 0.15,
          lineWidth: 1,
        },
        xAxis: {
          labels: { style: { color: "#9fb0d4" } },
        },
      },
      scrollbar: {
        enabled: hasData,
        barBackgroundColor: "rgba(255, 255, 255, 0.12)",
        barBorderColor: "rgba(255, 255, 255, 0.18)",
        buttonBackgroundColor: "rgba(255, 255, 255, 0.12)",
        buttonBorderColor: "rgba(255, 255, 255, 0.18)",
        rifleColor: "#9fb0d4",
        trackBackgroundColor: "rgba(255, 255, 255, 0.04)",
        trackBorderColor: "rgba(255, 255, 255, 0.12)",
      },
      xAxis: {
        type: "datetime",
        lineColor: "rgba(255, 255, 255, 0.12)",
        tickColor: "rgba(255, 255, 255, 0.12)",
        labels: {
          style: { color: "#9fb0d4" },
        },
      },
      yAxis: {
        opposite: false,
        startOnTick: false,
        endOnTick: false,
        minPadding: 0.02,
        maxPadding: 0.05,
        title: { text: null },
        gridLineColor: "rgba(255, 255, 255, 0.08)",
        labels: {
          style: { color: "#9fb0d4", fontSize: "11px" },
          formatter: function (this: Highcharts.AxisLabelsFormatterContextObject) {
            return formatKValue(Number(this.value) || 0);
          },
        },
        plotLines:
          lastPortfolioValue !== null && lastPortfolioValue !== undefined
            ? [
                {
                  value: lastPortfolioValue,
                  color: "rgba(34, 197, 94, 0.5)",
                  width: 1,
                  dashStyle: "ShortDot",
                  zIndex: 4,
                  label: {
                    text: formatKValue(lastPortfolioValue),
                    align: "left",
                    x: 6,
                    y: 4,
                    style: {
                      color: "#4ade80",
                      fontSize: "11px",
                      fontWeight: "700",
                      textOutline: "none",
                    },
                  },
                },
              ]
            : [],
      },
      tooltip: {
        shared: true,
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        xDateFormat: "%e %b %Y",
        pointFormatter: function (this: Highcharts.Point) {
          const value = formatMoney(this.y as number, totalCurrency);
          return `<span style="color:${this.color}">●</span> ${
            this.series.name
          }: <strong>${value}</strong><br/>`;
        },
      },
      plotOptions: {
        series: {
          dataGrouping: {
            enabled: false,
          },
        },
      },
      series: hasData
        ? [
            {
              type: "areaspline",
              name: valueSeriesName,
              data: valueSeries,
              color: "#38bdf8",
              fillColor: {
                linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
                stops: [
                  [0, "rgba(56, 189, 248, 0.32)"],
                  [0.6, "rgba(56, 189, 248, 0.14)"],
                  [1, "rgba(56, 189, 248, 0.02)"],
                ],
              },
              threshold: null,
              softThreshold: false,
              lineWidth: 2.2,
              marker: { enabled: false },
              tooltip: { valueDecimals: 2 },
            },
            ...(costSeries.length
              ? [
                  {
                    type: "line",
                    name: costSeriesName,
                    data: costSeries,
                    color: "#94a3b8",
                    dashStyle: "ShortDash",
                    lineWidth: 1.8,
                    visible: false,
                    marker: { enabled: false },
                    tooltip: { valueDecimals: 2 },
                  } as Highcharts.SeriesLineOptions,
                ]
              : []),
          ]
        : [],
    };
  }, [holdingEvolutionSeriesBySymbol, portfolioEvolutionSeries, selectedHistorySymbol, totalCurrency]);

  const historyChartHasData = useMemo(() => {
    if (!selectedHistorySymbol) return portfolioEvolutionSeries.totalValue.length > 0;
    return (holdingEvolutionSeriesBySymbol.get(selectedHistorySymbol)?.marketValue.length || 0) > 0;
  }, [holdingEvolutionSeriesBySymbol, portfolioEvolutionSeries, selectedHistorySymbol]);

  const historyEmptyMessage = selectedHistorySymbol
    ? `No history yet for ${selectedHistorySymbol} in this window.`
    : "No history yet. Daily snapshots are captured automatically.";

  const allocationChartOptions =
    allocationChartType === "donut" ? allocationOptions : allocationBarOptions;
  const allocationToggleLabel =
    allocationChartType === "donut" ? "Show bar chart" : "Show donut chart";
  const plChartOptions = plChartType === "donut" ? plDonutOptions : plBarOptions;
  const plToggleLabel = plChartType === "donut" ? "Show bar chart" : "Show donut chart";
  const chartGroupLabel =
    CHART_GROUP_OPTIONS.find((option) => option.value === chartGroupBy)?.label || "Holding";
  const hasHoldings = holdings.length > 0;
  const hasPlacements = placements.length > 0;
  const chartHasHoldings = chartHoldings.length > 0;
  const chartHasPlacements = chartPlacements.length > 0;
  const allocationEmptyMessage =
    !chartHasHoldings && !chartHasPlacements
      ? "Add holdings or placements to see the breakdown."
      : chartHasHoldings && chartHasPlacements
        ? "Select holdings or placements to see the breakdown."
        : chartHasHoldings
          ? "Select holdings to see the breakdown."
          : "Select placements to see the breakdown.";
  const plEmptyMessage =
    !chartHasHoldings && !chartHasPlacements
      ? "Add holdings or placements to see the P/L breakdown."
      : chartHasHoldings && chartHasPlacements
        ? "Select holdings/prices or placements to see the P/L breakdown."
        : chartHasHoldings
          ? "Select holdings/prices to see the P/L breakdown."
          : "Select placements to see the P/L breakdown.";
  const sortedPlacements = useMemo(
    () => [...placements].sort((a, b) => a.name.localeCompare(b.name)),
    [placements]
  );
  const placementsTotal = useMemo(() => {
    if (!placements.length) return null;
    return placements.reduce((sum, placement) => {
      const converted = convertAmount(placement.current_value, placement.currency);
      return sum + (converted ?? 0);
    }, 0);
  }, [placements, fxRates]);
  const holdingsTotal = useMemo(() => {
    if (!holdings.length) return null;
    return holdings.reduce((sum, holding) => {
      const marketValueNative =
        holding.last_price !== null && holding.last_price !== undefined
          ? holding.last_price * holding.shares
          : holding.market_value;
      const converted = convertAmount(
        marketValueNative,
        holding.currency,
        holding.fx_rate,
        true
      );
      return sum + (converted ?? 0);
    }, 0);
  }, [holdings, fxRates]);
  const filteredHoldings = useMemo(() => {
    if (holdingAccountFilter === "all") return holdings;
    const accountId = Number(holdingAccountFilter);
    if (!Number.isFinite(accountId)) return holdings;
    return holdings.filter((holding) => {
      const holdingAccountId = holding.account_id ?? holding.account?.id ?? null;
      return holdingAccountId === accountId;
    });
  }, [holdings, holdingAccountFilter]);
  const filteredHoldingsTotal = useMemo(() => {
    if (!filteredHoldings.length) return null;
    return filteredHoldings.reduce((sum, holding) => {
      const marketValueNative =
        holding.last_price !== null && holding.last_price !== undefined
          ? holding.last_price * holding.shares
          : holding.market_value;
      const converted = convertAmount(
        marketValueNative,
        holding.currency,
        holding.fx_rate,
        true
      );
      return sum + (converted ?? 0);
    }, 0);
  }, [filteredHoldings, fxRates]);
  const holdingCountLabel =
    holdingAccountFilter === "all"
      ? `${holdings.length} tracked`
      : `${filteredHoldings.length} of ${holdings.length} tracked`;
  const displayedHoldingsTotal =
    holdingAccountFilter === "all" ? holdingsTotal : filteredHoldingsTotal;
  const accountHoldingsCount = useMemo(() => {
    const counts = new Map<number, number>();
    holdings.forEach((holding) => {
      if (!holding.account_id) return;
      counts.set(holding.account_id, (counts.get(holding.account_id) || 0) + 1);
    });
    return counts;
  }, [holdings]);
  const accountPlacementsCount = useMemo(() => {
    const counts = new Map<number, number>();
    placements.forEach((placement) => {
      if (!placement.account_id) return;
      counts.set(placement.account_id, (counts.get(placement.account_id) || 0) + 1);
    });
    return counts;
  }, [placements]);
  const accountHoldingsValue = useMemo(() => {
    const values = new Map<number, number>();
    holdings.forEach((holding) => {
      const accountId = holding.account_id ?? holding.account?.id;
      if (!accountId) return;
      const lastPrice = holding.last_price ?? null;
      const mvRaw =
        holding.market_value !== null && holding.market_value !== undefined
          ? holding.market_value
          : lastPrice !== null
            ? lastPrice * holding.shares
            : null;
      const mv = convertAmount(mvRaw, holding.currency);
      if (mv === null || mv === undefined) return;
      values.set(accountId, (values.get(accountId) || 0) + mv);
    });
    return values;
  }, [holdings, fxRates]);
  const accountPlacementsValue = useMemo(() => {
    const values = new Map<number, number>();
    placements.forEach((placement) => {
      const accountId = placement.account_id ?? null;
      if (!accountId) return;
      const converted = convertAmount(placement.current_value, placement.currency);
      if (converted === null || converted === undefined) return;
      values.set(accountId, (values.get(accountId) || 0) + converted);
    });
    return values;
  }, [placements, fxRates]);
  const totalAllocationValue = useMemo(() => {
    let total = 0;
    accountHoldingsValue.forEach((value) => {
      total += value;
    });
    accountPlacementsValue.forEach((value) => {
      total += value;
    });
    return total;
  }, [accountHoldingsValue, accountPlacementsValue]);

  const accountRows = useMemo<AccountRow[]>(() => {
    return accounts.map((account) => {
      const holdingsValue = accountHoldingsValue.get(account.id) || 0;
      const placementsValue = accountPlacementsValue.get(account.id) || 0;
      const allocationValue = holdingsValue + placementsValue;
      const allocationPercent =
        totalAllocationValue > 0 ? allocationValue / totalAllocationValue : null;
      const totalValue = allocationValue + (account.liquidity || 0);
      const holdingsCount = accountHoldingsCount.get(account.id) || 0;
      const placementsCount = accountPlacementsCount.get(account.id) || 0;
      const manualInvested = account.manual_invested || 0;
      const performance = totalValue - manualInvested;
      const performanceRatio = manualInvested > 0 ? performance / manualInvested : null;
      return {
        account,
        holdingsValue,
        placementsValue,
        allocationValue,
        allocationPercent,
        totalValue,
        holdingsCount,
        placementsCount,
        manualInvested,
        performance,
        performanceRatio,
      };
    });
  }, [
    accounts,
    accountHoldingsCount,
    accountHoldingsValue,
    accountPlacementsCount,
    accountPlacementsValue,
    totalAllocationValue,
  ]);

  const sortedAccounts = useMemo(() => {
    const list = [...accountRows];
    const getValue = (row: AccountRow) => {
      switch (accountSortField) {
        case "name":
          return row.account.name.toLowerCase();
        case "type":
          return (row.account.account_type || "").toLowerCase();
        case "manual_invested":
          return row.manualInvested;
        case "holdings":
          return row.allocationValue;
        case "liquidity":
          return row.account.liquidity ?? 0;
        case "total":
          return row.totalValue;
        case "performance":
          return row.performance;
        default:
          return null;
      }
    };

    list.sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      const dir = accountSortDir === "asc" ? 1 : -1;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * dir;
      }
      if (av > bv) return dir;
      if (av < bv) return -dir;
      return 0;
    });

    return list;
  }, [accountRows, accountSortDir, accountSortField]);

  const accountsSummary = useMemo(() => {
    if (!accountRows.length) return null;
    let manualInvested = 0;
    let allocationValue = 0;
    let liquidity = 0;
    let totalValue = 0;
    let holdingsCount = 0;
    let placementsCount = 0;
    accountRows.forEach((row) => {
      manualInvested += row.manualInvested;
      allocationValue += row.allocationValue;
      liquidity += row.account.liquidity || 0;
      totalValue += row.totalValue;
      holdingsCount += row.holdingsCount;
      placementsCount += row.placementsCount;
    });
    const performance = totalValue - manualInvested;
    const performanceRatio = manualInvested > 0 ? performance / manualInvested : null;
    const allocationPercent =
      totalAllocationValue > 0 ? allocationValue / totalAllocationValue : null;
    return {
      manualInvested,
      allocationValue,
      liquidity,
      totalValue,
      performance,
      performanceRatio,
      holdingsCount,
      placementsCount,
      allocationPercent,
    };
  }, [accountRows, totalAllocationValue]);

  const sortedHoldings = useMemo(() => {
    const list = [...filteredHoldings];
    const getValue = (h: HoldingStats) => {
      switch (sortField) {
        case "instrument":
          return (h.name || h.symbol || h.isin || "").toString().toLowerCase();
        case "account":
          return (h.account?.name || "").toString().toLowerCase();
        case "acquired_at":
          return h.acquired_at ? new Date(h.acquired_at).getTime() : null;
        case "shares":
          return h.shares;
        case "cost":
          return convertAmount(getHoldingTotalCost(h), h.currency);
        case "last_price":
          return convertAmount(h.last_price, h.currency);
        case "value": {
          const mv =
            h.market_value ??
            (h.last_price !== null && h.last_price !== undefined ? h.last_price * h.shares : null);
          return convertAmount(mv, h.currency);
        }
        case "pl": {
          const mv =
            h.market_value ??
            (h.last_price !== null && h.last_price !== undefined ? h.last_price * h.shares : null);
          const totalCost = getHoldingTotalCost(h);
          const convMv = convertAmount(mv, h.currency);
          const convCost = convertAmount(totalCost, h.currency);
          return convMv !== null && convMv !== undefined && convCost !== null && convCost !== undefined
            ? convMv - convCost
            : convertAmount(h.gain_abs, h.currency);
        }
        default:
          return null;
      }
    };

    list.sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      const dir = sortDir === "asc" ? 1 : -1;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * dir;
      }
      if (av > bv) return dir;
      if (av < bv) return -dir;
      return 0;
    });

    return list;
  }, [filteredHoldings, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    setSortDir((prev) => (field === sortField ? (prev === "asc" ? "desc" : "asc") : "desc"));
    setSortField(field);
  };

  const renderSortIcon = (field: SortField) => {
    const isActive = field === sortField;
    const arrow = isActive ? (sortDir === "asc" ? "▲" : "▼") : "↕";
    return <span className={`sort-arrow ${isActive ? "active" : "inactive"}`}>{arrow}</span>;
  };

  const handleAccountSort = (field: AccountSortField) => {
    setAccountSortDir((prev) =>
      field === accountSortField ? (prev === "asc" ? "desc" : "asc") : "desc"
    );
    setAccountSortField(field);
  };

  const renderAccountSortIcon = (field: AccountSortField) => {
    const isActive = field === accountSortField;
    const arrow = isActive ? (accountSortDir === "asc" ? "▲" : "▼") : "↕";
    return <span className={`sort-arrow ${isActive ? "active" : "inactive"}`}>{arrow}</span>;
  };

  const loadDailyHistory = useCallback(async () => {
    const token = authToken || getStoredAuthToken();
    if (!token) {
      setDailyHistory(null);
      setDailyHistoryLoading(false);
      return;
    }
    setDailyHistoryLoading(true);
    try {
      const res = await fetchDailyHistory({
        days: dailyHistoryDays,
      });
      setDailyHistory(res.data);
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to load daily history";
      setStatus({ kind: "error", message: detail });
    } finally {
      setDailyHistoryLoading(false);
    }
  }, [authToken, dailyHistoryDays]);

  const loadPortfolio = async () => {
    const token = authToken || getStoredAuthToken();
    if (!token) {
      setPortfolio(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetchPortfolio();
      setPortfolio(res.data);
      void loadDailyHistory();
      if (!shareEditForm.holdingId && res.data.holdings.length > 0) {
        setShareEditForm({
          holdingId: String(res.data.holdings[0].id),
          shares: String(res.data.holdings[0].shares),
        });
      } else if (shareEditForm.holdingId) {
        const selected = res.data.holdings.find(
          (h) => String(h.id) === shareEditForm.holdingId
        );
        if (selected) {
          setShareEditForm({
            holdingId: String(selected.id),
            shares: String(selected.shares),
          });
        } else if (res.data.holdings.length > 0) {
          setShareEditForm({
            holdingId: String(res.data.holdings[0].id),
            shares: String(res.data.holdings[0].shares),
          });
        } else {
          setShareEditForm({ holdingId: "", shares: "" });
        }
      }
      const yfinanceStatus = res.data.yfinance_status;
      if (yfinanceStatus && yfinanceStatus.ok === false) {
        const message = yfinanceStatus.message || YFINANCE_WARNING_FALLBACK;
        const key = `${yfinanceStatus.last_error_at || ""}|${message}`;
        if (key !== yfinanceStatusRef.current) {
          yfinanceStatusRef.current = key;
          setStatus({ kind: "error", message });
        }
      } else {
        yfinanceStatusRef.current = null;
        setStatus({ kind: "idle" });
      }
    } catch (err) {
      const response = (err as { response?: { status?: number; data?: { detail?: string } } })
        ?.response;
      const statusCode = response?.status;
      if (statusCode === 401) {
        clearAuthToken();
        setAuthToken(null);
        setCurrentUser(null);
        setPortfolio(null);
        setAuthStatus({ kind: "error", message: "Session expired. Please sign in again." });
        setStatus({ kind: "idle" });
        return;
      }
      if (!statusCode) {
        clearAuthToken();
        setAuthToken(null);
        setCurrentUser(null);
        setPortfolio(null);
        setAuthStatus({
          kind: "error",
          message: "Unable to reach the server. Please check your connection and try again.",
        });
        setStatus({ kind: "idle" });
        return;
      }
      const detail =
        response?.data?.detail ||
        "Unable to reach the API";
      setStatus({ kind: "error", message: detail });
    } finally {
      setLoading(false);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = authForm.email.trim();
    const password = authForm.password.trim();
    const name = authForm.name.trim();
    if (!email || !password) {
      setAuthStatus({ kind: "error", message: "Email and password are required." });
      return;
    }
    setAuthStatus({
      kind: "loading",
      message: authMode === "login" ? "Signing in..." : "Creating account...",
    });
    try {
      const res =
        authMode === "login"
          ? await loginUser({ email, password })
          : await registerUser({ email, password, name: name || undefined });
      const token = res.data.access_token;
      storeAuthToken(token);
      setAuthToken(token);
      setCurrentUser(res.data.user);
      setAuthStatus({
        kind: "success",
        message: authMode === "login" ? "Signed in." : "Account created.",
      });
      setAuthForm({ name: "", email: "", password: "" });
      setLoading(true);
      await loadPortfolio();
    } catch (err) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Authentication failed.";
      setAuthStatus({ kind: "error", message });
    }
  };

  const handleLogout = () => {
    clearAuthToken();
    setAuthToken(null);
    setCurrentUser(null);
    setPortfolio(null);
    setLoading(false);
    setStatus({ kind: "idle" });
    setAuthStatus({ kind: "idle" });
    setAuthForm({ name: "", email: "", password: "" });
    setShowAddHoldingModal(false);
    setShowSymbolModal(false);
    setBuyHoldingTarget(null);
    setSellHoldingTarget(null);
    setEditingHoldingId(null);
    setSymbolSearchTerm("");
    setSymbolResults([]);
    setSymbolSearchStatus({ kind: "idle" });
  };

  useEffect(() => {
    if (!showAddHoldingModal) return;
    if (!holdingForm.account_id && defaultAccountId) {
      setHoldingForm((prev) => ({
        ...prev,
        account_id: String(defaultAccountId),
      }));
    }
  }, [showAddHoldingModal, defaultAccountId, holdingForm.account_id]);

  useEffect(() => {
    if (!showPlacementModal || editingPlacementId) return;
    if (!placementForm.account_id && defaultAccountId) {
      setPlacementForm((prev) => ({
        ...prev,
        account_id: String(defaultAccountId),
      }));
    }
  }, [showPlacementModal, editingPlacementId, defaultAccountId, placementForm.account_id]);

  useEffect(() => {
    if (!showAddHoldingModal || editingHoldingId) return;
    const currency = (holdingForm.currency || "EUR").toUpperCase();
    if (currency === "EUR") {
      if (holdingForm.fx_rate) {
        setHoldingForm((prev) => ({ ...prev, fx_rate: "" }));
      }
      return;
    }
    if (holdingForm.fx_rate) return;
    const key = `${currency}->${DISPLAY_CURRENCY}`;
    const cached = fxRates[key];
    if (cached) {
      setHoldingForm((prev) => ({ ...prev, fx_rate: String(cached) }));
      return;
    }
    let cancelled = false;
    const loadRate = async () => {
      try {
        const res = await fetchFxRate(currency, DISPLAY_CURRENCY);
        const rate = res.data?.rate;
        if (!cancelled && rate) {
          setFxRates((prev) => ({ ...prev, [key]: rate }));
          setHoldingForm((prev) => ({ ...prev, fx_rate: String(rate) }));
        }
      } catch {
        // optional field; ignore if unavailable
      }
    };
    loadRate();
    return () => {
      cancelled = true;
    };
  }, [
    showAddHoldingModal,
    editingHoldingId,
    holdingForm.currency,
    holdingForm.fx_rate,
    DISPLAY_CURRENCY,
    fxRates,
  ]);

  useEffect(() => {
    if (!sellHoldingTarget) return;
    const currency = (sellHoldingTarget.currency || "EUR").toUpperCase();
    if (currency === "EUR") {
      if (sellForm.fx_rate) {
        setSellForm((prev) => ({ ...prev, fx_rate: "" }));
      }
      return;
    }
    if (sellForm.fx_rate) return;
    const key = `${currency}->${DISPLAY_CURRENCY}`;
    const cached = fxRates[key];
    if (cached) {
      setSellForm((prev) => ({ ...prev, fx_rate: String(cached) }));
      return;
    }
    let cancelled = false;
    const loadRate = async () => {
      try {
        const res = await fetchFxRate(currency, DISPLAY_CURRENCY);
        const rate = res.data?.rate;
        if (!cancelled && rate) {
          setFxRates((prev) => ({ ...prev, [key]: rate }));
          setSellForm((prev) => ({ ...prev, fx_rate: String(rate) }));
        }
      } catch {
        // optional field; ignore if unavailable
      }
    };
    loadRate();
    return () => {
      cancelled = true;
    };
  }, [sellHoldingTarget, sellForm.fx_rate, DISPLAY_CURRENCY, fxRates]);

  useEffect(() => {
    if (!buyHoldingTarget) return;
    const currency = (buyHoldingTarget.currency || "EUR").toUpperCase();
    if (currency === "EUR") {
      if (buyForm.fx_rate) {
        setBuyForm((prev) => ({ ...prev, fx_rate: "" }));
      }
      return;
    }
    if (buyForm.fx_rate) return;
    const key = `${currency}->${DISPLAY_CURRENCY}`;
    const cached = fxRates[key];
    if (cached) {
      setBuyForm((prev) => ({ ...prev, fx_rate: String(cached) }));
      return;
    }
    let cancelled = false;
    const loadRate = async () => {
      try {
        const res = await fetchFxRate(currency, DISPLAY_CURRENCY);
        const rate = res.data?.rate;
        if (!cancelled && rate) {
          setFxRates((prev) => ({ ...prev, [key]: rate }));
          setBuyForm((prev) => ({ ...prev, fx_rate: String(rate) }));
        }
      } catch {
        // optional field; ignore if unavailable
      }
    };
    loadRate();
    return () => {
      cancelled = true;
    };
  }, [buyHoldingTarget, buyForm.fx_rate, DISPLAY_CURRENCY, fxRates]);

  useEffect(() => {
    const needed = new Set<string>();
    holdings.forEach((h) => {
      const cur = (h.currency || "").toUpperCase();
      if (cur && cur !== DISPLAY_CURRENCY) {
        const key = `${cur}->${DISPLAY_CURRENCY}`;
        if (!fxRates[key]) {
          needed.add(cur);
        }
      }
    });
    placements.forEach((placement) => {
      const cur = (placement.currency || "").toUpperCase();
      if (cur && cur !== DISPLAY_CURRENCY) {
        const key = `${cur}->${DISPLAY_CURRENCY}`;
        if (!fxRates[key]) {
          needed.add(cur);
        }
      }
    });
    if (needed.size === 0) return;
    let cancelled = false;
    const loadFx = async () => {
      for (const cur of needed) {
        try {
          const res = await fetchFxRate(cur, DISPLAY_CURRENCY);
          if (!cancelled) {
            const rate = res.data?.rate;
            if (rate) {
              setFxRates((prev) => ({ ...prev, [`${cur}->${DISPLAY_CURRENCY}`]: rate }));
            }
          }
        } catch {
          // ignore; will retry on next render
        }
      }
    };
    loadFx();
    return () => {
      cancelled = true;
    };
  }, [holdings, placements, DISPLAY_CURRENCY, fxRates]);

  useEffect(() => {
    if (!authToken) {
      setCurrentUser(null);
      return;
    }
    let cancelled = false;
    const loadUser = async () => {
      try {
        const res = await fetchCurrentUser();
        if (!cancelled) {
          setCurrentUser(res.data);
        }
      } catch {
        if (!cancelled) {
          setCurrentUser(null);
        }
      }
    };
    loadUser();
    return () => {
      cancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    if (!authToken) {
      setDailyHistory(null);
      setDailyHistoryLoading(false);
      return;
    }
    loadDailyHistory();
  }, [authToken, dailyHistoryDays, loadDailyHistory]);

  useEffect(() => {
    if (!authToken) {
      setPortfolio(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    loadPortfolio();
    const interval = setInterval(loadPortfolio, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => {
    if (status.kind !== "error") return;
    const timer = setTimeout(() => {
      setStatus({ kind: "idle" });
    }, 5000);
    return () => clearTimeout(timer);
  }, [status.kind, status.message]);

  useEffect(() => {
    const term = symbolSearchTerm.trim();
    if (term.length < 2) {
      setSymbolResults([]);
      setSymbolSearchStatus({ kind: "idle" });
      return;
    }
    const timer = setTimeout(async () => {
      setSymbolSearchStatus({ kind: "loading", message: "Searching..." });
      try {
        const res = await searchInstruments(term);
        const rawItems =
          res.data?.results ||
          res.data?.instruments ||
          res.data?.items ||
          (Array.isArray(res.data) ? res.data : []);
        const parsed: SearchItem[] = (rawItems || [])
          .map((item: any) => {
            const symbol = (item.symbol || item.ticker || "").toString().trim();
            const name = (item.longname || item.shortname || item.name || symbol || "").toString().trim();
            const exchange = (item.exchDisp || item.exchange || "").toString().trim();
            const sector = (item.sector || "").toString().trim();
            const industry = (item.industry || "").toString().trim();
            const typeDisp = (item.typeDisp || item.quoteType || "").toString().trim();
            const href = symbol ? `https://fr.finance.yahoo.com/quote/${symbol}/` : "";
            if (!symbol) return null;
            return {
              symbol,
              name,
              exchange,
              sector: sector || undefined,
              industry: industry || undefined,
              typeDisp: typeDisp || undefined,
              mic: exchange || undefined,
              href: href || undefined,
            };
          })
          .filter(Boolean) as SearchItem[];
        setSymbolResults(parsed);
        setSymbolSearchStatus({
          kind: "success",
          message: `Found ${parsed.length} suggestions`,
        });
      } catch (err) {
        setSymbolResults([]);
        setSymbolSearchStatus({ kind: "error", message: "Search failed" });
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [symbolSearchTerm]);

  const handleAddHolding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!holdingForm.symbol || !holdingForm.shares || !holdingForm.cost_basis) {
      setStatus({
        kind: "error",
        message: "Please fill symbol, shares, and cost basis",
      });
      return;
    }
    const tracker = (holdingForm.price_tracker || "yahoo").toLowerCase();
    if (tracker === "boursorama" && !holdingForm.tracker_symbol.trim()) {
      setStatus({
        kind: "error",
        message: "Enter the Boursorama tracker symbol (e.g. 1rASHELL)",
      });
      return;
    }
    const currency = (holdingForm.currency || "EUR").toUpperCase();
    let fxRate: number | undefined;
    if (currency !== "EUR" && holdingForm.fx_rate !== "") {
      fxRate = Number(holdingForm.fx_rate);
      if (!Number.isFinite(fxRate) || fxRate <= 0) {
        setStatus({
          kind: "error",
          message: "Enter a valid FX rate to EUR for non-EUR holdings",
        });
        return;
      }
    }
    if (!editingHoldingId && currency !== "EUR" && !fxRate) {
      setStatus({
        kind: "error",
        message: "Enter a valid FX rate to EUR for non-EUR holdings",
      });
      return;
    }
    const feeValue =
      holdingForm.acquisition_fee_value === ""
        ? 0
        : Number(holdingForm.acquisition_fee_value);
    const payload = {
      symbol: holdingForm.symbol.trim(),
      price_tracker: tracker as "yahoo" | "boursorama",
      ...(tracker === "boursorama"
        ? { tracker_symbol: holdingForm.tracker_symbol.trim() }
        : {}),
      shares: Number(holdingForm.shares),
      cost_basis: Number(holdingForm.cost_basis),
      acquisition_fee_value: feeValue,
      account_id: holdingForm.account_id ? Number(holdingForm.account_id) : undefined,
      currency: holdingForm.currency || "EUR",
      ...(fxRate ? { fx_rate: fxRate } : {}),
      sector: holdingForm.sector.trim() || undefined,
      industry: holdingForm.industry.trim() || undefined,
      asset_type: holdingForm.asset_type.trim() || undefined,
      isin: holdingForm.isin.trim() || undefined,
      mic: holdingForm.mic.trim() || undefined,
      name: holdingForm.name.trim() || undefined,
      href: holdingForm.href.trim() || undefined,
      acquired_at: holdingForm.acquired_at || undefined,
    };
    setStatus({ kind: "loading", message: editingHoldingId ? "Updating holding..." : "Saving holding..." });
    try {
      let targetHoldingId = editingHoldingId;
      if (editingHoldingId) {
        await updateHolding(editingHoldingId, payload);
      } else {
        const created = await createHolding(payload);
        targetHoldingId = created.data?.id ?? null;
      }
      setHoldingForm({
        symbol: "",
        price_tracker: "yahoo",
        tracker_symbol: "",
        shares: "",
        cost_basis: "",
        acquisition_fee_value: "",
        currency: "EUR",
        fx_rate: "",
        sector: "",
        industry: "",
        asset_type: "",
        account_id: defaultAccountId ? String(defaultAccountId) : "",
        isin: "",
        mic: "",
        name: "",
        href: "",
        acquired_at: "",
        manualPriceEnabled: false,
        manualLastPrice: "",
        manualLastPriceAt: formatDateTimeLocal(),
      });
      setEditingHoldingId(null);
      await loadPortfolio();
      if (holdingForm.manualPriceEnabled && holdingForm.manualLastPrice) {
        try {
          const recorded_at = holdingForm.manualLastPriceAt || undefined;
          if (!targetHoldingId) {
            setStatus({
              kind: "error",
              message: "Holding saved but price could not be attached",
            });
          } else {
            await addPriceSnapshot({
              holding_id: targetHoldingId,
              price: Number(holdingForm.manualLastPrice),
              recorded_at,
            });
          }
        } catch (err) {
          // non-blocking; just surface a message
          setStatus({
            kind: "error",
            message: "Holding saved but manual price failed",
          });
        }
      }
      await loadPortfolio();
      setStatus({ kind: "success", message: editingHoldingId ? "Holding updated" : "Holding added" });
      setShowAddHoldingModal(false);
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        undefined;
      setStatus({
        kind: "error",
        message:
          detail ||
          (editingHoldingId
            ? "Failed to update holding"
            : "Failed to add holding"),
      });
    }
  };

  const handleUpdateShares = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shareEditForm.holdingId || !shareEditForm.shares) {
      setStatus({
        kind: "error",
        message: "Choose a holding and enter the corrected shares",
      });
      return;
    }
    setStatus({ kind: "loading", message: "Updating shares..." });
    try {
      await updateHolding(Number(shareEditForm.holdingId), {
        shares: Number(shareEditForm.shares),
      });
      await loadPortfolio();
      setStatus({ kind: "success", message: "Shares updated" });
    } catch (err) {
      setStatus({ kind: "error", message: "Failed to update shares" });
    }
  };

  const handleDeleteHolding = async (holdingId: number) => {
    setDeletingId(holdingId);
    setStatus({ kind: "loading", message: "Deleting holding..." });
    try {
      await deleteHolding(holdingId);
      if (editingHoldingId === holdingId) {
        setEditingHoldingId(null);
      }
      await loadPortfolio();
      setStatus({ kind: "success", message: "Holding removed" });
      return true;
    } catch (err) {
      setStatus({ kind: "error", message: "Failed to delete holding" });
      return false;
    } finally {
      setDeletingId(null);
    }
  };

  const handleRefundHolding = async (holding: HoldingStats) => {
    setDeletingId(holding.id);
    setStatus({ kind: "loading", message: "Removing holding and refunding..." });
    try {
      const currency = (holding.currency || "EUR").toUpperCase();
      let fxRate: number | undefined;
      if (currency !== "EUR") {
        const key = `${currency}->${DISPLAY_CURRENCY}`;
        fxRate = fxRates[key];
        if (!fxRate) {
          const res = await fetchFxRate(currency, DISPLAY_CURRENCY);
          fxRate = res.data?.rate;
          if (fxRate) {
            setFxRates((prev) => ({ ...prev, [key]: fxRate as number }));
          }
        }
        if (!fxRate) {
          setStatus({ kind: "error", message: "FX rate unavailable for refund" });
          return;
        }
      }
      await refundHolding(holding.id, fxRate ? { fx_rate: fxRate } : undefined);
      await loadPortfolio();
      const refunded = getHoldingTotalCost(holding);
      setStatus({
        kind: "success",
        message: `Holding removed. Refunded ${formatMoney(refunded, holding.currency)}.`,
      });
      return true;
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to remove and refund holding";
      setStatus({ kind: "error", message: detail });
      return false;
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    if (!holdingActionsReturnId) return;
    const actionModalOpen =
      showAddHoldingModal ||
      showPlacementModal ||
      Boolean(buyHoldingTarget) ||
      Boolean(sellHoldingTarget) ||
      Boolean(holdingConfirmTarget) ||
      Boolean(cashTargetAccount) ||
      Boolean(placementHistoryTarget) ||
      Boolean(placementDeleteTarget);
    if (actionModalOpen) return;
    const latest = holdings.find((item) => item.id === holdingActionsReturnId);
    if (latest) {
      setHoldingActionsTarget(latest);
    }
    setHoldingActionsReturnId(null);
  }, [
    holdingActionsReturnId,
    showAddHoldingModal,
    showPlacementModal,
    buyHoldingTarget,
    sellHoldingTarget,
    holdingConfirmTarget,
    cashTargetAccount,
    placementHistoryTarget,
    placementDeleteTarget,
    holdings,
  ]);

  const openBuyModal = (holding: HoldingStats) => {
    const defaultPrice =
      holding.last_price !== null && holding.last_price !== undefined
        ? holding.last_price
        : holding.cost_basis;
    const currency = (holding.currency || "EUR").toUpperCase();
    const fxKey = `${currency}->${DISPLAY_CURRENCY}`;
    const fxRate = currency !== "EUR" ? fxRates[fxKey] : undefined;
    setBuyForm({
      shares: "",
      price: defaultPrice && defaultPrice > 0 ? String(defaultPrice) : "",
      fee_value: "",
      acquired_at: formatDateInput(),
      fx_rate: fxRate ? String(fxRate) : "",
    });
    setBuyHoldingTarget(holding);
  };

  const handleBuyHolding = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!buyHoldingTarget) return;
    const shares = Number(buyForm.shares);
    if (!Number.isFinite(shares) || shares <= 0) {
      setStatus({ kind: "error", message: "Enter a valid number of shares to buy" });
      return;
    }
    const price = Number(buyForm.price);
    if (!Number.isFinite(price) || price <= 0) {
      setStatus({ kind: "error", message: "Enter a valid buy price" });
      return;
    }
    const feeValue = buyForm.fee_value === "" ? 0 : Number(buyForm.fee_value);
    if (!Number.isFinite(feeValue) || feeValue < 0) {
      setStatus({ kind: "error", message: "Fee must be zero or positive" });
      return;
    }
    const currency = (buyHoldingTarget.currency || "EUR").toUpperCase();
    let fxRate: number | undefined;
    if (currency !== "EUR") {
      fxRate = buyForm.fx_rate === "" ? NaN : Number(buyForm.fx_rate);
      if (!Number.isFinite(fxRate) || fxRate <= 0) {
        setStatus({
          kind: "error",
          message: "Enter a valid FX rate to EUR for this purchase",
        });
        return;
      }
    }
    const accountId = buyHoldingTarget.account_id || buyHoldingTarget.account?.id;
    if (!accountId) {
      setStatus({ kind: "error", message: "Account is missing for this holding" });
      return;
    }
    setStatus({ kind: "loading", message: "Buying holding..." });
    try {
      await createHolding({
        account_id: accountId,
        symbol: buyHoldingTarget.symbol,
        shares,
        cost_basis: price,
        acquisition_fee_value: feeValue,
        currency: buyHoldingTarget.currency || "EUR",
        acquired_at: buyForm.acquired_at || undefined,
        ...(fxRate ? { fx_rate: fxRate } : {}),
      });
      await loadPortfolio();
      setStatus({ kind: "success", message: "Holding updated with new buy" });
      setBuyHoldingTarget(null);
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to buy holding";
      setStatus({ kind: "error", message: detail });
    }
  };

  const setHoldingFormFromHolding = (holding: HoldingStats) => {
    const assetType = (holding.asset_type || "").toLowerCase();
    const sector = (holding.sector || "").toLowerCase();
    const industry = (holding.industry || "").toLowerCase();
    const symbol = (holding.symbol || "").toLowerCase();
    const priceTracker = holding.price_tracker === "boursorama" ? "boursorama" : "yahoo";
    const likelyManual =
      priceTracker !== "boursorama" &&
      (!holding.mic ||
        assetType.includes("savings") ||
        sector.includes("cash") ||
        industry.includes("savings") ||
        symbol.includes("livret") ||
        symbol === "ldd" ||
        (!assetType.includes("equity") && !assetType.includes("etf")));
    const hasManualPrice =
      holding.last_price !== null && holding.last_price !== undefined && likelyManual;
    const manualLastPriceAtValue =
      hasManualPrice && holding.last_snapshot_at
        ? formatDateTimeLocal(new Date(holding.last_snapshot_at))
        : formatDateTimeLocal();
    setHoldingForm({
      symbol: holding.symbol,
      price_tracker: priceTracker,
      tracker_symbol: holding.tracker_symbol || "",
      shares: String(holding.shares),
      cost_basis: String(holding.cost_basis),
      acquisition_fee_value:
        holding.acquisition_fee_value !== null &&
        holding.acquisition_fee_value !== undefined
          ? String(holding.acquisition_fee_value)
          : "",
      currency: holding.currency,
      fx_rate: holding.fx_rate ? String(holding.fx_rate) : "",
      sector: holding.sector || "",
      industry: holding.industry || "",
      asset_type: holding.asset_type || "",
      account_id: holding.account_id ? String(holding.account_id) : "",
      isin: holding.isin || "",
      mic: holding.mic || "",
      name: holding.name || "",
      href: holding.href || "",
      acquired_at: holding.acquired_at ? holding.acquired_at.slice(0, 10) : "",
      manualPriceEnabled: hasManualPrice,
      manualLastPrice: hasManualPrice ? String(holding.last_price) : "",
      manualLastPriceAt: manualLastPriceAtValue,
    });
  };

  const openSellModal = (holding: HoldingStats) => {
    const defaultPrice =
      holding.last_price !== null && holding.last_price !== undefined
        ? holding.last_price
        : holding.cost_basis;
    const currency = (holding.currency || "EUR").toUpperCase();
    const fxKey = `${currency}->${DISPLAY_CURRENCY}`;
    const fxRate = currency !== "EUR" ? fxRates[fxKey] : undefined;
    setSellForm({
      shares: holding.shares ? String(holding.shares) : "",
      price: defaultPrice && defaultPrice > 0 ? String(defaultPrice) : "",
      fee_value: "",
      executed_at: formatDateInput(),
      fx_rate: fxRate ? String(fxRate) : "",
    });
    setSellHoldingTarget(holding);
  };

  const handleSellHolding = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sellHoldingTarget) return;
    const shares = Number(sellForm.shares);
    if (!Number.isFinite(shares) || shares <= 0) {
      setStatus({ kind: "error", message: "Enter a valid number of shares to sell" });
      return;
    }
    if (shares > sellHoldingTarget.shares + 1e-6) {
      setStatus({ kind: "error", message: "You cannot sell more shares than you own" });
      return;
    }
    const price = Number(sellForm.price);
    if (!Number.isFinite(price) || price <= 0) {
      setStatus({ kind: "error", message: "Enter a valid sell price" });
      return;
    }
    const currency = (sellHoldingTarget.currency || "EUR").toUpperCase();
    let fxRate: number | undefined;
    if (currency !== "EUR") {
      fxRate = sellForm.fx_rate === "" ? NaN : Number(sellForm.fx_rate);
      if (!Number.isFinite(fxRate) || fxRate <= 0) {
        setStatus({
          kind: "error",
          message: "Enter a valid FX rate to EUR for this sale",
        });
        return;
      }
    }
    const feeValue =
      sellForm.fee_value === "" ? 0 : Number(sellForm.fee_value);
    if (!Number.isFinite(feeValue) || feeValue < 0) {
      setStatus({ kind: "error", message: "Fee must be zero or positive" });
      return;
    }
    setStatus({ kind: "loading", message: "Selling holding..." });
    try {
      const res = await sellHolding(sellHoldingTarget.id, {
        shares,
        price,
        fee_value: feeValue,
        executed_at: sellForm.executed_at || undefined,
        ...(fxRate ? { fx_rate: fxRate } : {}),
      });
      await loadPortfolio();
      const realized = res.data?.realized_gain;
      const realizedLabel =
        realized !== null && realized !== undefined
          ? formatMoneySigned(realized, sellHoldingTarget.currency)
          : null;
      setStatus({
        kind: "success",
        message: realizedLabel
          ? `Holding sold. Realized ${realizedLabel}.`
          : "Holding sold.",
      });
      setSellHoldingTarget(null);
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to sell holding";
      setStatus({ kind: "error", message: detail });
    }
  };

  const handleExportBackup = async () => {
    setStatus({ kind: "loading", message: "Preparing JSON backup..." });
    try {
      const res = await exportBackupJson();
      const blob = new Blob([JSON.stringify(res.data, null, 2)], {
        type: "application/json;charset=utf-8;",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setStatus({
        kind: "success",
        message: "Backup exported (including history snapshots).",
      });
    } catch (err) {
      setStatus({ kind: "error", message: "Failed to export backup" });
    }
  };

  const handleRunYahooTargets = async () => {
    setStatus({ kind: "loading", message: "Updating Yahoo targets..." });
    try {
      await runYahooTargetsAgent();
      await loadPortfolio();
      setStatus({ kind: "success", message: "Yahoo targets updated." });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to update Yahoo targets";
      setStatus({ kind: "error", message: detail });
    }
  };

  const handleRefreshPrices = async () => {
    setStatus({ kind: "loading", message: "Refreshing latest prices..." });
    try {
      await refreshHoldingsPrices();
      await loadPortfolio();
      await loadDailyHistory();
      setStatus({ kind: "success", message: "Prices updated." });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to refresh prices";
      setStatus({ kind: "error", message: detail });
    }
  };

  const importBackupFile = async (file: File) => {
    setStatus({
      kind: "loading",
      message: "Importing backup (this replaces your current data)...",
    });
    try {
      const res = await importBackupJson(file);
      await loadPortfolio();
      const {
        accounts,
        holdings,
        transactions,
        cash_transactions,
        placements = 0,
        placement_snapshots = 0,
        holding_daily_snapshots = 0,
        portfolio_daily_snapshots = 0,
      } = res.data;
      const parts = [
        `${accounts} account${accounts === 1 ? "" : "s"}`,
        `${holdings} holding${holdings === 1 ? "" : "s"}`,
        `${transactions} transaction${transactions === 1 ? "" : "s"}`,
        `${cash_transactions} cash transaction${cash_transactions === 1 ? "" : "s"}`,
        `${placements} placement${placements === 1 ? "" : "s"}`,
        `${placement_snapshots} placement snapshot${placement_snapshots === 1 ? "" : "s"}`,
        `${holding_daily_snapshots} holding history snapshot${
          holding_daily_snapshots === 1 ? "" : "s"
        }`,
        `${portfolio_daily_snapshots} portfolio history snapshot${
          portfolio_daily_snapshots === 1 ? "" : "s"
        }`,
      ];
      setStatus({
        kind: "success",
        message: `Imported ${parts.join(", ")}.`,
      });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to import backup";
      setStatus({ kind: "error", message: detail });
    }
  };

  const handleImportBackup = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBackupImportTarget(file);
    event.target.value = "";
  };

  const handleConfirmBackupImport = async () => {
    if (!backupImportTarget) return;
    const file = backupImportTarget;
    setBackupImportTarget(null);
    await importBackupFile(file);
  };

  const handleAccountSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!accountForm.name.trim()) {
      setStatus({ kind: "error", message: "Account name is required" });
      return;
    }
    const liquidity =
      accountForm.liquidity === "" ? 0 : Number(accountForm.liquidity);
    if (Number.isNaN(liquidity) || liquidity < 0) {
      setStatus({ kind: "error", message: "Cash available must be a positive number" });
      return;
    }
    const manualInvested =
      accountForm.manual_invested === "" ? 0 : Number(accountForm.manual_invested);
    if (Number.isNaN(manualInvested) || manualInvested < 0) {
      setStatus({ kind: "error", message: "Capital contributed must be a positive number" });
      return;
    }
    const createdAt = accountForm.created_at?.trim();
    const createdAtValue = createdAt ? `${createdAt}T00:00:00` : undefined;
    const payload = {
      name: accountForm.name.trim(),
      account_type: accountForm.account_type.trim() || undefined,
      liquidity,
      manual_invested: manualInvested,
      created_at: createdAtValue,
    };
    setStatus({
      kind: "loading",
      message: editingAccountId ? "Updating account..." : "Creating account...",
    });
    try {
      let createdId: number | null = null;
      if (editingAccountId) {
        await updateAccount(editingAccountId, payload);
      } else {
        const created = await createAccount(payload);
        createdId = created.data?.id ?? null;
      }
      await loadPortfolio();
      if (createdId && showAddHoldingModal) {
        setHoldingForm((prev) => ({
          ...prev,
          account_id: String(createdId),
        }));
      }
      if (createdId && showPlacementModal) {
        setPlacementForm((prev) => ({
          ...prev,
          account_id: String(createdId),
        }));
      }
      setAccountForm({
        name: "",
        account_type: "",
        liquidity: "",
        manual_invested: "",
        created_at: formatDateInput(),
      });
      setEditingAccountId(null);
      setShowAccountModal(false);
      setStatus({
        kind: "success",
        message: editingAccountId ? "Account updated" : "Account created",
      });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to save account";
      setStatus({ kind: "error", message: detail });
    }
  };

  const handleDeleteAccount = async (accountId: number) => {
    setStatus({ kind: "loading", message: "Deleting account..." });
    try {
      await deleteAccount(accountId);
      await loadPortfolio();
      setStatus({ kind: "success", message: "Account deleted" });
      return true;
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to delete account";
      setStatus({ kind: "error", message: detail });
      return false;
    }
  };

  const resetPlacementForm = (options?: { accountId?: number | null }) => {
    const accountId =
      options?.accountId ?? (defaultAccountId ? defaultAccountId : null);
    setPlacementForm({
      account_id: accountId ? String(accountId) : "",
      name: "",
      placement_type: "",
      sector: "",
      industry: "",
      currency: "EUR",
      initial_value: "",
      recorded_at: formatDateTimeLocal(),
    });
  };

  const closePlacementModal = () => {
    setShowPlacementModal(false);
    setEditingPlacementId(null);
    resetPlacementForm();
  };

  const handlePlacementSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const isEditing = Boolean(editingPlacementId);
    const accountId = placementForm.account_id
      ? Number(placementForm.account_id)
      : undefined;
    const name = placementForm.name.trim();
    if (!name) {
      setStatus({ kind: "error", message: "Placement name is required" });
      return;
    }
    if (placementForm.account_id && Number.isNaN(accountId)) {
      setStatus({ kind: "error", message: "Account selection is invalid" });
      return;
    }
    const placementType = placementForm.placement_type.trim() || undefined;
    const sector = placementForm.sector.trim() || undefined;
    const industry = placementForm.industry.trim() || undefined;
    const currency = placementForm.currency || "EUR";
    let initialValue: number | undefined;
    let recordedAt: string | undefined;
    if (!editingPlacementId && placementForm.initial_value !== "") {
      const parsed = Number(placementForm.initial_value);
      if (Number.isNaN(parsed) || parsed < 0) {
        setStatus({ kind: "error", message: "Initial value must be a positive number" });
        return;
      }
      initialValue = parsed;
      recordedAt = placementForm.recorded_at || undefined;
    }
    setStatus({
      kind: "loading",
      message: isEditing ? "Updating placement..." : "Creating placement...",
    });
    try {
      if (isEditing && editingPlacementId) {
        await updatePlacement(editingPlacementId, {
          account_id: accountId ?? null,
          name,
          placement_type: placementType,
          sector,
          industry,
          currency,
        });
      } else {
        await createPlacement({
          ...(accountId ? { account_id: accountId } : {}),
          name,
          placement_type: placementType,
          sector,
          industry,
          currency,
          ...(initialValue !== undefined ? { initial_value: initialValue, recorded_at: recordedAt } : {}),
        });
      }
      await loadPortfolio();
      closePlacementModal();
      setStatus({
        kind: "success",
        message: isEditing ? "Placement updated" : "Placement created",
      });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to save placement";
      setStatus({ kind: "error", message: detail });
    }
  };

  const handleDeletePlacement = async (placementId: number) => {
    setDeletingPlacementId(placementId);
    setStatus({ kind: "loading", message: "Deleting placement..." });
    try {
      await deletePlacement(placementId);
      await loadPortfolio();
      setStatus({ kind: "success", message: "Placement deleted" });
      return true;
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to delete placement";
      setStatus({ kind: "error", message: detail });
      return false;
    } finally {
      setDeletingPlacementId(null);
    }
  };

  const getDefaultEntryKind = (placement?: Placement | null) => {
    if (!placement || placement.initial_value === null || placement.initial_value === undefined) {
      return "INITIAL" as const;
    }
    return "INTEREST" as const;
  };

  const resetPlacementSnapshotForm = (placement?: Placement | null) => {
    setPlacementSnapshotForm({
      value: "",
      recorded_at: formatDateTimeLocal(),
      entry_kind: getDefaultEntryKind(placement),
    });
    setEditingPlacementSnapshotId(null);
  };

  const openPlacementHistory = (placement: Placement) => {
    resetPlacementSnapshotForm(placement);
    setPlacementHistoryTarget(placement);
  };

  const closePlacementHistory = () => {
    setPlacementHistoryTarget(null);
    setPlacementSnapshots([]);
    resetPlacementSnapshotForm();
  };

  const closePlacementChart = () => {
    setPlacementChartTarget(null);
  };

  const handlePlacementSnapshotSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!placementHistoryTarget) return;
    if (
      placementSnapshotForm.entry_kind !== "VALUE" &&
      placementSnapshotForm.entry_kind !== "INITIAL" &&
      (placementHistoryTarget.initial_value === null ||
        placementHistoryTarget.initial_value === undefined)
    ) {
      setStatus({
        kind: "error",
        message:
          "Add an initial placement or value before interests, fees, contributions, or withdrawals",
      });
      return;
    }
    const value = Number(placementSnapshotForm.value);
    if (Number.isNaN(value) || value < 0) {
      setStatus({ kind: "error", message: "Snapshot value must be a positive number" });
      return;
    }
    setStatus({ kind: "loading", message: "Saving snapshot..." });
    try {
      if (editingPlacementSnapshotId) {
        const res = await updatePlacementSnapshot(
          placementHistoryTarget.id,
          editingPlacementSnapshotId,
          {
            value,
            recorded_at: placementSnapshotForm.recorded_at || undefined,
          entry_kind: placementSnapshotForm.entry_kind,
        }
      );
        setPlacementHistoryTarget(res.data);
      } else {
        const res = await addPlacementSnapshot(placementHistoryTarget.id, {
          value,
          recorded_at: placementSnapshotForm.recorded_at || undefined,
        entry_kind: placementSnapshotForm.entry_kind,
      });
        setPlacementHistoryTarget(res.data);
      }
      await loadPortfolio();
      const snapshots = await fetchPlacementSnapshots(placementHistoryTarget.id);
      setPlacementSnapshots(snapshots.data);
      resetPlacementSnapshotForm(placementHistoryTarget);
      setStatus({ kind: "success", message: "Snapshot saved" });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to save snapshot";
      setStatus({ kind: "error", message: detail });
    }
  };

  const handleEditPlacementSnapshot = (snapshot: PlacementSnapshot) => {
    setEditingPlacementSnapshotId(snapshot.id);
    setPlacementSnapshotForm({
      value: snapshot.value?.toString() ?? "",
      recorded_at: snapshot.recorded_at
        ? formatDateTimeLocal(new Date(snapshot.recorded_at))
        : formatDateTimeLocal(),
      entry_kind: snapshot.entry_kind || "VALUE",
    });
  };

  const handleDeletePlacementSnapshot = async (snapshotId: number) => {
    if (!placementHistoryTarget) return;
    setDeletingPlacementSnapshotId(snapshotId);
    setStatus({ kind: "loading", message: "Deleting snapshot..." });
    try {
      await deletePlacementSnapshot(placementHistoryTarget.id, snapshotId);
      await loadPortfolio();
      const snapshots = await fetchPlacementSnapshots(placementHistoryTarget.id);
      setPlacementSnapshots(snapshots.data);
      if (editingPlacementSnapshotId === snapshotId) {
        resetPlacementSnapshotForm(placementHistoryTarget);
      }
      setStatus({ kind: "success", message: "Snapshot deleted" });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to delete snapshot";
      setStatus({ kind: "error", message: detail });
    } finally {
      setDeletingPlacementSnapshotId(null);
    }
  };

  const openCashModal = (account: Account, mode: "add" | "withdraw", reasonPreset?: string) => {
    setCashTargetAccount(account);
    const options = CASH_REASON_OPTIONS[mode] as readonly string[];
    const safeReasonPreset =
      reasonPreset && options.includes(reasonPreset)
        ? reasonPreset
        : CASH_REASON_DEFAULT[mode];
    setCashForm({ amount: "", mode, reasonPreset: safeReasonPreset, reasonCustom: "" });
  };

  const closeCashModal = () => {
    setCashTargetAccount(null);
    setCashForm({
      amount: "",
      mode: "add",
      reasonPreset: CASH_REASON_DEFAULT.add,
      reasonCustom: "",
    });
  };

  const closeHoldingActions = () => {
    setHoldingActionsTarget(null);
    setHoldingActionsReturnId(null);
  };

  const openHoldingConfirm = (holding: HoldingStats, mode: "delete" | "refund") => {
    setHoldingActionsReturnId(holding.id);
    setHoldingActionsTarget(null);
    setHoldingConfirmTarget({ holding, mode });
  };

  const queueHoldingReturn = (holding: HoldingStats) => {
    setHoldingActionsReturnId(holding.id);
    setHoldingActionsTarget(null);
  };

  const handleCashMovement = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!cashTargetAccount) return;
    const amount = cashForm.amount === "" ? 0 : Number(cashForm.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      setStatus({ kind: "error", message: "Cash amount must be a positive number" });
      return;
    }
    const reason =
      cashForm.reasonPreset === "Other"
        ? cashForm.reasonCustom.trim()
        : cashForm.reasonPreset.trim();
    if (!reason) {
      setStatus({ kind: "error", message: "Reason is required" });
      return;
    }
    const reasonKey = reason.toLowerCase();
    const delta = cashForm.mode === "add" ? amount : -amount;
    const newLiquidity = (cashTargetAccount.liquidity || 0) + delta;
    if (newLiquidity < 0) {
      setStatus({ kind: "error", message: "Cash available cannot go below zero" });
      return;
    }
    const affectsCapital = reasonKey === "contribution" || reasonKey === "withdrawal";
    if (affectsCapital) {
      const newCapital = (cashTargetAccount.manual_invested || 0) + delta;
      if (newCapital < 0) {
        setStatus({ kind: "error", message: "Capital contributed cannot go below zero" });
        return;
      }
    }
    setStatus({
      kind: "loading",
      message: cashForm.mode === "add" ? "Adding cash..." : "Withdrawing cash...",
    });
    try {
      await moveAccountCash(cashTargetAccount.id, {
        amount,
        direction: cashForm.mode === "add" ? "ADD" : "WITHDRAW",
        reason,
      });
      await loadPortfolio();
      setStatus({
        kind: "success",
        message: cashForm.mode === "add" ? "Cash added" : "Cash withdrawn",
      });
      closeCashModal();
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to update cash";
      setStatus({ kind: "error", message: detail });
    }
  };

  return (
    <div className="page">
      <main className="grid">
        {!isAuthed ? (
          <>
          <section className="card auth-card">
            <div className="card-header">
              <div>
                {/* <p className="eyebrow">{authMode === "login" ? "Welcome back" : "Get started"}</p> */}
                <h2>{authMode === "login" ? "Sign in to your portfolio" : "Create your account"}</h2>
                <p className="muted helper">
                  {authMode === "login"
                    ? "Use your email and password to access holdings."
                    : "Choose an email and password to start tracking."}
                </p>
              </div>
              <div className="card-actions">
                <button
                  type="button"
                  className="button compact"
                  onClick={() => {
                    setAuthMode((prev) => (prev === "login" ? "register" : "login"));
                    setAuthStatus({ kind: "idle" });
                  }}
                >
                  {authMode === "login" ? "Need access?" : "Back to sign in"}
                </button>
              </div>
            </div>
            {authMode === "login" ? (
              <form
                key="login"
                id="auth-login-form"
                name="login"
                className="form"
                onSubmit={handleAuthSubmit}
                autoComplete="on"
                method="post"
                action="/auth/login"
                data-auth-mode="login"
                data-np-autofill-form-type="login"
              >
                <label htmlFor="login-email">
                  Email
                  <input
                    id="login-email"
                    name="username"
                    type="email"
                    value={authForm.email}
                    onChange={(e) => setAuthForm((prev) => ({ ...prev, email: e.target.value }))}
                    placeholder="you@example.com"
                    autoComplete="username"
                    inputMode="email"
                    data-np-autofill-field-type="username"
                    required
                  />
                </label>
                <label htmlFor="login-password">
                  Password
                  <input
                    id="login-password"
                    name="password"
                    type="password"
                    value={authForm.password}
                    onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
                    placeholder="Password"
                    autoComplete="current-password"
                    data-np-autofill-field-type="password"
                    required
                  />
                </label>
                <button
                  className="button primary"
                  type="submit"
                  disabled={authStatus.kind === "loading"}
                >
                  {authStatus.kind === "loading" ? "Signing in..." : "Sign in"}
                </button>
              </form>
            ) : (
              <form
                key="register"
                id="auth-register-form"
                name="register"
                className="form"
                onSubmit={handleAuthSubmit}
                autoComplete="on"
                method="post"
                action="/auth/register"
                data-auth-mode="register"
                data-np-autofill-form-type="register"
              >
                <label htmlFor="register-name">
                  Name
                  <input
                    id="register-name"
                    name="name"
                    type="text"
                    value={authForm.name}
                    onChange={(e) => setAuthForm((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Optional"
                    autoComplete="name"
                  />
                </label>
                <label htmlFor="register-email">
                  Email
                  <input
                    id="register-email"
                    name="email"
                    type="email"
                    value={authForm.email}
                    onChange={(e) => setAuthForm((prev) => ({ ...prev, email: e.target.value }))}
                    placeholder="you@example.com"
                    autoComplete="email"
                    inputMode="email"
                    data-np-autofill-field-type="email"
                    required
                  />
                </label>
                <label htmlFor="register-password">
                  Password
                  <input
                    id="register-password"
                    name="password"
                    type="password"
                    value={authForm.password}
                    onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    data-np-autofill-field-type="new-password"
                    required
                  />
                </label>
                <button
                  className="button primary"
                  type="submit"
                  disabled={authStatus.kind === "loading"}
                >
                  {authStatus.kind === "loading" ? "Creating account..." : "Create account"}
                </button>
              </form>
            )}
            {authStatus.kind === "error" && (
              <p className="status status-error">{authStatus.message}</p>
            )}
          </section>
          </>
        ) : (
          <>
            <section className="card summary">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Portfolio summary</p>
                </div>
                <div className="card-actions">
                  {loading && <span className="pill ghost">Loading…</span>}
                  <div className="user-menu" ref={userMenuRef}>
                    <button
                      type="button"
                      className="avatar-button"
                      aria-label="Account menu"
                      aria-haspopup="menu"
                      aria-expanded={isUserMenuOpen}
                      onClick={() => setIsUserMenuOpen((prev) => !prev)}
                    >
                      <span className="avatar-initials">{userInitials}</span>
                    </button>
                    {isUserMenuOpen && (
                      <div className="user-menu-dropdown" role="menu">
                        <div className="user-menu-header">
                          <span className="user-menu-email">{userDisplayEmail}</span>
                        </div>
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            navigate("/");
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M12 3v9l7.5 7.5A9 9 0 1 1 12 3z"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                                <path
                                  d="M12 3a9 9 0 0 1 9 9h-9z"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Portfolio</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            navigate("/simulate/assurance-vie");
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M12 3l7 4v5c0 4.5-3.1 8.4-7 9.7-3.9-1.3-7-5.2-7-9.7V7l7-4z"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                                <path
                                  d="M9.5 12.5l2 2 3.5-3.5"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Assurance vie</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            navigate("/simulate/compte-a-terme");
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <rect
                                  x="3"
                                  y="4"
                                  width="18"
                                  height="17"
                                  rx="2"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                />
                                <path
                                  d="M8 2v4M16 2v4M3 9h18"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Compte a terme</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            navigate("/analysis/bsf120");
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M4 19h16M5 16l4-5 3 3 5-7"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                                <path
                                  d="M15 7h2.5V9.5"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>BSF120</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className={`user-menu-item ${chatOpen ? "active" : ""}`.trim()}
                          aria-pressed={chatOpen}
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            setChatToggleToken((prev) => prev + 1);
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M5 6h14v9H9l-4 4z"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Chat</span>
                          </span>
                        </button>
                        <div className="user-menu-divider" />
                        <button
                          type="button"
                          className="user-menu-item"
                          aria-pressed={isTourActive}
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            if (isTourActive) {
                              endTour();
                            } else {
                              startTour();
                            }
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M12 3v18M3 12h18"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>{isTourActive ? "End tour" : "Start tour"}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            handleExportBackup();
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M12 4v11M8 11l4 4 4-4M5 20h14"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Export Data</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            backupInputRef.current?.click();
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M12 20V9M8 13l4-4 4 4M5 4h14"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Import Data</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            handleRunYahooTargets();
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M4 19h16M6 15l3-3 3 2 5-6"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Run Yahoo targets</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            handleRefreshPrices();
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M20 11a8 8 0 1 0 2 5.5M20 4v7h-7"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Refresh prices</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="user-menu-item danger"
                          onClick={() => {
                            setIsUserMenuOpen(false);
                            handleLogout();
                          }}
                        >
                          <span className="user-menu-item-content">
                            <span className="user-menu-item-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path
                                  d="M15 17l5-5-5-5M20 12H9M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span>Log out</span>
                          </span>
                        </button>
                      </div>
                    )}
                    <input
                      ref={backupInputRef}
                      type="file"
                      accept=".json,application/json"
                      onChange={handleImportBackup}
                      hidden
                    />
                  </div>
                </div>
              </div>
              <div className="summary-content">
                <div className="summary-grid">
                  <div className="stat">
                    <p>Capital</p>
                    <h3>{displayMoney(selectedCapitalContributed, totalCurrency)}</h3>
                  </div>
                  <div className="stat">
                    <p>Cash available</p>
                    <h3>{displayMoney(selectedLiquidity, totalCurrency)}</h3>
                  </div>
                  <div className="stat">
                    <p>Portfolio costs</p>
                    <h3>{displayMoney(enhancedSummary.total_cost, totalCurrency)}</h3>
                  </div>
                  
                  <div className="stat">
                    <p>Portfolio Value</p>
                    <h3>{displayMoney(enhancedSummary.total_value, totalCurrency)}</h3>
                  </div>
                  <div className="stat">
                    <p>Latent P/L</p>
                    <h3
                      className={
                        enhancedSummary.total_gain_abs === null ||
                        enhancedSummary.total_gain_abs === undefined
                          ? ""
                          : enhancedSummary.total_gain_abs >= 0
                          ? "positive"
                          : "negative"
                      }
                    >
                      {displayMoneySigned(enhancedSummary.total_gain_abs, totalCurrency)}{" "}
                      <span className="muted">
                        <small> ({formatPercentSigned(enhancedSummary.total_gain_pct)}) </small>
                      </span>
                    </h3>
                  </div>
                  
                </div>
                <div className="summary-charts-toolbar">
                  <div className="summary-chart-view-toggle" role="group" aria-label="Chart view">
                    <button
                      type="button"
                      className={`icon-button compact summary-chart-view-button ${
                        summaryChartView === "history" ? "active" : ""
                      }`}
                      onClick={() => setSummaryChartView("history")}
                      aria-pressed={summaryChartView === "history"}
                      aria-label="Show history chart"
                      title="History"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                        <path
                          d="M4 19h16M6 16l4-5l3 3l5-6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="summary-chart-view-label">History</span>
                    </button>
                    <button
                      type="button"
                      className={`icon-button compact summary-chart-view-button ${
                        summaryChartView === "portfolio" ? "active" : ""
                      }`}
                      onClick={() => setSummaryChartView("portfolio")}
                      aria-pressed={summaryChartView === "portfolio"}
                      aria-label="Show portfolio charts"
                      title="Portfolio and P/L"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                        <path
                          d="M12 3v8l6.4 3.7A9 9 0 1 1 12 3z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="summary-chart-view-label">Portfolio</span>
                    </button>
                  </div>
                </div>
                <div className="summary-charts">
                  {summaryChartView === "history" ? (
                    <div className="summary-chart summary-chart-wide">
                      <div className="summary-chart-header">
                        <p className="eyebrow">History</p>
                        <div className="summary-chart-title">
                          <h3>
                            {selectedHistorySymbol
                              ? `${selectedHistorySymbol} evolution`
                              : "Portfolio evolution"}
                          </h3>
                        </div>
                        <p className="muted helper">
                          End-of-day values from your saved daily snapshots. Filter:{" "}
                          {selectedHistoryFilterLabel}.
                        </p>
                        <div className="chart-header-actions history-actions">
                          <label className="chart-group-label">
                            Filter
                            <select
                              className="chart-select"
                              value={historySeriesFilter}
                              onChange={(event) => setHistorySeriesFilter(event.target.value)}
                            >
                              {historySeriesFilterOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="chart-group-label">
                            Window
                            <select
                              className="chart-select"
                              value={dailyHistoryDays}
                              onChange={(event) => setDailyHistoryDays(Number(event.target.value))}
                            >
                              {HISTORY_DAY_OPTIONS.map((days) => (
                                <option key={days} value={days}>
                                  {days}d
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="icon-button compact zoom-button"
                            onClick={() => setZoomedChart("history")}
                            aria-label="Expand history chart"
                          >
                            🔍
                          </button>
                        </div>
                      </div>
                      <div className="chart-wrapper">
                        <HighchartsReact
                          highcharts={Highcharts}
                          constructorType="stockChart"
                          options={portfolioEvolutionStockOptions}
                        />
                      </div>
                      {dailyHistoryLoading && (
                        <p className="muted helper">Loading history...</p>
                      )}
                      {!dailyHistoryLoading && !historyChartHasData && (
                        <p className="muted helper">
                          {historyEmptyMessage}
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="summary-chart">
                        <div className="summary-chart-header">
                          <p className="eyebrow">Allocation</p>
                          <div className="summary-chart-title">
                            <h3>Portfolio mix</h3>
                            {allocationChartType === "bar" && allocationData.total > 0 && (
                              <span className="pill ghost">
                                Total {formatMoney(allocationData.total, totalCurrency)}
                              </span>
                            )}
                          </div>
                          <p className="muted helper">
                            Based on latest prices · Grouped by {chartGroupLabel.toLowerCase()}
                          </p>
                          <div className="chart-header-actions">
                            <label className="chart-group-label">
                              Group by
                              <select
                                className="chart-select"
                                value={chartGroupBy}
                                onChange={(e) => setChartGroupBy(e.target.value as ChartGroupBy)}
                              >
                                {CHART_GROUP_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="icon-button compact chart-toggle"
                              onClick={() =>
                                setAllocationChartType((prev) =>
                                  prev === "donut" ? "bar" : "donut"
                                )
                              }
                              aria-label={allocationToggleLabel}
                              title={allocationToggleLabel}
                              aria-pressed={allocationChartType === "bar"}
                            >
                              {allocationChartType === "donut" ? (
                                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                  <rect x="2" y="3" width="12" height="2" rx="1" fill="currentColor" />
                                  <rect x="2" y="7" width="9" height="2" rx="1" fill="currentColor" />
                                  <rect x="2" y="11" width="6" height="2" rx="1" fill="currentColor" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                  <path
                                    d="M8 2a6 6 0 1 0 0 12a6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6a3 3 0 0 1 0-6z"
                                    fill="currentColor"
                                    fillRule="evenodd"
                                  />
                                </svg>
                              )}
                            </button>
                            <button
                              type="button"
                              className="icon-button compact zoom-button"
                              onClick={() => setZoomedChart("allocation")}
                              aria-label="Expand allocation chart"
                            >
                              🔍
                            </button>
                          </div>
                        </div>
                        <div className="chart-wrapper">
                          <HighchartsReact highcharts={Highcharts} options={allocationChartOptions} />
                        </div>
                        {(!allocationData.points.length || !allocationData.total) && (
                          <p className="muted helper">{allocationEmptyMessage}</p>
                        )}
                      </div>

                      <div className="summary-chart">
                        <div className="summary-chart-header">
                          <p className="eyebrow">Performance</p>
                          <div className="summary-chart-title">
                            <h3>P/L mix</h3>
                            {plChartType === "bar" &&
                              chartGainAbs !== null &&
                              chartGainAbs !== undefined && (
                                <span className="pill ghost">
                                  Total {formatMoneySigned(chartGainAbs, totalCurrency)}
                                </span>
                              )}
                          </div>
                          <p className="muted helper">
                            Absolute gains vs losses by {chartGroupLabel.toLowerCase()}
                          </p>
                          <div className="chart-header-actions">
                            <label className="chart-group-label">
                              Group by
                              <select
                                className="chart-select"
                                value={chartGroupBy}
                                onChange={(e) => setChartGroupBy(e.target.value as ChartGroupBy)}
                              >
                                {CHART_GROUP_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="icon-button compact chart-toggle"
                              onClick={() => setPlChartType((prev) => (prev === "donut" ? "bar" : "donut"))}
                              aria-label={plToggleLabel}
                              title={plToggleLabel}
                              aria-pressed={plChartType === "bar"}
                            >
                              {plChartType === "donut" ? (
                                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                  <rect x="2" y="3" width="12" height="2" rx="1" fill="currentColor" />
                                  <rect x="2" y="7" width="9" height="2" rx="1" fill="currentColor" />
                                  <rect x="2" y="11" width="6" height="2" rx="1" fill="currentColor" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                  <path
                                    d="M8 2a6 6 0 1 0 0 12a6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6a3 3 0 0 1 0-6z"
                                    fill="currentColor"
                                    fillRule="evenodd"
                                  />
                                </svg>
                              )}
                            </button>
                            <button
                              type="button"
                              className="icon-button compact zoom-button"
                              onClick={() => setZoomedChart("pl")}
                              aria-label="Expand P/L chart"
                            >
                              🔍
                            </button>
                          </div>
                        </div>
                        <div className="chart-wrapper">
                          <HighchartsReact highcharts={Highcharts} options={plChartOptions} />
                        </div>
                        {(!plData.points.length || !plData.total) && (
                          <p className="muted helper">{plEmptyMessage}</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </section>

            <section className="card accounts-card">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Accounts</p>
                  <h2>Accounts</h2>
                </div>
                <div className="card-actions">

                  <button
                    type="button"
                    className="button compact icon-only"
                    onClick={() => setShowAccounts((prev) => !prev)}
                    aria-label={showAccounts ? "Hide accounts" : "Show accounts"}
                  >
                    {showAccounts ? (
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                        <path
                          d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
                      </svg>
                  ) : (
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                        <path
                          d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
                        <path
                          d="M4 4l16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    className="button primary compact"
                    ref={addAccountButtonRef}
                      onClick={() => {
                        setAccountForm({
                          name: "",
                          account_type: "",
                          liquidity: "",
                          manual_invested: "",
                          created_at: formatDateInput(),
                        });
                        setEditingAccountId(null);
                        setShowAccountModal(true);
                      }}
                    >
                      + Add
                  </button>
                </div>
              </div>
              {showAccounts &&
                (accounts.length === 0 ? (
                  <p className="empty">Add an account to organize your holdings.</p>
                ) : (
                  <div className="table account-table">
                    <div className="table-head">
                      <button
                        type="button"
                        className="table-sort"
                        title="Account name."
                        onClick={() => handleAccountSort("name")}
                      >
                        Name {renderAccountSortIcon("name")}
                      </button>
                      <button
                        type="button"
                        className="table-sort"
                        title="Account type."
                        onClick={() => handleAccountSort("type")}
                      >
                        Type {renderAccountSortIcon("type")}
                      </button>
                      <button
                        type="button"
                        className="table-sort"
                        title="Capital contributed."
                        onClick={() => handleAccountSort("manual_invested")}
                      >
                        Capital {renderAccountSortIcon("manual_invested")}
                      </button>
                      <button
                        type="button"
                        className="table-sort"
                        title="Value of holdings and placements in this account."
                        onClick={() => handleAccountSort("holdings")}
                      >
                        Holdings allocation {renderAccountSortIcon("holdings")}
                      </button>
                      <button
                        type="button"
                        className="table-sort"
                        title="Current cash available."
                        onClick={() => handleAccountSort("liquidity")}
                      >
                        Cash available {renderAccountSortIcon("liquidity")}
                      </button>
                      <button
                        type="button"
                        className="table-sort"
                        title="Holdings value plus liquidity."
                        onClick={() => handleAccountSort("total")}
                      >
                        Total {renderAccountSortIcon("total")}
                      </button>
                      <button
                        type="button"
                        className="table-sort"
                        title="Total performance vs capital contributed."
                        onClick={() => handleAccountSort("performance")}
                      >
                        Performance {renderAccountSortIcon("performance")}
                      </button>
                    </div>
                    <div className="table-body">
                      {sortedAccounts.map((row) => {
                        const {
                          account,
                          allocationValue,
                          allocationPercent,
                          totalValue,
                          holdingsCount,
                          placementsCount,
                          manualInvested,
                          performance,
                          performanceRatio,
                        } = row;
                        const holdingsLabel = holdingsCount === 1 ? "holding" : "holdings";
                        const placementsLabel =
                          placementsCount === 1 ? "placement" : "placements";
                        const holdingsBreakdown =
                          holdingsCount > 0 && placementsCount > 0
                            ? `${holdingsCount} ${holdingsLabel} · ${placementsCount} ${placementsLabel}`
                            : holdingsCount > 0
                              ? `${holdingsCount} ${holdingsLabel}`
                              : placementsCount > 0
                                ? `${placementsCount} ${placementsLabel}`
                                : `0 ${holdingsLabel}`;
                        const performanceClass =
                          performance > 0 ? "positive" : performance < 0 ? "negative" : "";
                        return (
                          <article className="table-row account-row" key={account.id}>
                            <span className="account-identity">
                              <strong className="account-name">{account.name}</strong>
                              <small className="account-type">{account.account_type || "—"}</small>
                            </span>
                            <span className="account-actions">
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Add cash to ${account.name}`}
                                title="Add cash"
                                onClick={() => openCashModal(account, "add")}
                              >
                                ➕
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Withdraw cash from ${account.name}`}
                                title="Withdraw cash"
                                onClick={() => openCashModal(account, "withdraw")}
                              >
                                ➖
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Edit ${account.name}`}
                              onClick={() => {
                                setAccountForm({
                                  name: account.name,
                                  account_type: account.account_type || "",
                                  liquidity: String(account.liquidity ?? 0),
                                  manual_invested: String(account.manual_invested ?? 0),
                                  created_at: account.created_at
                                    ? formatDateInput(new Date(account.created_at))
                                    : formatDateInput(),
                                });
                                setEditingAccountId(account.id);
                                setShowAccountModal(true);
                              }}
                            >
                              ✏️
                            </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Delete ${account.name}`}
                                onClick={() => setAccountDeleteTarget(account)}
                              >
                                🗑️
                              </button>
                            </span>
                            <span className="account-metrics">
                              <span className="account-metric account-core-values">
                                <div className="account-core-line">
                                  <span>Capital</span>
                                  <strong>{formatMoney(manualInvested, totalCurrency)}</strong>
                                </div>
                                <div className="account-core-line">
                                  <span>Cash</span>
                                  <strong>{formatMoney(account.liquidity, totalCurrency)}</strong>
                                </div>
                                <div className="account-core-line">
                                  <span>Total</span>
                                  <strong>{formatMoney(totalValue, totalCurrency)}</strong>
                                </div>
                              </span>
                              <span className="account-metric account-insight-values">
                                <div className="account-insight-line">
                                  <span>P/L</span>
                                  <span className={`account-insight-value account-insight-pl ${performanceClass}`}>
                                    <span className="account-insight-pl-amount">
                                      {formatMoneySigned(performance, totalCurrency)}
                                    </span>
                                    {performanceRatio !== null && (
                                      <span className="account-insight-pl-ratio">
                                        ({formatPercentSigned(performanceRatio)})
                                      </span>
                                    )}
                                  </span>
                                </div>
                                <div className="account-insight-line">
                                  <span>Share</span>
                                  <strong className="account-insight-value">
                                    {allocationPercent !== null
                                      ? formatPercent(allocationPercent)
                                      : "—"}
                                  </strong>
                                </div>
                                <div className="account-insight-line">
                                  <span>Holdings</span>
                                  <strong className="account-insight-value">
                                    {holdingsBreakdown}
                                  </strong>
                                </div>
                              </span>
                            </span>
                          </article>
                        );
                      })}
                      {accountsSummary && (
                        <article className="table-row account-row account-summary-row">
                          <span className="account-identity">
                            <strong className="account-name">TOTAL</strong>
                            <small className="account-type">All accounts</small>
                          </span>
                          <span className="account-actions account-actions-placeholder" aria-hidden="true" />
                          <span className="account-metrics">
                            <span className="account-metric">
                              <span className="account-metric-label">Capital</span>
                              <strong>{formatMoney(accountsSummary.manualInvested, totalCurrency)}</strong>
                            </span>
                            <span className="account-metric">
                              <span className="account-metric-label">Allocation</span>
                              <strong>{formatMoney(accountsSummary.allocationValue, totalCurrency)}</strong>
                              <small>
                                {accountsSummary.allocationPercent !== null
                                  ? formatPercent(accountsSummary.allocationPercent)
                                  : "—"}
                              </small>
                              <small>
                                {accountsSummary.holdingsCount > 0 &&
                                accountsSummary.placementsCount > 0
                                  ? `${accountsSummary.holdingsCount} ${
                                      accountsSummary.holdingsCount === 1
                                        ? "holding"
                                        : "holdings"
                                    } · ${accountsSummary.placementsCount} ${
                                      accountsSummary.placementsCount === 1
                                        ? "placement"
                                        : "placements"
                                    }`
                                  : accountsSummary.holdingsCount > 0
                                    ? `${accountsSummary.holdingsCount} ${
                                        accountsSummary.holdingsCount === 1
                                          ? "holding"
                                          : "holdings"
                                      }`
                                    : accountsSummary.placementsCount > 0
                                      ? `${accountsSummary.placementsCount} ${
                                          accountsSummary.placementsCount === 1
                                            ? "placement"
                                            : "placements"
                                        }`
                                      : "0 holdings"}
                              </small>
                            </span>
                            <span className="account-metric">
                              <span className="account-metric-label">Cash</span>
                              <strong>{formatMoney(accountsSummary.liquidity, totalCurrency)}</strong>
                            </span>
                            <span className="account-metric">
                              <span className="account-metric-label">Total</span>
                              <strong>{formatMoney(accountsSummary.totalValue, totalCurrency)}</strong>
                            </span>
                            <span
                              className={`account-metric account-performance ${
                                accountsSummary.performance > 0
                                  ? "positive"
                                  : accountsSummary.performance < 0
                                    ? "negative"
                                    : ""
                              }`}
                            >
                              <span className="account-metric-label">P/L</span>
                              <strong>
                                {formatMoneySigned(accountsSummary.performance, totalCurrency)}
                              </strong>
                              <small className="account-performance-ratio">
                                {formatPercentSigned(accountsSummary.performanceRatio)}
                              </small>
                            </span>
                          </span>
                        </article>
                      )}
                    </div>
                  </div>
                ))}
            </section>

            <section className="card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Holdings</p>
              <h2>Positions</h2>
            </div>
            <div className="card-actions">
              <label className="chart-group-label">
                Account
                <select
                  className="chart-select"
                  value={holdingAccountFilter}
                  onChange={(e) => setHoldingAccountFilter(e.target.value)}
                >
                  <option value="all">All accounts</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={String(account.id)}>
                      {account.name}
                      {account.account_type ? ` · ${account.account_type}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <span className="pill ghost">{holdingCountLabel}</span>
              {displayedHoldingsTotal !== null && (
                <span className="pill ghost">
                  {formatMoney(displayedHoldingsTotal, totalCurrency)} total
                </span>
              )}
              <button
                  type="button"
                  className="button primary compact"
                  onClick={() => {
                    setSymbolSearchTerm("");
                    setEditingHoldingId(null);
                    setHoldingForm({
                      symbol: "",
                      price_tracker: "yahoo",
                      tracker_symbol: "",
                      shares: "",
                      cost_basis: "",
                      acquisition_fee_value: "",
                      currency: "EUR",
                      fx_rate: "",
                      sector: "",
                      industry: "",
                      asset_type: "",
                      account_id: defaultAccountId ? String(defaultAccountId) : "",
                      isin: "",
                      mic: "",
                      name: "",
                      href: "",
                      acquired_at: "",
                      manualPriceEnabled: false,
                      manualLastPrice: "",
                      manualLastPriceAt: formatDateTimeLocal(),
                    });
                    setShowAddHoldingModal(true);
                  }}
                >
                  + Add
                </button>
            </div>
          </div>
          {holdings.length === 0 ? (
            <p className="empty">Add your first holding to start tracking.</p>
          ) : filteredHoldings.length === 0 ? (
            <p className="empty">No holdings for the selected account.</p>
          ) : (
            <div className="table positions-table">
              <div className="table-head">
                <button
                  type="button"
                  className="table-sort"
                  title="Company name and ticker for the position."
                  onClick={() => handleSort("instrument")}
                >
                  Instrument {renderSortIcon("instrument")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Current market value and latest price."
                  onClick={() => handleSort("value")}
                >
                  Value / Last {renderSortIcon("value")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Profit/loss in percent and amount."
                  onClick={() => handleSort("pl")}
                >
                  P/L {renderSortIcon("pl")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Cost per share, number of shares, total cost, and fees."
                  onClick={() => handleSort("cost")}
                >
                  Cost Details {renderSortIcon("cost")}
                </button>
                <span>Actions</span>
              </div>
              <div className="table-body">
                {sortedHoldings.map((holding: HoldingStats) => {
                  const totalCost = getHoldingTotalCost(holding);
                  const feeValue = getHoldingFeeValue(holding);
                  const lastPrice = holding.last_price;
                  const marketValueNative =
                    lastPrice !== null && lastPrice !== undefined
                      ? lastPrice * holding.shares
                      : holding.market_value;
                  const marketValueEur = convertAmount(marketValueNative, holding.currency);
                  const totalCostEur = convertAmount(
                    totalCost,
                    holding.currency,
                    holding.fx_rate,
                    true
                  );
                  const gainAbsNative =
                    marketValueNative !== null && marketValueNative !== undefined
                      ? marketValueNative - totalCost
                      : holding.gain_abs;
                  const gainAbsEur =
                    marketValueEur !== null && marketValueEur !== undefined && totalCostEur !== null && totalCostEur !== undefined
                      ? marketValueEur - totalCostEur
                      : convertAmount(gainAbsNative, holding.currency);
                  const gainPct =
                    gainAbsEur !== null && gainAbsEur !== undefined && totalCostEur !== null && totalCostEur > 0
                      ? gainAbsEur / totalCostEur
                      : marketValueNative !== null && marketValueNative !== undefined && totalCost > 0
                        ? gainAbsNative / totalCost
                        : holding.gain_pct;
                  const lastPriceDisplay = renderAmount(lastPrice, holding.currency);
                  const valueDisplay = renderAmount(marketValueNative, holding.currency);
                  const gainDisplayPrimary =
                    gainAbsEur !== null && gainAbsEur !== undefined
                      ? formatMoney(gainAbsEur, totalCurrency)
                      : formatMoney(gainAbsNative, holding.currency);
                  const gainDisplaySecondary =
                    gainAbsEur !== null &&
                    gainAbsEur !== undefined &&
                    holding.currency?.toUpperCase() !== DISPLAY_CURRENCY &&
                    gainAbsNative !== null &&
                    gainAbsNative !== undefined
                      ? formatMoney(gainAbsNative, holding.currency)
                      : null;
                  const isUsdHolding = (holding.currency || "").toUpperCase() === "USD";
                  const isForeignCurrency =
                    holding.currency?.toUpperCase() !== DISPLAY_CURRENCY;
                  const fxRate = isForeignCurrency ? holding.fx_rate : null;
                  const costEur = fxRate && totalCost ? totalCost * fxRate : null;
                  const costPerShareEur =
                    fxRate && holding.cost_basis ? holding.cost_basis * fxRate : null;
                  const feeEur = fxRate && feeValue ? feeValue * fxRate : null;
                  const costPerSharePrimary =
                    isForeignCurrency && costPerShareEur !== null && costPerShareEur !== undefined
                      ? formatMoney(costPerShareEur, DISPLAY_CURRENCY)
                      : formatMoney(holding.cost_basis, holding.currency);
                  const costPerShareSecondary =
                    isForeignCurrency && costPerShareEur !== null && costPerShareEur !== undefined
                      ? formatMoney(holding.cost_basis, holding.currency)
                      : null;
                  const showCostPerShareSecondary =
                    costPerShareSecondary !== null &&
                    costPerShareSecondary !== undefined &&
                    !isUsdHolding;
                  const totalCostPrimary =
                    isForeignCurrency && costEur !== null && costEur !== undefined
                      ? formatMoney(costEur, DISPLAY_CURRENCY)
                      : formatMoney(totalCost, holding.currency);
                  const totalCostSecondary =
                    isForeignCurrency && costEur !== null && costEur !== undefined
                      ? formatMoney(totalCost, holding.currency)
                      : null;
                  const feePrimary =
                    isForeignCurrency && feeEur !== null && feeEur !== undefined
                      ? formatMoney(feeEur, DISPLAY_CURRENCY)
                      : formatMoney(feeValue, holding.currency);
                  const feeSecondary =
                    isForeignCurrency && feeEur !== null && feeEur !== undefined
                      ? formatMoney(feeValue, holding.currency)
                      : null;
                  const instrumentName = holding.name || holding.symbol || holding.isin || "Unknown";
                  const instrumentHref = holding.href || "";
                  const gainClassValue =
                    gainAbsEur !== null && gainAbsEur !== undefined ? gainAbsEur : gainAbsNative;
                  const gainSignSource =
                    gainPct !== null && gainPct !== undefined ? gainPct : gainClassValue;
                  const gainClass =
                    gainSignSource === null || gainSignSource === undefined
                      ? ""
                      : gainSignSource >= 0
                        ? "positive"
                        : "negative";
                  const analystProjectionPct =
                    holding.yahoo_target_mean !== null &&
                    holding.yahoo_target_mean !== undefined &&
                    holding.last_price !== null &&
                    holding.last_price !== undefined &&
                    holding.last_price > 0
                      ? (holding.yahoo_target_mean - holding.last_price) / holding.last_price
                      : null;
                  const analystProjectionArrow =
                    analystProjectionPct === null || analystProjectionPct === undefined
                      ? ""
                      : analystProjectionPct >= 0
                        ? "↗"
                        : "↘";
                  const hasGainBadge = gainPct !== null && gainPct !== undefined;
                  const hasAnalystBadge =
                    analystProjectionPct !== null && analystProjectionPct !== undefined;
                  return (
                    <div className="table-row position-row" key={holding.id}>
                      <span className="instrument-cell" data-label="Instrument">
                        <div className="position-card-header">
                          <div className="position-title-block">
                            {instrumentHref ? (
                              <a
                                href={instrumentHref}
                                className="name-link position-instrument-name"
                                target="_blank"
                                rel="noreferrer"
                              >
                                {instrumentName}
                              </a>
                            ) : (
                              <span className="muted position-instrument-name">{instrumentName}</span>
                            )}
                            <small className="position-title-meta">
                              {holding.asset_type ? ` ${holding.asset_type}` : ""}
                              {holding.sector ? ` · ${holding.sector}` : ""}
                            </small>
                          </div>
                          <span
                            className={`position-header-badges ${
                              hasGainBadge || hasAnalystBadge ? "" : "empty"
                            }`.trim()}
                          >
                            {hasGainBadge && hasAnalystBadge ? (
                              <span className="position-badges-stack">
                                <span className={`position-pl-badge ${gainClass}`.trim()}>
                                  {formatPercentSigned(gainPct)}
                                </span>
                                <span className="position-analyst-badge">
                                  <span className="position-analyst-badge-arrow">
                                    {analystProjectionArrow}
                                  </span>
                                  {formatPercentSigned(analystProjectionPct)}
                                </span>
                              </span>
                            ) : hasGainBadge ? (
                              <span className={`position-pl-badge ${gainClass}`.trim()}>
                                {formatPercentSigned(gainPct)}
                              </span>
                            ) : hasAnalystBadge ? (
                              <span className="position-analyst-badge">
                                <span className="position-analyst-badge-arrow">
                                  {analystProjectionArrow}
                                </span>
                                {formatPercentSigned(analystProjectionPct)}
                              </span>
                            ) : null}
                          </span>
                          <span className="holding-actions" data-label="Actions">
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Open actions for ${holding.symbol}`}
                              title="View details and actions"
                              onClick={() => setHoldingActionsTarget(holding)}
                            >
                              ⋯
                            </button>
                          </span>
                        </div>
                      </span>
                      <span className="position-metrics">
                        <span className="position-details">
                          <span className="metric-label">Cost (# {holding.shares.toFixed(2)})</span>
                          <span className="position-cost-primary">
                            {totalCostPrimary}
                            {totalCostSecondary && !isUsdHolding && (
                              <small> ({totalCostSecondary})</small>
                            )}
                          </span>
                          <span className="position-cost-share">
                            {costPerSharePrimary}
                            {showCostPerShareSecondary && <small> ({costPerShareSecondary})</small>}
                          </span>
                          {feeValue > 0 && (
                            <span className="position-cost-fee">
                              + {feePrimary}
                              {feeSecondary && !isUsdHolding && <small> ({feeSecondary})</small>}
                            </span>
                          )}
                        </span>
                        
                        <span className="position-value">
                          <span className="metric-label">Value</span>
                          <span className="position-value-primary">
                            {valueDisplay.primary}
                            {valueDisplay.secondary && !isUsdHolding && (
                              <small> ({valueDisplay.secondary})</small>
                            )}
                          </span>
                          <span className="position-value-last">
                            Last {lastPriceDisplay.primary}
                            {lastPriceDisplay.secondary && !isUsdHolding && (
                              <small> ({lastPriceDisplay.secondary})</small>
                            )}
                          </span>
                        </span>
                        
                        <span className="pl-cell position-pl">
                          <span className="metric-label">P/L</span>
                          <span className={`pl-amount ${gainClass}`.trim()}>{gainDisplayPrimary}</span>
                          {gainDisplaySecondary && !isUsdHolding && <small>{gainDisplaySecondary}</small>}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className="card placements-card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Placements</p>
              <h2>Placements</h2>
            </div>
            <div className="card-actions">
              <span className="pill ghost">{placements.length} tracked</span>
              {placementsTotal !== null && (
                <span className="pill ghost">
                  {formatMoney(placementsTotal, totalCurrency)} total
                </span>
              )}
              <button
                type="button"
                className="button primary compact"
                onClick={() => {
                  resetPlacementForm();
                  setEditingPlacementId(null);
                  setShowPlacementModal(true);
                }}
              >
                + Add
              </button>
            </div>
          </div>
          {!hasPlacements ? (
            <p className="empty">Add a placement to track manual values.</p>
          ) : (
            <div className="table placements-table">
              <div className="table-body">
                {sortedPlacements.map((placement) => {
                  const placementCurrency = placement.currency || "EUR";
                  const valueDisplay = renderAmount(placement.current_value, placementCurrency);
                  const initialValue = placement.initial_value;
                  const currentValue = placement.current_value;
                  const contributions = placement.total_contributions ?? 0;
                  const baseValue =
                    initialValue !== null && initialValue !== undefined
                      ? initialValue + contributions
                      : null;
                  const plRaw =
                    baseValue !== null &&
                    currentValue !== null &&
                    currentValue !== undefined
                      ? currentValue - baseValue
                      : null;
                  const rate =
                    plRaw !== null && baseValue !== null && baseValue > 0
                      ? plRaw / baseValue
                      : null;
                  const contributedDisplay = renderAmount(baseValue, placementCurrency);
                  const plDisplay = renderAmount(plRaw, placementCurrency);
                  const account =
                    placement.account_id !== null && placement.account_id !== undefined
                      ? accountsById.get(placement.account_id)
                      : null;
                  const plClass =
                    plRaw === null || plRaw === undefined
                      ? ""
                      : plRaw >= 0
                        ? "positive"
                        : "negative";
                  return (
                    <div className="placement-row" key={placement.id}>
                      <span className="instrument-cell">
                        <span className="instrument-name-row">
                          <span className="placement-instrument-name">{placement.name}</span>
                          {rate !== null && rate !== undefined && (
                            <span className={`position-pl-badge ${plClass}`.trim()}>
                              {formatPercentSigned(rate)}
                            </span>
                          )}
                        </span>
                        <small>
                          {placement.placement_type || "—"}
                          {account?.name ? ` · ${account.name}` : ""}
                        </small>
                      </span>
                      <span className="placement-metrics">
                        <span className="placement-value">
                          <span className="metric-label">Value</span>
                          <span className="placement-value-primary">
                            {valueDisplay.primary}
                            {valueDisplay.secondary && <small> ({valueDisplay.secondary})</small>}
                          </span>
                          <span className="placement-value-date">
                            {formatDate(placement.last_snapshot_at)}
                          </span>
                        </span>
                        <span className="placement-initial">
                          <span className="metric-label">Contributed</span>
                          <span className="placement-initial-primary">
                            {contributedDisplay.primary}
                            {contributedDisplay.secondary && (
                              <small> ({contributedDisplay.secondary})</small>
                            )}
                          </span>
                        </span>
                        <span className={`placement-pl ${plClass}`.trim()}>
                          <span className="metric-label">P/L</span>
                          <span className={`placement-pl-amount ${plClass}`.trim()}>
                            {plDisplay.primary}
                          </span>
                          {plDisplay.secondary && <small>{plDisplay.secondary}</small>}
                        </span>
                      </span>
                      <span className="account-actions placement-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`View chart for ${placement.name}`}
                          title="View chart"
                          onClick={() => setPlacementChartTarget(placement)}
                        >
                          📈
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Update ${placement.name}`}
                          title="Update value"
                          onClick={() => openPlacementHistory(placement)}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Edit ${placement.name}`}
                          onClick={() => {
                            setPlacementForm({
                              account_id: placement.account_id
                                ? String(placement.account_id)
                                : "",
                              name: placement.name,
                              placement_type: placement.placement_type || "",
                              sector: placement.sector || "",
                              industry: placement.industry || "",
                              currency: placement.currency || "EUR",
                              initial_value: "",
                              recorded_at: formatDateTimeLocal(),
                            });
                            setEditingPlacementId(placement.id);
                            setShowPlacementModal(true);
                          }}
                        >
                          ✏️
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Delete ${placement.name}`}
                          onClick={() => setPlacementDeleteTarget(placement)}
                        >
                          🗑️
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
          </>
        )}
      </main>

      {isAuthed && (
        <ChatWidget
          apiBase={CHAT_API_BASE}
          lang={chatLang}
          t={CHAT_TRANSLATOR}
          toggleToken={chatToggleToken}
          hideFab
          onOpenChange={setChatOpen}
        />
      )}

      {isTourActive && currentTourStep && (
        <div className="help-overlay" role="presentation" onClick={endTour}>
          {tourTargetRect && (
            <div className="help-highlight" style={tourHighlightStyle} />
          )}
          <div
            className="help-card"
            role="dialog"
            aria-labelledby="tour-step-title"
            aria-describedby="tour-step-body"
            style={tourCardStyle}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="help-title" id="tour-step-title">
              {currentTourStep.title}
            </p>
            <p className="help-body" id="tour-step-body">
              {currentTourStep.body}
            </p>
            <div className="help-controls">
              <button
                type="button"
                className="button compact"
                disabled={tourStepIndex === 0}
                onClick={() => goToTourStep(tourStepIndex - 1)}
              >
                Back
              </button>
              <button
                type="button"
                className="button compact primary"
                onClick={() =>
                  tourStepIndex === tourSteps.length - 1
                    ? endTour()
                    : goToTourStep(tourStepIndex + 1)
                }
              >
                {tourStepIndex === tourSteps.length - 1 ? "Finish" : "Next"}
              </button>
            </div>
            <p className="help-step-count">
              Step {tourStepIndex + 1} of {tourSteps.length}
            </p>
          </div>
        </div>
      )}

      {showAddHoldingModal && (
        <div
          className="symbol-modal-backdrop"
          onClick={() => setShowAddHoldingModal(false)}
        >
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-holding-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Portfolio</p>
                <h3 id="add-holding-modal-title">
                  {editingHoldingId ? "Edit holding" : "Add holding"}
                </h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setShowAddHoldingModal(false)}
              >
                ×
              </button>
            </div>
            <form className="form" onSubmit={handleAddHolding}>
              <div className="symbol-modal-body">
                <label>
                  Account (to hold)
                  <div className="account-select">
                    <select
                      ref={accountSelectRef}
                      value={holdingForm.account_id}
                      onChange={(e) =>
                        setHoldingForm((prev) => ({
                          ...prev,
                          account_id: e.target.value,
                        }))
                      }
                    >
                      <option value="">Default account</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                          {account.account_type ? ` · ${account.account_type}` : ""}
                          {"   "}  ({formatMoney(account.liquidity, totalCurrency)})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => {
                        setAccountForm({
                          name: "",
                          account_type: "",
                          liquidity: "",
                          manual_invested: "",
                          created_at: formatDateInput(),
                        });
                        setEditingAccountId(null);
                        setShowAccountModal(true);
                      }}
                    >
                      +
                    </button>
                  </div>
                  
                </label>
                <label>
                  Symbol
                  <div className="symbol-input-wrap">
                    <input
                      required
                      placeholder="AAPL"
                      autoComplete="off"
                      ref={symbolInputRef}
                      value={holdingForm.symbol}
                    onChange={(e) => {
                      setHoldingForm((prev) => ({
                        ...prev,
                        symbol: e.target.value,
                      }));
                    }}
                    />
                  </div>
                  <small className="muted">
                    {symbolSearchStatus.kind === "loading"
                      ? "Searching..."
                      : symbolSearchStatus.message || ""}
                  </small>
                </label>
                <label>
                  Price tracker
                  <select
                    value={holdingForm.price_tracker}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        price_tracker: e.target.value,
                        tracker_symbol: e.target.value === "boursorama" ? prev.tracker_symbol : "",
                      }))
                    }
                  >
                    <option value="yahoo">Yahoo Finance</option>
                    <option value="boursorama">Boursorama</option>
                  </select>
                  <small className="muted">
                    Use Boursorama for shares missing on Yahoo Finance.
                  </small>
                </label>
                {holdingForm.price_tracker === "boursorama" && (
                  <label>
                    Boursorama symbol
                    <input
                      placeholder="1rASHELL"
                      value={holdingForm.tracker_symbol}
                      onChange={(e) =>
                        setHoldingForm((prev) => ({
                          ...prev,
                          tracker_symbol: e.target.value,
                        }))
                      }
                    />
                    <small className="muted">
                      Find the symbol in the Boursorama chart URL (symbol=...).
                    </small>
                  </label>
                )}
                
                <label>
                  ISIN (optional)
                  <input
                    placeholder="US0378331005"
                    value={holdingForm.isin}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        isin: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Name (from search)
                  <input
                    placeholder="Instrument name"
                    value={holdingForm.name}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        name: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Asset type
                  <input
                    list="asset-type-list"
                    placeholder="Equity, ETF, Livret A, LDD"
                    value={holdingForm.asset_type}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        asset_type: e.target.value,
                      }))
                    }
                  />
                  <datalist id="asset-type-list">
                    <option value="Equity" />
                    <option value="ETF" />
                    <option value="Mutual Fund" />
                    <option value="Bond" />
                    <option value="Livret A" />
                    <option value="LDD" />
                    <option value="Cash" />
                  </datalist>
                </label>
                <label>
                  Sector
                  <input
                    placeholder="e.g. Financial Services"
                    value={holdingForm.sector}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        sector: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Industry
                  <input
                    placeholder="e.g. Banks - Diversified"
                    value={holdingForm.industry}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        industry: e.target.value,
                      }))
                    }
                  />
                </label>
                
                <label>
                  MIC (optional)
                  <input
                    placeholder="Paris"
                    value={holdingForm.mic}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        mic: e.target.value,
                      }))
                    }
                  />

                </label>
                <label>
                  Finance link
                  <input
                    placeholder="https://fr.finance.yahoo.com/quote/XYZ/"
                    value={holdingForm.href}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        href: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Acquisition date
                  <input
                    type="date"
                    value={holdingForm.acquired_at}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        acquired_at: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Shares
                  <input
                    required
                    type="number"
                    step="any"
                    ref={sharesInputRef}
                    value={holdingForm.shares}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        shares: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Cost basis (per share)
                  <input
                    required
                    type="number"
                    step="any"
                    ref={costBasisInputRef}
                    value={holdingForm.cost_basis}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        cost_basis: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Acquisition fee (value)
                  <input
                    type="number"
                    step="any"
                    min="0"
                    ref={acquisitionFeeInputRef}
                    value={holdingForm.acquisition_fee_value}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        acquisition_fee_value: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Currency
                  <select
                    ref={currencySelectRef}
                    value={holdingForm.currency}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        currency: e.target.value,
                      }))
                    }
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </label>
                {holdingForm.currency !== "EUR" && (
                  <label>
                    FX rate to EUR
                    <input
                      required
                      type="number"
                      step="any"
                      min="0"
                      placeholder="e.g. 0.92"
                      value={holdingForm.fx_rate}
                      onChange={(e) =>
                        setHoldingForm((prev) => ({
                          ...prev,
                          fx_rate: e.target.value,
                        }))
                      }
                    />
                    <small className="muted">
                      Used to convert the buy amount into EUR for account liquidity.
                    </small>
                  </label>
                )}
                {holdingForm.currency === "EUR" && (
                  <label className="inline-column" >  </label>)
                }
                <label className="inline-column" >  </label>
                <label className="inline-column-grid" >
                  <input
                    type="checkbox"
                    ref={manualPriceToggleRef}
                    checked={holdingForm.manualPriceEnabled}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        manualPriceEnabled: e.target.checked,
                      }))
                    }
                  />
                  <span className="muted">Manual last price. Use for non-standard instruments like FCPE, Livret A, LDD ...</span>
                </label>
                
                {holdingForm.manualPriceEnabled && (
                  <>
                    <label>
                      Last price (per share) 
                      <input
                        type="number"
                        step="any"
                        placeholder="Enter latest price"
                        ref={manualLastPriceInputRef}
                        value={holdingForm.manualLastPrice}
                        onChange={(e) =>
                          setHoldingForm((prev) => ({
                            ...prev,
                            manualLastPrice: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Last update
                      <input
                        type="datetime-local"
                        ref={manualLastPriceAtInputRef}
                        value={holdingForm.manualLastPriceAt}
                        onChange={(e) =>
                          setHoldingForm((prev) => ({
                            ...prev,
                            manualLastPriceAt: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </>
                )}
              </div>

              <div className="symbol-modal-footer">
                <div className="footer-left">
                  <button
                    type="button"
                    className="button primary"
                    ref={searchShareButtonRef}
                    onClick={() => {
                      setSymbolSearchTerm(holdingForm.symbol);
                      setShowSymbolModal(true);
                    }}
                  >
                    Search share
                  </button>
                </div>
                <div className="footer-right">
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      setShowAddHoldingModal(false);
                      setEditingHoldingId(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    ref={saveHoldingButtonRef}
                  >
                    {editingHoldingId ? "Save changes" : "Save holding"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {showPlacementModal && (
        <div className="symbol-modal-backdrop" onClick={closePlacementModal}>
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="placement-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Placements</p>
                <h3 id="placement-modal-title">
                  {editingPlacementId ? "Edit placement" : "Add placement"}
                </h3>
              </div>
              <button className="modal-close" type="button" onClick={closePlacementModal}>
                ×
              </button>
            </div>
            <form className="form" onSubmit={handlePlacementSubmit}>
              <div className="symbol-modal-body account-modal-body">
                <label>
                  Account
                  <div className="account-select">
                    <select
                      value={placementForm.account_id}
                      onChange={(e) =>
                        setPlacementForm((prev) => ({
                          ...prev,
                          account_id: e.target.value,
                        }))
                      }
                    >
                      <option value="">Default account</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                          {account.account_type ? ` · ${account.account_type}` : ""}
                          {"   "} ({formatMoney(account.liquidity, totalCurrency)})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => {
                        setAccountForm({
                          name: "",
                          account_type: "",
                          liquidity: "",
                          manual_invested: "",
                          created_at: formatDateInput(),
                        });
                        setEditingAccountId(null);
                        setShowAccountModal(true);
                      }}
                    >
                      + Add
                    </button>
                  </div>
                </label>
                <label>
                  Name
                  <input
                    type="text"
                    value={placementForm.name}
                    onChange={(e) =>
                      setPlacementForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                    placeholder="Assurance vie, Livret A..."
                    required
                  />
                </label>
                <label>
                  Type
                  <input
                    type="text"
                    list="placement-type-options"
                    value={placementForm.placement_type}
                    onChange={(e) =>
                      setPlacementForm((prev) => ({
                        ...prev,
                        placement_type: e.target.value,
                      }))
                    }
                    placeholder="Assurance vie, Livret A..."
                  />
                  <datalist id="placement-type-options">
                    {PLACEMENT_TYPE_OPTIONS.map((option) => (
                      <option key={option} value={option} />
                    ))}
                  </datalist>
                </label>
                <label>
                  Sector
                  <input
                    type="text"
                    value={placementForm.sector}
                    onChange={(e) =>
                      setPlacementForm((prev) => ({
                        ...prev,
                        sector: e.target.value,
                      }))
                    }
                    placeholder="Insurance, Banking..."
                  />
                </label>
                <label>
                  Industry
                  <input
                    type="text"
                    value={placementForm.industry}
                    onChange={(e) =>
                      setPlacementForm((prev) => ({
                        ...prev,
                        industry: e.target.value,
                      }))
                    }
                    placeholder="Life insurance, Savings..."
                  />
                </label>
                <label>
                  Currency
                  <select
                    value={placementForm.currency}
                    onChange={(e) =>
                      setPlacementForm((prev) => ({ ...prev, currency: e.target.value }))
                    }
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                  </select>
                </label>
                {!editingPlacementId && (
                  <>
                    <label>
                      Initial value
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={placementForm.initial_value}
                        onChange={(e) =>
                          setPlacementForm((prev) => ({
                            ...prev,
                            initial_value: e.target.value,
                          }))
                        }
                        placeholder="0"
                      />
                    </label>
                    <label>
                      Recorded at
                      <input
                        type="datetime-local"
                        value={placementForm.recorded_at}
                        onChange={(e) =>
                          setPlacementForm((prev) => ({
                            ...prev,
                            recorded_at: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="symbol-modal-footer">
                <button className="button" type="button" onClick={closePlacementModal}>
                  Cancel
                </button>
                <button className="button primary" type="submit">
                  {editingPlacementId ? "Save changes" : "Save placement"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {placementHistoryTarget && (
        <div className="symbol-modal-backdrop" onClick={closePlacementHistory}>
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="placement-history-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Placements</p>
                <h3 id="placement-history-title">{placementHistoryTarget.name}</h3>
              </div>
              <button className="modal-close" type="button" onClick={closePlacementHistory}>
                ×
              </button>
            </div>
            <form className="form" onSubmit={handlePlacementSnapshotSubmit}>
              <div className="symbol-modal-body account-modal-body">
                <label>
                  Entry type
                  <select
                    value={placementSnapshotForm.entry_kind}
                    onChange={(e) =>
                      setPlacementSnapshotForm((prev) => ({
                        ...prev,
                        entry_kind: e.target.value as
                          | "VALUE"
                          | "INITIAL"
                          | "INTEREST"
                          | "FEE"
                          | "CONTRIBUTION"
                          | "WITHDRAWAL",
                      }))
                    }
                  >
                    <option value="INITIAL">Initial placement</option>
                    <option value="VALUE">Value (absolute)</option>
                    <option value="INTEREST">Interest</option>
                    <option value="FEE">Management fee</option>
                    <option value="CONTRIBUTION">Contribution</option>
                    <option value="WITHDRAWAL">Withdrawal</option>
                  </select>
                </label>
                <label>
                  Amount
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={placementSnapshotForm.value}
                    onChange={(e) =>
                      setPlacementSnapshotForm((prev) => ({
                        ...prev,
                        value: e.target.value,
                      }))
                    }
                    placeholder="0"
                    required
                  />
                </label>
                <label>
                  Recorded at
                  <input
                    type="datetime-local"
                    value={placementSnapshotForm.recorded_at}
                    onChange={(e) =>
                      setPlacementSnapshotForm((prev) => ({
                        ...prev,
                        recorded_at: e.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <div className="confirm-modal-body">
                <div className="confirm-details">
                  <span className="pill ghost">
                    Current{" "}
                    {formatMoney(
                      placementHistoryTarget.current_value,
                      placementHistoryTarget.currency || "EUR"
                    )}
                  </span>
                  <span className="pill ghost">
                    Updated {formatDateTime(placementHistoryTarget.last_snapshot_at)}
                  </span>
                </div>
                {placementSnapshotsLoading ? (
                  <p className="muted helper">Loading history...</p>
                ) : placementSnapshots.length ? (
                  <div className="table snapshot-table">
                    <div className="table-head">
                      <span>Type</span>
                      <span>Amount</span>
                      <span>Recorded at</span>
                      <span>Actions</span>
                    </div>
                    <div className="table-body">
                      {placementSnapshots.map((snapshot) => {
                        const kind =
                          snapshot.entry_kind === "INITIAL"
                            ? "Initial"
                            : snapshot.entry_kind === "INTEREST"
                              ? "Interest"
                              : snapshot.entry_kind === "FEE"
                                ? "Fee"
                                : snapshot.entry_kind === "CONTRIBUTION"
                                  ? "Contribution"
                                  : snapshot.entry_kind === "WITHDRAWAL"
                                    ? "Withdrawal"
                                    : "Value";
                        const amount =
                          snapshot.entry_kind === "VALUE" || snapshot.entry_kind === "INITIAL"
                            ? formatMoney(
                                snapshot.value,
                                placementHistoryTarget.currency || "EUR"
                              )
                            : snapshot.entry_kind === "FEE" ||
                                snapshot.entry_kind === "WITHDRAWAL"
                              ? formatMoneySigned(
                                  -snapshot.value,
                                  placementHistoryTarget.currency || "EUR"
                                )
                              : formatMoneySigned(
                                  snapshot.value,
                                  placementHistoryTarget.currency || "EUR"
                                );
                        return (
                          <div className="table-row" key={snapshot.id}>
                            <span data-label="Type">{kind}</span>
                            <span data-label="Amount">{amount}</span>
                            <span data-label="Recorded at">
                              {formatDateTime(snapshot.recorded_at)}
                            </span>
                            <span className="account-actions" data-label="Actions">
                              <button
                                type="button"
                                className="icon-button"
                                aria-label="Edit entry"
                                onClick={() => handleEditPlacementSnapshot(snapshot)}
                              >
                                ✏️
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label="Delete entry"
                                disabled={deletingPlacementSnapshotId === snapshot.id}
                                onClick={() => handleDeletePlacementSnapshot(snapshot.id)}
                              >
                                🗑️
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="empty">No snapshots yet.</p>
                )}
              </div>
              <div className="symbol-modal-footer">
                <button className="button" type="button" onClick={closePlacementHistory}>
                  Close
                </button>
                {editingPlacementSnapshotId && (
                  <button
                    className="button"
                    type="button"
                    onClick={() => resetPlacementSnapshotForm(placementHistoryTarget)}
                  >
                    Cancel edit
                  </button>
                )}
                <button className="button primary" type="submit">
                  {editingPlacementSnapshotId ? "Update entry" : "Save entry"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {placementChartTarget && (
        <div className="symbol-modal-backdrop" onClick={closePlacementChart}>
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="placement-chart-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header chart-modal-header">
              <div>
                <p className="eyebrow">Placements</p>
                <h3 id="placement-chart-title">Placement evolution</h3>
                <p className="muted">{placementChartTarget.name}</p>
              </div>
              <button className="modal-close" type="button" onClick={closePlacementChart}>
                ×
              </button>
            </div>
            <div className="chart-wrapper">
              {placementChartLoading ? (
                <p className="muted helper">Loading history...</p>
              ) : placementEvolution.points.length ? (
                <HighchartsReact highcharts={Highcharts} options={placementChartOptions} />
              ) : (
                <p className="muted helper">No placement history yet.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {showAccountModal && (
        <div
          className="symbol-modal-backdrop"
          onClick={() => setShowAccountModal(false)}
        >
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Accounts</p>
                <h3 id="account-modal-title">
                  {editingAccountId ? "Edit account" : "Add account"}
                </h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setShowAccountModal(false)}
              >
                ×
              </button>
            </div>
            <form className="form" onSubmit={handleAccountSubmit}>
              <div className="symbol-modal-body account-modal-body">
                <label>
                  Name
                  <input
                    required
                    placeholder="Compte titres"
                    ref={accountNameInputRef}
                    value={accountForm.name}
                    onChange={(e) =>
                      setAccountForm((prev) => ({
                        ...prev,
                        name: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Type
                  <input
                    list="account-type-list"
                    placeholder="PEA, Assurance vie"
                    ref={accountTypeInputRef}
                    value={accountForm.account_type}
                    onChange={(e) =>
                      setAccountForm((prev) => ({
                        ...prev,
                        account_type: e.target.value,
                      }))
                    }
                  />
                  <datalist id="account-type-list">
                    <option value="Compte titres" />
                    <option value="PEA" />
                    <option value="Assurance vie" />
                    <option value="PER" />
                    <option value="Livret A" />
                    <option value="LDD" />
                    <option value="Cash" />
                  </datalist>
                </label>
                <label>
                  Opened at
                  <input
                    type="date"
                    required
                    ref={accountOpenedAtInputRef}
                    value={accountForm.created_at}
                    onChange={(e) =>
                      setAccountForm((prev) => ({
                        ...prev,
                        created_at: e.target.value,
                      }))
                    }
                  />
                  <small className="muted">
                    Used to compute annual performance for the account.
                  </small>
                </label>
                <label>
                  Cash available
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder="0"
                    ref={accountLiquidityInputRef}
                    value={accountForm.liquidity}
                    onChange={(e) =>
                      setAccountForm((prev) => ({
                        ...prev,
                        liquidity: e.target.value,
                      }))
                    }
                  />
                  <small className="muted">Cash available before contributions.</small>
                </label>
                <label>
                  Capital
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder="0"
                    ref={accountContributedInputRef}
                    value={accountForm.manual_invested}
                    onChange={(e) =>
                      setAccountForm((prev) => ({
                        ...prev,
                        manual_invested: e.target.value,
                      }))
                    }
                  />
                  <small className="muted">Added to liquidity to track contributions.</small>
                </label>
              </div>
              <div className="symbol-modal-footer">
                <div className="footer-right">
                  <button
                    className="button"
                    type="button"
                    onClick={() => setShowAccountModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    ref={accountSaveButtonRef}
                  >
                    {editingAccountId ? "Save changes" : "Save account"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {buyHoldingTarget && (
        <div
          className="symbol-modal-backdrop"
          onClick={() => setBuyHoldingTarget(null)}
        >
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="buy-holding-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Portfolio</p>
                <h3 id="buy-holding-title">
                  Buy {buyHoldingTarget.name || buyHoldingTarget.symbol}
                </h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setBuyHoldingTarget(null)}
              >
                ×
              </button>
            </div>
            <form className="form" onSubmit={handleBuyHolding}>
              <div className="symbol-modal-body account-modal-body">
                <label>
                  Shares to buy
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={buyForm.shares}
                    onChange={(e) =>
                      setBuyForm((prev) => ({
                        ...prev,
                        shares: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Price per share
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={buyForm.price}
                    onChange={(e) =>
                      setBuyForm((prev) => ({
                        ...prev,
                        price: e.target.value,
                      }))
                    }
                  />
                </label>
                {buyHoldingTarget.currency?.toUpperCase() !== "EUR" && (
                  <label>
                    FX rate to EUR
                    <input
                      required
                      type="number"
                      step="any"
                      min="0"
                      placeholder="e.g. 0.92"
                      value={buyForm.fx_rate}
                      onChange={(e) =>
                        setBuyForm((prev) => ({
                          ...prev,
                          fx_rate: e.target.value,
                        }))
                      }
                    />
                    <small className="muted">
                      Used to convert the buy amount into EUR for account liquidity.
                    </small>
                  </label>
                )}
                <label>
                  Fee value
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={buyForm.fee_value}
                    onChange={(e) =>
                      setBuyForm((prev) => ({
                        ...prev,
                        fee_value: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Buy date
                  <input
                    type="date"
                    value={buyForm.acquired_at}
                    onChange={(e) =>
                      setBuyForm((prev) => ({
                        ...prev,
                        acquired_at: e.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <div className="symbol-modal-footer">
                <div className="footer-right">
                  <button
                    className="button"
                    type="button"
                    onClick={() => setBuyHoldingTarget(null)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="button primary">
                    Buy holding
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {sellHoldingTarget && (
        <div
          className="symbol-modal-backdrop"
          onClick={() => setSellHoldingTarget(null)}
        >
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sell-holding-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Portfolio</p>
                <h3 id="sell-holding-title">
                  Sell {sellHoldingTarget.name || sellHoldingTarget.symbol}
                </h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setSellHoldingTarget(null)}
              >
                ×
              </button>
            </div>
            <form className="form" onSubmit={handleSellHolding}>
              <div className="symbol-modal-body account-modal-body">
                <label>
                  Shares to sell
                  <input
                    type="number"
                    step="any"
                    min="0"
                    max={sellHoldingTarget.shares}
                    value={sellForm.shares}
                    onChange={(e) =>
                      setSellForm((prev) => ({
                        ...prev,
                        shares: e.target.value,
                      }))
                    }
                  />
                  <small className="muted">
                    Available: {sellHoldingTarget.shares.toFixed(2)} shares
                  </small>
                </label>
                <label>
                  Price per share
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={sellForm.price}
                    onChange={(e) =>
                      setSellForm((prev) => ({
                        ...prev,
                        price: e.target.value,
                      }))
                    }
                  />
                </label>
                {sellHoldingTarget.currency?.toUpperCase() !== "EUR" && (
                  <label>
                    FX rate to EUR
                    <input
                      required
                      type="number"
                      step="any"
                      min="0"
                      placeholder="e.g. 0.92"
                      value={sellForm.fx_rate}
                      onChange={(e) =>
                        setSellForm((prev) => ({
                          ...prev,
                          fx_rate: e.target.value,
                        }))
                      }
                    />
                    <small className="muted">
                      Used to convert the sell proceeds into EUR for account liquidity.
                    </small>
                  </label>
                )}
                <label>
                  Fee value
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={sellForm.fee_value}
                    onChange={(e) =>
                      setSellForm((prev) => ({
                        ...prev,
                        fee_value: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Sell date
                  <input
                    type="date"
                    value={sellForm.executed_at}
                    onChange={(e) =>
                      setSellForm((prev) => ({
                        ...prev,
                        executed_at: e.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <div className="symbol-modal-footer">
                <div className="footer-right">
                  <button
                    className="button"
                    type="button"
                    onClick={() => setSellHoldingTarget(null)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="button danger">
                    Sell holding
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {showSymbolModal && (
        <div
          className="symbol-modal-backdrop"
          onClick={() => setShowSymbolModal(false)}
        >
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="symbol-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Instrument search</p>
                <h3 id="symbol-modal-title">Select a symbol</h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setShowSymbolModal(false)}
              >
                ×
              </button>
            </div>
            <div className="symbol-modal-search">
              <input
                autoFocus
                placeholder="Type a symbol, ISIN, or company name"
                value={symbolSearchTerm}
                onChange={(e) => setSymbolSearchTerm(e.target.value)}
              />
              <p className="muted helper">
                {symbolSearchStatus.kind === "loading"
                  ? "Searching..."
                  : symbolSearchStatus.message || ""}
              </p>
              <div className="symbol-modal-list">
                {symbolSearchStatus.kind === "error" && (
                  <p className="status status-error">
                    Search failed. Try again.
                  </p>
                )}
                {symbolSearchStatus.kind !== "loading" &&
                symbolResults.length === 0 ? (
                  <p className="empty">No results yet.</p>
                ) : (
                  symbolResults.slice(0, 20).map((item, idx) => {
                    const label = item.name || item.symbol || "Unknown";
                    const key = `${item.symbol || "sym"}-${item.exchange || "noex"}-${idx}`;
                    const yahooHref = item.symbol ? `https://fr.finance.yahoo.com/quote/${item.symbol}/` : "";
                    return (
                      <button
                        type="button"
                        key={key}
                        className="symbol-modal-item"
                      onClick={() => {
                        setHoldingForm((prev) => ({
                          ...prev,
                          symbol: item.symbol,
                          isin: item.isin || prev.isin,
                          mic: item.mic || prev.mic,
                          name: item.name || prev.name,
                          sector: item.sector || prev.sector,
                          industry: item.industry || prev.industry,
                          asset_type: item.typeDisp || prev.asset_type,
                          href: item.href || yahooHref || prev.href,
                        }));
                          setShowSymbolModal(false);
                        }}
                      >
                        <span className="combo-symbol">{item.symbol}</span>
                        <span className="combo-meta">
                          <span className="combo-name">{label}</span>
                          <span className="combo-tags">
                            {item.exchange && <span className="tag">{item.exchange}</span>}
                            {item.typeDisp && <span className="tag">{item.typeDisp}</span>}
                            {item.sector && <span className="tag">{item.sector}</span>}
                            {item.industry && <span className="tag">{item.industry}</span>}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
                {symbolSearchStatus.kind === "loading" && (
                  <p className="muted">Searching…</p>
                )}
              </div>
            </div>
            <div className="symbol-modal-footer">
              <button
                className="button"
                type="button"
                onClick={() => setShowSymbolModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {zoomedChart && (
        <div className="symbol-modal-backdrop full" onClick={() => setZoomedChart(null)}>
          <div
            className="symbol-modal full"
            role="dialog"
            aria-modal="true"
            aria-labelledby="zoom-chart-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header chart-modal-header">
              <div>
                <p className="eyebrow">
                  {zoomedChart === "history"
                    ? "History"
                    : zoomedChart === "allocation"
                      ? "Allocation"
                      : "Performance"}
                </p>
                <div className="summary-chart-title">
                  <h3 id="zoom-chart-title">
                    {zoomedChart === "history"
                      ? selectedHistorySymbol
                        ? `${selectedHistorySymbol} evolution`
                        : "Portfolio evolution"
                      : zoomedChart === "allocation"
                        ? "Portfolio mix"
                        : "P/L mix"}
                  </h3>
                  {zoomedChart === "allocation" &&
                    allocationChartType === "bar" &&
                    allocationData.total > 0 && (
                    <span className="pill ghost">
                      Total {formatMoney(allocationData.total, totalCurrency)}
                    </span>
                  )}
                  {zoomedChart === "pl" &&
                    plChartType === "bar" &&
                    chartGainAbs !== null &&
                    chartGainAbs !== undefined && (
                      <span className="pill ghost">
                        Total {formatMoneySigned(chartGainAbs, totalCurrency)}
                      </span>
                    )}
                </div>
              </div>
              <div className="chart-modal-actions">
                {zoomedChart === "history" ? (
                  <>
                    <label className="chart-group-label">
                      Filter
                      <select
                        className="chart-select"
                        value={historySeriesFilter}
                        onChange={(event) => setHistorySeriesFilter(event.target.value)}
                      >
                        {historySeriesFilterOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="chart-group-label">
                      Window
                      <select
                        className="chart-select"
                        value={dailyHistoryDays}
                        onChange={(event) => setDailyHistoryDays(Number(event.target.value))}
                      >
                        {HISTORY_DAY_OPTIONS.map((days) => (
                          <option key={days} value={days}>
                            {days}d
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <label className="chart-group-label">
                    Group by
                    <select
                      className="chart-select"
                      value={chartGroupBy}
                      onChange={(e) => setChartGroupBy(e.target.value as ChartGroupBy)}
                    >
                      {CHART_GROUP_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {zoomedChart === "allocation" && (
                  <button
                    type="button"
                    className="icon-button compact"
                    onClick={() =>
                      setAllocationChartType((prev) => (prev === "donut" ? "bar" : "donut"))
                    }
                    aria-label={allocationToggleLabel}
                    title={allocationToggleLabel}
                    aria-pressed={allocationChartType === "bar"}
                  >
                    {allocationChartType === "donut" ? (
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <rect x="2" y="3" width="12" height="2" rx="1" fill="currentColor" />
                        <rect x="2" y="7" width="9" height="2" rx="1" fill="currentColor" />
                        <rect x="2" y="11" width="6" height="2" rx="1" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path
                          d="M8 2a6 6 0 1 0 0 12a6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6a3 3 0 0 1 0-6z"
                          fill="currentColor"
                          fillRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                )}
                {zoomedChart === "pl" && (
                  <button
                    type="button"
                    className="icon-button compact"
                    onClick={() =>
                      setPlChartType((prev) => (prev === "donut" ? "bar" : "donut"))
                    }
                    aria-label={plToggleLabel}
                    title={plToggleLabel}
                    aria-pressed={plChartType === "bar"}
                  >
                    {plChartType === "donut" ? (
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <rect x="2" y="3" width="12" height="2" rx="1" fill="currentColor" />
                        <rect x="2" y="7" width="9" height="2" rx="1" fill="currentColor" />
                        <rect x="2" y="11" width="6" height="2" rx="1" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path
                          d="M8 2a6 6 0 1 0 0 12a6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6a3 3 0 0 1 0-6z"
                          fill="currentColor"
                          fillRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                )}
                <button
                  className="modal-close"
                  type="button"
                  onClick={() => setZoomedChart(null)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="chart-wrapper large">
              {zoomedChart === "history" ? (
                <HighchartsReact
                  highcharts={Highcharts}
                  constructorType="stockChart"
                  options={{
                    ...portfolioEvolutionStockOptions,
                    chart: {
                      ...portfolioEvolutionStockOptions.chart,
                      height: 520,
                    },
                  }}
                />
              ) : (
                <HighchartsReact
                  highcharts={Highcharts}
                  options={{
                    ...(zoomedChart === "allocation"
                      ? allocationChartOptions
                      : plChartOptions),
                    chart: {
                      ...(zoomedChart === "allocation"
                        ? allocationChartOptions.chart
                        : plChartOptions.chart),
                      height: 520,
                    },
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
      {accountDeleteTarget && (
        <div
          className="symbol-modal-backdrop"
          onClick={() => setAccountDeleteTarget(null)}
        >
          <div
            className="symbol-modal confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Delete account</p>
                <h3 id="delete-account-title">
                  Delete {accountDeleteTarget.name}?
                </h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setAccountDeleteTarget(null)}
              >
                ×
              </button>
            </div>
            <div className="confirm-modal-body">
              <p className="confirm-warning">
                This will permanently delete the account and all its holdings. This action is
                irreversible.
              </p>
              <div className="confirm-details">
                <span className="pill ghost">
                  Holdings {accountHoldingsCount.get(accountDeleteTarget.id) || 0}
                </span>
                <span className="pill ghost">
                  Cash available {formatMoney(accountDeleteTarget.liquidity, totalCurrency)}
                </span>
              </div>
            </div>
            <div className="symbol-modal-footer">
              <div className="footer-right">
                <button
                  className="button"
                  type="button"
                  onClick={() => setAccountDeleteTarget(null)}
                >
                  Cancel
                </button>
                <button
                  className="button danger"
                  type="button"
                  onClick={async () => {
                    const success = await handleDeleteAccount(accountDeleteTarget.id);
                    if (success) {
                      setAccountDeleteTarget(null);
                    }
                  }}
                >
                  Delete account
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {placementDeleteTarget && (
        <div
          className="symbol-modal-backdrop"
          onClick={() => setPlacementDeleteTarget(null)}
        >
          <div
            className="symbol-modal confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-placement-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Delete placement</p>
                <h3 id="delete-placement-title">
                  Delete {placementDeleteTarget.name}?
                </h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setPlacementDeleteTarget(null)}
              >
                ×
              </button>
            </div>
            <div className="confirm-modal-body">
              <p className="confirm-warning">
                This will permanently delete the placement and its history. This action is
                irreversible.
              </p>
              <div className="confirm-details">
                <span className="pill ghost">
                  Current{" "}
                  {formatMoney(
                    placementDeleteTarget.current_value,
                    placementDeleteTarget.currency || "EUR"
                  )}
                </span>
                <span className="pill ghost">
                  Updated {formatDateTime(placementDeleteTarget.last_snapshot_at)}
                </span>
              </div>
            </div>
            <div className="symbol-modal-footer">
              <div className="footer-right">
                <button
                  className="button"
                  type="button"
                  onClick={() => setPlacementDeleteTarget(null)}
                >
                  Cancel
                </button>
                <button
                  className="button danger"
                  type="button"
                  disabled={deletingPlacementId === placementDeleteTarget.id}
                  onClick={async () => {
                    const success = await handleDeletePlacement(placementDeleteTarget.id);
                    if (success) {
                      setPlacementDeleteTarget(null);
                    }
                  }}
                >
                  Delete placement
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {holdingActionsTarget &&
        (() => {
          const holding = holdingActionsTarget;
          const totalCost = getHoldingTotalCost(holding);
          const feeValue = getHoldingFeeValue(holding);
          const isForeignCurrency =
            holding.currency?.toUpperCase() !== DISPLAY_CURRENCY;
          const fxRate = isForeignCurrency ? holding.fx_rate : null;
          const costEur = fxRate && totalCost ? totalCost * fxRate : null;
          const costPerShareEur =
            fxRate && holding.cost_basis ? holding.cost_basis * fxRate : null;
          const feeEur = fxRate && feeValue ? feeValue * fxRate : null;
          const costPerSharePrimary =
            isForeignCurrency && costPerShareEur !== null && costPerShareEur !== undefined
              ? formatMoney(costPerShareEur, DISPLAY_CURRENCY)
              : formatMoney(holding.cost_basis, holding.currency);
          const costPerShareSecondary =
            isForeignCurrency && costPerShareEur !== null && costPerShareEur !== undefined
              ? formatMoney(holding.cost_basis, holding.currency)
              : null;
          const totalCostPrimary =
            isForeignCurrency && costEur !== null && costEur !== undefined
              ? formatMoney(costEur, DISPLAY_CURRENCY)
              : formatMoney(totalCost, holding.currency);
          const totalCostSecondary =
            isForeignCurrency && costEur !== null && costEur !== undefined
              ? formatMoney(totalCost, holding.currency)
              : null;
          const feePrimary =
            feeValue > 0
              ? isForeignCurrency && feeEur !== null && feeEur !== undefined
                ? formatMoney(feeEur, DISPLAY_CURRENCY)
                : formatMoney(feeValue, holding.currency)
              : "—";
          const feeSecondary =
            feeValue > 0 &&
            isForeignCurrency &&
            feeEur !== null &&
            feeEur !== undefined
              ? formatMoney(feeValue, holding.currency)
              : null;
          const lastPriceDisplay = renderAmount(holding.last_price, holding.currency);
          const lastPriceText = `${lastPriceDisplay.primary}${
            lastPriceDisplay.secondary ? ` (${lastPriceDisplay.secondary})` : ""
          }`;
          const holdingAccount =
            holding.account ||
            (holding.account_id
              ? accounts.find((account) => account.id === holding.account_id) || null
              : null);
          const accountLabel = holdingAccount?.name || "—";
          const accountType = holdingAccount?.account_type
            ? ` (${holdingAccount.account_type})`
            : "";
          const canAdjustCash = Boolean(holdingAccount);
          const trackerLabel =
            holding.price_tracker === "boursorama" ? "Boursorama" : "Yahoo Finance";
          return (
            <div className="symbol-modal-backdrop" onClick={closeHoldingActions}>
              <div
                className="symbol-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="holding-actions-title"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="symbol-modal-header">
                  <div>
                    <p className="eyebrow">Holdings</p>
                    <h3 id="holding-actions-title">
                      {holding.name || holding.symbol || "Holding details"}
                    </h3>
                    <hr/>
                  </div>
                  <button className="modal-close" type="button" onClick={closeHoldingActions}>
                    ×
                  </button>
                </div>
                <div className="holding-modal-content">
                  <div className="symbol-modal-body holding-modal-body">
                    <div className="holding-detail">
                      Name
                      <strong>{holding.name || "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      Symbol
                      <strong>{holding.symbol || "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      Price tracker
                      <strong>{trackerLabel}</strong>
                    </div>
                    {holding.price_tracker === "boursorama" && (
                      <div className="holding-detail">
                        Tracker symbol
                        <strong>{holding.tracker_symbol || "—"}</strong>
                      </div>
                    )}
                    <div className="holding-detail">
                      ISIN
                      <strong>{holding.isin || "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      Account
                      <strong>{`${accountLabel}${accountType}`}</strong>
                    </div>
                    <div className="holding-detail">
                      Shares
                      <strong>{holding.shares.toFixed(2)}</strong>
                    </div>
                    <div className="holding-detail">
                      Cost per share (PRU)
                      <strong>
                        {costPerSharePrimary}
                        {costPerShareSecondary ? ` (${costPerShareSecondary})` : ""}
                      </strong>
                    </div>
                    <div className="holding-detail">
                      Total cost
                      <strong>
                        {totalCostPrimary}
                        {totalCostSecondary ? ` (${totalCostSecondary})` : ""}
                      </strong>
                    </div>
                    <div className="holding-detail">
                      Fee
                      <strong>
                        {feePrimary}
                        {feeSecondary ? ` (${feeSecondary})` : ""}
                      </strong>
                    </div>
                    <div className="holding-detail">
                      Currency
                      <strong>{holding.currency || "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      Buy FX
                      <strong>{fxRate ? fxRate.toFixed(6) : "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      Acquired
                      <strong>{formatDate(holding.acquired_at)}</strong>
                    </div>
                    <div className="holding-detail">
                      Last price
                      <strong>{lastPriceText}</strong>
                    </div>
                    <div className="holding-detail">
                      Last price at
                      <strong>{formatDateTime(holding.last_snapshot_at)}</strong>
                    </div>
                    <div className="holding-detail">
                      Type
                      <strong>{holding.asset_type || "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      Sector
                      <strong>{holding.sector || "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      Industry
                      <strong>{holding.industry || "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      MIC
                      <strong>{holding.mic || "—"}</strong>
                    </div>
                    <div className="holding-detail">
                      Link
                      <strong>
                        {holding.href ? (
                          <a href={holding.href} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        ) : (
                          "—"
                        )}
                      </strong>
                    </div>
                  </div>
                  <div className="holding-modal-actions">
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => {
                        queueHoldingReturn(holding);
                        setHoldingFormFromHolding(holding);
                        setEditingHoldingId(holding.id);
                        setShowAddHoldingModal(true);
                      }}
                    >
                      Edit holding
                    </button>
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => {
                        queueHoldingReturn(holding);
                        setHoldingFormFromHolding(holding);
                        setEditingHoldingId(null);
                        setShowAddHoldingModal(true);
                      }}
                    >
                      Duplicate holding
                    </button>
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => {
                        queueHoldingReturn(holding);
                        openBuyModal(holding);
                      }}
                    >
                      Buy more
                    </button>
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => {
                        queueHoldingReturn(holding);
                        openSellModal(holding);
                      }}
                    >
                      Sell some
                    </button>
                    <button
                      type="button"
                      className="button compact"
                      disabled={!canAdjustCash}
                      onClick={() => {
                        if (!holdingAccount) {
                          setStatus({ kind: "error", message: "Account is missing for this holding" });
                          return;
                        }
                        queueHoldingReturn(holding);
                        openCashModal(holdingAccount, "add", "Dividend");
                      }}
                    >
                      Add dividend/interest
                    </button>
                    <button
                      type="button"
                      className="button compact"
                      disabled={deletingId === holding.id}
                      onClick={() => {
                        openHoldingConfirm(holding, "refund");
                      }}
                    >
                      Remove and refund
                    </button>
                    <button
                      type="button"
                      className="button compact danger"
                      disabled={deletingId === holding.id}
                      onClick={() => {
                        openHoldingConfirm(holding, "delete");
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
      {holdingConfirmTarget &&
        (() => {
          const { holding, mode } = holdingConfirmTarget;
          const totalCost = getHoldingTotalCost(holding);
          const currency = (holding.currency || "EUR").toUpperCase();
          const isForeignCurrency = currency !== DISPLAY_CURRENCY;
          const fxRate = isForeignCurrency ? holding.fx_rate : null;
          const refundEur = fxRate && totalCost ? totalCost * fxRate : null;
          const refundLabel =
            isForeignCurrency && refundEur !== null && refundEur !== undefined
              ? `${formatMoney(totalCost, currency)} (${formatMoney(refundEur, DISPLAY_CURRENCY)})`
              : formatMoney(totalCost, currency);
          const accountLabel = holding.account?.name || "—";
          return (
            <div
              className="symbol-modal-backdrop"
              onClick={() => setHoldingConfirmTarget(null)}
            >
              <div
                className="symbol-modal confirm-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="holding-confirm-title"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="symbol-modal-header">
                  <div>
                    <p className="eyebrow">Holdings</p>
                    <h3 id="holding-confirm-title">
                      {mode === "refund" ? "Remove & refund holding?" : "Delete holding?"}
                    </h3>
                  </div>
                  <button
                    className="modal-close"
                    type="button"
                    onClick={() => setHoldingConfirmTarget(null)}
                  >
                    ×
                  </button>
                </div>
                <div className="confirm-modal-body">
                  <p className="confirm-warning">
                    {mode === "refund"
                      ? "This will remove the holding and refund its cost back to cash. This action is irreversible."
                      : "This will permanently delete the holding. No cost back will be refunded to the account. This action is irreversible."}
                  </p>
                  <div className="confirm-details">
                    <span className="pill ghost">
                      {holding.symbol || holding.name || "Holding"}
                    </span>
                    <span className="pill ghost">
                      {holding.shares.toFixed(2)} shares
                    </span>
                    <span className="pill ghost">Account {accountLabel}</span>
                    {mode === "refund" && (
                      <span className="pill ghost">Refund {refundLabel}</span>
                    )}
                  </div>
                </div>
                <div className="symbol-modal-footer">
                  <div className="footer-right">
                    <button
                      className="button"
                      type="button"
                      onClick={() => setHoldingConfirmTarget(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className={`button ${mode === "refund" ? "primary" : "danger"}`}
                      type="button"
                      disabled={deletingId === holding.id}
                      onClick={async () => {
                        const success =
                          mode === "refund"
                            ? await handleRefundHolding(holding)
                            : await handleDeleteHolding(holding.id);
                        if (success) {
                          setHoldingConfirmTarget(null);
                        }
                      }}
                    >
                      {mode === "refund" ? "Remove & refund" : "Delete holding"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
      {backupImportTarget && (
        <div
          className="symbol-modal-backdrop"
          onClick={() => setBackupImportTarget(null)}
        >
          <div
            className="symbol-modal confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-import-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Backup</p>
                <h3 id="backup-import-title">Replace your data?</h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setBackupImportTarget(null)}
              >
                ×
              </button>
            </div>
            <div className="confirm-modal-body">
              <p className="confirm-warning">
                Importing this backup will replace all your current data (accounts, holdings,
                placements, transactions, cash, and history snapshots). This action is irreversible.
              </p>
              <div className="confirm-details">
                <span className="pill ghost">File {backupImportTarget.name}</span>
              </div>
            </div>
            <div className="symbol-modal-footer">
              <div className="footer-right">
                <button
                  className="button"
                  type="button"
                  onClick={() => setBackupImportTarget(null)}
                >
                  Cancel
                </button>
                <button
                  className="button danger"
                  type="button"
                  onClick={handleConfirmBackupImport}
                >
                  Import backup
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {cashTargetAccount && (
        <div className="symbol-modal-backdrop" onClick={closeCashModal}>
          <div
            className="symbol-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cash-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">Accounts</p>
                <h3 id="cash-modal-title">
                  {cashForm.mode === "add" ? "Add cash" : "Withdraw cash"}
                </h3>
              </div>
              <button className="modal-close" type="button" onClick={closeCashModal}>
                ×
              </button>
            </div>
            <form className="form" onSubmit={handleCashMovement}>
              <div className="symbol-modal-body cash-modal-body">
                <label>
                  Amount
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder="0"
                    value={cashForm.amount}
                    onChange={(e) =>
                      setCashForm((prev) => ({ ...prev, amount: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Action
                  <select
                    value={cashForm.mode}
                    onChange={(e) =>
                      setCashForm((prev) => {
                        const mode = e.target.value as "add" | "withdraw";
                        const options = CASH_REASON_OPTIONS[mode] as readonly string[];
                        const defaultReason = CASH_REASON_DEFAULT[mode];
                        const shouldReplace =
                          !prev.reasonPreset || !options.includes(prev.reasonPreset);
                        return {
                          ...prev,
                          mode,
                          reasonPreset: shouldReplace ? defaultReason : prev.reasonPreset,
                          reasonCustom: shouldReplace ? "" : prev.reasonCustom,
                        };
                      })
                    }
                  >
                    <option value="add">Add cash</option>
                    <option value="withdraw">Withdraw cash</option>
                  </select>
                </label>
                <label>
                  Reason
                  <div className="inline-row">
                    <select
                      value={cashForm.reasonPreset}
                      onChange={(e) =>
                        setCashForm((prev) => ({
                          ...prev,
                          reasonPreset: e.target.value,
                          reasonCustom: e.target.value === "Other" ? prev.reasonCustom : "",
                        }))
                      }
                    >
                      {CASH_REASON_OPTIONS[cashForm.mode].map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    {cashForm.reasonPreset === "Other" && (
                      <input
                        required
                        placeholder="Describe the reason"
                        value={cashForm.reasonCustom}
                        onChange={(e) =>
                          setCashForm((prev) => ({
                            ...prev,
                            reasonCustom: e.target.value,
                          }))
                        }
                      />
                    )}
                  </div>
                </label>
              </div>
              <div className="confirm-details">
                <span className="pill ghost">{cashTargetAccount.name}</span>
                <span className="pill ghost">
                  Cash available {formatMoney(cashTargetAccount.liquidity, totalCurrency)}
                </span>
                {cashPreview !== null && (
                  <span className={`pill ${cashPreview < 0 ? "danger" : "ghost"}`}>
                    After {formatMoney(cashPreview, totalCurrency)}
                  </span>
                )}
              </div>
              <div className="symbol-modal-footer">
                <div className="footer-right">
                  <button className="button" type="button" onClick={closeCashModal}>
                    Cancel
                  </button>
                  <button className="button primary" type="submit">
                    {cashForm.mode === "add" ? "Add cash" : "Withdraw cash"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
      {status.kind !== "idle" && status.message && (
        <div
          className={`toast toast-${status.kind}`}
          role={status.kind === "error" ? "alert" : "status"}
          aria-live={status.kind === "error" ? "assertive" : "polite"}
        >
          {status.message}
        </div>
      )}
    </div>
  );
}

export default App;
