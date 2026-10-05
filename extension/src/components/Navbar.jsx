import { useNavigate, useLocation } from "react-router-dom";
import { G } from "./Art.jsx";

/* Thin black announcement bar above the header (scrolls away). */
export function TopBar() {
  return (
    <div style={{
      background: "var(--ink)", color: "#fff",
      fontSize: 10.5, fontWeight: 500, letterSpacing: "0.08em",
    }}>
      <div className="container" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 34 }}>
        <span>Монгол хэлээр AI хайлт · 6 дэлгүүрийн үнийг нэг дор</span>
        <span className="hide-sm" style={{ display: "flex", gap: 18, color: "#bbb" }}>
          <span>МОНГОЛ</span>
          <span>₮ MNT</span>
        </span>
      </div>
    </div>
  );
}

/* Wordmark: "AI SHOP" with a small notch in the A, Zurea-style. */
export function Logo({ size = 26, color = "var(--ink)", onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label="AI Shop нүүр"
      style={{
        background: "none", border: "none", padding: 0, color,
        fontFamily: "var(--display)", fontWeight: 700, fontSize: size,
        letterSpacing: "0.14em", lineHeight: 1, display: "flex", alignItems: "baseline", gap: 6,
      }}
    >
      AI<span style={{ display: "inline-block", width: 6, height: 6, background: "var(--sale)", transform: "translateY(-2px)" }} />SHOP
    </button>
  );
}

export default function Navbar({ user, onLogout, chatOpen, onToggleChat }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const links = [
    { label: "Хайх",  path: "/search" },
    user && { label: "Түүх", path: "/history" },
    user?.is_admin && { label: "Admin", path: "/admin" },
  ].filter(Boolean);

  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 100,
      background: "rgba(255,255,255,0.96)",
      backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
      borderBottom: "1px solid var(--line)",
    }}>
      <div className="container header-grid" style={{
        height: "var(--header-h)", display: "grid",
        gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 16,
      }}>
        <div><Logo onClick={() => navigate("/search")} /></div>

        <nav style={{ display: "flex", gap: 30 }}>
          {links.map(l => (
            <button
              key={l.path}
              className={`link-tab ${pathname.startsWith(l.path) ? "active" : ""}`}
              onClick={() => navigate(l.path)}
              style={{ fontSize: 12 }}
            >
              {l.label}
            </button>
          ))}
        </nav>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 14 }}>
          {user ? (
            <>
              <span className="hide-sm" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 600 }}>
                <G.user size={16} />
                {user.username}
                {user.is_admin && (
                  <span style={{ fontSize: 9, letterSpacing: ".14em", border: "1px solid var(--ink)", padding: "1px 5px" }}>ADMIN</span>
                )}
              </span>
              <button onClick={onLogout} className="icon-btn" title="Гарах" aria-label="Гарах" style={{ border: "none" }}>
                <G.logout size={16} />
              </button>
            </>
          ) : (
            <button onClick={() => navigate("/login")} className="link-tab" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 7 }}>
              <G.user size={16} /> <span className="hide-sm">Нэвтрэх</span>
            </button>
          )}

          {/* Black block — like the template's cart box — toggles the AI assistant */}
          <button
            onClick={onToggleChat}
            aria-pressed={chatOpen}
            className="chat-toggle"
            style={{
              height: "var(--header-h)", padding: "0 26px",
              background: chatOpen ? "var(--paper)" : "var(--ink)",
              color: chatOpen ? "var(--ink)" : "var(--paper)",
              border: "none", borderLeft: "1px solid var(--ink)",
              display: "flex", alignItems: "center", gap: 10,
              fontSize: 11, fontWeight: 700, letterSpacing: ".16em", textTransform: "uppercase",
              transition: "background .2s, color .2s",
            }}
          >
            <G.chat size={17} />
            <span className="hide-sm">AI туслах</span>
          </button>
        </div>
      </div>
    </header>
  );
}
