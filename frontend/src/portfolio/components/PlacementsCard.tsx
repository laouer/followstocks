import { useMemo } from "react";
import type { Account, Placement } from "../../api";
import { formatDate, formatMoney, formatPercentSigned } from "../formatters";

type ConvertAmountFn = (
  value: number | null | undefined,
  currency: string,
  fallbackRate?: number | null,
  preferFallback?: boolean
) => number | null;

type PlacementsCardProps = {
  placements: Placement[];
  accountsById: Map<number, Account>;
  totalCurrency: string;
  convertAmount: ConvertAmountFn;
  onAddPlacement: () => void;
  onOpenPlacementChart: (placement: Placement) => void;
  onOpenPlacementHistory: (placement: Placement) => void;
  onEditPlacement: (placement: Placement) => void;
  onDeletePlacement: (placement: Placement) => void;
};

function PlacementsCard({
  placements,
  accountsById,
  totalCurrency,
  convertAmount,
  onAddPlacement,
  onOpenPlacementChart,
  onOpenPlacementHistory,
  onEditPlacement,
  onDeletePlacement,
}: PlacementsCardProps) {
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
  }, [convertAmount, placements]);

  const renderAmount = (value: number | null | undefined, currency: string) => {
    const converted = convertAmount(value, currency);
    const isConverted =
      currency.toUpperCase() !== totalCurrency && converted !== null && converted !== undefined;
    const primary = isConverted
      ? formatMoney(converted, totalCurrency)
      : formatMoney(value, currency);
    const secondary = isConverted ? formatMoney(value, currency) : null;
    return { primary, secondary };
  };

  return (
    <section className="card placements-card">
      <div className="card-header">
        <div>
          <p className="eyebrow">Placements</p>
          <h2>Placements</h2>
        </div>
        <div className="card-actions">
          <span className="pill ghost">{placements.length} tracked</span>
          {placementsTotal !== null && (
            <span className="pill ghost">{formatMoney(placementsTotal, totalCurrency)} total</span>
          )}
          <button type="button" className="button primary compact" onClick={onAddPlacement}>
            + Add
          </button>
        </div>
      </div>
      {placements.length === 0 ? (
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
                initialValue !== null && initialValue !== undefined ? initialValue + contributions : null;
              const plRaw =
                baseValue !== null && currentValue !== null && currentValue !== undefined
                  ? currentValue - baseValue
                  : null;
              const rate = plRaw !== null && baseValue !== null && baseValue > 0 ? plRaw / baseValue : null;
              const contributedDisplay = renderAmount(baseValue, placementCurrency);
              const plDisplay = renderAmount(plRaw, placementCurrency);
              const account =
                placement.account_id !== null && placement.account_id !== undefined
                  ? accountsById.get(placement.account_id)
                  : null;
              const plClass =
                plRaw === null || plRaw === undefined ? "" : plRaw >= 0 ? "positive" : "negative";

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
                      <span className="placement-value-date">{formatDate(placement.last_snapshot_at)}</span>
                    </span>
                    <span className="placement-initial">
                      <span className="metric-label">Contributed</span>
                      <span className="placement-initial-primary">
                        {contributedDisplay.primary}
                        {contributedDisplay.secondary && <small> ({contributedDisplay.secondary})</small>}
                      </span>
                    </span>
                    <span className={`placement-pl ${plClass}`.trim()}>
                      <span className="metric-label">P/L</span>
                      <span className={`placement-pl-amount ${plClass}`.trim()}>{plDisplay.primary}</span>
                      {plDisplay.secondary && <small>{plDisplay.secondary}</small>}
                    </span>
                  </span>
                  <span className="account-actions placement-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`View chart for ${placement.name}`}
                      title="View chart"
                      onClick={() => onOpenPlacementChart(placement)}
                    >
                      📈
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Update ${placement.name}`}
                      title="Update value"
                      onClick={() => onOpenPlacementHistory(placement)}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Edit ${placement.name}`}
                      onClick={() => onEditPlacement(placement)}
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete ${placement.name}`}
                      onClick={() => onDeletePlacement(placement)}
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
  );
}

export default PlacementsCard;
