import { useEffect, useMemo, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import {
  PortfolioResponse,
  HoldingStats,
  fetchPortfolio,
  createHolding,
  updateHolding,
  searchInstruments,
  fetchEuronextQuote,
  EuronextQuote,
  deleteHolding,
} from "./api";

type Status = {
  kind: "idle" | "loading" | "success" | "error";
  message?: string;
};

type SearchItem = {
  symbol: string;
  name: string;
  isin: string;
  mic?: string;
  href?: string;
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const ALLOCATION_COLORS = ["#22c55e", "#0ea5e9", "#a855f7", "#f97316", "#fcd34d", "#38bdf8", "#34d399"];
const LOSS_COLOR = "#fb7185";

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(2)}%`;
};

const formatMoney = (value?: number | null, currency = "EUR") => {
  if (value === null || value === undefined) return "—";
  if (currency === "EUR") {
    return `${value.toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} €`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 2,
  }).format(value);
};

const formatDateTime = (value?: string | null) => {
  if (!value) return "—";
  return new Date(value).toLocaleString();
};

const formatDate = (value?: string | null) => {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
};

function App() {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
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
  const [liveQuotes, setLiveQuotes] = useState<Record<string, EuronextQuote>>({});
  const [lastQuoteFetch, setLastQuoteFetch] = useState(0);
  const [editingHoldingId, setEditingHoldingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [openTooltipId, setOpenTooltipId] = useState<number | null>(null);

  const holdings = useMemo(() => portfolio?.holdings ?? [], [portfolio]);
  const summary = portfolio?.summary;
  const totalCurrency = holdings[0]?.currency || "EUR";

  const enhancedSummary = useMemo(() => {
    const total_cost = holdings.reduce((sum, h) => sum + h.shares * h.cost_basis, 0);
    const marketValues: number[] = [];
    holdings.forEach((h) => {
      const live = liveQuotes[h.symbol];
      const livePrice = live?.price ?? null;
      if (livePrice !== null) {
        marketValues.push(livePrice * h.shares);
      } else if (h.market_value !== null) {
        marketValues.push(h.market_value);
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
  }, [holdings, liveQuotes, summary]);

  const allocationData = useMemo(() => {
    const points = holdings
      .map((holding) => {
        const live = liveQuotes[holding.symbol];
        const price =
          live?.price ??
          holding.last_price ??
          holding.cost_basis ??
          0;
        const value =
          price !== null && price !== undefined
            ? price * holding.shares
            : 0;
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
  }, [holdings, liveQuotes, totalCurrency]);

  const plData = useMemo(() => {
    const points = holdings
      .map((holding) => {
        const live = liveQuotes[holding.symbol];
        const price = live?.price ?? holding.last_price ?? null;
        const marketValue =
          price !== null && price !== undefined
            ? price * holding.shares
            : holding.market_value;
        const totalCost = holding.shares * holding.cost_basis;
        const gainAbs =
          marketValue !== null && marketValue !== undefined
            ? marketValue - totalCost
            : holding.gain_abs;
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
  }, [holdings, liveQuotes, totalCurrency]);

  const allocationOptions = useMemo<Highcharts.Options>(() => {
    const hasData = allocationData.total > 0 && allocationData.points.length > 0;
    const data = hasData
      ? allocationData.points.map((p, idx) => ({
          name: p.name,
          y: p.y,
          color: ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
          currency: p.currency,
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
      title: { text: undefined },
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

  const plOptions = useMemo<Highcharts.Options>(() => {
    const hasData = plData.total > 0 && plData.points.length > 0;
    const data = hasData
      ? plData.points.map((p, idx) => ({
          name: p.name,
          y: p.y,
          color: p.isLoss
            ? LOSS_COLOR
            : ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
          currency: p.currency,
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
      title: { text: undefined },
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

  const loadPortfolio = async () => {
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
      setStatus({ kind: "error", message: "Unable to reach the API" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPortfolio();
    const interval = setInterval(loadPortfolio, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          res.data?.instruments ||
          res.data?.results ||
          res.data?.items ||
          (Array.isArray(res.data) ? res.data : []);
        const parsed: SearchItem[] = (rawItems || [])
          .map((item: any) => {
            const label: string = item.label || "";
            const symbolFromLabel = (
              label.match(/<span class=['"]symbol['"]>([^<]+)/i)?.[1] || ""
            ).trim();
            const nameFromLabel = (
              label.match(
                /<span class=['"]name['"][^>]*>(?:<a [^>]+>)?([^<]+)/i
              )?.[1] || ""
            ).trim();
            const rawHref = label.match(/<a [^>]*href=['"]([^'"]+)/i)?.[1] || item.link || "";
            const hrefClean = rawHref ? rawHref.replace(/^\/+/, "") : "";
            const hrefMatch = hrefClean ? `https://live.euronext.com/${hrefClean}` : "";
            const cleanName = (item.name || nameFromLabel || "")
              .toString()
              .trim();
            const symbol = (
              item.symbol ||
              item.ticker ||
              symbolFromLabel ||
              item.value ||
              ""
            )
              .toString()
              .trim();
            const isin = (item.isin || item.value || "").toString().trim();
            const mic = (item.mic || "").toString().trim();
            if (!symbol && !isin) return null;
            return { symbol, name: cleanName, isin, mic, href: hrefMatch };
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

  useEffect(() => {
    if (!holdings.length) {
      setLiveQuotes({});
      return;
    }
    const now = Date.now();
    if (now - lastQuoteFetch < REFRESH_INTERVAL_MS) return; // throttle to every 5 minutes
    let cancelled = false;
    const loadQuotes = async () => {
      const entries: Array<[string, EuronextQuote]> = [];
      for (const h of holdings) {
        if (!h.isin || !h.mic) continue;
        try {
          const res = await fetchEuronextQuote(h.isin, h.mic);
          entries.push([h.symbol, res.data]);
        } catch {
          entries.push([h.symbol, { isin: h.isin, mic: h.mic, price: null, timestamp: null, source: "euronext" }]);
        }
        await new Promise((resolve) => setTimeout(resolve, 400)); // slow down to avoid 429s
      }
      if (!cancelled) {
        setLiveQuotes(Object.fromEntries(entries));
        setLastQuoteFetch(Date.now());
      }
    };
    loadQuotes();
    return () => {
      cancelled = true;
    };
  }, [holdings, lastQuoteFetch]);

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
      if (editingHoldingId) {
        await updateHolding(editingHoldingId, payload);
      } else {
        await createHolding(payload);
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
      });
      setEditingHoldingId(null);
      await loadPortfolio();
      setStatus({ kind: "success", message: editingHoldingId ? "Holding updated" : "Holding added" });
      setShowAddHoldingModal(false);
    } catch (err) {
      setStatus({
        kind: "error",
        message: editingHoldingId
          ? "Failed to update holding"
          : "Failed to add holding (symbol must be unique)",
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
      <header className="hero">
        <div>
          <p className="eyebrow">Portfolio Pulse</p>
          <h1>Follow your stocks hourly and stay on top of gains.</h1>
          <p className="lede">
            Add your positions, log hourly prices, and watch performance update
            in real-time.
          </p>
        </div>
        <div className="hero-badge">
          <span className="dot" />
          <div>
            <p>API
            <strong>
              {status.kind === "error" ? " Disconnected" : " Connected"}
            </strong>
            </p>
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="card summary">
          <div className="card-header">
            <div>
              <p className="eyebrow">Portfolio summary</p>
            </div>
            {loading && <span className="pill ghost">Loading…</span>}
            {!loading && status.kind === "error" && (
              <span className="pill danger">API issue</span>
            )}
          </div>
          <div className="summary-content">
            <div className="summary-grid">
              <div className="stat">
                <p>Invested</p>
                <h3>{formatMoney(enhancedSummary.total_cost, totalCurrency)}</h3>
              </div>
              <div className="stat">
                <p>Value</p>
                <h3>{formatMoney(enhancedSummary.total_value, totalCurrency)}</h3>
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
                  {formatMoney(enhancedSummary.total_gain_abs, totalCurrency)}{" "}
                  <span className="muted">
                    ({formatPercent(enhancedSummary.total_gain_pct)})
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
                </div>
                <div className="chart-wrapper">
                  <HighchartsReact highcharts={Highcharts} options={plOptions} />
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
                <span>Instrument</span>
                <span>Acquisition</span>
                <span>Shares</span>
                <span>Cost / Total</span>
                <span>Last price</span>
                <span>Value</span>
                <span>P/L</span>
              </div>
              <div className="table-body">
                {holdings.map((holding: HoldingStats) => {
                  const totalCost = holding.shares * holding.cost_basis;
                  const live = liveQuotes[holding.symbol];
                  const lastPrice = live?.price ?? holding.last_price;
                  const lastTime = live?.timestamp ?? holding.last_snapshot_at;
                  const marketValue = lastPrice !== null && lastPrice !== undefined ? lastPrice * holding.shares : holding.market_value;
                  const gainAbs = marketValue !== null && marketValue !== undefined ? marketValue - totalCost : holding.gain_abs;
                  const gainPct = marketValue !== null && marketValue !== undefined && totalCost > 0 ? gainAbs / totalCost : holding.gain_pct;
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
                      <span className="instrument-cell">
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
                            <span className="name-link muted">{instrumentName}</span>
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
                              });
                              setSymbolSearchTerm(holding.symbol);
                              setEditingHoldingId(holding.id);
                              setShowAddHoldingModal(true);
                            }}
                            >
                              ✏️
                            </button>
                            <button
                              type="button"
                              className="icon-button danger"
                              aria-label={`Delete ${holding.symbol}`}
                              disabled={deletingId === holding.id}
                              onClick={() => handleDeleteHolding(holding.id)}
                            >
                              🗑️
                            </button>
                        </div>
                      </span>
                      <span>{holding.acquired_at ? formatDate(holding.acquired_at) : "—"}</span>
                      <span>{holding.shares.toFixed(2)}</span>
                      <span>
                        {formatMoney(holding.cost_basis, holding.currency)}
                        <small>
                          {formatMoney(totalCost, holding.currency)}
                        </small>
                      </span>
                      <span>
                        {formatMoney(lastPrice, holding.currency)}
                        <small>{formatDateTime(lastTime)}</small>
                        {live?.source === "euronext" && (
                          <small className="muted">Euronext live</small>
                        )}
                      </span>
                      <span>
                        {formatMoney(marketValue, holding.currency)}
                      </span>
                      <span className={gainClass}>
                        {gainAbs !== null && gainAbs !== undefined
                          ? `${gainAbs >= 0 ? "+" : "-"}${formatMoney(Math.abs(gainAbs), holding.currency)}`
                          : formatMoney(gainAbs, holding.currency)}
                        <small>{formatPercent(gainPct)}</small>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
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
                        setSymbolSearchTerm(e.target.value);
                      }}
                    />
                  </div>
                  <small className="muted">
                    {symbolSearchStatus.kind === "loading"
                      ? "Searching Euronext..."
                      : symbolSearchStatus.message ||
                        "Type 2+ letters to search Euronext"}
                  </small>
                </label>
                <label>
                  ISIN 
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
                  Euronext link
                  <input
                    placeholder="/fr/product/equities/ES0105486007-XMLI"
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
                  MIC (optional)
                  <input
                    placeholder="XPAR"
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
                  ? "Searching Euronext..."
                  : symbolSearchStatus.message ||
                    "Type 2+ letters to search Euronext"}
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
                    const label = item.name || item.isin || "Unknown";
                    const key = `${item.symbol || "sym"}-${item.isin || "noisin"}-${item.mic || "nomic"}-${idx}`;
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
                          href: item.href || prev.href,
                        }));
                          setShowSymbolModal(false);
                        }}
                      >
                        <span className="combo-symbol">{item.symbol}</span>
                        <span className="combo-meta">
                          <span className="combo-name">{label}</span>
                          <span className="combo-tags">
                            {item.isin && (
                              <span className="tag">ISIN {item.isin}</span>
                            )}
                            {item.mic && (
                              <span className="tag">{item.mic}</span>
                            )}
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
    </div>
  );
}

export default App;
