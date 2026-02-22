import { Link, useLocation } from "react-router-dom";

const NAV_ITEMS = [
  {
    to: "/",
    label: "Portefeuille",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
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
    ),
  },
  {
    to: "/simulate/assurance-vie",
    label: "Assurance vie",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
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
    ),
  },
  {
    to: "/simulate/compte-a-terme",
    label: "Compte a terme",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
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
    ),
  },
  {
    to: "/analysis/bsf120",
    label: "BSF120",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
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
    ),
  },
];

type FloatingSidebarProps = {
  onChatToggle?: () => void;
  chatActive?: boolean;
};

function FloatingSidebar({ onChatToggle, chatActive = false }: FloatingSidebarProps) {
  const { pathname } = useLocation();

  return (
    <nav className="floating-nav" aria-label="Navigation principale">
      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.to;
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`floating-nav-link${isActive ? " active" : ""}`}
            aria-label={item.label}
          >
            <span className="floating-nav-icon">{item.icon}</span>
            <span className="floating-nav-tooltip">{item.label}</span>
          </Link>
        );
      })}
      {onChatToggle && (
        <button
          type="button"
          className={`floating-nav-link floating-nav-chat-link${chatActive ? " active" : ""}`}
          aria-label="Chat"
          onClick={onChatToggle}
        >
          <span className="floating-nav-icon" aria-hidden="true">
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
          <span className="floating-nav-tooltip">Chat</span>
        </button>
      )}
    </nav>
  );
}

export default FloatingSidebar;
