export type ThemeMode = "dark" | "light";

const THEME_STORAGE_KEY = "followstocks_theme_mode";

const normalizeTheme = (value?: string | null): ThemeMode =>
  value === "light" ? "light" : "dark";

export const getStoredTheme = (): ThemeMode => {
  if (typeof window === "undefined") return "dark";
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
};

export const applyTheme = (theme: ThemeMode) => {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", normalizeTheme(theme));
};

export const setThemePreference = (theme: ThemeMode): ThemeMode => {
  const normalized = normalizeTheme(theme);
  applyTheme(normalized);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch {
      // ignore storage write issues (private mode, disabled storage)
    }
  }
  return normalized;
};

