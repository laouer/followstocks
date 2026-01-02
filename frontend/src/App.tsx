import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import Highcharts from "highcharts";
import HighchartsDrilldown from "highcharts/modules/drilldown";
import HighchartsReact from "highcharts-react-official";
import FloatingSidebar from "./FloatingSidebar";
import {
  PortfolioResponse,
  HoldingStats,
  Account,
  AuthUser,
  loginUser,
  registerUser,
  fetchCurrentUser,
  storeAuthToken,
  clearAuthToken,
  getStoredAuthToken,
  fetchPortfolio,
  exportHoldingsCsv,
  importHoldingsCsv,
  createAccount,
  updateAccount,
  deleteAccount,
  createHolding,
  updateHolding,
  searchInstruments,
  deleteHolding,
  addPriceSnapshot,
  fetchFxRate,
  sellHolding,
  refundHolding,
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
  holdingsPercent: number | null;
  totalValue: number;
  holdingsCount: number;
  manualInvested: number;
  performance: number;
  performanceRatio: number | null;
};
type AuthMode = "login" | "register";
type ChartGroupBy = "holding" | "account" | "asset_type" | "sector" | "industry";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
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
const LOSS_COLOR = "#fb7185";

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

function App() {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [authToken, setAuthToken] = useState<string | null>(() => getStoredAuthToken());
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [authStatus, setAuthStatus] = useState<Status>({ kind: "idle" });
  const [holdingForm, setHoldingForm] = useState({
    symbol: "",
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
  const [showSymbolModal, setShowSymbolModal] = useState(false);
  const [showAddHoldingModal, setShowAddHoldingModal] = useState(false);
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
  const [zoomedChart, setZoomedChart] = useState<"allocation" | "pl" | null>(null);
  const [allocationChartType, setAllocationChartType] = useState<"donut" | "bar">("donut");
  const [plChartType, setPlChartType] = useState<"donut" | "bar">("donut");
  const [chartGroupBy, setChartGroupBy] = useState<ChartGroupBy>("holding");
  const [excludedHoldings, setExcludedHoldings] = useState<Set<number>>(new Set());
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
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const includeAllRef = useRef<HTMLInputElement | null>(null);

  const holdings = useMemo(() => portfolio?.holdings ?? [], [portfolio]);
  const accounts = useMemo<Account[]>(() => portfolio?.accounts ?? [], [portfolio]);
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
  const chartHoldings = useMemo(
    () => holdings.filter((holding) => !excludedHoldings.has(holding.id)),
    [holdings, excludedHoldings]
  );
  const summary = portfolio?.summary;
  const totalCurrency = DISPLAY_CURRENCY;
  const isAuthed = Boolean(authToken);

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

  const toggleHoldingForCharts = (holdingId: number) => {
    setExcludedHoldings((prev) => {
      const next = new Set(prev);
      if (next.has(holdingId)) {
        next.delete(holdingId);
      } else {
        next.add(holdingId);
      }
      return next;
    });
  };

  const setAllHoldingsForCharts = (included: boolean) => {
    if (!holdings.length) return;
    if (included) {
      setExcludedHoldings(new Set());
      return;
    }
    setExcludedHoldings(new Set(holdings.map((holding) => holding.id)));
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
    const total_value = marketValues.length ? marketValues.reduce((a, b) => a + b, 0) : null;
    const total_gain_abs = total_value !== null ? total_value - total_cost : null;
    const total_gain_pct =
      total_gain_abs !== null && total_cost > 0 ? total_gain_abs / total_cost : null;

    return {
      total_cost,
      total_value,
      total_gain_abs,
      total_gain_pct,
      hourly_change_abs: summary?.hourly_change_abs ?? null,
      hourly_change_pct: summary?.hourly_change_pct ?? null,
    };
  }, [chartHoldings, fxRates, summary]);

  const selectedLiquidity = useMemo(() => {
    if (!chartHoldings.length) return null;
    const accountIds = new Set<number>();
    chartHoldings.forEach((holding) => {
      const accountId = holding.account_id ?? holding.account?.id;
      if (accountId) {
        accountIds.add(accountId);
      }
    });
    if (!accountIds.size) return null;
    return accounts.reduce(
      (sum, account) => (accountIds.has(account.id) ? sum + (account.liquidity || 0) : sum),
      0
    );
  }, [accounts, chartHoldings]);

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

      const points = Array.from(grouped.values()).map((entry) => ({
        name: entry.symbol,
        label: entry.label,
        y: Number(entry.y.toFixed(2)),
        currency: totalCurrency,
        drilldown: entry.lots.length > 1 ? `allocation-${entry.symbol}` : undefined,
        detailCount: entry.lots.length,
        detailLabel: entry.lots.length === 1 ? "lot" : "lots",
      }));

      const drilldownSeries = Array.from(grouped.values())
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
              })),
            }) as Highcharts.SeriesOptionsType
        );

      const total = points.reduce((sum, p) => sum + p.y, 0);
      return { points, total, drilldownSeries };
    }

    const grouped = new Map<
      string,
      {
        label: string;
        y: number;
        holdings: Map<string, { name: string; y: number; displayName: string }>;
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
          holdings: new Map<string, { name: string; y: number; displayName: string }>(),
        } as {
          label: string;
          y: number;
          holdings: Map<string, { name: string; y: number; displayName: string }>;
        });
      entry.y += value;
      const symbol =
        (holding.symbol || holding.name || holding.isin || `holding-${holding.id}`)
          .toString()
          .toUpperCase();
      const holdingLabel = holding.name || holding.symbol || holding.isin || symbol;
      const holdingKey = symbol.toLowerCase();
      const holdingEntry =
        entry.holdings.get(holdingKey) ||
        ({
          name: symbol,
          y: 0,
          displayName: holdingLabel,
        } as { name: string; y: number; displayName: string });
      holdingEntry.y += value;
      entry.holdings.set(holdingKey, holdingEntry);
      grouped.set(key, entry);
    });

    const points = Array.from(grouped.values()).map((entry) => {
      const holdingCount = entry.holdings.size;
      return {
        name: entry.label,
        label: entry.label,
        y: Number(entry.y.toFixed(2)),
        currency: totalCurrency,
        drilldown: holdingCount >= 1 ? `allocation-group-${slugify(entry.label)}` : undefined,
        detailCount: holdingCount,
        detailLabel: holdingCount === 1 ? "holding" : "holdings",
      };
    });
    const drilldownSeries = Array.from(grouped.values()).map(
      (entry) =>
        ({
          type: "pie",
          id: `allocation-group-${slugify(entry.label)}`,
          name: entry.label,
          data: Array.from(entry.holdings.values()).map((item) => ({
            name: item.name,
            y: Number(item.y.toFixed(2)),
            currency: totalCurrency,
            displayName: item.displayName,
          })),
        }) as Highcharts.SeriesOptionsType
    );
    const total = points.reduce((sum, p) => sum + p.y, 0);
    return { points, total, drilldownSeries };
  }, [chartGroupBy, chartHoldings, fxRates, totalCurrency]);

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
      const points = Array.from(grouped.values())
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
      const total = points.reduce((sum, p) => sum + p.y, 0);
      return { points, total, drilldownSeriesPie, drilldownSeriesBar };
    }

    const grouped = new Map<
      string,
      {
        id: string;
        label: string;
        gain: number;
        holdings: Map<string, { name: string; label: string; gain: number }>;
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
          holdings: new Map<string, { name: string; label: string; gain: number }>(),
        } as {
          id: string;
          label: string;
          gain: number;
          holdings: Map<string, { name: string; label: string; gain: number }>;
        });
      entry.gain += gainAbs;
      const symbol = (holding.symbol || holding.isin || `holding-${holding.id}`)
        .toString()
        .toUpperCase();
      const holdingLabel = holding.name || holding.symbol || holding.isin || symbol;
      const holdingKey = symbol.toLowerCase();
      const holdingEntry =
        entry.holdings.get(holdingKey) ||
        ({
          name: symbol,
          label: holdingLabel,
          gain: 0,
        } as { name: string; label: string; gain: number });
      holdingEntry.gain += gainAbs;
      entry.holdings.set(holdingKey, holdingEntry);
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
          drilldown: entry.holdings.size >= 1 ? entry.id : undefined,
          detailCount: entry.holdings.size,
          detailLabel: entry.holdings.size === 1 ? "holding" : "holdings",
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
          data: Array.from(entry.holdings.values())
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
          data: Array.from(entry.holdings.values())
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
  }, [chartGroupBy, chartHoldings, fxRates, totalCurrency]);

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
    return hasValue ? total : null;
  }, [chartHoldings, fxRates]);

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
            name: "Add holdings",
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
        series: allocationData.drilldownSeries,
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
        formatter: function (this: Highcharts.TooltipFormatterContextObject) {
          const point = this.point as Highcharts.Point & {
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
            return "Add holdings to see allocation";
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
            formatter: function (this: Highcharts.DataLabelsFormatterContextObject) {
              const point = this.point as Highcharts.Point & {
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
        categories: data.map((point) => point.name || ""),
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
        formatter: function (this: Highcharts.TooltipFormatterContextObject) {
          const point = this.point as Highcharts.Point;
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
          dataLabels: {
            enabled: hasData,
            style: {
              color: "#e9ecf4",
              textOutline: "none",
              fontWeight: "600",
              fontSize: "11px",
            },
            formatter: function (this: Highcharts.DataLabelsFormatterContextObject) {
              return formatMoney(this.y as number, totalCurrency);
            },
          },
        },
        series: {
          groupPadding: 0.1,
          pointPadding: 0.08,
        },
      },
      legend: { enabled: false },
      credits: { enabled: false },
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
        text: `<div class="donut-center"><strong>${formatMoneySigned(chartGainAbs, totalCurrency)}</strong></div>`,
      },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        formatter: function (this: Highcharts.TooltipFormatterContextObject) {
          const point = this.point as Highcharts.Point & {
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
            formatter: function (this: Highcharts.DataLabelsFormatterContextObject) {
              const point = this.point as Highcharts.Point;
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
        categories: data.map((point) => point.name || ""),
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
        formatter: function (this: Highcharts.TooltipFormatterContextObject) {
          const point = this.point as Highcharts.Point;
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
          dataLabels: {
            enabled: hasData,
            style: {
              color: "#e9ecf4",
              textOutline: "none",
              fontWeight: "600",
              fontSize: "11px",
            },
            formatter: function (this: Highcharts.DataLabelsFormatterContextObject) {
              const point = this.point as Highcharts.Point;
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
        series: {
          groupPadding: 0.1,
          pointPadding: 0.08,
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

  const allocationChartOptions =
    allocationChartType === "donut" ? allocationOptions : allocationBarOptions;
  const allocationToggleLabel =
    allocationChartType === "donut" ? "Show bar chart" : "Show donut chart";
  const plChartOptions = plChartType === "donut" ? plDonutOptions : plBarOptions;
  const plToggleLabel = plChartType === "donut" ? "Show bar chart" : "Show donut chart";
  const chartGroupLabel =
    CHART_GROUP_OPTIONS.find((option) => option.value === chartGroupBy)?.label || "Holding";
  const hasHoldings = holdings.length > 0;
  const allHoldingsIncluded = holdings.length > 0 && excludedHoldings.size === 0;
  const allocationEmptyMessage = hasHoldings
    ? "Select holdings to see the breakdown."
    : "Add holdings to see the breakdown.";
  const plEmptyMessage = hasHoldings
    ? "Select holdings/prices to see the P/L breakdown."
    : "Add holdings/prices to see the P/L breakdown.";
  const accountHoldingsCount = useMemo(() => {
    const counts = new Map<number, number>();
    holdings.forEach((holding) => {
      if (!holding.account_id) return;
      counts.set(holding.account_id, (counts.get(holding.account_id) || 0) + 1);
    });
    return counts;
  }, [holdings]);
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
  const totalHoldingsValue = useMemo(() => {
    let total = 0;
    accountHoldingsValue.forEach((value) => {
      total += value;
    });
    return total;
  }, [accountHoldingsValue]);

  const accountRows = useMemo<AccountRow[]>(() => {
    return accounts.map((account) => {
      const holdingsValue = accountHoldingsValue.get(account.id) || 0;
      const holdingsPercent =
        totalHoldingsValue > 0 ? holdingsValue / totalHoldingsValue : null;
      const totalValue = holdingsValue + (account.liquidity || 0);
      const holdingsCount = accountHoldingsCount.get(account.id) || 0;
      const manualInvested = account.manual_invested || 0;
      const performance = totalValue - manualInvested;
      const performanceRatio = manualInvested > 0 ? performance / manualInvested : null;
      return {
        account,
        holdingsValue,
        holdingsPercent,
        totalValue,
        holdingsCount,
        manualInvested,
        performance,
        performanceRatio,
      };
    });
  }, [accounts, accountHoldingsCount, accountHoldingsValue, totalHoldingsValue]);

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
          return row.holdingsValue;
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
    let holdingsValue = 0;
    let liquidity = 0;
    let totalValue = 0;
    let holdingsCount = 0;
    accountRows.forEach((row) => {
      manualInvested += row.manualInvested;
      holdingsValue += row.holdingsValue;
      liquidity += row.account.liquidity || 0;
      totalValue += row.totalValue;
      holdingsCount += row.holdingsCount;
    });
    const performance = totalValue - manualInvested;
    const performanceRatio = manualInvested > 0 ? performance / manualInvested : null;
    const holdingsPercent = totalHoldingsValue > 0 ? holdingsValue / totalHoldingsValue : null;
    return {
      manualInvested,
      holdingsValue,
      liquidity,
      totalValue,
      performance,
      performanceRatio,
      holdingsCount,
      holdingsPercent,
    };
  }, [accountRows, totalHoldingsValue]);

  const sortedHoldings = useMemo(() => {
    const list = [...holdings];
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
  }, [holdings, sortField, sortDir]);

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
      setStatus({ kind: "idle" });
    } catch (err) {
      const statusCode = (err as { response?: { status?: number } })?.response?.status;
      if (statusCode === 401) {
        clearAuthToken();
        setAuthToken(null);
        setCurrentUser(null);
        setPortfolio(null);
        setAuthStatus({ kind: "error", message: "Session expired. Please sign in again." });
        setStatus({ kind: "idle" });
        return;
      }
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
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
    if (!includeAllRef.current) return;
    const total = holdings.length;
    includeAllRef.current.indeterminate =
      excludedHoldings.size > 0 && excludedHoldings.size < total;
  }, [excludedHoldings.size, holdings.length]);

  useEffect(() => {
    if (!holdings.length) {
      if (excludedHoldings.size) {
        setExcludedHoldings(new Set());
      }
      return;
    }
    setExcludedHoldings((prev) => {
      if (!prev.size) return prev;
      const validIds = new Set(holdings.map((holding) => holding.id));
      let changed = false;
      const next = new Set<number>();
      prev.forEach((id) => {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [holdings, excludedHoldings.size]);

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
  }, [holdings, DISPLAY_CURRENCY, fxRates]);

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
    } catch (err) {
      setStatus({ kind: "error", message: "Failed to delete holding" });
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
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to remove and refund holding";
      setStatus({ kind: "error", message: detail });
    } finally {
      setDeletingId(null);
    }
  };

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
    setHoldingForm({
      symbol: holding.symbol,
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
      manualPriceEnabled: false,
      manualLastPrice: "",
      manualLastPriceAt: formatDateTimeLocal(),
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

  const handleExportHoldings = async () => {
    setStatus({ kind: "loading", message: "Preparing CSV export..." });
    try {
      const res = await exportHoldingsCsv();
      const blob = new Blob([res.data], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `holdings-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setStatus({ kind: "success", message: "Holdings exported." });
    } catch (err) {
      setStatus({ kind: "error", message: "Failed to export holdings" });
    }
  };

  const handleImportHoldings = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus({ kind: "loading", message: "Importing holdings..." });
    try {
      const res = await importHoldingsCsv(file);
      await loadPortfolio();
      const { created, skipped, errors } = res.data;
      const createdLabel = created === 1 ? "holding" : "holdings";
      const skippedLabel = skipped === 1 ? "holding" : "holdings";
      const skippedMessage = skipped ? ` Skipped ${skipped} ${skippedLabel}.` : "";
      const errorMessage = errors?.length ? ` First error: ${errors[0]}` : "";
      setStatus({
        kind: created > 0 ? "success" : "error",
        message: `Imported ${created} ${createdLabel}.${skippedMessage}${errorMessage}`,
      });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "Failed to import holdings";
      setStatus({ kind: "error", message: detail });
    } finally {
      event.target.value = "";
    }
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
      setStatus({ kind: "error", message: "Liquidity must be a positive number" });
      return;
    }
    const manualInvested =
      accountForm.manual_invested === "" ? 0 : Number(accountForm.manual_invested);
    if (Number.isNaN(manualInvested) || manualInvested < 0) {
      setStatus({ kind: "error", message: "Manual invested must be a positive number" });
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

  return (
    <div className="page">
      <FloatingSidebar />

      <main className="grid">
        {!isAuthed ? (
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
                <div className={`hero-badge ${status.kind === "error" ? "is-error" : ""}`}>
                  <span className="dot" />
                  <div>
                    <p>API
                    <strong>
                      {status.kind === "error" ? " Disconnected" : " Connected"}
                    </strong>
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="button compact"
                  onClick={() => {
                    setAuthMode((prev) => (prev === "login" ? "register" : "login"));
                    setAuthStatus({ kind: "idle" });
                  }}
                >
                  {authMode === "login" ? "Create account" : "Sign in"}
                </button>
              </div>
            </div>
            <form className="form" onSubmit={handleAuthSubmit}>
              {authMode === "register" && (
                <label>
                  Name
                  <input
                    type="text"
                    value={authForm.name}
                    onChange={(e) => setAuthForm((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Optional"
                    autoComplete="name"
                  />
                </label>
              )}
              <label>
                Email
                <input
                  type="email"
                  value={authForm.email}
                  onChange={(e) => setAuthForm((prev) => ({ ...prev, email: e.target.value }))}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={authForm.password}
                  onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="At least 8 characters"
                  autoComplete={authMode === "login" ? "current-password" : "new-password"}
                  required
                />
              </label>
              <button
                className="button primary"
                type="submit"
                disabled={authStatus.kind === "loading"}
              >
                {authStatus.kind === "loading"
                  ? authMode === "login"
                    ? "Signing in..."
                    : "Creating account..."
                  : authMode === "login"
                  ? "Sign in"
                  : "Create account"}
              </button>
            </form>
            {authStatus.kind === "error" && (
              <p className="status status-error">{authStatus.message}</p>
            )}
          </section>
        ) : (
          <>
            <section className="card summary">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Portfolio summary</p>
                </div>
                <div className="card-actions">
                  <span className="pill ghost">{currentUser?.email || "Signed in"}</span>
                  <div className={`hero-badge ${status.kind === "error" ? "is-error" : ""}`}>
                    <span className="dot" />
                    <div>
                      <p>API
                      <strong>
                        {status.kind === "error" ? " Disconnected" : " Connected"}
                      </strong>
                      </p>
                    </div>
                  </div>
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
                  {loading && <span className="pill ghost">Loading…</span>}
                  {!loading && status.kind === "error" && (
                    <span className="pill danger">API issue</span>
                  )}
                  <button
                    type="button"
                    className="button compact icon-only"
                    onClick={handleLogout}
                    aria-label="Log out"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                      <path
                        d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M10 17l5-5-5-5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M15 12H4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="summary-content">
                <div className="summary-grid">
                  <div className="stat">
                    <p>Invested</p>
                    <h3>{displayMoney(enhancedSummary.total_cost, totalCurrency)}</h3>
                  </div>
                  <div className="stat">
                    <p>Value</p>
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
                        ({formatPercentSigned(enhancedSummary.total_gain_pct)})
                      </span>
                    </h3>
                  </div>
                  <div className="stat">
                    <p>Liquidity</p>
                    <h3>{displayMoney(selectedLiquidity, totalCurrency)}</h3>
                  </div>
                </div>
                  <div className="summary-charts">
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
                        <button
                          type="button"
                          className="icon-button compact chart-toggle"
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
                        <button
                          type="button"
                          className="icon-button compact zoom-button"
                          onClick={() => setZoomedChart("allocation")}
                          aria-label="Expand allocation chart"
                        >
                          🔍
                        </button>
                      </div>
                      <div className="chart-wrapper">
                        <HighchartsReact
                          highcharts={Highcharts}
                          options={allocationChartOptions}
                      />
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
                          {plChartType === "bar" && chartGainAbs !== null && chartGainAbs !== undefined && (
                            <span className="pill ghost">
                              Total {formatMoneySigned(chartGainAbs, totalCurrency)}
                            </span>
                          )}
                        </div>
                        <p className="muted helper">
                          Absolute gains vs losses by {chartGroupLabel.toLowerCase()}
                        </p>
                        <button
                          type="button"
                          className="icon-button compact chart-toggle"
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
                        <button
                          type="button"
                          className="icon-button compact zoom-button"
                          onClick={() => setZoomedChart("pl")}
                          aria-label="Expand P/L chart"
                        >
                          🔍
                        </button>
                      </div>
                      <div className="chart-wrapper">
                        <HighchartsReact highcharts={Highcharts} options={plChartOptions} />
                      </div>
                    {(!plData.points.length || !plData.total) && (
                      <p className="muted helper">{plEmptyMessage}</p>
                    )}
                  </div>
                </div>
              </div>
              {status.kind !== "idle" && (
                <p className={`status status-${status.kind}`}>{status.message}</p>
              )}
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
                      Add account
                  </button>
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
                        title="Manually invested amount."
                        onClick={() => handleAccountSort("manual_invested")}
                      >
                        Manual invested {renderAccountSortIcon("manual_invested")}
                      </button>
                      <button
                        type="button"
                        className="table-sort"
                        title="Value of holdings in this account."
                        onClick={() => handleAccountSort("holdings")}
                      >
                        Holdings allocation {renderAccountSortIcon("holdings")}
                      </button>
                      <button
                        type="button"
                        className="table-sort"
                        title="Current liquidity available."
                        onClick={() => handleAccountSort("liquidity")}
                      >
                        Liquidity {renderAccountSortIcon("liquidity")}
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
                        title="Total performance vs manual invested."
                        onClick={() => handleAccountSort("performance")}
                      >
                        Performance {renderAccountSortIcon("performance")}
                      </button>
                      <span>Actions</span>
                    </div>
                    <div className="table-body">
                      {sortedAccounts.map((row) => {
                        const {
                          account,
                          holdingsValue,
                          holdingsPercent,
                          totalValue,
                          holdingsCount,
                          manualInvested,
                          performance,
                          performanceRatio,
                        } = row;
                        return (
                          <div className="table-row" key={account.id}>
                            <span data-label="Name">{account.name}</span>
                            <span data-label="Type">{account.account_type || "—"}</span>
                            <span data-label="Manual invested">
                              {formatMoney(manualInvested, totalCurrency)}
                            </span>
                            <span data-label="Holdings allocation">
                              {formatMoney(holdingsValue, totalCurrency)}
                              <small>
                                {holdingsPercent !== null
                                  ? formatPercent(holdingsPercent)
                                  : "—"}
                                {" · "}
                                {holdingsCount} holding{holdingsCount === 1 ? "" : "s"}
                              </small>
                            </span>
                            <span data-label="Liquidity">
                              {formatMoney(account.liquidity, totalCurrency)}
                            </span>
                            <span data-label="Total">
                              {formatMoney(totalValue, totalCurrency)}
                            </span>
                            <span
                              data-label="Performance"
                              className={
                                performance > 0 ? "positive" : performance < 0 ? "negative" : ""
                              }
                            >
                              {formatMoneySigned(performance, totalCurrency)}
                              <small>{formatPercentSigned(performanceRatio)}</small>
                            </span>
                            <span className="account-actions" data-label="Actions">
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
                          </div>
                        );
                      })}
                      {accountsSummary && (
                        <div className="table-row summary-row">
                          <span data-label="Name">Total</span>
                          <span data-label="Type">—</span>
                          <span data-label="Manual invested">
                            {formatMoney(accountsSummary.manualInvested, totalCurrency)}
                          </span>
                          <span data-label="Holdings allocation">
                            {formatMoney(accountsSummary.holdingsValue, totalCurrency)}
                            <small>
                              {accountsSummary.holdingsPercent !== null
                                ? formatPercent(accountsSummary.holdingsPercent)
                                : "—"}
                              {" · "}
                              {accountsSummary.holdingsCount} holding
                              {accountsSummary.holdingsCount === 1 ? "" : "s"}
                            </small>
                          </span>
                          <span data-label="Liquidity">
                            {formatMoney(accountsSummary.liquidity, totalCurrency)}
                          </span>
                          <span data-label="Total">
                            {formatMoney(accountsSummary.totalValue, totalCurrency)}
                          </span>
                          <span
                            data-label="Performance"
                            className={
                              accountsSummary.performance > 0
                                ? "positive"
                                : accountsSummary.performance < 0
                                  ? "negative"
                                  : ""
                            }
                          >
                            {formatMoneySigned(accountsSummary.performance, totalCurrency)}
                            <small>{formatPercentSigned(accountsSummary.performanceRatio)}</small>
                          </span>
                          <span data-label="Actions">—</span>
                        </div>
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
              <span className="pill ghost">{holdings.length} tracked</span>
              <button
                type="button"
                className="button compact"
                title="Download holdings as CSV"
                onClick={handleExportHoldings}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="button compact"
                title="Import holdings from a CSV file"
                onClick={() => importInputRef.current?.click()}
              >
                Import CSV
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleImportHoldings}
                hidden
              />
              <button
                  type="button"
                  className="button primary compact"
                  onClick={() => {
                    setSymbolSearchTerm("");
                    setEditingHoldingId(null);
                    setHoldingForm({
                      symbol: "",
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
          ) : (
            <div className="table">
              <div className="table-head">
                <div className="table-toggle">
                  <input
                    ref={includeAllRef}
                    className="table-checkbox"
                    type="checkbox"
                    checked={allHoldingsIncluded}
                    disabled={holdings.length === 0}
                    onChange={(e) => setAllHoldingsForCharts(e.target.checked)}
                    aria-label="Include all holdings in charts"
                    title="Include all holdings in charts"
                  />
                </div>
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
                  title="Account that holds this position."
                  onClick={() => handleSort("account")}
                >
                  Account {renderSortIcon("account")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Acquisition date for the holding."
                  onClick={() => handleSort("acquired_at")}
                >
                  Acquisition {renderSortIcon("acquired_at")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Number of shares held."
                  onClick={() => handleSort("shares")}
                >
                  Shares {renderSortIcon("shares")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Cost per share and total cost paid (incl. fee)."
                  onClick={() => handleSort("cost")}
                >
                  Cost / Total {renderSortIcon("cost")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Latest price per share and timestamp."
                  onClick={() => handleSort("last_price")}
                >
                  Last price {renderSortIcon("last_price")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Current market value of the position."
                  onClick={() => handleSort("value")}
                >
                  Value {renderSortIcon("value")}
                </button>
                <button
                  type="button"
                  className="table-sort"
                  title="Profit/loss in currency and percent (annualized when available)."
                  onClick={() => handleSort("pl")}
                >
                  P/L {renderSortIcon("pl")}
                </button>
              </div>
              <div className="table-body">
                {sortedHoldings.map((holding: HoldingStats) => {
                  const totalCost = getHoldingTotalCost(holding);
                  const feeValue = getHoldingFeeValue(holding);
                  const lastPrice = holding.last_price;
                  const lastTime = holding.last_snapshot_at;
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
                    isForeignCurrency && feeEur !== null && feeEur !== undefined
                      ? formatMoney(feeEur, DISPLAY_CURRENCY)
                      : formatMoney(feeValue, holding.currency);
                  const feeSecondary =
                    isForeignCurrency && feeEur !== null && feeEur !== undefined
                      ? formatMoney(feeValue, holding.currency)
                      : null;
                  const annualized = computeAnnualizedReturn(gainPct, holding.acquired_at);
                  const instrumentName = holding.name || holding.symbol || holding.isin || "Unknown";
                  const instrumentHref = holding.href || "";
                  const gainClassValue =
                    gainAbsEur !== null && gainAbsEur !== undefined ? gainAbsEur : gainAbsNative;
                  const gainClass =
                    gainClassValue === null || gainClassValue === undefined
                      ? ""
                      : gainClassValue >= 0
                        ? "positive"
                        : "negative";
                  return (
                    <div className="table-row" key={holding.id}>
                      <span className="table-toggle" data-label="Charts">
                        <input
                          className="table-checkbox"
                          type="checkbox"
                          checked={!excludedHoldings.has(holding.id)}
                          onChange={() => toggleHoldingForCharts(holding.id)}
                          aria-label={`Include ${holding.symbol || holding.name || "holding"} in charts`}
                          title="Include in charts"
                        />
                      </span>
                      <span className="instrument-cell" data-label="Instrument">
                        <div className="instrument-name-row">
                          {instrumentHref ? (
                            <a
                              href={instrumentHref}
                              className="name-link"
                              target="_blank"
                              rel="noreferrer"
                            >
                              {instrumentName}
                            </a>
                          ) : (
                            <span className="muted">{instrumentName}</span>
                          )}
                        </div>
                        <div className="instrument-actions column">
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Edit ${holding.symbol}`}
                              onClick={() => {
                                setHoldingFormFromHolding(holding);
                                setEditingHoldingId(holding.id);
                                setShowAddHoldingModal(true);
                              }}
                            >
                              ✏️
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Duplicate ${holding.symbol}`}
                              onClick={() => {
                                setHoldingFormFromHolding(holding);
                                setEditingHoldingId(null);
                                setShowAddHoldingModal(true);
                              }}
                            >
                              ⧉
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Buy more of ${holding.symbol}`}
                              onClick={() => openBuyModal(holding)}
                            >
                              🛒
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Sell ${holding.symbol}`}
                              onClick={() => openSellModal(holding)}
                            >
                              💸
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Remove ${holding.symbol} and refund`}
                              disabled={deletingId === holding.id}
                              onClick={() => handleRefundHolding(holding)}
                            >
                              ↩️
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Delete ${holding.symbol}`}
                              disabled={deletingId === holding.id}
                              onClick={() => handleDeleteHolding(holding.id)}
                            >
                              🗑️
                            </button>
                        </div>
                      </span>
                      <span data-label="Account">
                        {holding.account?.name || "—"}
                        {holding.account?.account_type && (
                          <small>{holding.account.account_type}</small>
                        )}
                      </span>
                      <span data-label="Acquisition">
                        {holding.acquired_at ? formatDate(holding.acquired_at) : "—"}
                      </span>
                      <span data-label="Shares">{holding.shares.toFixed(2)}</span>
                      <span data-label="Cost / Total">
                      <span className="cost-values">
                        {costPerSharePrimary}
                        {costPerShareSecondary && <small> ({costPerShareSecondary})</small>}
                        </span>
                      <span className="total-cost">
                          {totalCostPrimary}
                        {totalCostSecondary && <small> ({totalCostSecondary})</small>}
                        {feeValue > 0 && (
                          <small>
                            {" "}
                            <br />
                            Fee: {feePrimary}
                            {feeSecondary ? ` (${feeSecondary})` : ""}
                          </small>
                        )}
                        </span>

                      </span>
                      <span data-label="Last price">
                        <span className="cost-values">
                        {lastPriceDisplay.primary}
                        {lastPriceDisplay.secondary && <small>{" "}({lastPriceDisplay.secondary})</small>}
                        </span>
                        <small>{formatDateTime(lastTime)}</small>
                      </span>
                      <span data-label="Value">
                        {valueDisplay.primary}
                        {valueDisplay.secondary && <small>{valueDisplay.secondary}</small>}
                      </span>
                      <span className={gainClass} data-label="P/L">
                        {gainDisplayPrimary}
                        {gainDisplaySecondary && <small>{gainDisplaySecondary}</small>}
                        <small>{formatPercentSigned(gainPct)}</small>
                        {annualized !== null && (
                          <small>Ann.: {formatPercentSigned(annualized)}</small>
                        )}
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
                      New
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
                <label className="inline-column" >
                  <input
                    type="checkbox"
                    checked={holdingForm.manualPriceEnabled}
                    onChange={(e) =>
                      setHoldingForm((prev) => ({
                        ...prev,
                        manualPriceEnabled: e.target.checked,
                      }))
                    }
                  />
                  <span className="muted">Manual last price <br/> (use for non-standard instruments like FCPE)</span>
                </label>
                {holdingForm.manualPriceEnabled && (
                  <>
                    <label>
                      Last price (per share) 
                      <input
                        type="number"
                        step="any"
                        placeholder="Enter latest price"
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
                  <button type="submit" className="button primary">
                    {editingHoldingId ? "Save changes" : "Save holding"}
                  </button>
                </div>
              </div>
            </form>
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
                  Created at
                  <input
                    type="date"
                    required
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
                  Liquidity
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder="0"
                    value={accountForm.liquidity}
                    onChange={(e) =>
                      setAccountForm((prev) => ({
                        ...prev,
                        liquidity: e.target.value,
                      }))
                    }
                  />
                  <small className="muted">Cash available before manual investments.</small>
                </label>
                <label>
                  Manual invested
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder="0"
                    value={accountForm.manual_invested}
                    onChange={(e) =>
                      setAccountForm((prev) => ({
                        ...prev,
                        manual_invested: e.target.value,
                      }))
                    }
                  />
                  <small className="muted">
                    Added to liquidity to track cash injected.
                  </small>
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
                  <button type="submit" className="button primary">
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
                <p className="eyebrow">{zoomedChart === "allocation" ? "Allocation" : "Performance"}</p>
                <div className="summary-chart-title">
                  <h3 id="zoom-chart-title">
                    {zoomedChart === "allocation" ? "Portfolio mix" : "P/L mix"}
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
                  Liquidity {formatMoney(accountDeleteTarget.liquidity, totalCurrency)}
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
      {status.kind === "error" && status.message && (
        <div className="toast toast-error" role="alert">
          {status.message}
        </div>
      )}
    </div>
  );
}

export default App;
