import { useMemo, useState } from "react";
import type { Account, HoldingStats } from "../../api";
import { formatMoney, formatMoneySigned, formatPercentSigned } from "../formatters";
import type { SortField } from "../types";

type ConvertAmountFn = (
  value: number | null | undefined,
  currency: string,
  fallbackRate?: number | null,
  preferFallback?: boolean
) => number | null;

type HoldingsCardProps = {
  accounts: Account[];
  holdings: HoldingStats[];
  holdingAccountFilter: string;
  totalCurrency: string;
  convertAmount: ConvertAmountFn;
  onHoldingAccountFilterChange: (value: string) => void;
  onAddHolding: () => void;
  onOpenHoldingActions: (holding: HoldingStats) => void;
};

const getHoldingFeeValue = (holding: HoldingStats) => holding.acquisition_fee_value ?? 0;

const getHoldingTotalCost = (holding: HoldingStats) =>
  holding.shares * holding.cost_basis + getHoldingFeeValue(holding);

const resolveMarketValueNative = (holding: HoldingStats) =>
  holding.last_price !== null && holding.last_price !== undefined
    ? holding.last_price * holding.shares
    : holding.market_value;

function HoldingsCard({
  accounts,
  holdings,
  holdingAccountFilter,
  totalCurrency,
  convertAmount,
  onHoldingAccountFilterChange,
  onAddHolding,
  onOpenHoldingActions,
}: HoldingsCardProps) {
  const [sortField, setSortField] = useState<SortField>("instrument");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const filteredHoldings = useMemo(() => {
    if (holdingAccountFilter === "all") return holdings;
    const accountId = Number(holdingAccountFilter);
    if (!Number.isFinite(accountId)) return holdings;
    return holdings.filter((holding) => {
      const holdingAccountId = holding.account_id ?? holding.account?.id ?? null;
      return holdingAccountId === accountId;
    });
  }, [holdings, holdingAccountFilter]);

  const displayedHoldingsTotal = useMemo(() => {
    if (!filteredHoldings.length) return null;
    return filteredHoldings.reduce((sum, holding) => {
      const converted = convertAmount(
        resolveMarketValueNative(holding),
        holding.currency,
        holding.fx_rate,
        true
      );
      return sum + (converted ?? 0);
    }, 0);
  }, [convertAmount, filteredHoldings]);

  const holdingCountLabel =
    holdingAccountFilter === "all"
      ? `${holdings.length} tracked`
      : `${filteredHoldings.length} of ${holdings.length} tracked`;

  const sortedHoldings = useMemo(() => {
    const list = [...filteredHoldings];
    const getValue = (holding: HoldingStats) => {
      switch (sortField) {
        case "instrument":
          return (holding.name || holding.symbol || holding.isin || "").toString().toLowerCase();
        case "account":
          return (holding.account?.name || "").toString().toLowerCase();
        case "acquired_at":
          return holding.acquired_at ? new Date(holding.acquired_at).getTime() : null;
        case "shares":
          return holding.shares;
        case "cost":
          return convertAmount(getHoldingTotalCost(holding), holding.currency);
        case "last_price":
          return convertAmount(holding.last_price, holding.currency);
        case "value":
          return convertAmount(resolveMarketValueNative(holding), holding.currency);
        case "pl": {
          const convMv = convertAmount(resolveMarketValueNative(holding), holding.currency);
          const convCost = convertAmount(getHoldingTotalCost(holding), holding.currency);
          return convMv !== null && convCost !== null
            ? convMv - convCost
            : convertAmount(holding.gain_abs, holding.currency);
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
  }, [convertAmount, filteredHoldings, sortDir, sortField]);

  const handleSort = (field: SortField) => {
    setSortField(field);
    setSortDir((prev) => (field === sortField ? (prev === "asc" ? "desc" : "asc") : "desc"));
  };

  const renderSortIcon = (field: SortField) => {
    const isActive = field === sortField;
    const arrow = isActive ? (sortDir === "asc" ? "▲" : "▼") : "↕";
    return <span className="muted">{arrow}</span>;
  };

  const renderAmount = (value: number | null | undefined, currency: string, fallbackRate?: number | null) => {
    const converted = convertAmount(value, currency, fallbackRate);
    const isConverted =
      currency.toUpperCase() !== totalCurrency && converted !== null && converted !== undefined;
    const primary = isConverted
      ? formatMoney(converted, totalCurrency)
      : formatMoney(value, currency);
    const secondary = isConverted ? formatMoney(value, currency) : null;
    return { primary, secondary };
  };

  return (
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
              onChange={(event) => onHoldingAccountFilterChange(event.target.value)}
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
            <span className="pill ghost">{formatMoney(displayedHoldingsTotal, totalCurrency)} total</span>
          )}
          <button type="button" className="button primary compact" onClick={onAddHolding}>
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
            {sortedHoldings.map((holding) => {
              const totalCost = getHoldingTotalCost(holding);
              const feeValue = getHoldingFeeValue(holding);
              const marketValueNative = resolveMarketValueNative(holding);
              const marketValueEur = convertAmount(marketValueNative, holding.currency);
              const totalCostEur = convertAmount(totalCost, holding.currency, holding.fx_rate, true);
              const gainAbsNative =
                marketValueNative !== null && marketValueNative !== undefined
                  ? marketValueNative - totalCost
                  : holding.gain_abs;
              const gainAbsEur =
                marketValueEur !== null && totalCostEur !== null
                  ? marketValueEur - totalCostEur
                  : convertAmount(gainAbsNative, holding.currency);
              const gainPct =
                gainAbsEur !== null && totalCostEur !== null && totalCostEur > 0
                  ? gainAbsEur / totalCostEur
                  : marketValueNative !== null && marketValueNative !== undefined && totalCost > 0
                    ? gainAbsNative / totalCost
                    : holding.gain_pct;
              const lastPriceDisplay = renderAmount(holding.last_price, holding.currency);
              const valueDisplay = renderAmount(marketValueNative, holding.currency);
              const gainDisplayPrimary =
                gainAbsEur !== null
                  ? formatMoney(gainAbsEur, totalCurrency)
                  : formatMoney(gainAbsNative, holding.currency);
              const gainDisplaySecondary =
                gainAbsEur !== null &&
                holding.currency?.toUpperCase() !== totalCurrency &&
                gainAbsNative !== null &&
                gainAbsNative !== undefined
                  ? formatMoney(gainAbsNative, holding.currency)
                  : null;
              const isUsdHolding = (holding.currency || "").toUpperCase() === "USD";
              const isForeignCurrency = holding.currency?.toUpperCase() !== totalCurrency;
              const fxRate = isForeignCurrency ? holding.fx_rate : null;
              const costEur = fxRate && totalCost ? totalCost * fxRate : null;
              const costPerShareEur = fxRate && holding.cost_basis ? holding.cost_basis * fxRate : null;
              const feeEur = fxRate && feeValue ? feeValue * fxRate : null;
              const costPerSharePrimary =
                isForeignCurrency && costPerShareEur !== null
                  ? formatMoney(costPerShareEur, totalCurrency)
                  : formatMoney(holding.cost_basis, holding.currency);
              const costPerShareSecondary =
                isForeignCurrency && costPerShareEur !== null
                  ? formatMoney(holding.cost_basis, holding.currency)
                  : null;
              const showCostPerShareSecondary = costPerShareSecondary !== null && !isUsdHolding;
              const totalCostPrimary =
                isForeignCurrency && costEur !== null
                  ? formatMoney(costEur, totalCurrency)
                  : formatMoney(totalCost, holding.currency);
              const totalCostSecondary =
                isForeignCurrency && costEur !== null
                  ? formatMoney(totalCost, holding.currency)
                  : null;
              const feePrimary =
                isForeignCurrency && feeEur !== null
                  ? formatMoney(feeEur, totalCurrency)
                  : formatMoney(feeValue, holding.currency);
              const feeSecondary =
                isForeignCurrency && feeEur !== null
                  ? formatMoney(feeValue, holding.currency)
                  : null;
              const instrumentName = holding.name || holding.symbol || holding.isin || "Unknown";
              const gainClassValue = gainAbsEur !== null ? gainAbsEur : gainAbsNative;
              const gainSignSource = gainPct !== null && gainPct !== undefined ? gainPct : gainClassValue;
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
              const evolutionMetrics = [
                { label: "YEAR", value: holding.evolution_1y_pct },
                { label: "MONTH", value: holding.evolution_1m_pct },
                { label: "5D", value: holding.evolution_5d_pct },
                { label: "1D", value: holding.evolution_1d_pct },
              ];

              return (
                <div className="table-row position-row" key={holding.id}>
                  <span className="instrument-cell" data-label="Instrument">
                    <div className="position-card-header">
                      <div className="position-title-block">
                        {holding.href ? (
                          <a
                            href={holding.href}
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
                          gainPct !== null || analystProjectionPct !== null ? "" : "empty"
                        }`.trim()}
                      >
                        {gainPct !== null && gainPct !== undefined && analystProjectionPct !== null && analystProjectionPct !== undefined ? (
                          <span className="position-badges-stack">
                            <span className={`position-pl-badge ${gainClass}`.trim()}>
                              {formatPercentSigned(gainPct)}
                            </span>
                            <span className="position-analyst-badge">
                              <span className="position-analyst-badge-arrow">{analystProjectionArrow}</span>
                              {formatPercentSigned(analystProjectionPct)}
                            </span>
                          </span>
                        ) : gainPct !== null && gainPct !== undefined ? (
                          <span className={`position-pl-badge ${gainClass}`.trim()}>
                            {formatPercentSigned(gainPct)}
                          </span>
                        ) : analystProjectionPct !== null && analystProjectionPct !== undefined ? (
                          <span className="position-analyst-badge">
                            <span className="position-analyst-badge-arrow">{analystProjectionArrow}</span>
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
                          onClick={() => onOpenHoldingActions(holding)}
                        >
                          ⋯
                        </button>
                      </span>
                    </div>
                  </span>
                  <span className="position-metrics">
                    <span className="position-details">
                      <span className="metric-label">COST</span>
                      <span className="position-cost-primary">
                        {totalCostPrimary}
                        {totalCostSecondary && !isUsdHolding && <small> ({totalCostSecondary})</small>}
                      </span>
                      <span className="position-cost-share">
                        {holding.shares.toFixed(2)} @ {costPerSharePrimary}
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
                      <span className="metric-label">VALUE</span>
                      <span className="position-value-primary">
                        {valueDisplay.primary}
                        {valueDisplay.secondary && !isUsdHolding && <small> ({valueDisplay.secondary})</small>}
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
                  <span className="position-evolution" data-label="Evolution">
                    {evolutionMetrics.map((metric) => {
                      const trendClass =
                        metric.value === null || metric.value === undefined
                          ? "neutral"
                          : metric.value >= 0
                            ? "positive"
                            : "negative";
                      return (
                        <span
                          className={`position-evolution-item ${trendClass}`.trim()}
                          key={`${holding.id}-${metric.label}`}
                        >
                          <span className="position-evolution-label">{metric.label}</span>
                          <span className="position-evolution-value">
                            {formatPercentSigned(metric.value)}
                          </span>
                        </span>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export default HoldingsCard;
