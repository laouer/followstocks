import type { ChartGroupBy } from "./portfolio/types";

export const DISPLAY_CURRENCY = "EUR";
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const BAR_VALUE_LABEL_ROTATION = -45;

export const ALLOCATION_COLORS = [
  "#22c55e", "#0ea5e9", "#a855f7", "#f97316", "#fcd34d", "#38bdf8",
  "#34d399", "#ef4444", "#10b981", "#3b82f6", "#ec4899", "#6366f1",
  "#14b8a6", "#f59e0b", "#8b5cf6", "#22d3ee", "#84cc16", "#fb7185",
  "#c084fc", "#f43f5e", "#fda4af", "#fb7185", "#f87171", "#fbbf24",
  "#f472b6", "#eab308", "#a3e635", "#4ade80", "#34d399", "#2dd4bf",
  "#5eead4", "#38bdf8", "#60a5fa", "#818cf8", "#a78bfa", "#c4b5fd",
  "#f0abfc", "#fda4af", "#fb923c", "#fdba74", "#bef264", "#86efac",
  "#93c5fd", "#c7d2fe", "#f9a8d4", "#fde047", "#7dd3fc", "#67e8f9",
  "#5eead4", "#facc15",
];

export const LOSS_COLOR = "#fb7185";

export const CHART_GROUP_OPTIONS: Array<{ value: ChartGroupBy; label: string }> = [
  { value: "holding", label: "Holding" },
  { value: "account", label: "Account" },
  { value: "asset_type", label: "Type" },
  { value: "sector", label: "Sector" },
  { value: "industry", label: "Industry" },
];

export const CASH_REASON_OPTIONS = {
  add: [
    "Contribution", "Dividend", "Interest", "Refund",
    "Transfer in", "Correction", "Other",
  ],
  withdraw: [
    "Withdrawal", "Fee", "Tax", "Transfer out",
    "Correction", "Other",
  ],
} as const;

export const CASH_REASON_DEFAULT = {
  add: "Contribution",
  withdraw: "Withdrawal",
} as const;

export const PLACEMENT_TYPE_OPTIONS = [
  "Assurance vie", "Livret A", "LDD", "Compte a terme",
];

export const HISTORY_DAY_OPTIONS = [30, 90, 180, 365];
export const HISTORY_SERIES_GLOBAL = "global";
export const HISTORY_SERIES_PREFIX = "stock:";

export const YFINANCE_WARNING_FALLBACK =
  "Last prices are not updated because Yahoo Finance is unreachable (connection lost or blocked).";
