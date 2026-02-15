import axios from "axios";

export interface HoldingStats {
  id: number;
  account_id?: number | null;
  symbol: string;
  price_tracker?: "yahoo" | "boursorama";
  tracker_symbol?: string | null;
  yahoo_target_low?: number | null;
  yahoo_target_mean?: number | null;
  yahoo_target_high?: number | null;
  yahoo_target_parsed_at?: string | null;
  shares: number;
  cost_basis: number;
  acquisition_fee_value?: number | null;
  fx_rate?: number | null;
  currency: string;
  sector?: string | null;
  industry?: string | null;
  asset_type?: string | null;
  account?: Account | null;
  isin?: string | null;
  mic?: string | null;
  name?: string | null;
  href?: string | null;
  acquired_at?: string | null;
  created_at: string;
  updated_at: string;
  last_price: number | null;
  last_snapshot_at: string | null;
  market_value: number | null;
  gain_abs: number | null;
  gain_pct: number | null;
  hourly_change: number | null;
  hourly_change_pct: number | null;
}

export interface Placement {
  id: number;
  account_id?: number | null;
  name: string;
  placement_type?: string | null;
  sector?: string | null;
  industry?: string | null;
  currency: string;
  initial_value?: number | null;
  initial_recorded_at?: string | null;
  total_contributions?: number | null;
  total_withdrawals?: number | null;
  total_interests?: number | null;
  total_fees?: number | null;
  current_value?: number | null;
  last_snapshot_at?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlacementSnapshot {
  id: number;
  placement_id: number;
  entry_kind: "VALUE" | "INITIAL" | "INTEREST" | "FEE" | "CONTRIBUTION" | "WITHDRAWAL";
  value: number;
  recorded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PortfolioSummary {
  total_cost: number;
  total_value: number | null;
  total_gain_abs: number | null;
  total_gain_pct: number | null;
  hourly_change_abs: number | null;
  hourly_change_pct: number | null;
}

export interface YahooFinanceStatus {
  ok: boolean;
  message?: string | null;
  last_error_at?: string | null;
}

export interface PortfolioResponse {
  summary: PortfolioSummary;
  holdings: HoldingStats[];
  accounts?: Account[];
  placements?: Placement[];
  yfinance_status?: YahooFinanceStatus | null;
}

export interface BackupImportResult {
  accounts: number;
  holdings: number;
  transactions: number;
  cash_transactions: number;
}

export interface HoldingSellResult {
  status: string;
  realized_gain?: number | null;
  remaining_shares: number;
  account_liquidity?: number | null;
}

export interface Account {
  id: number;
  name: string;
  account_type?: string | null;
  liquidity: number;
  manual_invested?: number | null;
  created_at: string;
  updated_at: string;
}

export interface AuthUser {
  id: number;
  email: string;
  name?: string | null;
  created_at: string;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: AuthUser;
}

export type Cac40Metric =
  | "analyst_discount"
  | "pe_discount"
  | "sector_pe_discount"
  | "dividend_yield"
  | "composite";

export interface Cac40Item {
  symbol: string;
  name?: string | null;
  currency?: string | null;
  price?: number | null;
  target_mean_price?: number | null;
  trailing_pe?: number | null;
  price_to_book?: number | null;
  dividend_yield?: number | null;
  market_cap?: number | null;
  score?: number | null;
}

export interface Cac40AnalysisResponse {
  metric: Cac40Metric;
  updated_at: string;
  items: Cac40Item[];
}

export interface AnalystForecastItem {
  symbol: string;
  name?: string | null;
  currency?: string | null;
  price?: number | null;
  target_low_price?: number | null;
  target_mean_price?: number | null;
  target_high_price?: number | null;
  analyst_count?: number | null;
  recommendation_mean?: number | null;
  recommendation_key?: string | null;
  upside_pct?: number | null;
}

export interface AnalystForecastResponse {
  universe: string;
  updated_at: string;
  total_symbols: number;
  with_forecast: number;
  items: AnalystForecastItem[];
}

const AUTH_TOKEN_KEY = "followstocks_token";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || "http://localhost:8000",
  timeout: 5000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export function storeAuthToken(token: string) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

export function getStoredAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export async function registerUser(payload: { email: string; password: string; name?: string }) {
  return api.post<AuthResponse>("/auth/register", payload);
}

export async function loginUser(payload: { email: string; password: string }) {
  return api.post<AuthResponse>("/auth/login", payload);
}

export async function fetchCurrentUser() {
  return api.get<AuthUser>("/auth/me");
}

export async function fetchCac40Analysis(metric: Cac40Metric) {
  return api.get<Cac40AnalysisResponse>("/analysis/cac40", { params: { metric } });
}

export async function fetchBsf120Analysis(includeMissing = false) {
  return api.get<AnalystForecastResponse>("/analysis/bsf120", {
    params: { include_missing: includeMissing },
  });
}

export async function fetchPortfolio() {
  return api.get<PortfolioResponse>("/portfolio");
}

export async function fetchAccounts() {
  return api.get<Account[]>("/accounts");
}

export async function createAccount(payload: {
  name: string;
  account_type?: string;
  liquidity?: number;
  manual_invested?: number;
  created_at?: string;
}) {
  return api.post<Account>("/accounts", payload);
}

export async function updateAccount(
  accountId: number,
  payload: {
    name?: string;
    account_type?: string;
    liquidity?: number;
    manual_invested?: number;
    created_at?: string;
  }
) {
  return api.put<Account>(`/accounts/${accountId}`, payload);
}

export async function moveAccountCash(
  accountId: number,
  payload: { amount: number; direction: "ADD" | "WITHDRAW"; reason: string }
) {
  return api.post<Account>(`/accounts/${accountId}/cash`, payload);
}

export async function deleteAccount(accountId: number) {
  return api.delete(`/accounts/${accountId}`);
}

export async function exportBackupJson() {
  return api.get("/backup/export");
}

export async function importBackupJson(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return api.post<BackupImportResult>("/backup/import", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
}

export async function createHolding(payload: {
  account_id?: number;
  symbol: string;
  price_tracker?: "yahoo" | "boursorama";
  tracker_symbol?: string;
  shares: number;
  cost_basis: number;
  acquisition_fee_value?: number;
  currency?: string;
  fx_rate?: number;
  sector?: string;
  industry?: string;
  asset_type?: string;
  isin?: string;
  mic?: string;
  name?: string;
  href?: string;
  acquired_at?: string;
}) {
  return api.post("/holdings", payload);
}

export async function createPlacement(payload: {
  account_id?: number;
  name: string;
  placement_type?: string;
  sector?: string;
  industry?: string;
  currency?: string;
  notes?: string;
  initial_value?: number;
  recorded_at?: string;
}) {
  return api.post<Placement>("/placements", payload);
}

export async function updatePlacement(
  placementId: number,
  payload: {
    account_id?: number | null;
    name?: string;
    placement_type?: string;
    sector?: string;
    industry?: string;
    currency?: string;
    notes?: string;
  }
) {
  return api.put<Placement>(`/placements/${placementId}`, payload);
}

export async function deletePlacement(placementId: number) {
  return api.delete(`/placements/${placementId}`);
}

export async function fetchPlacementSnapshots(placementId: number, limit = 50) {
  return api.get<PlacementSnapshot[]>(`/placements/${placementId}/snapshots`, {
    params: { limit },
  });
}

export async function addPlacementSnapshot(
  placementId: number,
  payload: {
    value: number;
    recorded_at?: string;
    entry_kind?: "VALUE" | "INITIAL" | "INTEREST" | "FEE" | "CONTRIBUTION" | "WITHDRAWAL";
  }
) {
  return api.post<Placement>(`/placements/${placementId}/snapshots`, payload);
}

export async function updatePlacementSnapshot(
  placementId: number,
  snapshotId: number,
  payload: {
    value?: number;
    recorded_at?: string;
    entry_kind?: "VALUE" | "INITIAL" | "INTEREST" | "FEE" | "CONTRIBUTION" | "WITHDRAWAL";
  }
) {
  return api.put<Placement>(`/placements/${placementId}/snapshots/${snapshotId}`, payload);
}

export async function deletePlacementSnapshot(placementId: number, snapshotId: number) {
  return api.delete(`/placements/${placementId}/snapshots/${snapshotId}`);
}

export interface EuronextQuote {
  isin: string;
  mic: string;
  price: number | null;
  timestamp: string | null;
  source?: string;
}

export async function fetchEuronextQuote(isin: string, mic: string) {
  return api.get<EuronextQuote>("/quotes/euronext", { params: { isin, mic } });
}

export async function addPriceSnapshot(payload: { holding_id: number; price: number; recorded_at?: string }) {
  return api.post("/prices", payload);
}

export async function updateHolding(
  holdingId: number,
  payload: {
    account_id?: number;
    shares?: number;
    cost_basis?: number;
    acquisition_fee_value?: number;
    currency?: string;
    sector?: string;
    industry?: string;
    asset_type?: string;
    price_tracker?: "yahoo" | "boursorama";
    tracker_symbol?: string;
    symbol?: string;
    isin?: string;
    mic?: string;
    name?: string;
    href?: string;
    acquired_at?: string;
  },
) {
  return api.put(`/holdings/${holdingId}`, payload);
}

export async function deleteHolding(holdingId: number) {
  return api.delete(`/holdings/${holdingId}`);
}

export async function refundHolding(holdingId: number, payload?: { fx_rate?: number }) {
  return api.post(`/holdings/${holdingId}/refund`, payload || {});
}

export async function sellHolding(
  holdingId: number,
  payload: {
    shares: number;
    price: number;
    fee_value?: number;
    executed_at?: string;
    fx_rate?: number;
  },
) {
  return api.post<HoldingSellResult>(`/holdings/${holdingId}/sell`, payload);
}

export async function searchInstruments(query: string) {
  return api.get("/search", { params: { q: query } });
}

export async function fetchFxRate(base: string, quote: string) {
  return api.get("/fx", { params: { base, quote } });
}

export async function runYahooTargetsAgent() {
  return api.post("/agents/yahoo-targets");
}

export async function refreshHoldingsPrices() {
  return api.post("/holdings/refresh");
}

export default api;
