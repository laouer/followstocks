import { useCallback, useEffect, useState } from "react";
import type { AuthUser } from "../api";
import type { AuthMode, Status } from "../portfolio/types";
import { readAuthFormValues } from "../portfolio/formatters";
import {
  loginUser,
  registerUser,
  fetchCurrentUser,
  storeAuthToken,
  clearAuthToken,
  getStoredAuthToken,
} from "../api";

export function useAuth(onAuthChange?: (token: string | null) => void) {
  const [authToken, setAuthToken] = useState<string | null>(() => getStoredAuthToken());
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authStatus, setAuthStatus] = useState<Status>({ kind: "idle" });

  const isAuthed = Boolean(authToken);
  const userDisplayEmail = currentUser?.email || "Signed in";

  // Load user profile when token changes
  useEffect(() => {
    if (!authToken) {
      setCurrentUser(null);
      return;
    }
    let cancelled = false;
    const loadUser = async () => {
      try {
        const res = await fetchCurrentUser();
        if (!cancelled) setCurrentUser(res.data);
      } catch {
        if (!cancelled) setCurrentUser(null);
      }
    };
    loadUser();
    return () => { cancelled = true; };
  }, [authToken]);

  const handleAuthSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = readAuthFormValues(e.currentTarget);
      if (!form.email || !form.password) {
        setAuthStatus({ kind: "error", message: "Email and password are required." });
        return;
      }
      setAuthStatus({
        kind: "loading",
        message: authMode === "login" ? "Signing in..." : "Creating account...",
      });
      try {
        const res =
          authMode === "login"
            ? await loginUser({ email: form.email, password: form.password })
            : await registerUser({
                email: form.email,
                password: form.password,
                name: form.name || undefined,
              });
        const token = res.data.access_token;
        storeAuthToken(token);
        setAuthToken(token);
        setCurrentUser(res.data.user);
        setAuthStatus({
          kind: "success",
          message: authMode === "login" ? "Signed in." : "Account created.",
        });
        onAuthChange?.(token);
      } catch (err) {
        const message =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail || "Authentication failed.";
        setAuthStatus({ kind: "error", message });
      }
    },
    [authMode, onAuthChange],
  );

  const handleLogout = useCallback(() => {
    clearAuthToken();
    setAuthToken(null);
    setCurrentUser(null);
    setAuthStatus({ kind: "idle" });
    onAuthChange?.(null);
  }, [onAuthChange]);

  const handleSessionExpired = useCallback(() => {
    clearAuthToken();
    setAuthToken(null);
    setCurrentUser(null);
    setAuthStatus({ kind: "error", message: "Session expired. Please sign in again." });
  }, []);

  const toggleAuthMode = useCallback(() => {
    setAuthMode((prev) => (prev === "login" ? "register" : "login"));
    setAuthStatus({ kind: "idle" });
  }, []);

  return {
    authToken,
    currentUser,
    authMode,
    authStatus,
    isAuthed,
    userDisplayEmail,
    handleAuthSubmit,
    handleLogout,
    handleSessionExpired,
    toggleAuthMode,
    setAuthStatus,
  };
}
