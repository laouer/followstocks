import { useCallback, useEffect, useMemo, useState } from "react";
import FloatingSidebar from "./FloatingSidebar";
import { Cac40AnalysisResponse, Cac40Metric, fetchCac40Analysis } from "./api";

type Status = {
  kind: "idle" | "loading" | "success" | "error";
  message?: string;
};

const METRIC_OPTIONS: Array<{
  value: Cac40Metric;
  label: string;
  description: string;
}> = [
  {
    value: "analyst_discount",
    label: "Analyst discount",
    description: "Difference between analyst target mean price and current price.",
  },
  {
    value: "pe_discount",
    label: "P/E discount",
    description: "Discount vs the median trailing P/E in the CAC40 set.",
  },
  {
    value: "sector_pe_discount",
    label: "Sector P/E discount",
    description:
      "Discount vs the median trailing P/E within the company's sector (falls back to CAC40 median).",
  },
  {
    value: "dividend_yield",
    label: "Dividend yield",
    description: "Higher dividend yield ranks higher.",
  },
  {
    value: "composite",
    label: "Composite score",
    description:
      "Average percentile rank across analyst discount, sector P/E discount, and dividend yield.",
  },
];

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

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
};

const formatNumber = (value?: number | null) => {
  if (value === null || value === undefined) return "—";
  return value.toFixed(2);
};

const formatShortNumber = (value?: number | null) => {
  if (value === null || value === undefined) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  return value.toFixed(0);
};

type SortKey =
  | "company"
  | "price"
  | "target"
  | "score"
  | "pe"
  | "pb"
  | "dividend"
  | "market_cap";

