import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { clearAuthToken, fetchCurrentUser, getStoredAuthToken, type AuthUser } from "./api";

type PageAvatarMenuProps = {
  chatActive?: boolean;
  onChatToggle?: () => void;
};

const getInitials = (email?: string | null) => {
  const base = (email || "User").split("@")[0];
  const parts = base.split(/[.\s_-]+/).filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "U";
};

function PageAvatarMenu({ chatActive = false, onChatToggle }: PageAvatarMenuProps) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(() => getStoredAuthToken());
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    setAuthToken(getStoredAuthToken());
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!authToken) {
      setCurrentUser(null);
      return;
    }
    let canceled = false;
    void fetchCurrentUser()
      .then((res) => {
        if (!canceled) setCurrentUser(res.data);
      })
      .catch(() => {
        if (!canceled) setCurrentUser(null);
      });
    return () => {
      canceled = true;
    };
  }, [authToken]);

  const userDisplayEmail = currentUser?.email || (authToken ? "Signed in" : "Guest");
  const userInitials = getInitials(currentUser?.email || userDisplayEmail);

  const navigateTo = (path: string) => {
    setIsOpen(false);
    navigate(path);
  };

  const handleLogout = () => {
    clearAuthToken();
    setAuthToken(null);
    setCurrentUser(null);
    setIsOpen(false);
    navigate("/");
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

          <button
            type="button"
            className="user-menu-item"
            onClick={() => navigateTo("/simulate/assurance-vie")}
          >
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

          <button
            type="button"
            className="user-menu-item"
            onClick={() => navigateTo("/simulate/compte-a-terme")}
          >
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

          <button
            type="button"
            className="user-menu-item"
            onClick={() => navigateTo("/analysis/bsf120")}
          >
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

          {onChatToggle && (
            <button
              type="button"
              className={`user-menu-item ${chatActive ? "active" : ""}`.trim()}
              aria-pressed={chatActive}
              onClick={() => {
                setIsOpen(false);
                onChatToggle();
              }}
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
          )}

          <div className="user-menu-divider" />

          {authToken ? (
            <button type="button" className="user-menu-item danger" onClick={handleLogout}>
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
          ) : (
            <button type="button" className="user-menu-item" onClick={() => navigateTo("/")}>
              <span className="user-menu-item-content">
                <span className="user-menu-item-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M9 6l-5 6l5 6M4 12h11M12 4h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span>Sign in</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default PageAvatarMenu;
