import type { RefObject } from "react";
import type { Account } from "../api";

export type Status = {
  kind: "idle" | "loading" | "success" | "error";
  message?: string;
};

export type AuthFormState = {
  name: string;
  email: string;
  password: string;
};

export type SearchItem = {
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

export type SortField =
  | "instrument"
  | "account"
  | "acquired_at"
  | "shares"
  | "cost"
  | "last_price"
  | "value"
  | "pl";

export type AccountSortField =
  | "name"
  | "type"
  | "manual_invested"
  | "holdings"
  | "liquidity"
  | "total"
  | "performance";

export type AccountRow = {
  account: Account;
  holdingsValue: number;
  placementsValue: number;
  allocationValue: number;
  allocationPercent: number | null;
  totalValue: number;
  holdingsCount: number;
  placementsCount: number;
  manualInvested: number;
  performance: number;
  performanceRatio: number | null;
};

export type AccountsSummary = {
  manualInvested: number;
  allocationValue: number;
  liquidity: number;
  totalValue: number;
  performance: number;
  performanceRatio: number | null;
  holdingsCount: number;
  placementsCount: number;
  allocationPercent: number | null;
};

export type AuthMode = "login" | "register";
export type ChartGroupBy = "holding" | "account" | "asset_type" | "sector" | "industry";

export type HelpTargetRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type TourStep = {
  id: string;
  title: string;
  body: string;
  targetRef: RefObject<HTMLElement>;
  requiresAccountModal?: boolean;
  requiresAddHoldingModal?: boolean;
};
