import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import PageAvatarMenu from "./PageAvatarMenu";
import {
  fetchDailyHistory,
  fetchPortfolio,
  getStoredAuthToken,
  type Account,
  type DailyHistoryResponse,
  type HoldingStats,
  type Placement,
  type PortfolioResponse,
} from "./api";

type LoadState = {
  kind: "idle" | "loading" | "ready" | "error";
  message?: string;
};

type InsightTone = "positive" | "warning" | "neutral";

type InsightItem = {
  tone: InsightTone;
  title: string;
  detail: string;
};

type ShareBarItem = {
  label: string;
  detail: string;
  value: number;
  share: number;
};

type AccountCoachItem = {
  id: number;
  name: string;
  holdingsCount: number;
  placementsCount: number;
  liquidity: number;
  trackedValue: number;
  totalValue: number;
  performance: number | null;
  cashShare: number | null;
  note: string;
};

const comparisonRows = [
  {
    label: "Primary goal",
    current:
      "Operate everything from one dense workspace: create accounts, edit holdings, review charts, and import or export data.",
    proposed:
      "Start with what matters now: value, trend, concentration, stale data, idle cash, and next actions.",
  },
  {
    label: "First scan",
    current: "Tables, charts, and forms all compete for visual priority.",
    proposed: "A daily brief establishes context before the user enters detailed tables.",
  },
  {
    label: "Decision support",
    current: "Signals exist, but the user has to hunt across multiple cards and rows.",
    proposed: "The screen promotes portfolio health signals and concrete review prompts.",
  },
  {
    label: "Account clarity",
    current: "Accounts are visible as rows with many metrics.",
    proposed:
      "Each account becomes a readable story: invested capital, tracked value, cash share, and whether it needs attention.",
  },
  {
    label: "Best use case",
    current: "Power users performing lots of maintenance actions.",
    proposed: "Regular portfolio check-ins where the user wants to understand, then act.",
  },
] as const;

