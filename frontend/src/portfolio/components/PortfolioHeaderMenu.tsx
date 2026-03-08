import { useEffect, useRef, useState, type ChangeEventHandler } from "react";
import { useNavigate } from "react-router-dom";
import type { ThemeMode } from "../../theme";

type PortfolioHeaderMenuProps = {
  userDisplayEmail: string;
  userInitials: string;
  chatOpen: boolean;
  themeMode: ThemeMode;
  isTourActive: boolean;
  onToggleChat: () => void;
  onToggleTheme: () => void;
  onToggleTour: () => void;
  onExportData: () => void;
  onImportData: ChangeEventHandler<HTMLInputElement>;
  onRunYahooTargets: () => void;
  onRefreshPrices: () => void;
  onLogout: () => void;
};

function PortfolioHeaderMenu({
  userDisplayEmail,
  userInitials,
  chatOpen,
  themeMode,
  isTourActive,
  onToggleChat,
  onToggleTheme,
  onToggleTour,
  onExportData,
  onImportData,
  onRunYahooTargets,
  onRefreshPrices,
  onLogout,
}: PortfolioHeaderMenuProps) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const navigateTo = (path: string) => {
    setIsOpen(false);
    navigate(path);
  };

  const runAction = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        type="button"
        className="avatar-button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="avatar-initials">{userInitials}</span>
      </button>
      {isOpen && (
        <div className="user-menu-dropdown" role="menu">
          <div className="user-menu-header">
            <span className="user-menu-email">{userDisplayEmail}</span>
          </div>
          <button type="button" className="user-menu-item" onClick={() => navigateTo("/portfolio/compare")}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M4 7h6v10H4zM14 4h6v16h-6z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Compare views</span>
            </span>
          </button>
          <button type="button" className="user-menu-item" onClick={() => navigateTo("/")}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 3v9l7.5 7.5A9 9 0 1 1 12 3z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 3a9 9 0 0 1 9 9h-9z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Portfolio</span>
            </span>
          </button>
          <button type="button" className="user-menu-item" onClick={() => navigateTo("/simulate/assurance-vie")}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 3l7 4v5c0 4.5-3.1 8.4-7 9.7-3.9-1.3-7-5.2-7-9.7V7l7-4z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M9.5 12.5l2 2 3.5-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Assurance vie</span>
            </span>
          </button>
          <button type="button" className="user-menu-item" onClick={() => navigateTo("/simulate/compte-a-terme")}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <rect
                    x="3"
                    y="4"
                    width="18"
                    height="17"
                    rx="2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                  <path
                    d="M8 2v4M16 2v4M3 9h18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Compte a terme</span>
            </span>
          </button>
          <button type="button" className="user-menu-item" onClick={() => navigateTo("/analysis/bsf120")}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M4 19h16M5 16l4-5 3 3 5-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M15 7h2.5V9.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>BSF120</span>
            </span>
          </button>
          <button
            type="button"
            className={`user-menu-item ${chatOpen ? "active" : ""}`.trim()}
            aria-pressed={chatOpen}
            onClick={() => runAction(onToggleChat)}
          >
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M5 6h14v9H9l-4 4z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Chat</span>
            </span>
          </button>
          <button
            type="button"
            className={`user-menu-item ${themeMode === "light" ? "active" : ""}`.trim()}
            aria-pressed={themeMode === "light"}
            onClick={() => runAction(onToggleTheme)}
          >
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                </svg>
              </span>
              <span>{themeMode === "dark" ? "Switch to light theme" : "Switch to dark theme"}</span>
            </span>
          </button>
          <div className="user-menu-divider" />
          <button
            type="button"
            className="user-menu-item"
            aria-pressed={isTourActive}
            onClick={() => runAction(onToggleTour)}
          >
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 3v18M3 12h18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>{isTourActive ? "End tour" : "Start tour"}</span>
            </span>
          </button>
          <button type="button" className="user-menu-item" onClick={() => runAction(onExportData)}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 4v11M8 11l4 4 4-4M5 20h14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Export Data</span>
            </span>
          </button>
          <button
            type="button"
            className="user-menu-item"
            onClick={() => {
              setIsOpen(false);
              inputRef.current?.click();
            }}
          >
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 20V9M8 13l4-4 4 4M5 4h14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Import Data</span>
            </span>
          </button>
          <button type="button" className="user-menu-item" onClick={() => runAction(onRunYahooTargets)}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M4 19h16M6 15l3-3 3 2 5-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Run Yahoo targets</span>
            </span>
          </button>
          <button type="button" className="user-menu-item" onClick={() => runAction(onRefreshPrices)}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M20 11a8 8 0 1 0 2 5.5M20 4v7h-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Refresh prices</span>
            </span>
          </button>
          <button type="button" className="user-menu-item danger" onClick={() => runAction(onLogout)}>
            <span className="user-menu-item-content">
              <span className="user-menu-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M15 17l5-5-5-5M20 12H9M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Log out</span>
            </span>
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        onChange={(event) => {
          setIsOpen(false);
          onImportData(event);
        }}
        hidden
      />
    </div>
  );
}

export default PortfolioHeaderMenu;
