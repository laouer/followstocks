import { useCallback, useEffect, useMemo, useState } from "react";
import FloatingSidebar from "./FloatingSidebar";
import { AnalystForecastItem, AnalystForecastResponse, fetchBsf120Analysis } from "./api";

type Status = {
  kind: "idle" | "loading" | "success" | "error";
  message?: string;
};

type SortKey =
  | "company"
  | "price"
  | "target_low"
  | "target_mean"
  | "target_high"
  | "upside"
  | "analysts"
  | "reco";

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

const formatNumber = (value?: number | null, digits = 2) => {
  if (value === null || value === undefined) return "—";
  return value.toFixed(digits);
};

const recommendationLabel = (key?: string | null) => {
  if (!key) return "—";
  return key.replaceAll("_", " ");
};

const RECO_TOOLTIP =
  "Yahoo recommendation mean:\n1.0 = Strong Buy\n2.0 = Buy\n3.0 = Hold\n4.0 = Sell\n5.0 = Strong Sell\nLower is more bullish.";

function Bsf120Analysis() {
  const [data, setData] = useState<AnalystForecastResponse | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [includeMissing, setIncludeMissing] = useState(false);
  const [nameFilter, setNameFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("upside");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const loadAnalysis = useCallback(async () => {
    setStatus({ kind: "loading", message: "Loading BSF120 analyst forecasts..." });
    try {
      const res = await fetchBsf120Analysis(includeMissing);
      setData(res.data);
      setStatus({ kind: "success" });
    } catch (_err) {
      setStatus({ kind: "error", message: "Unable to load BSF120 analyst forecasts." });
    }
  }, [includeMissing]);

  useEffect(() => {
    loadAnalysis();
  }, [loadAnalysis]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const filteredItems = useMemo(() => {
    const query = nameFilter.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      `${item.name ?? ""} ${item.symbol ?? ""}`.toLowerCase().includes(query)
    );
  }, [items, nameFilter]);

  const sortedItems = useMemo(() => {
    const list = [...filteredItems];
    const getValue = (item: AnalystForecastItem) => {
      switch (sortKey) {
        case "company":
          return (item.name || item.symbol || "").toString().toLowerCase();
        case "price":
          return item.price;
        case "target_low":
          return item.target_low_price;
        case "target_mean":
          return item.target_mean_price;
        case "target_high":
          return item.target_high_price;
        case "upside":
          return item.upside_pct;
        case "analysts":
          return item.analyst_count;
        case "reco":
          return item.recommendation_mean;
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
  }, [filteredItems, sortDir, sortKey]);

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
              <h2>BSF120 analyst forecasts</h2>
              <p className="muted helper">
                Sort by upside potential, target prices, recommendation, or analyst coverage.
              </p>
            </div>
            <div className="card-actions">
              <button className="button compact" type="button" onClick={loadAnalysis}>
                Refresh
              </button>
            </div>
          </div>

          <div className="analysis-controls">
            <div className="analysis-filters">
              <label>
                Data
                <span className="muted helper">
                  <input
                    checked={includeMissing}
                    onChange={(event) => setIncludeMissing(event.target.checked)}
                    type="checkbox"
                  />{" "}
                  Include symbols without target mean
                </span>
              </label>
              <label>
                Search by name
                <input
                  type="search"
                  value={nameFilter}
                  onChange={(event) => setNameFilter(event.target.value)}
                  placeholder="Type a company or ticker"
                />
              </label>
            </div>
            <div className="analysis-meta">
              <p className="muted helper">
                {data
                  ? `${data.with_forecast}/${data.total_symbols} symbols with analyst mean target`
                  : "No data yet"}
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

          <div className="table analysis-table bsf120-table">
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
                title="Analyst low target."
                onClick={() => handleSort("target_low")}
              >
                Target low {renderSortIcon("target_low")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Analyst mean target."
                onClick={() => handleSort("target_mean")}
              >
                Target mean {renderSortIcon("target_mean")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Analyst high target."
                onClick={() => handleSort("target_high")}
              >
                Target high {renderSortIcon("target_high")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="(Target mean - price) / price"
                onClick={() => handleSort("upside")}
              >
                Upside {renderSortIcon("upside")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Number of analyst opinions."
                onClick={() => handleSort("analysts")}
              >
                Analysts {renderSortIcon("analysts")}
              </button>
              <button
                type="button"
                className="table-sort"
                title={RECO_TOOLTIP}
                onClick={() => handleSort("reco")}
              >
                Reco <span className="tooltip-hint">?</span> {renderSortIcon("reco")}
              </button>
            </div>
            <div className="table-body">
              {sortedItems.length === 0 ? (
                <p className="empty">No symbols match your search.</p>
              ) : (
                sortedItems.map((item) => {
                  const currency = item.currency || "EUR";
                  const upsideClass =
                    item.upside_pct === null || item.upside_pct === undefined
                      ? ""
                      : item.upside_pct >= 0
                        ? "positive"
                        : "negative";
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
                      <span data-label="Target low">
                        {formatMoney(item.target_low_price, currency)}
                      </span>
                      <span data-label="Target mean">
                        {formatMoney(item.target_mean_price, currency)}
                      </span>
                      <span data-label="Target high">
                        {formatMoney(item.target_high_price, currency)}
                      </span>
                      <span data-label="Upside" className={upsideClass}>
                        {formatPercent(item.upside_pct)}
                      </span>
                      <span data-label="Analysts">{formatNumber(item.analyst_count, 0)}</span>
                      <span data-label="Reco">
                        {formatNumber(item.recommendation_mean)}
                        <small className="analysis-symbol">
                          {recommendationLabel(item.recommendation_key)}
                        </small>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default Bsf120Analysis;
