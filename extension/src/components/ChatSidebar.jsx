import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { sendChat, getChatHistory, compareProducts } from "../api.js";
import { G } from "./Art.jsx";

const USD_TO_MNT = 3450;

function toMNT(price, priceText) {
  if (price && price > 0) return `₮${Math.round(price * USD_TO_MNT).toLocaleString()}`;
  const rawText = String(priceText || "").trim();
  if (rawText && rawText !== "None" && rawText !== "—") {
    const first   = rawText.split(/\s+to\s+|\s*[–—]\s*|\s+-\s+/)[0];
    const cleaned = first.replace(/\b(USD|CAD|AUD|GBP|CNY|US)\b/gi, "").replace(/[₮€£¥₩₽]/g, "").trim();
    const m       = cleaned.match(/\$?([\d,]+\.?\d*)/);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(num) && num > 0 && num < 10000) return `₮${Math.round(num * USD_TO_MNT).toLocaleString()}`;
    }
  }
  return "—";
}

function renderFormatted(text) {
  return text.split("\n").map((line, i, arr) => {
    const parts = line.split(/\*\*(.*?)\*\*/g);
    const nodes = parts.map((p, j) =>
      j % 2 === 1 ? <strong key={j} style={{ fontWeight: 700 }}>{p}</strong> : p
    );
    return <span key={i}>{nodes}{i < arr.length - 1 && <br />}</span>;
  });
}

function Bubble({ role, content, isAction }) {
  if (isAction) {
    return (
      <div className="fade-in" style={{
        alignSelf: "flex-start", maxWidth: "90%",
        border: "1px dashed var(--ink)", padding: "7px 11px",
        fontSize: 11.5, fontWeight: 600, display: "flex", alignItems: "flex-start", gap: 7,
      }}>
        <span style={{ flexShrink: 0, marginTop: 2 }}><G.filter size={11} /></span>
        <span>{content}</span>
      </div>
    );
  }
  const isUser = role === "user";
  return (
    <div className="fade-in" style={{
      alignSelf:  isUser ? "flex-end" : "flex-start",
      background: isUser ? "var(--ink)" : "var(--mist)",
      color:      isUser ? "var(--paper)" : "var(--ink)",
      padding:    "10px 14px",
      maxWidth:   "86%",
      fontSize:   13,
      lineHeight: 1.6,
      wordBreak:  "break-word",
    }}>
      {role === "ai" ? renderFormatted(content) : content}
    </div>
  );
}

const SEARCH_PAGE_PROMPTS = ["Хямд iPhone хайж өг", "Budget gaming mouse хайж өг", "Sony laptop харуул", "Хямд чихэвч хайж өг"];
const DEFAULT_PROMPTS     = ["Хамгийн сайн ноутбук аль вэ?", "Хямд утас санал болго", "Чихэвч харьцуулж өг"];
const PRODUCT_PROMPTS     = ["Авах уу? Зөвлөгөө өг", "Давуу болон сул тал юу вэ?", "Үнэ зохистой юу?", "Хэнд тохиромжтой?"];

function LoadingDots() {
  return (
    <div style={{ alignSelf: "flex-start", background: "var(--mist)", padding: "13px 16px", display: "flex", gap: 5 }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: 6, height: 6, background: "var(--ink)",
          animation: `dotBounce 1.2s ${i * 0.18}s infinite ease-in-out`,
        }} />
      ))}
    </div>
  );
}

const chipStyle = {
  background: "var(--paper)", border: "1px solid var(--line)",
  padding: "5px 10px", fontSize: 11, color: "var(--ink-2)",
  transition: "border-color .15s, background .15s, color .15s",
};