function Cac40Analysis() {
  const [metric, setMetric] = useState<Cac40Metric>("analyst_discount");
  const [data, setData] = useState<Cac40AnalysisResponse | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const metricMeta = useMemo(
    () => METRIC_OPTIONS.find((option) => option.value === metric),
    [metric]
  );

  const loadAnalysis = useCallback(async () => {
    setStatus({ kind: "loading", message: "Loading CAC40 analysis..." });
    try {
      const res = await fetchCac40Analysis(metric);
      setData(res.data);
      setStatus({ kind: "success" });
    } catch (err) {
      setStatus({ kind: "error", message: "Unable to load CAC40 analysis." });
    }
  }, [metric]);

  useEffect(() => {
    loadAnalysis();
  }, [loadAnalysis]);

  useEffect(() => {
    setSortKey("score");
    setSortDir("desc");
  }, [metric]);

  const items = useMemo(() => data?.items ?? [], [data]);

  const ratingMap = useMemo(() => {
    const scored = items.filter(
      (item) => item.score !== null && item.score !== undefined
    );
    if (scored.length === 0) {
      return new Map<string, number>();
    }
    const sortedByScore = [...scored].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0)
    );
    const total = sortedByScore.length;
    const map = new Map<string, number>();
    sortedByScore.forEach((item, index) => {
      const rating = total === 1 ? 5 : 5 * (1 - index / (total - 1));
      map.set(item.symbol, Number(rating.toFixed(1)));
    });
    return map;
  }, [items]);

  const sortedItems = useMemo(() => {
    const list = [...items];
    const getValue = (item: (typeof items)[number]) => {
      switch (sortKey) {
        case "company":
          return (item.name || item.symbol || "").toString().toLowerCase();
        case "price":
          return item.price;
        case "target":
          return item.target_mean_price;
        case "score":
          return item.score;
        case "pe":
          return item.trailing_pe;
        case "pb":
          return item.price_to_book;
        case "dividend":
          return item.dividend_yield;
        case "market_cap":
          return item.market_cap;
        default:
          return null;
      }
    };

    list.sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      if ((av === null || av === undefined) && (bv === null || bv === undefined)) {
        return 0;
      }
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const dir = sortDir === "asc" ? 1 : -1;
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * dir;
      }
      if (av > bv) return dir;
      if (av < bv) return -dir;
      return 0;
    });
    return list;
  }, [items, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    setSortDir((prev) => (key === sortKey ? (prev === "asc" ? "desc" : "asc") : "desc"));
    setSortKey(key);
  };

  const renderSortIcon = (key: SortKey) => {
    const isActive = key === sortKey;
    const arrow = isActive ? (sortDir === "asc" ? "▲" : "▼") : "↕";
    return <span className={`sort-arrow ${isActive ? "active" : "inactive"}`}>{arrow}</span>;
  };

  return (
    <div className="page">
      <FloatingSidebar />
      <main className="grid">
        <section className="card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Market scan</p>
              <h2>CAC40 undervaluation</h2>
              <p className="muted helper">{metricMeta?.description}</p>
            </div>
            <div className="card-actions">
              <button className="button compact" type="button" onClick={loadAnalysis}>
                Refresh
              </button>
            </div>
          </div>

          <div className="analysis-controls">
            <label>
              Metric
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as Cac40Metric)}
              >
                {METRIC_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="analysis-meta">
              <p className="muted helper">
                Ratings are based on the selected signal, not a full valuation.
              </p>
              <p className="muted helper">
                {data?.updated_at
                  ? `Updated ${new Date(data.updated_at).toLocaleString()}`
                  : "Not updated yet"}
              </p>
              {status.kind === "loading" && <span className="pill ghost">Loading…</span>}
              {status.kind === "error" && <span className="pill danger">API issue</span>}
            </div>
          </div>

          {status.kind === "error" && status.message && (
            <p className="status status-error">{status.message}</p>
          )}

          <div className="table analysis-table">
            <div className="table-head">
              <button
                type="button"
                className="table-sort"
                title="Company name and ticker."
                onClick={() => handleSort("company")}
              >
                Company {renderSortIcon("company")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Latest market price."
                onClick={() => handleSort("price")}
              >
                Price {renderSortIcon("price")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Analyst target mean price."
                onClick={() => handleSort("target")}
              >
                Target {renderSortIcon("target")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Trailing price-to-earnings ratio."
                onClick={() => handleSort("pe")}
              >
                P/E {renderSortIcon("pe")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Price-to-book ratio."
                onClick={() => handleSort("pb")}
              >
                P/B {renderSortIcon("pb")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Trailing dividend yield."
                onClick={() => handleSort("dividend")}
              >
                Div. yield {renderSortIcon("dividend")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Total market capitalization."
                onClick={() => handleSort("market_cap")}
              >
                Market cap {renderSortIcon("market_cap")}
              </button>
              <button
                type="button"
                className="table-sort"
                title={metricMeta?.description || "Selected metric; higher is better."}
                onClick={() => handleSort("score")}
              >
                {metricMeta?.label || "Score"} {renderSortIcon("score")}
              </button>
              <span title="0-5 star rating based on rank within the selected metric.">
                Attractiveness
              </span>
            </div>
            <div className="table-body">
              {sortedItems.map((item) => {
                const score = item.score ?? null;
                const scoreClass =
                  metric === "dividend_yield"
                    ? ""
                    : score === null || score === undefined
                      ? ""
                      : score >= 0
                        ? "positive"
                        : "negative";
                const currency = item.currency || "EUR";
                const rating = ratingMap.get(item.symbol);
                const ratingPercent =
                  rating !== undefined && rating !== null
                    ? `${(Math.max(0, Math.min(5, rating)) / 5) * 100}%`
                    : "0%";
                const hasRating = rating !== undefined && rating !== null;
                return (
                  <div className="table-row" key={item.symbol}>
                    <span data-label="Company">
                      <a
                        className="analysis-link"
                        href={`https://fr.finance.yahoo.com/quote/${item.symbol}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className="analysis-name">{item.name || item.symbol}</span>
                      </a>
                      <small className="analysis-symbol">{item.symbol}</small>
                    </span>
                    <span data-label="Price">{formatMoney(item.price, currency)}</span>
                    <span data-label="Target">
                      {formatMoney(item.target_mean_price, currency)}
                    </span>
                    <span data-label="P/E">{formatNumber(item.trailing_pe)}</span>
                    <span data-label="P/B">{formatNumber(item.price_to_book)}</span>
                    <span data-label="Div. yield">
                      {formatPercent(item.dividend_yield)}
                    </span>
                    <span data-label="Market cap">
                      {formatShortNumber(item.market_cap)}
                    </span>
                    <span data-label={metricMeta?.label || "Score"} className={scoreClass}>
                      {formatPercent(score)}
                    </span>
                    <span data-label="Attractiveness">
                      {hasRating ? (
                        <>
                          <span className="analysis-stars" aria-hidden="true">
                            <span className="analysis-stars-track">★★★★★</span>
                            <span
                              className="analysis-stars-fill"
                              style={{ width: ratingPercent }}
                            >
                              ★★★★★
                            </span>
                          </span>
                          <small className="analysis-rating">{rating.toFixed(1)}</small>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default Cac40Analysis;
