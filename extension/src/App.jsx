import { useEffect, useMemo, useRef, useState } from "react";

const api = {
  analyze: "http://127.0.0.1:8000/analyze",
  chat: "http://127.0.0.1:8000/chat",
};

export default function App() {
  // data
  const [products, setProducts] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  // page translate toggle
  const [pageMn, setPageMn] = useState(false);
  const [pageMsg, setPageMsg] = useState("");

  // status
  const [status, setStatus] = useState("ready"); // ready | loading | asking | error
  const [error, setError] = useState("");

  // analyze output
  const [mnTitle, setMnTitle] = useState("");
  const [mnDesc, setMnDesc] = useState("");

  // chat
  const [chat, setChat] = useState([]); // {role:'user'|'ai', text}
  const [chatInput, setChatInput] = useState("");
  const chatBoxRef = useRef(null);

  const selected = useMemo(
    () => (selectedIndex >= 0 ? products[selectedIndex] : null),
    [products, selectedIndex]
  );

  const scrollChatToBottom = () => {
    const el = chatBoxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    scrollChatToBottom();
  }, [chat]);

  const resetAnalyze = () => {
    setMnTitle("");
    setMnDesc("");
  };

  const loadProducts = () => {
    setStatus("loading");
    setError("");
    setPageMsg("");
    resetAnalyze();

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) {
        setError("Tab олдсонгүй.");
        setStatus("error");
        return;
      }

      chrome.tabs.sendMessage(tabId, { action: "MVP_EXTRACT" }, (res) => {
        if (chrome.runtime.lastError) {
          setError("Content script ажиллахгүй байна. Page refresh (F5) + Extension reload.");
          setStatus("error");
          return;
        }
        setProducts(res?.products || []);
        setSelectedIndex((res?.products || []).length ? 0 : -1);
        setStatus("ready");
      });
    });
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const toggleWholePage = () => {
    setError("");
    setPageMsg("");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) return;

      const next = !pageMn;

      chrome.tabs.sendMessage(
        tabId,
        { action: "PAGE_TRANSLATE_TOGGLE", enabled: next },
        (res) => {
          if (chrome.runtime.lastError) {
            setPageMsg("Page refresh (F5) хийгээд дахин оролдоорой.");
            return;
          }
          if (!res?.ok) {
            setPageMsg(res?.error || "Орчуулга дээр алдаа гарлаа.");
            return;
          }
          setPageMn(next);
          setPageMsg(next ? "✅ Хуудас Монгол боллоо" : "↩️ Original буцаалаа");
        }
      );
    });
  };

  const analyzeSelected = async () => {
    if (!selected) {
      setError("Эхлээд бүтээгдэхүүн сонгоно уу.");
      return;
    }

    setStatus("asking");
    setError("");
    resetAnalyze();

    try {
      const res = await fetch(api.analyze, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: selected.title || "",
          price: selected.price || "",
          url: selected.url || "",
          description: selected.description || selected.rawText || "",
        }),
      });

      const data = await res.json();
      if (data?.error) setError(String(data.error));

      setMnTitle(data?.mn?.title || "");
      setMnDesc(data?.mn?.description || "");
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError("Backend холбогдсонгүй. Python server асаалттай эсэхийг шалга.");
    }
  };

  const sendChat = async () => {
    const msg = (chatInput || "").trim();
    if (!msg) return;

    setChat((prev) => [...prev, { role: "user", text: msg }]);
    setChatInput("");
    setError("");
    setStatus("asking");

    try {
      const res = await fetch(api.chat, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          product_title: selected?.title || "",
          product_price: selected?.price || "",
          product_url: selected?.url || "",
          product_description: selected?.description || selected?.rawText || "",
        }),
      });

      const data = await res.json();
      if (data?.error) setError(String(data.error));

      setChat((prev) => [...prev, { role: "ai", text: data.answer || "Хариу хоосон байна." }]);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError("Backend холбогдсонгүй (chat). Python server асаалттай эсэхийг шалга.");
    }
  };

  // ---------------- UI styles ----------------
  const S = {
    wrap: {
      width: 400,
      padding: 12,
      color: "#EDEDED",
      background: "#0F1115",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial",
    },
    topRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
    title: { fontSize: 14, fontWeight: 800, letterSpacing: 0.2 },
    pill: (tone) => ({
      fontSize: 11,
      padding: "4px 8px",
      borderRadius: 999,
      border: "1px solid rgba(255,255,255,0.08)",
      background:
        tone === "ok"
          ? "rgba(0,255,164,0.12)"
          : tone === "warn"
          ? "rgba(255,208,0,0.12)"
          : "rgba(255,80,80,0.12)",
      color:
        tone === "ok" ? "#62FBC5" : tone === "warn" ? "#FFD26A" : "#FF7A7A",
      whiteSpace: "nowrap",
    }),
    btn: (variant = "primary", disabled = false) => ({
      width: "100%",
      padding: "10px 10px",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.10)",
      background:
        variant === "primary"
          ? "linear-gradient(180deg, rgba(114,168,255,0.35), rgba(114,168,255,0.15))"
          : "rgba(255,255,255,0.06)",
      color: "#EDEDED",
      fontWeight: 700,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.55 : 1,
      transition: "0.2s",
    }),
    card: {
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(255,255,255,0.04)",
      borderRadius: 14,
      padding: 10,
    },
    input: {
      width: "100%",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(0,0,0,0.25)",
      color: "#EDEDED",
      padding: "10px 10px",
      outline: "none",
    },
    textarea: {
      width: "100%",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(0,0,0,0.25)",
      color: "#EDEDED",
      padding: "10px 10px",
      outline: "none",
      resize: "none",
    },
    list: {
      maxHeight: 170,
      overflowY: "auto",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.08)",
      background: "rgba(0,0,0,0.15)",
    },
    item: (active) => ({
      padding: 10,
      cursor: "pointer",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      background: active ? "rgba(98,251,197,0.10)" : "transparent",
    }),
    itemTitle: { fontSize: 12, fontWeight: 800, lineHeight: 1.2 },
    itemSub: { fontSize: 11, color: "rgba(237,237,237,0.75)", marginTop: 4 },
    chatBox: {
      maxHeight: 160,
      overflowY: "auto",
      padding: 10,
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.08)",
      background: "rgba(0,0,0,0.15)",
    },
    bubble: (role) => ({
      maxWidth: "92%",
      padding: "8px 10px",
      borderRadius: 12,
      marginBottom: 8,
      whiteSpace: "pre-wrap",
      lineHeight: 1.25,
      fontSize: 12.5,
      alignSelf: role === "user" ? "flex-end" : "flex-start",
      background:
        role === "user"
          ? "linear-gradient(180deg, rgba(114,168,255,0.40), rgba(114,168,255,0.18))"
          : "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.10)",
    }),
    hr: { height: 1, background: "rgba(255,255,255,0.08)", border: "none", margin: "10px 0" },
    small: { fontSize: 11, color: "rgba(237,237,237,0.70)" },
    row: { display: "flex", gap: 8, alignItems: "center" },
  };

  const statusTone = status === "ready" ? "ok" : status === "loading" || status === "asking" ? "warn" : "bad";

  return (
    <div style={S.wrap}>
      {/* Header */}
      <div style={S.topRow}>
        <div style={S.title}>🛒 Орчуулгатай Худалдааны Туслах</div>
        <div style={S.pill(statusTone)}>
          {status === "ready" ? "Ready" : status === "loading" ? "Loading" : status === "asking" ? "Working" : "Error"}
        </div>
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button style={S.btn("secondary", status === "loading")} onClick={loadProducts} disabled={status === "loading"}>
          ↻ Refresh бүтээгдэхүүн
        </button>
        <button style={S.btn("secondary")} onClick={toggleWholePage}>
          {pageMn ? "↩️ Original" : "🌍 Хуудсыг Монгол"}
        </button>
      </div>

      {(pageMsg || error) && (
        <div style={{ marginTop: 8, ...S.card }}>
          {pageMsg && <div style={{ fontSize: 12, color: "#62FBC5" }}>{pageMsg}</div>}
          {error && <div style={{ fontSize: 12, color: "#FF7A7A", marginTop: pageMsg ? 6 : 0 }}>{error}</div>}
        </div>
      )}

      {/* Product List */}
      <div style={{ marginTop: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontWeight: 800, fontSize: 12 }}>Бүтээгдэхүүн</div>
          <div style={S.small}>Олдсон: {products.length}</div>
        </div>

        <div style={S.list}>
          {products.length === 0 ? (
            <div style={{ padding: 10, fontSize: 12, color: "rgba(237,237,237,0.70)" }}>
              Бүтээгдэхүүн олдсонгүй. Refresh хийгээд үз.
            </div>
          ) : (
            products.map((p, i) => (
              <div key={i} style={S.item(i === selectedIndex)} onClick={() => setSelectedIndex(i)}>
                <div style={S.itemTitle}>{p.title}</div>
                <div style={S.itemSub}>Үнэ: {p.price || "?"}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button
          style={S.btn("primary", status === "asking" || !selected)}
          disabled={status === "asking" || !selected}
          onClick={analyzeSelected}
        >
          {status === "asking" ? "Орчуулж байна..." : "Монгол тайлбар (Selected)"}
        </button>
      </div>

      {/* Analyze Output */}
      {(mnTitle || mnDesc) && (
        <div style={{ marginTop: 10, ...S.card }}>
          <div style={{ fontWeight: 900, fontSize: 12 }}>📌 Монгол орчуулга</div>
          {mnTitle && <div style={{ marginTop: 6, fontSize: 13, fontWeight: 800 }}>{mnTitle}</div>}
          {mnDesc && <div style={{ marginTop: 6, fontSize: 12.5, whiteSpace: "pre-wrap", color: "rgba(237,237,237,0.85)" }}>{mnDesc}</div>}
        </div>
      )}

      <hr style={S.hr} />

      {/* Chat */}
      <div style={{ fontWeight: 900, fontSize: 12, marginBottom: 6 }}>💬 Chat</div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div ref={chatBoxRef} style={S.chatBox}>
          {chat.length === 0 ? (
            <div style={S.small}>Энд чат эхэлнэ. (ж: “Энэ бараа надад тохирох уу?”)</div>
          ) : (
            chat.map((m, idx) => (
              <div key={idx} style={S.bubble(m.role)}>
                {m.text}
              </div>
            ))
          )}
        </div>

        <div style={{ marginTop: 8, ...S.row }}>
          <textarea
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Мессеж бичээд Enter дар (Shift+Enter = шинэ мөр)…"
            style={{ ...S.textarea, height: 52 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChat();
              }
            }}
          />
        </div>

        <button style={S.btn("secondary", status === "asking")} onClick={sendChat} disabled={status === "asking"}>
          {status === "asking" ? "Илгээж байна..." : "Send"}
        </button>

        <div style={{ marginTop: 6, fontSize: 11, color: "rgba(237,237,237,0.65)" }}>
          Сонгосон бүтээгдэхүүний контекстээр чат хийнэ: {selected ? "✅" : "❌ (сонго)"}
        </div>
      </div>
    </div>
  );
}