function ChatPanel({ user, contextProduct, onSearch, onFilter, isOnSearchPage, activeQuery }) {
  const navigate = useNavigate();
  const [sessionId] = useState(() => {
    const ex = sessionStorage.getItem("chat_session_id");
    if (ex) return ex;
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem("chat_session_id", id);
    return id;
  });

  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState("");
  const [loading, setLoading]     = useState(false);
  const [product, setProduct]     = useState(null);
  const [comparing, setComparing] = useState(false);
  const [compareResults, setCompareResults] = useState(null);
  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);

  useEffect(() => {
    if (!contextProduct) return;
    setProduct(contextProduct);
    // Auto-request advice immediately when user clicks "AI зөвлөгөө" on a result card
    const msg = "Энэ барааны зөвлөгөө өг. Давуу болон сул тал, үнэ зүйтэй эсэх, хэнд тохиромжтой болохыг хэлж өг.";
    setMessages(prev => [...prev, { role: "user", content: msg }]);
    setLoading(true);
    sendChat({
      message:       msg,
      product:       contextProduct,
      sessionId:     user ? sessionId : null,
      history:       [],
      searchContext: activeQuery || "",
    }).then(data => {
      setMessages(prev => [...prev, { role: "ai", content: data.answer || "Хариу хоосон байна." }]);
    }).catch(e => {
      setMessages(prev => [...prev, { role: "ai", content: e.message }]);
    }).finally(() => setLoading(false));
  }, [contextProduct]);

  useEffect(() => {
    const welcome = user
      ? `Сайн байна уу, ${user.username}! Онлайн дэлгүүрт хамгийн тохиромжтой бараа олоход туслана.\nМонгол эсвэл англиар юу хайж байна?`
      : "Сайн байна уу! Би онлайн худалдааны AI туслах.\nБараа хайх, үнэ харьцуулах, зөвлөгөө авахад туслана — юу хайж байна вэ?";
    if (!user) { setMessages([{ role: "ai", content: welcome }]); return; }
    getChatHistory(sessionId).then(history => {
      if (history.length > 0) setMessages(history.reverse().map(h => ({ role: h.role, content: h.content })));
      else setMessages([{ role: "ai", content: welcome }]);
    }).catch(() => setMessages([{ role: "ai", content: welcome }]));
  }, [user, sessionId]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const handleSend = async (overrideMsg) => {
    const msg = (overrideMsg || input).trim();
    if (!msg || loading) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setMessages(prev => [...prev, { role: "user", content: msg }]);
    setLoading(true);
    try {
      const data = await sendChat({
        message:       msg,
        product,
        sessionId:     user ? sessionId : null,
        history:       messages.slice(-6).map(m => ({ role: m.role, content: m.content })),
        searchContext: activeQuery || "",
      });
      setMessages(prev => [...prev, { role: "ai", content: data.answer || "Хариу хоосон байна." }]);
      if (data.intent === "search" && data.search_query) {
        const query = data.search_query;
        if (!isOnSearchPage) navigate("/search");
        setTimeout(() => onSearch(query), 100);
        setMessages(prev => [...prev, { role: "ai", isAction: true, content: `"${query}" хайлтыг эхлүүллээ...` }]);
      } else if (data.intent === "filter" && data.filters) {
        const f = data.filters;
        const parts = [
          f.color     && `өнгө: ${f.color}`,
          f.brand     && `брэнд: ${f.brand}`,
          f.keyword   && `"${f.keyword}"`,
          f.max_price && `≤ ${toMNT(Number(f.max_price))}`,
          f.min_price && `≥ ${toMNT(Number(f.min_price))}`,
          f.store     && `дэлгүүр: ${f.store}`,
        ].filter(Boolean);
        onFilter(f);
        setMessages(prev => [...prev, { role: "ai", isAction: true, content: `Шүүлт: ${parts.join(" · ") || "шинэчлэлт"}` }]);
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: "ai", content: e.message }]);
    } finally {
      setLoading(false);
    }
  };

  const handleCompare = async () => {
    if (!product) return;
    setComparing(true); setCompareResults(null);
    try {
      const data  = await compareProducts(product.name);
      const all   = data.results || [];
      setCompareResults([...all.filter(r => !r.is_search_link).slice(0, 5), ...all.filter(r => r.is_search_link).slice(0, 4)]);
    } catch { setCompareResults([]); }
    finally { setComparing(false); }
  };

  const clearChat = () => { sessionStorage.removeItem("chat_session_id"); window.location.reload(); };
  const quickPrompts = product ? PRODUCT_PROMPTS : isOnSearchPage ? SEARCH_PAGE_PROMPTS : DEFAULT_PROMPTS;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* Sub-header */}
      <div style={{
        padding: "10px 16px", borderBottom: "1px solid var(--line)",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5 }}>
          {user ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
              <G.user size={13} /> {user.username}
            </span>
          ) : (
            <span style={{ color: "var(--mute)" }}>Зочин горим</span>
          )}
          {isOnSearchPage && (
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", border: "1px solid var(--ink)", padding: "2px 6px" }}>
              <G.search size={10} /> Хайлт
            </span>
          )}
        </div>
        <button onClick={clearChat} title="Чат арилгах" aria-label="Чат арилгах" className="icon-btn" style={{ width: 30, height: 30 }}>
          <G.trash size={13} />
        </button>
      </div>

      {/* Product context */}
      {product && (
        <div className="fade-in" style={{ margin: "12px 14px 0", background: "var(--mist)", padding: "12px 12px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div className="eyebrow" style={{ fontSize: 9 }}>Сонгосон бараа</div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {product.name}
              </div>
            </div>
            <button onClick={() => { setProduct(null); setCompareResults(null); }} aria-label="Хаах"
              style={{ background: "none", border: "none", color: "var(--mute)", padding: 2, display: "flex" }}>
              <G.x size={14} />
            </button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-sm" style={{ flex: 1 }} disabled={loading}
              onClick={() => handleSend("Энэ барааны зөвлөгөө өг. Давуу болон сул тал, үнэ зүйтэй эсэх, хэнд тохиромжтой болохыг хэлж өг.")}>
              <G.spark size={12} /> Зөвлөгөө
            </button>
            <button className="btn btn-outline btn-sm" style={{ flex: 1 }} disabled={comparing} onClick={handleCompare}>
              {comparing ? "Түр хүлээнэ үү" : "Харьцуулах"}
            </button>
          </div>

          {compareResults && compareResults.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
              {compareResults.filter(r => !r.is_search_link).map((r, i) => (
                <a key={`real-${i}`} href={r.url} target="_blank" rel="noreferrer"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "var(--paper)", border: "1px solid var(--line)", padding: "6px 9px" }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = "var(--ink)"}
                  onMouseLeave={e => e.currentTarget.style.borderColor = "var(--line)"}
                >
                  <span style={{ fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    <span style={{ fontFamily: "var(--display)", fontSize: 13 }}>{toMNT(r.price, r.price_text)}</span>
                    <span style={{ background: "var(--ink)", color: "#fff", fontSize: 8.5, fontWeight: 700, letterSpacing: ".08em", padding: "1px 5px", textTransform: "uppercase" }}>{r.source}</span>
                  </span>
                </a>
              ))}
              {compareResults.some(r => r.is_search_link) && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                  {compareResults.filter(r => r.is_search_link).map((r, i) => (
                    <a key={`link-${i}`} href={r.url} target="_blank" rel="noreferrer" style={{ ...chipStyle, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                      {r.source} <G.arrow size={10} />
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          {compareResults && compareResults.length === 0 && (
            <div style={{ color: "var(--mute)", fontSize: 11, marginTop: 8, textAlign: "center" }}>Үр дүн олдсонгүй</div>
          )}
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} isAction={m.isAction} />
        ))}
        {loading && <LoadingDots />}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick prompts */}
      {(messages.length <= 1 || product) && (
        <div style={{ padding: "0 14px 10px", display: "flex", gap: 6, flexWrap: "wrap", flexShrink: 0 }}>
          {quickPrompts.map(p => (
            <button key={p} onClick={() => handleSend(p)} style={chipStyle}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--ink)"; e.currentTarget.style.background = "var(--ink)"; e.currentTarget.style.color = "#fff"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.background = "var(--paper)"; e.currentTarget.style.color = "var(--ink-2)"; }}
            >{p}</button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ borderTop: "1px solid var(--line)", padding: 14, display: "flex", gap: 0, alignItems: "stretch", flexShrink: 0 }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={isOnSearchPage ? "Хайлт өөрчлөх, шүүлт тохируулах..." : "Монгол эсвэл англиар асуугаарай..."}
          aria-label="Мессеж"
          rows={1}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          onInput={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 110) + "px"; }}
          onFocus={e => { e.target.style.borderColor = "var(--ink)"; }}
          onBlur={e => { e.target.style.borderColor = "var(--line)"; }}
          style={{
            flex: 1, background: "var(--paper)", border: "1px solid var(--line)", borderRight: "none",
            padding: "12px 12px", fontSize: 13, outline: "none", resize: "none",
            maxHeight: 110, lineHeight: 1.5, borderRadius: 0, transition: "border-color .15s",
          }}
        />
        <button
          onClick={() => handleSend()}
          disabled={!input.trim() || loading}
          aria-label="Илгээх"
          className="btn"
          style={{ padding: 0, width: 48, flexShrink: 0 }}
        >
          <G.send size={16} />
        </button>
      </div>
    </div>
  );
}

export default function ChatSidebar({ user, contextProduct = null, open = true, onToggle, onSearch, onFilter, isOnSearchPage, activeQuery = "" }) {
  return (
    <aside
      aria-label="AI туслах"
      aria-hidden={!open}
      style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: "min(var(--chat-w), 100vw)",
        background: "var(--paper)",
        borderLeft: "1px solid var(--ink)",
        display: "flex", flexDirection: "column",
        zIndex: 200,
        transform: open ? "translateX(0)" : "translateX(100%)",
        visibility: open ? "visible" : "hidden",
        transition: "transform .32s var(--ease), visibility .32s",
        boxShadow: open ? "-20px 0 40px -30px rgba(0,0,0,.5)" : "none",
      }}
    >
      {/* Black header — same height as the top bar + site header */}
      <div style={{
        background: "var(--ink)", color: "#fff", flexShrink: 0,
        height: "calc(34px + var(--header-h))", padding: "0 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div>
          <div style={{ fontFamily: "var(--display)", fontSize: 24, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", lineHeight: 1 }}>
            AI туслах
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "#aaa" }}>
            <span style={{ width: 6, height: 6, background: "#3ddc84", display: "inline-block" }} />
            Онлайн · Монгол хэлээр
          </div>
        </div>
        <button onClick={onToggle} aria-label="Хаах"
          style={{ width: 36, height: 36, background: "transparent", border: "1px solid #444", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}
          onMouseEnter={e => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.color = "var(--ink)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#fff"; }}
        >
          <G.x size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <ChatPanel
          user={user}
          contextProduct={contextProduct}
          onSearch={onSearch}
          onFilter={onFilter}
          isOnSearchPage={isOnSearchPage}
          activeQuery={activeQuery}
        />
      </div>
    </aside>
  );
}
