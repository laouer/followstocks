import { useMemo, useState, type RefObject } from "react";
import type { Account } from "../../api";
import { formatMoney, formatMoneySigned, formatPercent, formatPercentSigned } from "../formatters";
import type { AccountRow, AccountSortField, AccountsSummary } from "../types";

type AccountsCardProps = {
  accounts: Account[];
  totalCurrency: string;
  totalAllocationValue: number;
  accountHoldingsCount: Map<number, number>;
  accountPlacementsCount: Map<number, number>;
  accountHoldingsValue: Map<number, number>;
  accountPlacementsValue: Map<number, number>;
  addButtonRef: RefObject<HTMLButtonElement>;
  onAddAccount: () => void;
  onAddCash: (account: Account) => void;
  onWithdrawCash: (account: Account) => void;
  onEditAccount: (account: Account) => void;
  onDeleteAccount: (account: Account) => void;
};

const formatHoldingsBreakdown = (holdingsCount: number, placementsCount: number) => {
  const holdingsLabel = holdingsCount === 1 ? "holding" : "holdings";
  const placementsLabel = placementsCount === 1 ? "placement" : "placements";

  if (holdingsCount > 0 && placementsCount > 0) {
    return `${holdingsCount} ${holdingsLabel} · ${placementsCount} ${placementsLabel}`;
  }
  if (holdingsCount > 0) {
    return `${holdingsCount} ${holdingsLabel}`;
  }
  if (placementsCount > 0) {
    return `${placementsCount} ${placementsLabel}`;
  }
  return `0 ${holdingsLabel}`;
};

function AccountsCard({
  accounts,
  totalCurrency,
  totalAllocationValue,
  accountHoldingsCount,
  accountPlacementsCount,
  accountHoldingsValue,
  accountPlacementsValue,
  addButtonRef,
  onAddAccount,
  onAddCash,
  onWithdrawCash,
  onEditAccount,
  onDeleteAccount,
}: AccountsCardProps) {
  const [showAccounts, setShowAccounts] = useState(false);
  const [sortField, setSortField] = useState<AccountSortField>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const accountRows = useMemo<AccountRow[]>(
    () =>
      accounts.map((account) => {
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
      }),
    [
      accounts,
      accountHoldingsCount,
      accountHoldingsValue,
      accountPlacementsCount,
      accountPlacementsValue,
      totalAllocationValue,
    ]
  );

  const sortedAccounts = useMemo(() => {
    const list = [...accountRows];
    const getValue = (row: AccountRow) => {
      switch (sortField) {
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
  }, [accountRows, sortDir, sortField]);

  const accountsSummary = useMemo<AccountsSummary | null>(() => {
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

  const handleSort = (field: AccountSortField) => {
    setSortField(field);
    setSortDir((prev) => (field === sortField ? (prev === "asc" ? "desc" : "asc") : "desc"));
  };

  const renderSortIcon = (field: AccountSortField) => {
    const isActive = field === sortField;
    const arrow = isActive ? (sortDir === "asc" ? "▲" : "▼") : "↕";
    return <span className="muted">{arrow}</span>;
  };

  return (
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
            ref={addButtonRef}
            onClick={onAddAccount}
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
              <button type="button" className="table-sort" title="Account name." onClick={() => handleSort("name")}>
                Name {renderSortIcon("name")}
              </button>
              <button type="button" className="table-sort" title="Account type." onClick={() => handleSort("type")}>
                Type {renderSortIcon("type")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Capital contributed."
                onClick={() => handleSort("manual_invested")}
              >
                Capital {renderSortIcon("manual_invested")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Value of holdings and placements in this account."
                onClick={() => handleSort("holdings")}
              >
                Holdings allocation {renderSortIcon("holdings")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Current cash available."
                onClick={() => handleSort("liquidity")}
              >
                Cash available {renderSortIcon("liquidity")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Holdings value plus liquidity."
                onClick={() => handleSort("total")}
              >
                Total {renderSortIcon("total")}
              </button>
              <button
                type="button"
                className="table-sort"
                title="Total account value versus capital contributed."
                onClick={() => handleSort("performance")}
              >
                Performance {renderSortIcon("performance")}
              </button>
            </div>
            <div className="table-body">
              {sortedAccounts.map((row) => {
                const {
                  account,
                  allocationPercent,
                  totalValue,
                  holdingsCount,
                  placementsCount,
                  manualInvested,
                  performance,
                  performanceRatio,
                } = row;
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
                        onClick={() => onAddCash(account)}
                      >
                        ➕
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Withdraw cash from ${account.name}`}
                        title="Withdraw cash"
                        onClick={() => onWithdrawCash(account)}
                      >
                        ➖
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Edit ${account.name}`}
                        onClick={() => onEditAccount(account)}
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Delete ${account.name}`}
                        onClick={() => onDeleteAccount(account)}
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
                            {allocationPercent !== null ? formatPercent(allocationPercent) : "—"}
                          </strong>
                        </div>
                        <div className="account-insight-line">
                          <span>Holdings</span>
                          <strong className="account-insight-value">
                            {formatHoldingsBreakdown(holdingsCount, placementsCount)}
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
                        {formatHoldingsBreakdown(
                          accountsSummary.holdingsCount,
                          accountsSummary.placementsCount
                        )}
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
                      <strong>{formatMoneySigned(accountsSummary.performance, totalCurrency)}</strong>
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
  );
}

export default AccountsCard;
