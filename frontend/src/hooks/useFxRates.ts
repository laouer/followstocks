import { useCallback, useEffect, useState } from "react";
import { fetchFxRate, type HoldingStats, type Placement } from "../api";

const DISPLAY_CURRENCY = "EUR";

/**
 * Manages FX rate cache and currency conversion helpers.
 */
export function useFxRates(
  holdings: HoldingStats[],
  placements: Placement[],
) {
  const [fxRates, setFxRates] = useState<Record<string, number>>({});

  // Auto-fetch missing FX rates when holdings/placements change
  useEffect(() => {
    const needed = new Set<string>();
    const check = (cur: string) => {
      const c = (cur || "").toUpperCase();
      if (c && c !== DISPLAY_CURRENCY) {
        const key = `${c}->${DISPLAY_CURRENCY}`;
        if (!fxRates[key]) needed.add(c);
      }
    };
    holdings.forEach((h) => check(h.currency));
    placements.forEach((p) => check(p.currency));
    if (needed.size === 0) return;

    let cancelled = false;
    const loadFx = async () => {
      for (const cur of needed) {
        try {
          const res = await fetchFxRate(cur, DISPLAY_CURRENCY);
          if (!cancelled && res.data?.rate) {
            setFxRates((prev) => ({ ...prev, [`${cur}->${DISPLAY_CURRENCY}`]: res.data.rate }));
          }
        } catch {
          // will retry on next render
        }
      }
    };
    loadFx();
    return () => { cancelled = true; };
  }, [holdings, placements, fxRates]);

  /** Convert a value from `currency` to DISPLAY_CURRENCY. */
  const convertAmount = useCallback(
    (
      value: number | null | undefined,
      currency: string,
      fallbackRate?: number | null,
      preferFallback = false,
    ): number | null => {
      if (value === null || value === undefined) return null;
      const curr = (currency || "").toUpperCase();
      if (curr === DISPLAY_CURRENCY) return value;
      const key = `${curr}->${DISPLAY_CURRENCY}`;
      const rate = preferFallback
        ? (fallbackRate ?? fxRates[key])
        : (fxRates[key] ?? fallbackRate);
      return rate ? value * rate : value;
    },
    [fxRates],
  );

  /** Fetch and cache a specific FX rate, returning the rate. */
  const ensureFxRate = useCallback(
    async (currency: string): Promise<number | undefined> => {
      const curr = (currency || "").toUpperCase();
      if (curr === DISPLAY_CURRENCY) return 1;
      const key = `${curr}->${DISPLAY_CURRENCY}`;
      if (fxRates[key]) return fxRates[key];
      try {
        const res = await fetchFxRate(curr, DISPLAY_CURRENCY);
        const rate = res.data?.rate;
        if (rate) {
          setFxRates((prev) => ({ ...prev, [key]: rate }));
          return rate;
        }
      } catch {
        // ignore
      }
      return undefined;
    },
    [fxRates],
  );

  return {
    fxRates,
    setFxRates,
    convertAmount,
    ensureFxRate,
    DISPLAY_CURRENCY,
  };
}
