import { useEffect, useMemo, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import {
  PortfolioResponse,
  HoldingStats,
  AuthUser,
  loginUser,
  registerUser,
  fetchCurrentUser,
  storeAuthToken,
  clearAuthToken,
  getStoredAuthToken,
  fetchPortfolio,
  createHolding,
  updateHolding,
  searchInstruments,
  deleteHolding,
  addPriceSnapshot,
  fetchFxRate,
} from "./api";

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

type SortField = "instrument" | "acquired_at" | "shares" | "cost" | "last_price" | "value" | "pl";
type AuthMode = "login" | "register";

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
    currency: "EUR",
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
  const [fxRates, setFxRates] = useState<Record<string, number>>({});
  const DISPLAY_CURRENCY = "EUR";
  const [zoomedChart, setZoomedChart] = useState<"allocation" | "pl" | null>(null);
  const [plChartType, setPlChartType] = useState<"donut" | "bar">("donut");

  const holdings = useMemo(() => portfolio?.holdings ?? [], [portfolio]);
  const summary = portfolio?.summary;
  const totalCurrency = DISPLAY_CURRENCY;
  const isAuthed = Boolean(authToken);

  const convertAmount = (value: number | null | undefined, currency: string) => {
    if (value === null || value === undefined) return null;
    const curr = (currency || "").toUpperCase();
    if (curr === DISPLAY_CURRENCY) return value;
    const key = `${curr}->${DISPLAY_CURRENCY}`;
    const rate = fxRates[key];
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
  const isConverted = currency.toUpperCase() !== DISPLAY_CURRENCY && converted !== null && converted !== undefined;
  const primary = isConverted ? formatMoney(converted, DISPLAY_CURRENCY) : formatMoney(value, currency);
  const secondary = isConverted ? formatMoney(value, currency) : null;
  return { primary, secondary };
};

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
    const total_cost = holdings.reduce(
      (sum, h) => sum + (convertAmount(h.shares * h.cost_basis, h.currency) || 0),
      0
    );
    const marketValues: number[] = [];
    holdings.forEach((h) => {
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
  }, [holdings, summary]);

  const allocationData = useMemo(() => {
    const points = holdings
      .map((holding) => {
        const price = holding.last_price ?? holding.cost_basis ?? 0;
        const nativeValue =
          price !== null && price !== undefined ? price * holding.shares : 0;
        const value = convertAmount(nativeValue, holding.currency) ?? 0;
        if (!value || Number.isNaN(value) || value <= 0) return null;
        return {
          name: holding.symbol,
          label: holding.name || holding.symbol || holding.isin || "Holding",
          y: Number(value.toFixed(2)),
          currency: holding.currency || totalCurrency,
        };
      })
      .filter(Boolean) as Array<{
        name: string;
        label: string;
        y: number;
        currency: string;
      }>;
    const total = points.reduce((sum, p) => sum + p.y, 0);
    return { points, total };
  }, [holdings, totalCurrency]);

  const plData = useMemo(() => {
    const points = holdings
      .map((holding) => {
        const price = holding.last_price ?? null;
        const marketValueNative =
          price !== null && price !== undefined ? price * holding.shares : holding.market_value;
        const marketValue = convertAmount(marketValueNative, holding.currency);
        const totalCost = holding.shares * holding.cost_basis;
        const gainAbs =
          marketValue !== null && marketValue !== undefined
            ? marketValue - (convertAmount(totalCost, holding.currency) || 0)
            : convertAmount(holding.gain_abs, holding.currency);
        if (gainAbs === null || gainAbs === undefined || gainAbs === 0) return null;
        const amount = Math.abs(gainAbs);
        if (!amount || Number.isNaN(amount)) return null;
        return {
          name: holding.symbol,
          label: holding.name || holding.symbol || holding.isin || "Holding",
          gain: Number(gainAbs.toFixed(2)),
          y: Number(amount.toFixed(2)),
          currency: holding.currency || totalCurrency,
          isLoss: gainAbs < 0,
        };
      })
      .filter(Boolean) as Array<{
        name: string;
        label: string;
        gain: number;
        y: number;
        currency: string;
        isLoss: boolean;
      }>;
    const total = points.reduce((sum, p) => sum + p.y, 0);
    return { points, total };
  }, [holdings, totalCurrency]);

  const allocationOptions = useMemo<Highcharts.Options>(() => {
    const hasData = allocationData.total > 0 && allocationData.points.length > 0;
    const data = hasData
      ? allocationData.points.map((p, idx) => ({
          name: p.name,
          y: Math.ceil(p.y),
          color: ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
          currency: DISPLAY_CURRENCY,
          displayName: p.label,
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
      },
      title: {
        useHTML: true,
        align: "center",
        verticalAlign: "middle",
        floating: true,
        text: `<div class="donut-center"><strong>${formatMoney(Math.ceil(allocationData.total), totalCurrency)}</strong></div>`,
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
          };
          const options = point.options as Highcharts.PointOptionsObject & {
            currency?: string;
            displayName?: string;
            isDummy?: boolean;
          };
          if (options.isDummy) {
            return "Add holdings to see allocation";
          }
          const currency = options.currency || totalCurrency;
          const displayName = options.displayName || point.name;
          const value = formatMoney(point.y ?? 0, currency);
          const percentage = (point.percentage || 0).toFixed(1);
          return `<strong>${displayName}</strong><br/>${value}<br/>${percentage}% of portfolio`;
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
      title: {
        useHTML: true,
        align: "center",
        verticalAlign: "middle",
        floating: true,
        text: `<div class="donut-center"><strong>${formatMoneySigned(enhancedSummary.total_gain_abs, totalCurrency)}</strong></div>`,
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
          };
          if (options.isDummy) {
            return "Add holdings/prices to see P/L mix";
          }
          const currency = options.currency || totalCurrency;
          const rawGain = options.rawGain ?? 0;
          const value = `${rawGain >= 0 ? "+" : "-"}${formatMoney(Math.abs(rawGain), currency)}`;
          const percentage = (point.percentage || 0).toFixed(1);
          return `<strong>${options.displayName || point.name}</strong><br/>${value}<br/>${percentage}% of total P/L`;
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
  }, [plData, totalCurrency]);

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
          };
          const currency = options.currency || totalCurrency;
          const rawGain = options.rawGain ?? (point.y as number) ?? 0;
          const value = formatMoneySigned(rawGain, currency);
          const share =
            options.share !== undefined
              ? `${(options.share * 100).toFixed(1)}% of total P/L`
              : null;
          return `<strong>${options.displayName || point.name}</strong><br/>${value}${
            share ? `<br/>${share}` : ""
          }`;
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

  const plChartOptions = plChartType === "donut" ? plDonutOptions : plBarOptions;
  const plToggleLabel = plChartType === "donut" ? "Show bar chart" : "Show donut chart";

  const sortedHoldings = useMemo(() => {
    const list = [...holdings];
    const getValue = (h: HoldingStats) => {
      switch (sortField) {
        case "instrument":
          return (h.name || h.symbol || h.isin || "").toString().toLowerCase();
        case "acquired_at":
          return h.acquired_at ? new Date(h.acquired_at).getTime() : null;
        case "shares":
          return h.shares;
        case "cost":
          return convertAmount(h.shares * h.cost_basis, h.currency);
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
          const totalCost = h.shares * h.cost_basis;
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
      setStatus({ kind: "error", message: "Unable to reach the API" });
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
    setEditingHoldingId(null);
    setSymbolSearchTerm("");
    setSymbolResults([]);
    setSymbolSearchStatus({ kind: "idle" });
  };

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
    const payload = {
      symbol: holdingForm.symbol.trim(),
      shares: Number(holdingForm.shares),
      cost_basis: Number(holdingForm.cost_basis),
      currency: holdingForm.currency || "EUR",
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
        currency: "EUR",
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
      setStatus({
        kind: "error",
        message: editingHoldingId
          ? "Failed to update holding"
          : "Failed to add holding",
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

  return (
    <div className="page">

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
                  {loading && <span className="pill ghost">Loading…</span>}
                  {!loading && status.kind === "error" && (
                    <span className="pill danger">API issue</span>
                  )}
                  <button
                    type="button"
                    className="button compact"
                    onClick={handleLogout}
                  >
                    Log out
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
                </div>
                  <div className="summary-charts">
                    <div className="summary-chart">
                      <div className="summary-chart-header">
                        <p className="eyebrow">Allocation</p>
                        <h3>Portfolio mix</h3>
                        <p className="muted helper">Based on latest prices</p>
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
                          options={allocationOptions}
                      />
                    </div>
                    {(!allocationData.points.length || !allocationData.total) && (
                      <p className="muted helper">Add holdings to see the breakdown.</p>
                    )}
                    </div>

                    <div className="summary-chart">
                      <div className="summary-chart-header">
                        <p className="eyebrow">Performance</p>
                        <h3>P/L mix</h3>
                        <p className="muted helper">Absolute gains vs losses by holding</p>
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
                      <p className="muted helper">Add holdings/prices to see the P/L breakdown.</p>
                    )}
                  </div>
                </div>
              </div>
              {status.kind !== "idle" && (
                <p className={`status status-${status.kind}`}>{status.message}</p>
              )}
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
                className="button primary compact"
                onClick={() => {
                  setSymbolSearchTerm("");
                  setEditingHoldingId(null);
                  setHoldingForm({symbol: "",
                    shares: "",
                    cost_basis: "",
                    currency: "EUR",
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
                <button type="button" className="table-sort" onClick={() => handleSort("instrument")}>
                  Instrument {renderSortIcon("instrument")}
                </button>
                <button type="button" className="table-sort" onClick={() => handleSort("acquired_at")}>
                  Acquisition {renderSortIcon("acquired_at")}
                </button>
                <button type="button" className="table-sort" onClick={() => handleSort("shares")}>
                  Shares {renderSortIcon("shares")}
                </button>
                <button type="button" className="table-sort" onClick={() => handleSort("cost")}>
                  Cost / Total {renderSortIcon("cost")}
                </button>
                <button type="button" className="table-sort" onClick={() => handleSort("last_price")}>
                  Last price {renderSortIcon("last_price")}
                </button>
                <button type="button" className="table-sort" onClick={() => handleSort("value")}>
                  Value {renderSortIcon("value")}
                </button>
                <button type="button" className="table-sort" onClick={() => handleSort("pl")}>
                  P/L {renderSortIcon("pl")}
                </button>
              </div>
              <div className="table-body">
                {sortedHoldings.map((holding: HoldingStats) => {
                  const totalCost = holding.shares * holding.cost_basis;
                  const lastPrice = holding.last_price;
                  const lastTime = holding.last_snapshot_at;
                  const marketValue =
                    lastPrice !== null && lastPrice !== undefined ? lastPrice * holding.shares : holding.market_value;
                  const gainAbs = marketValue !== null && marketValue !== undefined ? marketValue - totalCost : holding.gain_abs;
                  const gainPct = marketValue !== null && marketValue !== undefined && totalCost > 0 ? gainAbs / totalCost : holding.gain_pct;
                  const lastPriceDisplay = renderAmount(lastPrice, holding.currency);
                  const valueDisplay = renderAmount(marketValue, holding.currency);
                  const gainDisplay = renderAmount(gainAbs, holding.currency);
                  const annualized = computeAnnualizedReturn(gainPct, holding.acquired_at);
                  const instrumentName = holding.name || holding.symbol || holding.isin || "Unknown";
                  const instrumentHref = holding.href || "";
                  const gainClass =
                    gainAbs === null || gainAbs === undefined
                      ? ""
                      : gainAbs >= 0
                        ? "positive"
                        : "negative";
                  return (
                    <div className="table-row" key={holding.id}>
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
                                setHoldingForm({
                                  symbol: holding.symbol,
                                  shares: String(holding.shares),
                                  cost_basis: String(holding.cost_basis),
                                  currency: holding.currency,
                                  isin: holding.isin || "",
                                  mic: holding.mic || "",
                                  name: holding.name || "",
                                  href: holding.href || "",
                                  acquired_at: holding.acquired_at ? holding.acquired_at.slice(0, 10) : "",
                                  manualPriceEnabled: false,
                                  manualLastPrice: "",
                                  manualLastPriceAt: formatDateTimeLocal(),
                                });
                              setEditingHoldingId(holding.id);
                              setShowAddHoldingModal(true);
                            }}
                            >
                              ✏️
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
                      <span data-label="Acquisition">
                        {holding.acquired_at ? formatDate(holding.acquired_at) : "—"}
                      </span>
                      <span data-label="Shares">{holding.shares.toFixed(2)}</span>
                      <span data-label="Cost / Total">
                        {formatMoney(holding.cost_basis, holding.currency)}
                        <small>
                          {formatMoney(totalCost, holding.currency)}
                        </small>
                      </span>
                      <span data-label="Last price">
                        {lastPriceDisplay.primary}
                        <small>{formatDateTime(lastTime)}</small>
                        {lastPriceDisplay.secondary && <small>{lastPriceDisplay.secondary}</small>}
                      </span>
                      <span data-label="Value">
                        {valueDisplay.primary}
                        {valueDisplay.secondary && <small>{valueDisplay.secondary}</small>}
                      </span>
                      <span className={gainClass} data-label="P/L">
                        {gainDisplay.primary}
                        {gainDisplay.secondary && <small>{gainDisplay.secondary}</small>}
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
            <div className="symbol-modal-header">
              <div>
                <p className="eyebrow">{zoomedChart === "allocation" ? "Allocation" : "Performance"}</p>
                <h3 id="zoom-chart-title">
                  {zoomedChart === "allocation" ? "Portfolio mix" : "P/L mix"}
                </h3>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setZoomedChart(null)}
              >
                ×
              </button>
            </div>
            <div className="chart-wrapper large">
              <HighchartsReact
                highcharts={Highcharts}
                options={{
                  ...(zoomedChart === "allocation" ? allocationOptions : plChartOptions),
                  chart: {
                    ...(zoomedChart === "allocation" ? allocationOptions.chart : plChartOptions.chart),
                    height: 520,
                  },
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
