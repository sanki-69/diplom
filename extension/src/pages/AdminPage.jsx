import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  adminGetStats, adminGetUsers, adminDeleteUser, adminCreateUser,
  adminCreateProduct, adminUpdateProduct, adminDeleteProduct,
  getProducts, adminDbView, adminDbDelete,
} from "../api.js";

/* ── palette ─────────────────────────────────────────────────── */
const C = {
  sidebar:    "#111111",
  sideHover:  "rgba(255,255,255,0.07)",
  sideActive: "rgba(255,255,255,0.14)",
  bg:         "#f5f5f5",
  panel:      "#ffffff",
  accent:     "#111111",
  accentDim:  "#111111",
  border:     "#e5e5e5",
  borderDark: "#cfcfcf",
  text:       "#111111",
  textMuted:  "#6b6b6b",
  dim:        "#a8a8a8",
  success:    "#1a7f37",
  successBg:  "rgba(26,127,55,0.08)",
  error:      "#d0021b",
  errorBg:    "rgba(208,2,27,0.06)",
  warning:    "#b26a00",
  badge:      "#f0f0f0",
};

const SIDEBAR_W = 230;

/* ── helpers ─────────────────────────────────────────────────── */
const USD_TO_MNT = 3450;
function toMNT(p) { return p != null ? `₮${Math.round(p*USD_TO_MNT).toLocaleString()}` : "—"; }
function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("mn-MN",{year:"numeric",month:"2-digit",day:"2-digit"});
}

/* ── SVG icons ───────────────────────────────────────────────── */
const Ic = {
  Grid:    p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  Box:     p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>,
  Users:   p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  DB:      p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  Search:  p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  Plus:    p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Dots:    p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>,
  Shield:  p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Trash:   p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>,
  Edit:    p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Home:    p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  LogOut:  p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  User:    p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  History: p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="12 8 12 12 14 14"/><path d="M3.05 11a9 9 0 1 0 .5-4.5"/><polyline points="3 3 3 7 7 7"/></svg>,
  Lock:    p => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
};

const iconSz = { width:16, height:16 };
const iconSm = { width:14, height:14 };

/* ── Sidebar nav item ─────────────────────────────────────────── */
function NavItem({ icon: Icon, label, active, onClick, badge }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 12,
        padding: "10px 16px", borderRadius:0, border: "none", cursor: "pointer",
        background: active ? C.sideActive : hov ? C.sideHover : "transparent",
        color: active ? "#fff" : "rgba(255,255,255,0.6)",
        fontWeight: active ? 600 : 400, fontSize: 13,
        transition: "all .12s", textAlign: "left", outline: "none",
        borderLeft: active ? "3px solid #ffffff" : "3px solid transparent",
      }}
    >
      <Icon {...iconSz} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge > 0 && (
        <span style={{ background: C.accent, color: "#fff", borderRadius:0, fontSize: 10, fontWeight: 700, padding: "1px 7px" }}>
          {badge}
        </span>
      )}
    </button>
  );
}

/* ── Status badge ─────────────────────────────────────────────── */
function Badge({ active = true, text }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: active ? C.successBg : C.badge,
      color: active ? C.success : C.textMuted,
      border: `1px solid ${active ? "rgba(22,199,132,0.25)" : C.border}`,
      borderRadius:0, fontSize: 12, fontWeight: 600, padding: "3px 10px",
    }}>
      <span style={{ width: 6, height: 6, borderRadius:0, background: active ? C.success : C.dim, display:"inline-block" }} />
      {text || (active ? "Идэвхтэй" : "Идэвхгүй")}
    </span>
  );
}

