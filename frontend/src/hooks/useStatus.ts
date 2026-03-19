import { useCallback, useEffect, useState } from "react";
import type { Status } from "../portfolio/types";

const AUTO_DISMISS_MS = 5000;

export function useStatus() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    if (status.kind === "success" || status.kind === "error") {
      const timer = window.setTimeout(() => setStatus({ kind: "idle" }), AUTO_DISMISS_MS);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [status.kind, status.message]);

  const clearStatus = useCallback(() => setStatus({ kind: "idle" }), []);

  return { status, setStatus, clearStatus };
}