const formatMoney = (value?: number | null, currency = "EUR") => {
  if (value === null || value === undefined) return "—";
  if ((currency || "EUR").toUpperCase() === "EUR") {
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

const formatPercentSigned = (value?: number | null) => {
  if (value === null || value === undefined) return "—";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(value) * 100).toFixed(1)}%`;
};

const resolveHoldingValue = (holding: HoldingStats) => {
  if (holding.market_value !== null && holding.market_value !== undefined) return holding.market_value;
  if (holding.last_price !== null && holding.last_price !== undefined) return holding.last_price * holding.shares;
  return 0;
};

const resolvePlacementValue = (placement: Placement) => placement.current_value ?? placement.initial_value ?? 0;

const daysSince = (value?: string | null) => {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24)));
};

const formatShortDate = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

function PortfolioApproachComparison() {
  const navigate = useNavigate();
  const authToken = getStoredAuthToken();
  const [loadState, setLoadState] = useState<LoadState>(() =>
    authToken ? { kind: "loading" } : { kind: "idle" }
  );
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [history, setHistory] = useState<DailyHistoryResponse | null>(null);

  useEffect(() => {
    if (!authToken) {
      setLoadState({ kind: "idle" });
      setPortfolio(null);
      setHistory(null);
      return;
    }

    let canceled = false;
    setLoadState({ kind: "loading" });

    void (async () => {
      try {
        const [portfolioRes, historyRes] = await Promise.all([
          fetchPortfolio(),
          fetchDailyHistory({ days: 30 }).catch(() => null),
        ]);
        if (canceled) return;
        setPortfolio(portfolioRes.data);
        setHistory(historyRes?.data ?? null);
        setLoadState({ kind: "ready" });
      } catch (error) {
        if (canceled) return;
        const message = error instanceof Error ? error.message : "Unable to load the portfolio preview.";
        setLoadState({ kind: "error", message });
      }
    })();

    return () => {
      canceled = true;
    };
  }, [authToken]);

  const accounts = portfolio?.accounts ?? [];
  const holdings = portfolio?.holdings ?? [];
  const placements = portfolio?.placements ?? [];

  const totalCash = useMemo(
    () => accounts.reduce((sum, account) => sum + (account.liquidity || 0), 0),
    [accounts]
  );

  const trackedValue = portfolio?.summary.total_value ?? null;
  const totalWealth = trackedValue !== null ? trackedValue + totalCash : totalCash || null;

  const historyChange = useMemo(() => {
    const rows = history?.portfolio ?? [];
    if (rows.length < 2) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const delta = last.total_value - first.total_value;
    const pct = first.total_value > 0 ? delta / first.total_value : null;
    return {
      delta,
      pct,
      start: first.snapshot_date,
      end: last.snapshot_date,
    };
  }, [history]);

  const exposureItems = useMemo(() => {
    const entries = [
      ...holdings.map((holding) => ({
        label: holding.name || holding.symbol || "Unnamed holding",
        value: resolveHoldingValue(holding),
        detail: holding.account?.name || holding.asset_type || "Holding",
      })),
      ...placements.map((placement) => ({
        label: placement.name || "Unnamed placement",
        value: resolvePlacementValue(placement),
        detail: placement.placement_type || "Placement",
      })),
    ].filter((item) => item.value > 0);

    const total = entries.reduce((sum, item) => sum + item.value, 0);

    return entries
      .sort((a, b) => b.value - a.value)
      .map((item) => ({
        ...item,
        share: total > 0 ? item.value / total : 0,
      }));
  }, [holdings, placements]);

  const topExposure = exposureItems[0] ?? null;
  const topThreeShare = exposureItems.slice(0, 3).reduce((sum, item) => sum + item.share, 0) || null;

  const staleHoldings = useMemo(
    () =>
      holdings
        .map((holding) => ({
          holding,
          age: daysSince(holding.last_snapshot_at),
        }))
        .filter((item) => item.age === null || item.age > 3)
        .sort((a, b) => (b.age ?? 9999) - (a.age ?? 9999)),
    [holdings]
  );

  const assetMix = useMemo<ShareBarItem[]>(() => {
    const buckets = new Map<string, number>();

    holdings.forEach((holding) => {
      const key = holding.asset_type || "Equities";
      buckets.set(key, (buckets.get(key) || 0) + resolveHoldingValue(holding));
    });

    placements.forEach((placement) => {
      const key = placement.placement_type || "Placements";
      buckets.set(key, (buckets.get(key) || 0) + resolvePlacementValue(placement));
    });

    const total = Array.from(buckets.values()).reduce((sum, value) => sum + value, 0);

    return Array.from(buckets.entries())
      .map(([label, value]) => ({
        label,
        value,
        share: total > 0 ? value / total : 0,
        detail: formatMoney(value, "EUR"),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [holdings, placements]);

  const accountCoach = useMemo<AccountCoachItem[]>(() => {
    const accountMap = new Map<
      number,
      { account: Account; holdingsCount: number; placementsCount: number; trackedValue: number }
    >();

    accounts.forEach((account) => {
      accountMap.set(account.id, {
        account,
        holdingsCount: 0,
        placementsCount: 0,
        trackedValue: 0,
      });
    });

    holdings.forEach((holding) => {
      const accountId = holding.account_id ?? holding.account?.id ?? null;
      if (!accountId || !accountMap.has(accountId)) return;
      const entry = accountMap.get(accountId);
      if (!entry) return;
      entry.holdingsCount += 1;
      entry.trackedValue += resolveHoldingValue(holding);
    });

    placements.forEach((placement) => {
      const accountId = placement.account_id ?? null;
      if (!accountId || !accountMap.has(accountId)) return;
      const entry = accountMap.get(accountId);
      if (!entry) return;
      entry.placementsCount += 1;
      entry.trackedValue += resolvePlacementValue(placement);
    });

    return Array.from(accountMap.values())
      .map(({ account, holdingsCount, placementsCount, trackedValue }) => {
        const liquidity = account.liquidity || 0;
        const totalValue = trackedValue + liquidity;
        const invested = account.manual_invested ?? null;
        const performance = invested && invested > 0 ? (totalValue - invested) / invested : null;
        const cashShare = totalValue > 0 ? liquidity / totalValue : null;
        let note = "Operational account with room for more narrative guidance.";

        if (trackedValue === 0 && liquidity > 0) {
          note = "Mostly cash today. This view should suggest funding or watchlist actions.";
        } else if ((cashShare ?? 0) > 0.3) {
          note = `High cash share at ${formatPercent(cashShare)}. A friendlier UI should flag this immediately.`;
        } else if ((performance ?? 0) > 0.08) {
          note = `Currently ahead of invested capital by ${formatPercentSigned(performance)}.`;
        } else if ((performance ?? 0) < -0.05) {
          note = `Below invested capital by ${formatPercentSigned(performance)}. This account needs a review cue.`;
        } else if (holdingsCount + placementsCount >= 5) {
          note = "Dense account. It benefits most from summarised risk and concentration cards.";
        }

        return {
          id: account.id,
          name: account.name,
          holdingsCount,
          placementsCount,
          liquidity,
          trackedValue,
          totalValue,
          performance,
          cashShare,
          note,
        };
      })
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [accounts, holdings, placements]);

  const accountAllocation = useMemo<ShareBarItem[]>(() => {
    const total = accountCoach.reduce((sum, item) => sum + item.totalValue, 0);
    return accountCoach
      .map((item) => ({
        label: item.name,
        value: item.totalValue,
        share: total > 0 ? item.totalValue / total : 0,
        detail: `${formatMoney(item.totalValue, "EUR")} total`,
      }))
      .slice(0, 5);
  }, [accountCoach]);

  const rankedHoldings = useMemo(
    () =>
      [...holdings]
        .filter((holding) => holding.gain_pct !== null && holding.gain_pct !== undefined)
        .sort((a, b) => (b.gain_pct ?? -Infinity) - (a.gain_pct ?? -Infinity)),
    [holdings]
  );

  const bestHolding = rankedHoldings[0] ?? null;
  const weakestHolding = rankedHoldings[rankedHoldings.length - 1] ?? null;

  const portfolioPulse = useMemo(() => {
    let score = 72;

    if (topExposure?.share !== undefined) {
      if (topExposure.share > 0.35) score -= 16;
      else if (topExposure.share > 0.25) score -= 8;
      else score += 6;
    }

    if (staleHoldings.length === 0) score += 10;
    else score -= Math.min(18, staleHoldings.length * 4);

    if ((accountCoach[0]?.cashShare ?? 0) > 0.35) score -= 8;
    else if (totalCash > 0) score += 3;

    if ((historyChange?.pct ?? 0) > 0) score += 5;
    if (holdings.length + placements.length >= 6) score += 4;

    const value = Math.max(0, Math.min(100, score));
    const label =
      value >= 85 ? "Clear read" : value >= 68 ? "Good visibility" : value >= 50 ? "Needs review" : "Low visibility";

    return { value, label };
  }, [
    accountCoach,
    historyChange?.pct,
    holdings.length,
    placements.length,
    staleHoldings.length,
    topExposure?.share,
    totalCash,
  ]);

  const pulseStyle = useMemo<CSSProperties>(
    () => ({
      background: `conic-gradient(rgba(34, 197, 94, 0.95) 0 ${portfolioPulse.value}%, rgba(255, 255, 255, 0.08) ${portfolioPulse.value}% 100%)`,
    }),
    [portfolioPulse.value]
  );

  const focusItems = useMemo<InsightItem[]>(() => {
    const items: InsightItem[] = [];

    if (topExposure && topExposure.share >= 0.25) {
      items.push({
        tone: "warning",
        title: "Concentration is visible",
        detail: `${topExposure.label} represents ${formatPercent(topExposure.share)} of tracked value.`,
      });
    }

    if (staleHoldings.length > 0) {
      const oldest = staleHoldings[0];
      items.push({
        tone: "warning",
        title: "Price freshness needs attention",
        detail:
          oldest?.age === null
            ? `${staleHoldings.length} holdings have no tracked price snapshot yet.`
            : `${staleHoldings.length} holdings are stale, oldest update is ${oldest.age} days old.`,
      });
    }

    if (totalCash > 0 && totalWealth) {
      items.push({
        tone: "positive",
        title: "Cash is easy to spot",
        detail: `${formatMoney(totalCash, "EUR")} sits in liquidity, or ${formatPercent(totalCash / totalWealth)} of visible wealth.`,
      });
    }

    if (bestHolding && (bestHolding.gain_pct ?? 0) > 0) {
      items.push({
        tone: "positive",
        title: "A winner stands out",
        detail: `${bestHolding.name || bestHolding.symbol} is up ${formatPercentSigned(bestHolding.gain_pct)}.`,
      });
    }

    if (weakestHolding && (weakestHolding.gain_pct ?? 0) < 0) {
      items.push({
        tone: "neutral",
        title: "One laggard deserves review",
        detail: `${weakestHolding.name || weakestHolding.symbol} is down ${formatPercentSigned(weakestHolding.gain_pct)}.`,
      });
    }

    if (!items.length) {
      items.push({
        tone: "positive",
        title: "The data reads cleanly",
        detail: "Use the redesigned view to keep this high-level clarity even as the portfolio grows.",
      });
    }

    return items.slice(0, 4);
  }, [bestHolding, staleHoldings, topExposure, totalCash, totalWealth, weakestHolding]);

  const topHoldings = exposureItems.slice(0, 5).map((item) => ({
    label: item.label,
    value: item.value,
    share: item.share,
    detail: `${item.detail} · ${formatMoney(item.value, "EUR")}`,
  }));

  const showData = loadState.kind === "ready" && portfolio;

  return (
    <div className="page portfolio-compare-page">
      <main className="grid">
        <section className="hero compare-hero">
          <div className="compare-hero-copy">
            <p className="eyebrow">Experience comparison</p>
            <h1>Make portfolio management friendlier without losing control</h1>
            <p className="lede">
              The current screen is strong for operations. This alternative page shows how the same
              portfolio can be explained in a more readable, more informative, and more actionable way.
            </p>
            <div className="compare-hero-actions">
              <button type="button" className="button primary" onClick={() => navigate("/")}>
                Open current portfolio
              </button>
              <button
                type="button"
                className="button compact"
                onClick={() => {
                  document.getElementById("proposed-approach")?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                See redesigned view
              </button>
            </div>
          </div>

          <div className="compare-hero-side">
            <div className="compare-page-tools">
              <span className={`pill ${authToken ? "ghost" : "danger"}`}>
                {authToken ? "Live portfolio data" : "Sign in for live data"}
              </span>
              <PageAvatarMenu />
            </div>
            <div className="compare-kpi-grid">
              <article className="compare-kpi-card">
                <span>Total wealth</span>
                <strong>{formatMoney(totalWealth, "EUR")}</strong>
              </article>
              <article className="compare-kpi-card">
                <span>Tracked positions</span>
                <strong>{holdings.length + placements.length}</strong>
              </article>
              <article className="compare-kpi-card">
                <span>Accounts</span>
                <strong>{accounts.length}</strong>
              </article>
              <article className="compare-kpi-card">
                <span>30d move</span>
                <strong>{historyChange ? formatMoney(historyChange.delta, "EUR") : "No history"}</strong>
              </article>
            </div>
          </div>
        </section>

        {!authToken && (
          <section className="card compare-state-card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Live preview unavailable</p>
                <h2>Sign in first to compare both approaches with your own portfolio</h2>
                <p className="muted helper">
                  The redesign page is ready, but it can only render real insights after the current
                  portfolio loads from your account.
                </p>
              </div>
              <div className="card-actions">
                <button type="button" className="button primary" onClick={() => navigate("/")}>
                  Go to sign in
                </button>
              </div>
            </div>
          </section>
        )}

        {authToken && loadState.kind === "loading" && (
          <section className="card compare-state-card">
            <p className="eyebrow">Loading</p>
            <h2>Building the comparison from your live portfolio</h2>
            <p className="muted helper">
              Fetching the current portfolio and the last 30 days of history to populate the friendly
              preview.
            </p>
          </section>
        )}

        {authToken && loadState.kind === "error" && (
          <section className="card compare-state-card">
            <p className="eyebrow">Load failed</p>
            <h2>Unable to render the live comparison</h2>
            <p className="status status-error">{loadState.message}</p>
            <div className="card-actions">
              <button type="button" className="button primary" onClick={() => navigate("/")}>
                Return to portfolio
              </button>
            </div>
          </section>
        )}

        {showData && (
          <>
            <section className="card compare-section">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Approach comparison</p>
                  <h2>Current workflow vs a more guided portfolio cockpit</h2>
                  <p className="muted helper">
                    Keep the current operations page for editing. Add a lighter overview page for daily
                    decision-making and monitoring.
                  </p>
                </div>
              </div>

              <div className="compare-columns">
                <article className="compare-approach compare-approach-current">
                  <span className="compare-approach-tag">Current approach</span>
                  <h3>Operations-first workspace</h3>
                  <p>
                    Strong for users who want every chart, form, and table available immediately.
                  </p>
                  <ul className="compare-list">
                    <li>
                      {holdings.length} holdings, {placements.length} placements, and {accounts.length} accounts are editable from one place.
                    </li>
                    <li>Charts, CRUD actions, imports, exports, and helpers are all reachable without navigation.</li>
                    <li>Tradeoff: important signals are mixed with setup and maintenance tasks.</li>
                    <li>High-value insights like stale prices, concentration, and cash drag require manual scanning.</li>
                  </ul>
                </article>

                <article className="compare-approach compare-approach-proposed">
                  <span className="compare-approach-tag">Proposed approach</span>
                  <h3>Insights-first dashboard</h3>
                  <p>
                    Better for the daily question: what changed, what matters, and what should I review now?
                  </p>
                  <ul className="compare-list">
                    <li>Lead with total wealth, recent trend, and a readable portfolio pulse.</li>
                    <li>Highlight the next review items before exposing full tables.</li>
                    <li>Turn accounts and allocations into short narratives instead of raw rows.</li>
                    <li>Keep the current page as the deeper workspace when the user wants to edit details.</li>
                  </ul>
                </article>
              </div>
            </section>

            <section className="card compare-section" id="proposed-approach">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Redesigned preview</p>
                  <h2>A friendlier and more informative portfolio front page</h2>
                  <p className="muted helper">
                    Same data, different hierarchy: summary first, signals next, deep detail later.
                  </p>
                </div>
              </div>

              <div className="friendly-overview">
                <article className="pulse-panel">
                  <div className="pulse-score-wrap">
                    <div className="pulse-score-ring" style={pulseStyle}>
                      <div className="pulse-score-inner">
                        <strong>{portfolioPulse.value}</strong>
                        <span>/100</span>
                      </div>
                    </div>
                    <div>
                      <p className="eyebrow">Portfolio pulse</p>
                      <h3>{portfolioPulse.label}</h3>
                      <p className="muted helper">
                        Built from diversification, price freshness, account visibility, and recent trend.
                      </p>
                    </div>
                  </div>

                  <div className="friendly-kpi-grid">
                    <article className="friendly-kpi-card">
                      <span>Total wealth</span>
                      <strong>{formatMoney(totalWealth, "EUR")}</strong>
                      <small>Tracked value + liquidity</small>
                    </article>
                    <article className="friendly-kpi-card">
                      <span>Tracked market value</span>
                      <strong>{formatMoney(trackedValue, "EUR")}</strong>
                      <small>{holdings.length + placements.length} positions</small>
                    </article>
                    <article className="friendly-kpi-card">
                      <span>Available cash</span>
                      <strong>{formatMoney(totalCash, "EUR")}</strong>
                      <small>{accounts.length} visible accounts</small>
                    </article>
                    <article className="friendly-kpi-card">
                      <span>Total performance</span>
                      <strong>{formatPercentSigned(portfolio.summary.total_gain_pct)}</strong>
                      <small>{formatMoney(portfolio.summary.total_gain_abs, "EUR")}</small>
                    </article>
                  </div>
                </article>

                <article className="focus-panel">
                  <p className="eyebrow">What deserves attention</p>
                  <h3>Daily review cues</h3>
                  <div className="focus-list">
                    {focusItems.map((item) => (
                      <article key={item.title} className={`focus-item ${item.tone}`}>
                        <strong>{item.title}</strong>
                        <p>{item.detail}</p>
                      </article>
                    ))}
                  </div>
                </article>
              </div>

              <div className="friendly-panels">
                <article className="story-card">
                  <div className="story-card-header">
                    <h3>Allocation story</h3>
                    <span className="pill ghost">
                      {topThreeShare ? `Top 3 = ${formatPercent(topThreeShare)}` : "No concentration data"}
                    </span>
                  </div>
                  <div className="story-bar-list">
                    {topHoldings.length ? (
                      topHoldings.map((item) => (
                        <div key={item.label} className="story-bar-row">
                          <div className="story-bar-copy">
                            <strong>{item.label}</strong>
                            <span>{item.detail}</span>
                          </div>
                          <div className="story-bar-track">
                            <div
                              className="story-bar-fill"
                              style={{ width: `${Math.max(item.share * 100, 4)}%` }}
                            />
                          </div>
                          <span className="story-bar-share">{formatPercent(item.share)}</span>
                        </div>
                      ))
                    ) : (
                      <p className="muted helper">No tracked exposures yet.</p>
                    )}
                  </div>
                  {topExposure && (
                    <p className="story-footnote">
                      The friendlier view makes concentration explicit instead of forcing the user to infer it.
                    </p>
                  )}
                </article>

                <article className="story-card">
                  <div className="story-card-header">
                    <h3>Account allocation</h3>
                    <span className="pill ghost">{accounts.length} accounts</span>
                  </div>
                  <div className="story-bar-list">
                    {accountAllocation.length ? (
                      accountAllocation.map((item) => (
                        <div key={item.label} className="story-bar-row">
                          <div className="story-bar-copy">
                            <strong>{item.label}</strong>
                            <span>{item.detail}</span>
                          </div>
                          <div className="story-bar-track">
                            <div
                              className="story-bar-fill secondary"
                              style={{ width: `${Math.max(item.share * 100, 4)}%` }}
                            />
                          </div>
                          <span className="story-bar-share">{formatPercent(item.share)}</span>
                        </div>
                      ))
                    ) : (
                      <p className="muted helper">No account allocations available.</p>
                    )}
                  </div>
                </article>

                <article className="story-card">
                  <div className="story-card-header">
                    <h3>Asset mix</h3>
                    <span className="pill ghost">{assetMix.length} categories</span>
                  </div>
                  <div className="story-bar-list">
                    {assetMix.length ? (
                      assetMix.map((item) => (
                        <div key={item.label} className="story-bar-row">
                          <div className="story-bar-copy">
                            <strong>{item.label}</strong>
                            <span>{item.detail}</span>
                          </div>
                          <div className="story-bar-track">
                            <div
                              className="story-bar-fill accent"
                              style={{ width: `${Math.max(item.share * 100, 4)}%` }}
                            />
                          </div>
                          <span className="story-bar-share">{formatPercent(item.share)}</span>
                        </div>
                      ))
                    ) : (
                      <p className="muted helper">No asset categories available.</p>
                    )}
                  </div>
                </article>
              </div>

              <div className="friendly-panels friendly-panels-bottom">
                <article className="story-card">
                  <div className="story-card-header">
                    <h3>Portfolio movement</h3>
                    <span className="pill ghost">
                      {historyChange
                        ? `${formatShortDate(historyChange.start)} to ${formatShortDate(historyChange.end)}`
                        : "History unavailable"}
                    </span>
                  </div>
                  {historyChange ? (
                    <div className="story-highlights">
                      <div>
                        <span>30d change</span>
                        <strong>{formatMoney(historyChange.delta, "EUR")}</strong>
                      </div>
                      <div>
                        <span>30d return</span>
                        <strong>{formatPercentSigned(historyChange.pct)}</strong>
                      </div>
                      <div>
                        <span>Best holding</span>
                        <strong>{bestHolding ? bestHolding.name || bestHolding.symbol : "—"}</strong>
                      </div>
                      <div>
                        <span>Needs review</span>
                        <strong>{weakestHolding ? weakestHolding.name || weakestHolding.symbol : "—"}</strong>
                      </div>
                    </div>
                  ) : (
                    <p className="muted helper">
                      This section can still work without history, but it becomes stronger once daily
                      snapshots are available.
                    </p>
                  )}
                </article>

                <article className="story-card account-coach-card">
                  <div className="story-card-header">
                    <h3>Account coach</h3>
                    <span className="pill ghost">Narrative account cards</span>
                  </div>
                  <div className="account-coach-grid">
                    {accountCoach.length ? (
                      accountCoach.slice(0, 4).map((account) => (
                        <article key={account.id} className="account-coach-tile">
                          <div className="account-coach-head">
                            <strong>{account.name}</strong>
                            <span>{formatMoney(account.totalValue, "EUR")}</span>
                          </div>
                          <div className="account-coach-metrics">
                            <span>{account.holdingsCount} holdings</span>
                            <span>{account.placementsCount} placements</span>
                            <span>{formatMoney(account.liquidity, "EUR")} cash</span>
                            <span>{account.performance !== null ? formatPercentSigned(account.performance) : "No baseline"}</span>
                          </div>
                          <p>{account.note}</p>
                        </article>
                      ))
                    ) : (
                      <p className="muted helper">Create an account to make this layer meaningful.</p>
                    )}
                  </div>
                </article>
              </div>
            </section>

            <section className="card compare-section">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Why this page is useful</p>
                  <h2>What changes when the interface becomes more informative</h2>
                </div>
              </div>

              <div className="comparison-table">
                {comparisonRows.map((row) => (
                  <article key={row.label} className="comparison-row">
                    <div className="comparison-label">{row.label}</div>
                    <div className="comparison-copy">
                      <strong>Current</strong>
                      <p>{row.current}</p>
                    </div>
                    <div className="comparison-copy">
                      <strong>Proposed</strong>
                      <p>{row.proposed}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default PortfolioApproachComparison;
