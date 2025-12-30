import axios from "axios";

export interface HoldingStats {
  id: number;
  symbol: string;
  shares: number;
  cost_basis: number;
  currency: string;
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

export interface PortfolioSummary {
  total_cost: number;
  total_value: number | null;
  total_gain_abs: number | null;
  total_gain_pct: number | null;
  hourly_change_abs: number | null;
  hourly_change_pct: number | null;
}

export interface PortfolioResponse {
  summary: PortfolioSummary;
  holdings: HoldingStats[];
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

export async function fetchPortfolio() {
  return api.get<PortfolioResponse>("/portfolio");
}

export async function createHolding(payload: {
  symbol: string;
  shares: number;
  cost_basis: number;
  currency?: string;
  isin?: string;
  mic?: string;
  name?: string;
  href?: string;
  acquired_at?: string;
}) {
  return api.post("/holdings", payload);
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

export async function fetchPrices(holdingId: number, limit = 12) {
  return api.get(`/prices/${holdingId}`, { params: { limit } });
}

export async function updateHolding(
  holdingId: number,
  payload: {
    shares?: number;
    cost_basis?: number;
    currency?: string;
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

export async function searchInstruments(query: string) {
  return api.get("/search", { params: { q: query } });
}

export async function fetchFxRate(base: string, quote: string) {
  return api.get("/fx", { params: { base, quote } });
}

export default api;
