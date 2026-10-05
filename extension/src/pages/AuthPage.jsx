import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, register, setToken } from "../api.js";
import { Logo } from "../components/Navbar.jsx";
import { G, BagArt } from "../components/Art.jsx";

const GUEST_FEATURES  = ["Бараа хайх — 6 дэлгүүрээс", "Үнэ харьцуулах, хамгийн хямдыг олох", "AI чатаар асуух"];
const MEMBER_FEATURES = ["Хайлтын түүх хадгалах", "Чатын яриаг хадгалах", "Хувийн тохиргоо"];

function FieldInput({ label, type = "text", value, onChange, placeholder, autoComplete }) {
  const id = `f-${label}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} autoComplete={autoComplete}
        onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

export default function AuthPage({ onAuth }) {
  const navigate = useNavigate();
  const [mode, setMode]         = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      let data;
      if (mode === "login") {
        data = await login(username, password);
      } else {
        if (!email.trim()) { setError("Email шаардлагатай"); setLoading(false); return; }
        data = await register(username, email, password);
      }
      setToken(data.access_token);
      onAuth(data.user, data.access_token);
      navigate("/search");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = username.trim() && password.trim();

  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }} className="auth-grid">
      <style>{`@media (max-width: 860px) { .auth-grid { grid-template-columns: 1fr !important; } .auth-left { display: none !important; } }`}</style>

      {/* ── LEFT: black brand panel ── */}
      <div className="auth-left" style={{ background: "var(--ink)", color: "#fff", padding: "48px 56px", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
        <Logo size={24} color="#fff" onClick={() => navigate("/search")} />

        <div style={{ position: "absolute", right: -60, bottom: -40, width: 340, opacity: 0.08, filter: "invert(1)" }}>
          <BagArt />
        </div>

        <div style={{ marginTop: "auto", position: "relative" }}>
          <div className="eyebrow" style={{ color: "#8a8a8a" }}>Онлайн худалдааны AI туслах</div>
          <h1 style={{ fontSize: "clamp(40px, 5vw, 68px)", margin: "14px 0 30px", lineHeight: 1 }}>
            Хайх.<br />Харьцуулах.<br /><span style={{ color: "transparent", WebkitTextStroke: "1px #fff" }}>Хэмнэх.</span>
          </h1>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, maxWidth: 520 }}>
            <div>
              <div className="eyebrow" style={{ color: "#8a8a8a", marginBottom: 12 }}>Бүртгэлгүйгээр</div>
              {GUEST_FEATURES.map(t => (
                <div key={t} style={{ display: "flex", gap: 10, fontSize: 12.5, marginBottom: 9, color: "#e8e8e8" }}>
                  <span style={{ color: "#fff" }}>—</span>{t}
                </div>
              ))}
            </div>
            <div>
              <div className="eyebrow" style={{ color: "#8a8a8a", marginBottom: 12 }}>Бүртгэлтэй бол</div>
              {MEMBER_FEATURES.map(t => (
                <div key={t} style={{ display: "flex", gap: 10, fontSize: 12.5, marginBottom: 9, color: "#bdbdbd" }}>
                  <span style={{ color: "#fff" }}>+</span>{t}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── RIGHT: form ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 24px" }}>
        <div className="fade-up" style={{ width: "100%", maxWidth: 380 }}>
          <div className="tabs" style={{ marginBottom: 34 }}>
            {[
              { key: "login",    label: "Нэвтрэх" },
              { key: "register", label: "Бүртгүүлэх" },
            ].map(({ key, label }) => (
              <button key={key} className={`tab ${mode === key ? "active" : ""}`} onClick={() => { setMode(key); setError(""); }}>
                {label}
              </button>
            ))}
          </div>

          <h2 style={{ fontSize: 38 }}>{mode === "login" ? "Тавтай морил" : "Шинэ бүртгэл"}</h2>
          <p style={{ color: "var(--mute)", fontSize: 13, margin: "8px 0 32px" }}>
            {mode === "login" ? "Данс руугаа нэвтэрнэ үү" : "Бүртгэл үүсгээд бүх боломжийг нээгээрэй"}
          </p>

          <form onSubmit={handleSubmit}>
            <FieldInput label="Хэрэглэгчийн нэр" value={username} onChange={setUsername} placeholder="username" autoComplete="username" />
            {mode === "register" && (
              <FieldInput label="Email" type="email" value={email} onChange={setEmail} placeholder="example@email.com" autoComplete="email" />
            )}
            <FieldInput label="Нууц үг" type="password" value={password} onChange={setPassword} placeholder="••••••••"
              autoComplete={mode === "login" ? "current-password" : "new-password"} />

            {error && (
              <div role="alert" style={{ borderLeft: "3px solid var(--sale)", background: "#fdf2f3", padding: "10px 14px", color: "var(--sale)", fontSize: 12.5, marginBottom: 18 }}>
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-block" disabled={loading || !canSubmit} style={{ padding: "16px 0", marginTop: 8 }}>
              {loading ? <><span className="spinner" /> Түр хүлээнэ үү</> : <>{mode === "login" ? "Нэвтрэх" : "Бүртгүүлэх"} <G.arrow size={13} /></>}
            </button>
          </form>

          <button className="link-tab" onClick={() => navigate("/search")} style={{ marginTop: 26, display: "flex", alignItems: "center", gap: 8 }}>
            Нэвтрэхгүйгээр үргэлжлүүлэх <G.arrow size={12} />
          </button>

          <p style={{ color: "var(--mute-2)", fontSize: 11, marginTop: 22, lineHeight: 1.7 }}>
            Бүртгэлгүй хэрэглэгч хайлт хийх, үнэ харьцуулах боломжтой. Хайлтын түүх хадгалахад бүртгэл шаардлагатай.
          </p>
        </div>
      </div>
    </div>
  );
}
