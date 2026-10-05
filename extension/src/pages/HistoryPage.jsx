import { useState, useEffect, useRef } from "react";
import { getChatSessions, getChatHistory } from "../api.js";

const C = {
  bg:     "var(--paper)",
  panel:  "var(--paper)",
  border: "var(--line)",
  text:   "var(--ink)",
  dim:    "var(--mute)",
  dimLt:  "var(--mute-2)",
  accent: "var(--ink)",
  userBg: "var(--ink)",
  aiBg:   "var(--mist)",
};

// ── Icons ──────────────────────────────────────────────────────────────────────
const IconMessage = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);
const IconBot = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/>
    <path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>
  </svg>
);
const IconUser = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
  </svg>
);
const IconEmpty = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={C.dimLt} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);
const IconClock = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
);

// ── Time helpers ───────────────────────────────────────────────────────────────
function relativeTime(dateStr) {
  const now  = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60)    return "Дөнгөж сая";
  if (diff < 3600)  return `${Math.floor(diff / 60)} мин өмнө`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} цаг өмнө`;
  if (diff < 172800) return "Өчигдөр";
  if (diff < 604800) return `${Math.floor(diff / 86400)} өдрийн өмнө`;
  return new Date(dateStr).toLocaleDateString("mn-MN", { month: "short", day: "numeric" });
}

function absoluteTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString("mn-MN", { hour: "2-digit", minute: "2-digit" });
}

function groupByDate(sessions) {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = { "Өнөөдөр": [], "Өчигдөр": [], "Энэ долоо хоног": [], "Өмнөх": [] };

  sessions.forEach(s => {
    const diff = today - new Date(new Date(s.last_at).toDateString()).getTime();
    if (diff === 0)        groups["Өнөөдөр"].push(s);
    else if (diff === 86400000) groups["Өчигдөр"].push(s);
    else if (diff < 604800000)  groups["Энэ долоо хоног"].push(s);
    else                         groups["Өмнөх"].push(s);
  });
  return groups;
}

// ── Skeleton loader ────────────────────────────────────────────────────────────
const Skeleton = ({ w = "100%", h = 14, r = 6 }) => (
  <div style={{ width: w, height: h, borderRadius: r, background: "linear-gradient(90deg,#ececec 25%,#f5f5f5 50%,#ececec 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.4s infinite" }} />
);

export default function HistoryPage({ user }) {
  const [sessions, setSessions]     = useState([]);
  const [selected, setSelected]     = useState(null);
  const [messages, setMessages]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [msgLoading, setMsgLoading] = useState(false);
  const msgEndRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    // `loading` starts as true, so no need to set it here before fetching.
    getChatSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [user]);

  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadSession = async (sessionId) => {
    if (sessionId === selected) return;
    setSelected(sessionId);
    setMessages([]);
    setMsgLoading(true);
    const data = await getChatHistory(sessionId).catch(() => []);
    setMessages(data.reverse());
    setMsgLoading(false);
  };

  const groups = groupByDate(sessions);

  return (
    <div style={{ background: C.bg, minHeight: "calc(100vh - var(--header-h))", display: "flex" }}>
      <style>{`
        @keyframes shimmer { to { background-position: -200% 0; } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .session-item:hover { background: var(--mist) !important; }
        .msg-bubble { animation: fadeUp 0.2s ease both; }
      `}</style>

      {/* ── Left sidebar ── */}
      <div style={{
        width: 280, flexShrink: 0,
        background: C.panel,
        borderRight: `1px solid ${C.border}`,
        display: "flex", flexDirection: "column",
        height: "calc(100vh - var(--header-h))",
        position: "sticky", top: "var(--header-h)",
        overflowY: "auto",
      }}>
        {/* Header */}
        <div style={{ padding: "18px 16px 12px", borderBottom: `1px solid ${C.border}` }}>
          <h2 style={{ fontSize: 22 }}>Чатын түүх</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 2 }}>{sessions.length} харилцаа</div>
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {loading ? (
            <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
              {[1,2,3,4].map(i => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <Skeleton w="60%" h={11} />
                  <Skeleton w="90%" h={13} />
                  <Skeleton w="40%" h={10} />
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center" }}>
              <IconEmpty />
              <div style={{ color: C.dim, fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>
                Чатын түүх байхгүй байна.<br />AI чатаар харилцаарай.
              </div>
            </div>
          ) : (
            Object.entries(groups).map(([label, items]) => items.length === 0 ? null : (
              <div key={label}>
                <div style={{ padding: "10px 16px 4px", color: C.dimLt, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  {label}
                </div>
                {items.map(s => (
                  <div
                    key={s.session_id}
                    className="session-item"
                    onClick={() => loadSession(s.session_id)}
                    style={{
                      padding: "10px 16px",
                      cursor: "pointer",
                      borderLeft: `3px solid ${selected === s.session_id ? C.accent : "transparent"}`,
                      background: selected === s.session_id ? "var(--mist)" : "transparent",
                      transition: "background 0.12s, border-color 0.12s",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ marginTop: 1, color: selected === s.session_id ? C.accent : C.dimLt, flexShrink: 0 }}>
                        <IconMessage />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          color: selected === s.session_id ? C.text : C.text,
                          fontSize: 13, fontWeight: selected === s.session_id ? 600 : 400,
                          lineHeight: 1.4,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {s.preview || "Харилцаа"}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.dim, fontSize: 11, marginTop: 3 }}>
                          <IconClock />
                          {relativeTime(s.last_at)}
                          <span style={{ color: C.border }}>·</span>
                          {s.message_count} мессеж
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "calc(100vh - var(--header-h))", position: "sticky", top: "var(--header-h)", overflow: "hidden" }}>
        {!selected ? (
          /* Empty state */
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 40 }}>
            <div style={{
              width: 64, height: 64, borderRadius: 0,
              background: "var(--ink)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "none",
            }}>
              <IconBot />
            </div>
            <div style={{ textAlign: "center" }}>
              <h2 style={{ fontSize: 26, marginBottom: 8 }}>Харилцаа сонгоно уу</h2>
              <div style={{ color: C.dim, fontSize: 13 }}>Зүүн талаас харилцаагаа сонгоод дэлгэрэнгүй харах боломжтой</div>
            </div>
          </div>
        ) : msgLoading ? (
          /* Loading skeleton */
          <div style={{ flex: 1, padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
            {[0,1,2,3].map(i => (
              <div key={i} style={{ display: "flex", gap: 10, flexDirection: i % 2 === 0 ? "row" : "row-reverse" }}>
                <div style={{ width: 30, height: 30, borderRadius: 0, background: "#ececec", flexShrink: 0 }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 5, maxWidth: "60%", alignItems: i % 2 === 0 ? "flex-start" : "flex-end" }}>
                  <Skeleton w={180 + i * 20} h={14} />
                  <Skeleton w={120 + i * 10} h={14} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div style={{
              padding: "14px 24px",
              borderBottom: `1px solid ${C.border}`,
              background: C.panel,
              display: "flex", alignItems: "center", gap: 10,
              flexShrink: 0,
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: 0,
                background: "var(--ink)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "none",
              }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <div>
                <div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>
                  {sessions.find(s => s.session_id === selected)?.preview || "Харилцаа"}
                </div>
                <div style={{ color: C.dim, fontSize: 11 }}>{messages.length} мессеж</div>
              </div>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
              <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 6 }}>
                {messages.map((m, i) => {
                  const isUser = m.role === "user";
                  const showDate = i === 0 || new Date(messages[i-1].created_at).toDateString() !== new Date(m.created_at).toDateString();
                  return (
                    <div key={i}>
                      {showDate && (
                        <div style={{ textAlign: "center", margin: "16px 0 10px", color: C.dimLt, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em" }}>
                          {new Date(m.created_at).toLocaleDateString("mn-MN", { year: "numeric", month: "long", day: "numeric" })}
                        </div>
                      )}
                      <div
                        className="msg-bubble"
                        style={{
                          display: "flex",
                          flexDirection: isUser ? "row-reverse" : "row",
                          alignItems: "flex-end",
                          gap: 8,
                          marginBottom: 4,
                          animationDelay: `${Math.min(i * 0.03, 0.3)}s`,
                        }}
                      >
                        {/* Avatar */}
                        <div style={{
                          width: 28, height: 28, borderRadius: 0, flexShrink: 0,
                          background: isUser
                            ? "var(--ink)"
                            : C.panel,
                          border: isUser ? "none" : `1.5px solid ${C.border}`,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          color: isUser ? "#fff" : C.dim,
                        }}>
                          {isUser ? <IconUser /> : <IconBot />}
                        </div>

                        {/* Bubble */}
                        <div style={{ maxWidth: "70%", display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
                          {m.product_context && (
                            <div style={{
                              fontSize: 11, color: C.dim, marginBottom: 3,
                              padding: "3px 8px", borderRadius: 0,
                              background: "var(--mist)",
                              border: "none",
                            }}>
                              {m.product_context}
                            </div>
                          )}
                          <div style={{
                            padding: "10px 14px",
                            borderRadius: 0,
                            background: isUser ? C.userBg : C.aiBg,
                            border: isUser ? "none" : `1px solid ${C.border}`,
                            boxShadow: "none",
                            color: isUser ? "#fff" : C.text,
                            fontSize: 13.5,
                            lineHeight: 1.6,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}>
                            {m.content}
                          </div>
                          <div style={{ color: C.dimLt, fontSize: 10.5, marginTop: 3, padding: "0 2px" }}>
                            {absoluteTime(m.created_at)}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={msgEndRef} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
