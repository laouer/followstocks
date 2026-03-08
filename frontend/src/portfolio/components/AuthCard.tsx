import { useEffect, useState, type FormEventHandler } from "react";
import { type AuthMode, type AuthFormState, type Status } from "../types";

type AuthCardProps = {
  authMode: AuthMode;
  authStatus: Status;
  onToggleMode: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
};

function PasswordToggleIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.1A10.7 10.7 0 0 1 12 4.9c5.4 0 9.1 4.4 10 6.1a.9.9 0 0 1 0 .9 17.2 17.2 0 0 1-4.1 4.8M6.7 6.7A17.3 17.3 0 0 0 2 11a.9.9 0 0 0 0 .9c.9 1.7 4.6 6.1 10 6.1a10.8 10.8 0 0 0 5.3-1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2 12c.9-1.7 4.6-6.1 10-6.1s9.1 4.4 10 6.1c.1.3.1.6 0 .9-.9 1.7-4.6 6.1-10 6.1S2.9 14.6 2 12.9a.9.9 0 0 1 0-.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="12"
        cy="12.4"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function AuthCard({ authMode, authStatus, onToggleMode, onSubmit }: AuthCardProps) {
  const [authForm, setAuthForm] = useState<AuthFormState>({ name: "", email: "", password: "" });
  const [showAuthPassword, setShowAuthPassword] = useState(false);

  useEffect(() => {
    setShowAuthPassword(false);
  }, [authMode]);

  return (
    <section className="card auth-card">
      <div className="card-header">
        <div>
          <h2>{authMode === "login" ? "Sign in to your portfolio" : "Create your account"}</h2>
          <p className="muted helper">
            {authMode === "login"
              ? "Use your email and password to access holdings."
              : "Choose an email and password to start tracking."}
          </p>
        </div>
        <div className="card-actions">
          <button type="button" className="button compact" onClick={onToggleMode}>
            {authMode === "login" ? "Need access?" : "Back to sign in"}
          </button>
        </div>
      </div>
      {authMode === "login" ? (
        <form
          key="login"
          id="auth-login-form"
          name="login"
          className="form"
          onSubmit={onSubmit}
          autoComplete="on"
          method="post"
          action="/auth/login"
          data-auth-mode="login"
          data-np-autofill-form-type="login"
        >
          <label htmlFor="login-email">
            Email
            <input
              id="login-email"
              name="email"
              type="email"
              value={authForm.email}
              onChange={(event) =>
                setAuthForm((prev) => ({ ...prev, email: event.target.value }))
              }
              placeholder="you@example.com"
              autoComplete="username"
              inputMode="email"
              data-np-autofill-field-type="username"
              required
            />
          </label>
          <label htmlFor="login-password">
            Password
            <span className="password-input-wrap">
              <input
                id="login-password"
                name="password"
                type={showAuthPassword ? "text" : "password"}
                value={authForm.password}
                onChange={(event) =>
                  setAuthForm((prev) => ({ ...prev, password: event.target.value }))
                }
                placeholder="Password"
                autoComplete="current-password"
                data-np-autofill-field-type="password"
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowAuthPassword((prev) => !prev)}
                aria-label={showAuthPassword ? "Hide password" : "Show password"}
                aria-pressed={showAuthPassword}
              >
                <PasswordToggleIcon visible={showAuthPassword} />
              </button>
            </span>
          </label>
          <button className="button primary" type="submit" disabled={authStatus.kind === "loading"}>
            {authStatus.kind === "loading" ? "Signing in..." : "Sign in"}
          </button>
        </form>
      ) : (
        <form
          key="register"
          id="auth-register-form"
          name="register"
          className="form"
          onSubmit={onSubmit}
          autoComplete="on"
          method="post"
          action="/auth/register"
          data-auth-mode="register"
          data-np-autofill-form-type="register"
        >
          <label htmlFor="register-name">
            Name
            <input
              id="register-name"
              name="name"
              type="text"
              value={authForm.name}
              onChange={(event) =>
                setAuthForm((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder="Optional"
              autoComplete="name"
            />
          </label>
          <label htmlFor="register-email">
            Email
            <input
              id="register-email"
              name="email"
              type="email"
              value={authForm.email}
              onChange={(event) =>
                setAuthForm((prev) => ({ ...prev, email: event.target.value }))
              }
              placeholder="you@example.com"
              autoComplete="email"
              inputMode="email"
              data-np-autofill-field-type="email"
              required
            />
          </label>
          <label htmlFor="register-password">
            Password
            <span className="password-input-wrap">
              <input
                id="register-password"
                name="password"
                type={showAuthPassword ? "text" : "password"}
                value={authForm.password}
                onChange={(event) =>
                  setAuthForm((prev) => ({ ...prev, password: event.target.value }))
                }
                placeholder="At least 8 characters"
                autoComplete="new-password"
                data-np-autofill-field-type="new-password"
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowAuthPassword((prev) => !prev)}
                aria-label={showAuthPassword ? "Hide password" : "Show password"}
                aria-pressed={showAuthPassword}
              >
                <PasswordToggleIcon visible={showAuthPassword} />
              </button>
            </span>
          </label>
          <button className="button primary" type="submit" disabled={authStatus.kind === "loading"}>
            {authStatus.kind === "loading" ? "Creating account..." : "Create account"}
          </button>
        </form>
      )}
      {authStatus.kind === "error" && <p className="status status-error">{authStatus.message}</p>}
    </section>
  );
}

export default AuthCard;