/* ── Role badge ───────────────────────────────────────────────── */
function RoleBadge({ isAdmin }) {
  return (
    <span style={{
      background: isAdmin ? "rgba(59,111,247,0.1)" : C.badge,
      color: isAdmin ? C.accent : C.textMuted,
      border: `1px solid ${isAdmin ? "rgba(59,111,247,0.25)" : C.border}`,
      borderRadius:0, fontSize: 11, fontWeight: 700, padding: "3px 10px",
    }}>
      {isAdmin ? "Admin" : "User"}
    </span>
  );
}

/* ── Table head cell ──────────────────────────────────────────── */
function TH({ children, w }) {
  return (
    <th style={{
      textAlign: "left", padding: "11px 16px",
      color: C.textMuted, fontSize: 11, fontWeight: 700,
      letterSpacing: "0.06em", textTransform: "uppercase",
      background: "#f7f7f7", borderBottom: `1px solid ${C.border}`,
      whiteSpace: "nowrap", width: w,
    }}>{children}</th>
  );
}

/* ── Avatar placeholder ───────────────────────────────────────── */
function Avatar({ name }) {
  const ch = (name || "?")[0].toUpperCase();
  const hue = (name || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <div style={{
      width: 32, height: 32, borderRadius:0, flexShrink: 0,
      background: `hsl(${hue},55%,88%)`, color: `hsl(${hue},55%,35%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 13, fontWeight: 700,
    }}>{ch}</div>
  );
}

/* ── Stat card ────────────────────────────────────────────────── */
function StatCard({ Icon, label, value, accent }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius:0,
      padding: "20px 24px", display: "flex", alignItems: "center", gap: 16,
    }}>
      <div style={{
        width: 48, height: 48, borderRadius:0, flexShrink: 0,
        background: `${accent}14`, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Icon width={22} height={22} stroke={accent} />
      </div>
      <div>
        <div style={{ color: C.textMuted, fontSize: 12, fontWeight: 600 }}>{label}</div>
        <div style={{ color: C.text, fontFamily: "var(--display)", fontSize: 34, fontWeight: 500, lineHeight: 1.1, marginTop: 2 }}>
          {value ?? "—"}
        </div>
      </div>
    </div>
  );
}

/* ── Search input ─────────────────────────────────────────────── */
function SearchInput({ value, onChange, placeholder }) {
  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: C.dim }}>
        <Ic.Search {...iconSm} />
      </div>
      <input
        value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder || "Хайх..."}
        style={{
          paddingLeft: 36, paddingRight: 14, paddingTop: 9, paddingBottom: 9,
          border: `1px solid ${C.border}`, borderRadius:0, outline: "none",
          fontSize: 13, color: C.text, background: C.panel, width: 240,
          boxSizing: "border-box",
        }}
        onFocus={e => e.target.style.borderColor = C.accent}
        onBlur={e => e.target.style.borderColor = C.border}
      />
    </div>
  );
}

/* ── Action button ────────────────────────────────────────────── */
function ActBtn({ onClick, danger, children }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        padding: "5px 10px", border: "none", borderRadius:0, cursor: "pointer",
        fontSize: 11, fontWeight: 600, transition: "background .12s",
        background: danger
          ? hov ? "rgba(229,62,62,0.15)" : "rgba(229,62,62,0.08)"
          : hov ? "rgba(59,111,247,0.15)" : "rgba(59,111,247,0.08)",
        color: danger ? C.error : C.accent,
        display: "flex", alignItems: "center", gap: 4,
      }}
    >{children}</button>
  );
}

/* ── Modal wrapper ────────────────────────────────────────────── */
function Modal({ title, onClose, children }) {
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{
      position: "fixed", inset: 0, background: "rgba(13,27,62,0.45)", zIndex: 300,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: C.panel, borderRadius:0, padding: 32,
        width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto",
        boxShadow:"none", border: `1px solid ${C.border}`,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ margin: 0, color: C.text, fontSize: 20, fontWeight: 600 }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.dim, padding: 4 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Field ────────────────────────────────────────────────────── */
function Field({ label, value, onChange, placeholder, type = "text", area }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", color: C.textMuted, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 6 }}>{label}</label>
      {area
        ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3}
            style={{ width:"100%", border:`1px solid ${C.border}`, borderRadius:0, color:C.text,
              padding:"9px 12px", fontSize:13, outline:"none", resize:"vertical",
              boxSizing:"border-box", fontFamily:"inherit", background:"#fafbfe" }} />
        : <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
            style={{ width:"100%", border:`1px solid ${C.border}`, borderRadius:0, color:C.text,
              padding:"9px 12px", fontSize:13, outline:"none", boxSizing:"border-box", background:"#fafbfe" }}
            onFocus={e => e.target.style.borderColor = C.accent}
            onBlur={e => e.target.style.borderColor = C.border} />
      }
    </div>
  );
}

/* ══════════════════════════════════════════
   DASHBOARD TAB
══════════════════════════════════════════ */
function Dashboard({ stats, onNav }) {
  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, color: C.text, fontSize: 32, fontWeight: 600 }}>Хяналтын самбар</h1>
        <p style={{ margin: "6px 0 0", color: C.textMuted, fontSize: 13 }}>Системийн ерөнхий мэдээлэл</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard Icon={Ic.Users} label="Нийт хэрэглэгч"  value={stats?.total_users}    accent={C.accent}   />
        <StatCard Icon={Ic.Box}   label="Нийт бараа"       value={stats?.total_products} accent={C.success}  />
        <StatCard Icon={({...p}) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 0 2 2z"/></svg>}
          label="Нийт мессеж" value={stats?.total_messages} accent="#f59e0b" />
        <StatCard Icon={Ic.History} label="Нийт сесс"      value={stats?.total_sessions} accent="#8b5cf6"   />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius:0, padding: 24 }}>
          <h3 style={{ color: C.text, margin: "0 0 16px", fontSize: 14, fontWeight: 700 }}>Хурдан үйлдэл</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              { label: "Шинэ бараа нэмэх",   tab: "products", primary: true },
              { label: "Хэрэглэгчид харах",   tab: "users",   primary: false },
              { label: "Мэдээллийн сан",      tab: "database", primary: false },
            ].map(a => (
              <button key={a.tab} onClick={() => onNav(a.tab)} style={{
                background: a.primary ? `linear-gradient(135deg,${C.accent},${C.accentDim})` : "transparent",
                border: a.primary ? "none" : `1px solid ${C.border}`,
                color: a.primary ? "#fff" : C.text,
                borderRadius:0, padding: "10px 16px", fontSize: 13,
                fontWeight: 600, cursor: "pointer", textAlign: "left",
              }}>{a.label}</button>
            ))}
          </div>
        </div>
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius:0, padding: 24 }}>
          <h3 style={{ color: C.text, margin: "0 0 16px", fontSize: 14, fontWeight: 700 }}>Систем</h3>
          {[
            { label: "Backend",   value: "FastAPI + MongoDB" },
            { label: "AI",        value: "Gemini 2.0 Flash + Groq" },
            { label: "Frontend",  value: "React + Vite (MV3)" },
            { label: "Auth",      value: "JWT / bcrypt" },
            { label: "Scraping",  value: "6 дэлгүүр (BS4)" },
          ].map(r => (
            <div key={r.label} style={{ display: "flex", justifyContent: "space-between",
              padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.textMuted, fontSize: 13 }}>{r.label}</span>
              <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{r.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   USERS TAB
══════════════════════════════════════════ */
function Users({ currentUser, flash }) {
  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState("");
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ username: "", email: "", password: "" });
  const [adding, setAdding]     = useState(false);

  const load = () => {
    setLoading(true);
    adminGetUsers().then(setUsers).catch(e => flash(e.message, true)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const del = async (u) => {
    if (!confirm(`"${u.username}" устгах уу?`)) return;
    try {
      await adminDeleteUser(u.id);
    } catch (e) {
      flash(e.message, true);
      return; // keep the row: the server did not delete it
    }
    setUsers(p => p.filter(x => x.id !== u.id));
    flash("Устгагдлаа");
  };

  const addUser = async () => {
    if (!form.username || !form.password) { flash("Нэр болон нууц үг шаардлагатай", true); return; }
    setAdding(true);
    try {
      const u = await adminCreateUser(form.username, form.email, form.password);
      setUsers(p => [...p, u]);
      setForm({ username: "", email: "", password: "" });
      setShowAdd(false);
      flash(`"${u.username}" нэмэгдлээ`);
    } catch(e) { flash(e.message, true); }
    finally { setAdding(false); }
  };

  const filtered = users.filter(u =>
    u.username?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: C.text, fontSize: 32, fontWeight: 600 }}>Хэрэглэгч удирдах</h1>
        <p style={{ margin: "6px 0 0", color: C.textMuted, fontSize: 13 }}>Платформын бүх хэрэглэгчийн жагсаалт</p>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, alignItems: "center" }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Нэр, email хайх..." />
        <div style={{ flex: 1 }} />
        <div style={{ color: C.textMuted, fontSize: 13 }}>
          Нийт <strong style={{ color: C.text }}>{users.length}</strong> хэрэглэгч
        </div>
        <button onClick={() => setShowAdd(v => !v)} style={{
          display: "flex", alignItems: "center", gap: 7, padding: "9px 18px",
          background: `linear-gradient(135deg,${C.accent},${C.accentDim})`,
          border: "none", borderRadius:0, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>
          <Ic.Plus width={15} height={15} /> Хэрэглэгч нэмэх
        </button>
      </div>

      {/* Add user form */}
      {showAdd && (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius:0, padding: 20, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, color: C.text, marginBottom: 14, fontSize: 14 }}>Шинэ хэрэглэгч</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {[["Нэр *", "username", "text"], ["Email", "email", "email"], ["Нууц үг *", "password", "password"]].map(([lbl, key, type]) => (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 160px" }}>
                <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>{lbl}</label>
                <input
                  type={type}
                  value={form[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  style={{ padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius:0, fontSize: 13, outline: "none", color: C.text }}
                />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={addUser} disabled={adding} style={{
              padding: "9px 20px", background: C.accent, border: "none", borderRadius:0,
              color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>{adding ? "Нэмж байна..." : "Нэмэх"}</button>
            <button onClick={() => setShowAdd(false)} style={{
              padding: "9px 16px", background: C.badge, border: `1px solid ${C.border}`, borderRadius:0,
              color: C.textMuted, fontSize: 13, cursor: "pointer",
            }}>Болих</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius:0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <TH w={48}>#</TH>
              <TH>Нэр</TH>
              <TH>Email</TH>
              <TH w={90}>Эрх</TH>
              <TH w={110}>Огноо</TH>
              <TH w={70}></TH>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={{ padding: 40, textAlign: "center", color: C.dim, fontSize: 13 }}>
                Ачааллаж байна...
              </td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 40, textAlign: "center", color: C.dim, fontSize: 13 }}>
                Хэрэглэгч олдсонгүй
              </td></tr>
            )}
            {filtered.map((u, i) => (
              <tr key={u.id}
                style={{ borderBottom: `1px solid ${C.border}`, transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = "#f7f7f7"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <td style={{ padding: "13px 16px", color: C.dim, fontSize: 13 }}>{i + 1}</td>

                <td style={{ padding: "13px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar name={u.username} />
                    <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>{u.username}</span>
                  </div>
                </td>

                <td style={{ padding: "13px 16px", color: C.textMuted, fontSize: 13 }}>{u.email || "—"}</td>

                <td style={{ padding: "13px 16px" }}><RoleBadge isAdmin={u.is_admin} /></td>

                <td style={{ padding: "13px 16px", color: C.textMuted, fontSize: 12 }}>{fmtDate(u.created_at)}</td>

                {/* Delete */}
                <td style={{ padding: "13px 16px" }}>
                  {u.id !== currentUser?.id && (
                    <button onClick={() => del(u)} title="Устгах" style={{
                      background: "none", border: `1px solid ${C.border}`, borderRadius:0,
                      cursor: "pointer", padding: "5px 7px", color: C.error, display: "flex",
                    }}>
                      <Ic.Trash {...iconSm} stroke={C.error} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   PRODUCTS TAB
══════════════════════════════════════════ */
const EMPTY_P = { name:"", description:"", price:"", image_url:"", category:"", stock:"0" };

function Products({ flash }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [modal, setModal]       = useState(null);
  const [search, setSearch]     = useState("");

  const load = () => {
    setLoading(true);
    getProducts().then(setProducts).catch(e=>flash(e.message,true)).finally(()=>setLoading(false));
  };
  useEffect(load, []);

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.category.toLowerCase().includes(search.toLowerCase())
  );

  const [form, setForm] = useState(EMPTY_P);
  const setF = k => v => setForm(p => ({ ...p, [k]: v }));
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState("");

  const openNew  = () => { setForm(EMPTY_P); setFormErr(""); setModal("new"); };
  const openEdit = p  => { setForm({ ...p, price: String(p.price), stock: String(p.stock) }); setFormErr(""); setModal(p); };

  const handleSave = async () => {
    if (!form.name.trim() || !form.price) { setFormErr("Нэр болон үнэ заавал!"); return; }
    setSaving(true); setFormErr("");
    try {
      const data = { name:form.name, description:form.description,
        price:parseFloat(form.price), image_url:form.image_url,
        category:form.category, stock:parseInt(form.stock)||0 };
      if (modal?.id) await adminUpdateProduct(modal.id, data);
      else           await adminCreateProduct(data);
      flash(modal?.id ? "Бараа шинэчлэгдлаа" : "Бараа нэмэгдлаа");
      setModal(null); load();
    } catch(e) { setFormErr(e.message); } finally { setSaving(false); }
  };

  const handleDel = async (p) => {
    if (!confirm(`"${p.name}" устгах уу?`)) return;
    await adminDeleteProduct(p.id).catch(e=>flash(e.message,true));
    flash("Устгагдлаа"); load();
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: C.text, fontSize: 32, fontWeight: 600 }}>Бараа удирдах</h1>
        <p style={{ margin: "6px 0 0", color: C.textMuted, fontSize: 13 }}>Дэлгүүрийн барааны жагсаалт</p>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 20, alignItems: "center" }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Нэр, ангилалаар хайх..." />
        <div style={{ flex: 1 }} />
        <button onClick={openNew} style={{
          display: "flex", alignItems: "center", gap: 7,
          background: `linear-gradient(135deg,${C.accent},${C.accentDim})`,
          border: "none", color: "#fff", borderRadius:0,
          padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer",
        }}>
          <Ic.Plus width={14} height={14} /> Шинэ бараа
        </button>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius:0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: C.dim, fontSize: 13 }}>Ачааллаж байна...</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <TH w={52}>Зураг</TH>
                <TH>Нэр</TH>
                <TH w={110}>Ангилал</TH>
                <TH w={120}>Үнэ</TH>
                <TH w={90}>Нөөц</TH>
                <TH w={90}>Үйлдэл</TH>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 40, textAlign: "center", color: C.dim, fontSize: 13 }}>Бараа олдсонгүй</td></tr>
              )}
              {filtered.map(p => (
                <tr key={p.id} style={{ borderBottom: `1px solid ${C.border}` }}
                  onMouseEnter={e => e.currentTarget.style.background = "#f7f7f7"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ width:40, height:40, borderRadius:0, overflow:"hidden", background:C.bg, flexShrink:0 }}>
                      {p.image_url
                        ? <img src={p.image_url} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>e.target.style.display="none"} />
                        : <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%" }}><Ic.Box width={18} height={18} stroke={C.dim} /></div>}
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ color:C.text, fontWeight:600, fontSize:13 }}>{p.name}</div>
                    <div style={{ color:C.dim, fontSize:11, marginTop:2 }}>{p.description?.slice(0,48)}{p.description?.length>48?"…":""}</div>
                  </td>
                  <td style={{ padding:"12px 16px" }}>
                    <span style={{ background:C.badge, color:C.textMuted, borderRadius:0, fontSize:11, fontWeight:600, padding:"3px 10px" }}>{p.category || "—"}</span>
                  </td>
                  <td style={{ padding:"12px 16px", color:C.accent, fontWeight:700, fontSize:14 }}>{toMNT(p.price)}</td>
                  <td style={{ padding:"12px 16px" }}>
                    <span style={{ color:p.stock>0?C.success:C.error, fontWeight:600, fontSize:13 }}>
                      {p.stock > 0 ? `${p.stock} ш` : "Дууссан"}
                    </span>
                  </td>
                  <td style={{ padding:"12px 16px" }}>
                    <div style={{ display:"flex", gap:6 }}>
                      <ActBtn onClick={() => openEdit(p)}><Ic.Edit {...iconSm} /> Засах</ActBtn>
                      <ActBtn onClick={() => handleDel(p)} danger><Ic.Trash {...iconSm} /></ActBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal !== null && (
        <Modal title={modal?.id ? "Бараа засах" : "Шинэ бараа нэмэх"} onClose={() => setModal(null)}>
          {["name","category","image_url"].map(k => (
            <Field key={k} label={k==="name"?"Нэр *":k==="category"?"Ангилал":"Зургийн URL"}
              value={form[k]} onChange={setF(k)}
              placeholder={k==="name"?"iPhone 15 Pro":k==="category"?"Утас, Компьютер...":"https://..."} />
          ))}
          <Field label="Тайлбар" value={form.description} onChange={setF("description")}
            placeholder="Дэлгэрэнгүй тайлбар..." area />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <Field label="Үнэ ($) *" value={form.price} onChange={setF("price")} type="number" placeholder="0.00" />
            <Field label="Нөөц" value={form.stock} onChange={setF("stock")} type="number" placeholder="0" />
          </div>
          {formErr && (
            <div style={{ background:C.errorBg, border:`1px solid rgba(229,62,62,0.2)`, borderRadius:0,
              padding:"10px 14px", color:C.error, fontSize:13, marginBottom:14 }}>{formErr}</div>
          )}
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={handleSave} disabled={saving} style={{
              flex:1, background:`linear-gradient(135deg,${C.accent},${C.accentDim})`,
              border:"none", color:"#fff", borderRadius:0, padding:"12px 0",
              fontWeight:700, fontSize:14, cursor: saving ? "wait":"pointer" }}>
              {saving ? "Хадгалж байна..." : "Хадгалах"}
            </button>
            <button onClick={() => setModal(null)} style={{ background:"transparent",
              border:`1px solid ${C.border}`, color:C.textMuted, borderRadius:0,
              padding:"12px 20px", cursor:"pointer", fontSize:14 }}>Болих</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   DATABASE TAB
══════════════════════════════════════════ */
const TABLES = [
  { key:"users",        label:"Хэрэглэгч",   desc:"Бүртгэлтэй хэрэглэгчид" },
  { key:"products",     label:"Бараа",        desc:"Дэлгүүрийн бараанууд" },
  { key:"chat_history", label:"Чатын түүх",   desc:"AI чатын бүх мессеж" },
];

function Database({ flash }) {
  const [table, setTable]   = useState("users");
  const [data, setData]     = useState(null);
  const [page, setPage]     = useState(1);
  const [loading, setLoading] = useState(true);

  const load = (t = table, p = page) => {
    setLoading(true);
    adminDbView(t, p, 20).then(setData).catch(e => flash(e.message, true)).finally(() => setLoading(false));
  };

  const switchTable = (t) => {
    if (t === table) return;
    setLoading(true);
    setTable(t);
    setPage(1);
  };

  // Fetch page 1 whenever the table changes. `alive` drops a slow response
  // for the previous table so it can't overwrite the newly selected one.
  useEffect(() => {
    let alive = true;
    adminDbView(table, 1, 20)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) flash(e.message, true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [table]);

  const goPage = (p) => { setPage(p); load(table, p); };

  const handleDelete = async (id) => {
    if (!confirm(`ID=${id} мөрийг устгах уу?`)) return;
    try { await adminDbDelete(table, id); flash("Мөр устгагдлаа"); load(table, page); }
    catch(e) { flash(e.message, true); }
  };

  const truncate = (val, max=60) => {
    if (!val && val !== 0) return <span style={{ color:C.dim }}>—</span>;
    const s = String(val);
    return s.length > max ? <span title={s}>{s.slice(0,max)}…</span> : s;
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin:0, color:C.text, fontSize:32, fontWeight:600 }}>Мэдээллийн сан</h1>
        <p style={{ margin:"6px 0 0", color:C.textMuted, fontSize:13 }}>Өгөгдлийн сангийн хүснэгтүүд</p>
      </div>

      <div style={{ display:"flex", gap:10, marginBottom:20 }}>
        {TABLES.map(t => (
          <button key={t.key} onClick={() => switchTable(t.key)} style={{
            padding:"9px 18px", borderRadius:0, border:`1px solid ${table===t.key ? C.accent : C.border}`,
            background: table===t.key ? C.accent : C.panel,
            color: table===t.key ? "#fff" : C.textMuted,
            fontWeight:600, fontSize:13, cursor:"pointer", transition:"all .12s",
          }}>{t.label}</button>
        ))}
      </div>

      {data && (
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <span style={{ color:C.textMuted, fontSize:13 }}>
            Нийт <strong style={{ color:C.text }}>{data.total}</strong> мөр · Хуудас {data.page}/{data.pages}
          </span>
          <div style={{ display:"flex", gap:8 }}>
            {[{label:"← Өмнөх",disabled:page<=1,pg:page-1},{label:"Дараах →",disabled:page>=data.pages,pg:page+1}].map(b=>(
              <button key={b.label} onClick={()=>!b.disabled&&goPage(b.pg)} disabled={b.disabled} style={{
                background:"transparent", border:`1px solid ${C.border}`, color:b.disabled?C.dim:C.text,
                borderRadius:0, padding:"6px 14px", cursor:b.disabled?"not-allowed":"pointer", fontSize:13 }}>
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ padding:60, textAlign:"center", color:C.dim, fontSize:13 }}>Ачааллаж байна...</div>
      ) : data ? (
        <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:0, overflow:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr>
                {data.columns.map(col => <TH key={col}>{col}</TH>)}
                <TH w={60}>Del</TH>
              </tr>
            </thead>
            <tbody>
              {data.rows.length===0 && (
                <tr><td colSpan={data.columns.length+1} style={{ padding:40, textAlign:"center", color:C.dim }}>Өгөгдөл байхгүй</td></tr>
              )}
              {data.rows.map((row,i) => (
                <tr key={i} style={{ borderBottom:`1px solid ${C.border}` }}
                  onMouseEnter={e=>e.currentTarget.style.background="#f7f7f7"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  {data.columns.map(col => (
                    <td key={col} style={{ padding:"10px 16px", color:col==="id"?C.accent:C.text,
                      fontWeight:col==="id"?700:400, maxWidth:240,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                      fontFamily:["id","user_id","session_id"].includes(col)?"monospace":"inherit" }}>
                      {col==="role"
                        ? <RoleBadge isAdmin={row[col]==="assistant"||row[col]==="admin"} />
                        : col==="is_admin"
                          ? <RoleBadge isAdmin={row[col]==="True"} />
                          : truncate(row[col], col==="content"?80:60)}
                    </td>
                  ))}
                  <td style={{ padding:"10px 16px" }}>
                    <ActBtn onClick={()=>handleDelete(row.id)} danger>
                      <Ic.Trash {...iconSm} />
                    </ActBtn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/* ══════════════════════════════════════════
   MAIN ADMIN PAGE
══════════════════════════════════════════ */
export default function AdminPage({ user }) {
  const navigate   = useNavigate();
  const [tab, setTab]     = useState("users");
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState(null);

  const flash = (text, err=false) => {
    setToast({ text, err });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    adminGetStats().then(setStats).catch(()=>{});
  }, []);

  const navItems = [
    { key:"dashboard", Icon:Ic.Grid,  label:"Хяналтын самбар" },
    { key:"users",     Icon:Ic.Users, label:"Хэрэглэгч",       badge: stats?.total_users },
    { key:"products",  Icon:Ic.Box,   label:"Бараа",            badge: stats?.total_products },
    { key:"database",  Icon:Ic.DB,    label:"Мэдээллийн сан" },
  ];

  return (
    <div style={{ display:"flex", minHeight:"calc(100vh - 56px)", background:C.bg }}>

      {/* ── Sidebar ── */}
      <aside style={{
        width: SIDEBAR_W, flexShrink:0, background:C.sidebar,
        display:"flex", flexDirection:"column",
        padding:"24px 12px 20px", position:"sticky",
        top:0, height:"100vh", overflowY:"auto",
      }}>
        {/* Brand */}
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"0 6px 24px" }}>
          <div style={{ width:32, height:32, borderRadius:0, background:C.accent,
            display:"flex", alignItems:"center", justifyContent:"center" }}>
            <Ic.Box width={16} height={16} stroke="#fff" />
          </div>
          <span style={{ color:"#fff", fontFamily:"var(--display)", fontSize:20, fontWeight:700, letterSpacing:"0.14em" }}>AI SHOP</span>
        </div>

        {/* Nav */}
        <div style={{ color:"rgba(255,255,255,0.35)", fontSize:10, fontWeight:700,
          letterSpacing:"0.08em", textTransform:"uppercase", padding:"0 6px 8px" }}>
          Удирдлага
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
          {navItems.map(n => (
            <NavItem key={n.key} icon={n.Icon} label={n.label}
              active={tab===n.key} onClick={()=>setTab(n.key)} badge={n.badge} />
          ))}
        </div>

        <div style={{ flex:1 }} />

        {/* Footer nav */}
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.08)", paddingTop:12, display:"flex", flexDirection:"column", gap:2 }}>
          <NavItem icon={Ic.Home} label="Дэлгүүр рүү" onClick={()=>navigate("/search")} />
          <NavItem icon={Ic.LogOut} label="Гарах" onClick={()=>{ navigate("/search"); }} />
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={{ flex:1, padding:"36px 40px", overflowY:"auto", minWidth:0 }}>

        {/* Toast */}
        {toast && (
          <div style={{
            position:"fixed", top:24, right:24, zIndex:400,
            background: C.panel,
            border:`1px solid ${toast.err ? "rgba(229,62,62,0.3)" : "rgba(22,199,132,0.3)"}`,
            color: toast.err ? C.error : C.success,
            borderRadius:0, padding:"12px 20px", fontSize:13, fontWeight:600,
            boxShadow:"none",
          }}>
            {toast.text}
          </div>
        )}

        {tab==="dashboard" && <Dashboard stats={stats} onNav={setTab} />}
        {tab==="users"     && <Users currentUser={user} flash={flash} />}
        {tab==="products"  && <Products flash={flash} />}
        {tab==="database"  && <Database flash={flash} />}
      </main>
    </div>
  );
}
