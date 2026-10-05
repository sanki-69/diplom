import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { getToken, setToken, getMe } from "./api.js";
import Navbar, { TopBar, Logo } from "./components/Navbar.jsx";
import ChatSidebar from "./components/ChatSidebar.jsx";
import AuthPage from "./pages/AuthPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import AdminPage from "./pages/AdminPage.jsx";
import OpenClawPage from "./pages/OpenClawPage.jsx";
import { G } from "./components/Art.jsx";

function LoginGate({ onNavigate }) {
  return (
    <div className="fade-up" style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      flexDirection: "column", gap: 14, padding: "100px 20px", textAlign: "center",
    }}>
      <div style={{ width: 64, height: 64, border: "1px solid var(--ink)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <G.clock size={26} sw={1.4} />
      </div>
      <h2 style={{ fontSize: 28, marginTop: 8 }}>Нэвтрэх шаардлагатай</h2>
      <p style={{ color: "var(--mute)", fontSize: 13, maxWidth: 300 }}>
        Хайлт болон чатын түүхээ харахын тулд данс нээж нэвтэрнэ үү
      </p>
      <button className="btn" onClick={onNavigate} style={{ marginTop: 10 }}>
        Нэвтрэх / Бүртгүүлэх
      </button>
    </div>
  );
}

function Footer() {
  return (
    <footer style={{ background: "var(--ink)", color: "#bdbdbd", marginTop: "auto" }}>
      <div className="container" style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 20, flexWrap: "wrap", padding: "34px 32px",
      }}>
        <Logo size={20} color="#fff" />
        <span style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase" }}>
          AliExpress · Amazon · eBay · Walmart · BestBuy · Newegg
        </span>
        <span style={{ fontSize: 11 }}>© {new Date().getFullYear()} AI Shop · Дипломын ажил</span>
      </div>
    </footer>
  );
}

function AppInner() {
  const [user, setUser]               = useState(null);
  // Only show the loading screen when there is a saved token to verify.
  const [authLoading, setAuthLoading] = useState(() => Boolean(getToken()));
  // Chat starts closed on narrow screens, where it would cover the page.
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1000);
  // Chat → Search: chat sidebar triggers a new search
  const [chatSearch, setChatSearch]   = useState(null);   // { query, ts }
  // Chat → Filter: chat sidebar requests to filter current results
  const [chatFilter, setChatFilter]   = useState(null);   // { color, brand, keyword, ... }
  // Search → Chat: active search query shared with sidebar for context
  const [activeQuery, setActiveQuery] = useState("");
  // Search → Chat: product selected for AI advice
  const [selectedProduct, setSelectedProduct] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!getToken()) return;
    getMe()
      .then(u => { if (u) setUser(u); else setToken(null); })
      .finally(() => setAuthLoading(false));
  }, []);

  if (authLoading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18 }}>
        <Logo size={30} />
        <span className="spinner" style={{ color: "var(--ink)", borderColor: "var(--line)", borderTopColor: "var(--ink)" }} />
      </div>
    );
  }

  const isSearchPage = location.pathname === "/search";
  const isLoginPage  = location.pathname === "/login";
  const isAdminPage  = location.pathname === "/admin";
  const shell        = !isLoginPage && !isAdminPage;   // pages that get header + chat

  const routes = (
    <Routes>
      <Route path="/" element={<Navigate to="/search" replace />} />
      <Route path="/search" element={
        <OpenClawPage
          chatSearch={chatSearch}
          onChatSearchUsed={() => setChatSearch(null)}
          chatFilter={chatFilter}
          onChatFilterUsed={() => setChatFilter(null)}
          onQueryChange={setActiveQuery}
          onSelectProduct={p => { setSelectedProduct(p); setSidebarOpen(true); }}
        />
      } />
      <Route path="/history" element={
        user
          ? <HistoryPage user={user} />
          : <LoginGate onNavigate={() => navigate("/login")} />
      } />
      <Route path="/admin" element={<AdminPage user={user} />} />
      <Route path="/login" element={user ? <Navigate to="/search" replace /> : <AuthPage onAuth={(u, t) => { setToken(t); setUser(u); }} />} />
      <Route path="*" element={<Navigate to="/search" replace />} />
    </Routes>
  );

  if (!shell) return routes;

  return (
    <>
      <div className={`main-col ${sidebarOpen ? "with-chat" : ""}`}>
        <TopBar />
        <Navbar
          user={user}
          onLogout={() => { setToken(null); setUser(null); }}
          chatOpen={sidebarOpen}
          onToggleChat={() => setSidebarOpen(o => !o)}
        />
        <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>{routes}</main>
        {location.pathname !== "/history" && <Footer />}
      </div>

      <ChatSidebar
        user={user}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        onSearch={(query) => { setChatFilter(null); setChatSearch({ query, ts: Date.now() }); }}
        onFilter={(filters) => setChatFilter({ ...filters, ts: Date.now() })}
        isOnSearchPage={isSearchPage}
        activeQuery={activeQuery}
        contextProduct={selectedProduct}
      />
    </>
  );
}

export default function App() {
  return <BrowserRouter><AppInner /></BrowserRouter>;
}
