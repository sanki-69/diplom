// Replaced at build time from VITE_API_URL / VITE_WEB_URL (see vite.config.js),
// so a deployed build of the extension talks to the deployed backend.
const API_BASE   = "http://127.0.0.1:8000";
const WEB_URL    = "http://localhost:5173";
const PROMO_KEY      = "__ai_promo_shown";
const CHAT_COUNT_KEY = "__ai_chat_count";

// ── Utils ─────────────────────────────────────────────────────────────────────
function clean(t) { return (t || "").replace(/\s+/g, " ").trim(); }
const PRICE_RE = /(?:₮|¥|\$|€|£)\s?\d|(\d[\d.,\s]{1,}\s?(₮|¥|\$|€|£))/;

const USD_TO_MNT = 3450;
function toMNT(price, priceText) {
  if (price && price > 0) return `₮${Math.round(price * USD_TO_MNT).toLocaleString()}`;
  if (priceText) {
    const num = parseFloat((priceText || "").replace(/[^0-9.]/g, ""));
    if (!isNaN(num) && num > 0) return `₮${Math.round(num * USD_TO_MNT).toLocaleString()}`;
  }
  return "—";
}

// ── Product extraction from current page ──────────────────────────────────────
const GARBAGE_PATTERNS = [
  /keyboard\s+shortcut/i, /skip\s+to\s+(main|content)/i, /screen\s+reader/i,
  /javascript/i, /cookie\s+policy/i, /privacy\s+policy/i, /terms\s+of\s+service/i,
  /add\s+to\s+(cart|bag|basket)/i,
];
function isValidTitle(t) {
  if (!t || t.length < 2 || t.length > 200) return false;
  return !GARBAGE_PATTERNS.some(re => re.test(t));
}

function extractProducts() {
  const nodes = Array.from(document.querySelectorAll("span,div,p,strong"))
    .filter(n => PRICE_RE.test(clean(n.innerText)));
  const results = [], seen = new Set();
  for (const el of nodes) {
    const card = el.closest("a,article,li,div");
    if (!card) continue;
    const text  = clean(card.innerText);
    const price = (text.match(PRICE_RE) || [""])[0];
    const img   = card.querySelector("img");
    const link  = card.querySelector("a[href]");
    const title = clean(img?.alt) || clean(text.replace(price, "")).slice(0, 80);
    const url   = link ? new URL(link.href, location.href).toString() : "";
    if (!title || !price || !isValidTitle(title)) continue;
    const key = `${title}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ title, price, url, description: text.slice(0, 300) });
    if (results.length >= 20) break;
  }
  return results;
}

function extractDetailProduct() {
  const titleSelectors = [
    "#productTitle", "#title", "h1.product-title", "h1.productTitle",
    "[data-automation='product-title']", "h1[itemprop='name']",
    ".product_title", ".pdp-title",
  ];
  let title = "";
  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    if (el) { const t = clean(el.innerText); if (isValidTitle(t)) { title = t; break; } }
  }
  if (!title) {
    const h1 = document.querySelector("h1");
    if (h1) { const t = clean(h1.innerText); if (isValidTitle(t)) title = t; }
  }
  const priceSelectors = [
    ".a-price .a-offscreen", "#priceblock_ourprice", "#priceblock_dealprice",
    ".priceToPay .a-offscreen", "#price_inside_buybox",
    "[data-automation='product-price']", "[itemprop='price']",
    ".product-price", ".price", ".pdp-price",
  ];
  let price = "";
  for (const sel of priceSelectors) {
    const el = document.querySelector(sel);
    if (el) { price = clean(el.getAttribute("content") || el.innerText); if (price) break; }
  }
  if (!price) {
    const el = Array.from(document.querySelectorAll("span,div,p"))
      .find(n => PRICE_RE.test(clean(n.innerText)));
    if (el) price = (clean(el.innerText).match(PRICE_RE) || [""])[0];
  }
  const descSelectors = [
    "#feature-bullets", "#productDescription", "#dpx-feature-bullets",
    "[data-automation='product-description']", "[itemprop='description']",
    ".product-description", ".pdp-description", ".product__description",
  ];
  let description = "";
  for (const sel of descSelectors) {
    const el = document.querySelector(sel);
    if (el) { description = clean(el.innerText).slice(0, 800); break; }
  }
  if (!title || !price) {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        for (const n of [data, ...(data["@graph"] || [])]) {
          if (n["@type"] === "Product") {
            if (!title) title = clean(n.name || "");
            if (!price) {
              const offer = Array.isArray(n.offers) ? n.offers[0] : n.offers;
              price = String(offer?.price || offer?.lowPrice || "");
            }
            if (!description) description = clean(n.description || "").slice(0, 800);
          }
        }
      } catch {}
    }
  }
  if (!title) return null;
  return { title, price, url: location.href, description };
}

// ── Page translate ────────────────────────────────────────────────────────────
let backup = null, isTranslating = false;

function collectTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const t = clean(node.nodeValue);
    const tag = node.parentElement?.tagName?.toLowerCase() || "";
    if (t.length > 1 && t.length < 400 &&
        !["script","style","noscript","textarea","input"].includes(tag) &&
        !node.parentElement?.closest("#__ai_widget_root")) {
      nodes.push(node);
    }
  }
  return nodes;
}

async function translatePage(onProgress) {
  if (backup || isTranslating) return;
  isTranslating = true;
  const nodes = collectTextNodes();
  backup = new Map();
  const texts = [];
  for (const n of nodes) { backup.set(n, n.nodeValue); texts.push(n.nodeValue); }
  try {
    const lang = document.documentElement.lang || "";
    const source_lang = lang.startsWith("zh") ? "zh" : "en";
    onProgress?.("🔄 Орчуулж байна...");
    const res  = await fetch(`${API_BASE}/translate_page`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts, source_lang }),
    });
    const data = await res.json();
    if (!data.translated) throw new Error("No data");
    nodes.forEach((n, i) => { if (data.translated[i]) n.nodeValue = data.translated[i]; });
    onProgress?.("✅ Хуудас Монгол боллоо");
  } catch {
    backup = null;
    onProgress?.("❌ Орчуулга амжилтгүй");
  } finally { isTranslating = false; }
}

function restorePage(onProgress) {
  if (!backup) return;
  for (const [node, txt] of backup.entries()) { try { node.nodeValue = txt; } catch {} }
  backup = null;
  onProgress?.("↩️ Original буцаалаа");
}

// ── Smart search ──────────────────────────────────────────────────────────────
let searchOverlay = null;

function showSearchOverlay(text) {
  removeSearchOverlay();
  searchOverlay = document.createElement("div");
  searchOverlay.textContent = text;
  Object.assign(searchOverlay.style, {
    position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)",
    zIndex: "2147483646",
    background: "rgba(253,252,249,0.96)", color: "#1d1a16",
    padding: "10px 20px", borderRadius: "12px",
    border: "1.5px solid rgba(109,91,230,0.25)",
    boxShadow: "0 8px 32px rgba(109,91,230,0.18), 0 2px 8px rgba(0,0,0,0.08)",
    fontSize: "13px", fontWeight: "600",
    fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
    maxWidth: "360px", lineHeight: "1.35",
  });
  document.body.appendChild(searchOverlay);
}
function removeSearchOverlay() {
  if (searchOverlay?.parentNode) searchOverlay.parentNode.removeChild(searchOverlay);
  searchOverlay = null;
}
function setNativeInputValue(input, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input",  { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function findSearchInput() {
  const amazon = document.querySelector("#twotabsearchtextbox");
  if (amazon) return amazon;
  for (const sel of [
    "input[type='search']", "input[name='field-keywords']",
    "input[placeholder*='Search']", "input[placeholder*='search']",
    "input[aria-label*='Search']", "input[aria-label*='search']",
  ]) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return Array.from(document.querySelectorAll("input")).filter(el => el.offsetParent !== null)[0] || null;
}
function submitClosestForm(input) {
  const form = input.closest("form");
  if (form) {
    const btn = form.querySelector("input[type='submit'], button[type='submit']");
    if (btn) { btn.click(); return; }
    try { form.submit(); return; } catch {}
  }
  ["keydown","keyup"].forEach(type =>
    input.dispatchEvent(new KeyboardEvent(type, { key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true }))
  );
}
function smartSearch(query) {
  const keyword = clean(query);
  if (!keyword) return;
  showSearchOverlay(`🔍 "${keyword}" хайж байна...`);
  const found = findSearchInput();
  if (found) {
    found.focus();
    setNativeInputValue(found, keyword);
    setTimeout(() => submitClosestForm(found), 300);
    setTimeout(removeSearchOverlay, 2500);
  } else {
    setTimeout(removeSearchOverlay, 3000);
  }
}

// ── Draggable helper ──────────────────────────────────────────────────────────
function makeDraggable(el, handle) {
  let startX, startY, startLeft, startTop, dragging = false;
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = el.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    el.style.left   = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  startLeft + e.clientX - startX)) + "px";
    el.style.top    = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop  + e.clientY - startY)) + "px";
    el.style.right  = "auto";
    el.style.bottom = "auto";
  });
  document.addEventListener("mouseup", () => { dragging = false; });
}

// ── Floating widget ───────────────────────────────────────────────────────────
function injectWidget() {
  if (document.getElementById("__ai_widget_root")) return;

  // Inject global keyframe styles once
  if (!document.getElementById("__ai_widget_styles")) {
    const style = document.createElement("style");
    style.id = "__ai_widget_styles";
    style.textContent = `
      #__ai_widget_root * { box-sizing: border-box; }
      @keyframes __ai_dotBounce {
        0%, 80%, 100% { transform: scale(0.55); opacity: 0.35; }
        40%            { transform: scale(1);    opacity: 1; }
      }
      @keyframes __ai_float {
        0%, 100% { transform: translateY(0); }
        50%       { transform: translateY(-4px); }
      }
      #__ai_widget_root ::-webkit-scrollbar { width: 3px; }
      #__ai_widget_root ::-webkit-scrollbar-track { background: transparent; }
      #__ai_widget_root ::-webkit-scrollbar-thumb { background: #d4cec5; border-radius: 99px; }
    `;
    document.head.appendChild(style);
  }

  let isOpen = false, isLoading = false, pageMn = false, currentProduct = null;
  const HISTORY_KEY = "__ai_chat_history";
  let chatHistory = [];

  function saveHistory() { try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory)); } catch {} }
  function loadHistory() { try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; } }

  // ── Color palette — matches the React web app ────────────────────────────
  const C = {
    bg:      "#f5f3ef",
    panel:   "#fdfcf9",
    inputBg: "#f0ede8",
    border:  "#e7e1d8",
    text:    "#1d1a16",
    dim:     "#9b9187",
    accent:  "#6d5be6",
    accentDk:"#5b4de0",
    green:   "#16a34a",
    greenBg: "rgba(22,163,74,0.08)",
  };

  const FONT = "'Inter','Segoe UI',system-ui,-apple-system,sans-serif";

  const STORE_COLORS = {
    Amazon:"#ff9900", eBay:"#e53238", Walmart:"#0071ce",
    AliExpress:"#ff6900", BestBuy:"#003087", Newegg:"#e05c00",
  };

  // ── Root container ────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.id = "__ai_widget_root";
  Object.assign(root.style, {
    position: "fixed", bottom: "24px", right: "24px",
    zIndex: "2147483647", display: "flex",
    flexDirection: "column", alignItems: "flex-end", gap: "12px",
    fontFamily: FONT,
  });

  // ── FAB button ────────────────────────────────────────────────────────────
  const fabWrap = document.createElement("div");
  Object.assign(fabWrap.style, { position: "relative", width: "52px", height: "52px", flexShrink: "0" });

  const fab = document.createElement("div");
  Object.assign(fab.style, {
    width: "52px", height: "52px", borderRadius: "50%",
    background: "linear-gradient(135deg, #5b4de0, #8b74f8)",
    boxShadow: "0 6px 24px rgba(109,91,230,0.45), 0 2px 8px rgba(0,0,0,0.1)",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", userSelect: "none",
    transition: "transform 0.22s cubic-bezier(0.16,1,0.3,1), box-shadow 0.2s",
    animation: "__ai_float 4s ease-in-out infinite",
  });
  fab.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

  const fabClose = document.createElement("div");
  Object.assign(fabClose.style, {
    position: "absolute", top: "-3px", right: "-3px",
    width: "18px", height: "18px", borderRadius: "50%",
    background: "#ef4444", color: "#fff", fontSize: "10px", fontWeight: "700",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", opacity: "0",
    transition: "opacity 0.15s, transform 0.15s",
    transform: "scale(0.7)",
    boxShadow: "0 2px 6px rgba(239,68,68,0.4)",
    lineHeight: "1", userSelect: "none",
  });
  fabClose.textContent = "✕";

  fabWrap.addEventListener("mouseenter", () => {
    fab.style.transform = "scale(1.07)";
    fab.style.boxShadow = "0 10px 32px rgba(109,91,230,0.58), 0 2px 8px rgba(0,0,0,0.12)";
    fab.style.animation = "none";
    fabClose.style.opacity = "1";
    fabClose.style.transform = "scale(1)";
  });
  fabWrap.addEventListener("mouseleave", () => {
    fab.style.transform = "scale(1)";
    fab.style.boxShadow = "0 6px 24px rgba(109,91,230,0.45), 0 2px 8px rgba(0,0,0,0.1)";
    fab.style.animation = "__ai_float 4s ease-in-out infinite";
    fabClose.style.opacity = "0";
    fabClose.style.transform = "scale(0.7)";
  });
  fabClose.addEventListener("click", (e) => { e.stopPropagation(); root.remove(); });
  fabWrap.appendChild(fab);
  fabWrap.appendChild(fabClose);

  // ── Panel ─────────────────────────────────────────────────────────────────
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    width: "348px", height: "520px",
    minWidth: "280px", minHeight: "340px", maxWidth: "520px", maxHeight: "740px",
    background: C.panel, borderRadius: "20px",
    boxShadow: "0 24px 64px rgba(0,0,0,0.13), 0 4px 20px rgba(109,91,230,0.1)",
    border: `1.5px solid ${C.border}`,
    display: "none", flexDirection: "column",
    overflow: "hidden", resize: "both",
    opacity: "0", transform: "scale(0.94) translateY(14px)",
    transition: "opacity 0.24s cubic-bezier(0.16,1,0.3,1), transform 0.24s cubic-bezier(0.16,1,0.3,1)",
  });

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement("div");
  Object.assign(header.style, {
    padding: "13px 16px",
    background: C.panel,
    borderBottom: `1px solid ${C.border}`,
    display: "flex", alignItems: "center", justifyContent: "space-between",
    cursor: "move", flexShrink: "0",
    userSelect: "none",
  });
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:36px;height:36px;border-radius:11px;background:linear-gradient(135deg,#5b4de0,#8b74f8);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(91,77,224,0.4);flex-shrink:0;">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </div>
      <div>
        <div style="font-weight:800;font-size:14px;letter-spacing:-0.02em;line-height:1.2;background:linear-gradient(135deg,#1d1a16,#6d5be6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">AI Shop</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:2px;">
          <div style="width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px #22c55e;"></div>
          <span style="color:${C.dim};font-size:10px;font-family:${FONT};">Онлайн</span>
        </div>
      </div>
    </div>
    <button id="__ai_close" style="background:transparent;border:1px solid ${C.border};color:${C.dim};width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;font-family:${FONT};line-height:1;">✕</button>
  `;

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const toolbar = document.createElement("div");
  Object.assign(toolbar.style, {
    padding: "7px 12px", borderBottom: `1px solid ${C.border}`,
    display: "flex", gap: "7px", flexShrink: "0", background: C.bg,
  });

  function makeToolBtn(label) {
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      flex: "1", padding: "6px 0", borderRadius: "8px",
      border: `1px solid ${C.border}`, background: C.panel,
      color: C.dim, fontSize: "10.5px", fontWeight: "600",
      cursor: "pointer", transition: "all 0.15s", fontFamily: FONT,
    });
    btn.textContent = label;
    btn.addEventListener("mouseenter", () => {
      btn.style.borderColor = C.accent;
      btn.style.color = C.accent;
      btn.style.background = "rgba(109,91,230,0.06)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.borderColor = C.border;
      btn.style.color = C.dim;
      btn.style.background = C.panel;
    });
    return btn;
  }

  const btnTranslate = makeToolBtn("🌍 Монгол хэлрүү");
  const btnRefresh   = makeToolBtn("↻ Refresh");
  toolbar.appendChild(btnTranslate);
  toolbar.appendChild(btnRefresh);

  // ── Status bar ────────────────────────────────────────────────────────────
  const statusBar = document.createElement("div");
  Object.assign(statusBar.style, {
    padding: "4px 14px", fontSize: "10.5px", color: C.dim,
    background: C.bg, borderBottom: `1px solid ${C.border}`,
    flexShrink: "0", minHeight: "24px",
    display: "flex", alignItems: "center", fontFamily: FONT,
  });
  statusBar.id = "__ai_status_bar";
  statusBar.textContent = "Бараа олдсонгүй — Refresh дарна уу";

  // ── Messages area ─────────────────────────────────────────────────────────
  const msgs = document.createElement("div");
  Object.assign(msgs.style, {
    flex: "1", overflowY: "auto", padding: "12px 12px",
    display: "flex", flexDirection: "column", gap: "9px",
    background: C.bg,
  });

  // ── Input area ────────────────────────────────────────────────────────────
  const inputWrap = document.createElement("div");
  Object.assign(inputWrap.style, {
    padding: "10px 12px", borderTop: `1px solid ${C.border}`,
    display: "flex", gap: "8px", alignItems: "flex-end",
    background: C.panel, flexShrink: "0",
  });

  const textarea = document.createElement("textarea");
  Object.assign(textarea.style, {
    flex: "1", background: C.inputBg, border: `1px solid ${C.border}`,
    borderRadius: "10px", color: C.text, padding: "9px 12px",
    fontSize: "12.5px", lineHeight: "1.45", outline: "none",
    resize: "none", height: "38px", maxHeight: "100px",
    fontFamily: FONT, transition: "border-color 0.15s, box-shadow 0.15s",
    caretColor: C.accent,
  });
  textarea.placeholder = "монгол эсвэл англиар хайх...";
  textarea.addEventListener("focus", () => {
    textarea.style.borderColor = C.accent;
    textarea.style.boxShadow = "0 0 0 3px rgba(109,91,230,0.1)";
  });
  textarea.addEventListener("blur", () => {
    textarea.style.borderColor = C.border;
    textarea.style.boxShadow = "none";
  });
  textarea.addEventListener("input", () => {
    textarea.style.height = "38px";
    textarea.style.height = Math.min(textarea.scrollHeight, 100) + "px";
  });

  const sendBtn = document.createElement("button");
  Object.assign(sendBtn.style, {
    width: "40px", height: "40px", borderRadius: "10px", flexShrink: "0",
    background: "linear-gradient(135deg, #5b4de0, #8b74f8)",
    border: "none", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 3px 12px rgba(109,91,230,0.38)",
    transition: "opacity 0.15s, transform 0.15s, box-shadow 0.15s",
  });
  sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  sendBtn.addEventListener("mouseenter", () => {
    sendBtn.style.transform = "scale(1.07)";
    sendBtn.style.boxShadow = "0 5px 20px rgba(109,91,230,0.52)";
  });
  sendBtn.addEventListener("mouseleave", () => {
    sendBtn.style.transform = "scale(1)";
    sendBtn.style.boxShadow = "0 3px 12px rgba(109,91,230,0.38)";
  });

  inputWrap.appendChild(textarea);
  inputWrap.appendChild(sendBtn);

  // ── Assemble panel ────────────────────────────────────────────────────────
  panel.appendChild(header);
  panel.appendChild(toolbar);
  panel.appendChild(statusBar);
  panel.appendChild(msgs);
  panel.appendChild(inputWrap);
  root.appendChild(panel);
  root.appendChild(fabWrap);
  document.body.appendChild(root);

  makeDraggable(root, fabWrap);
  makeDraggable(panel, header);

  // Attach close btn hover after DOM insertion
  const closeBtn = panel.querySelector("#__ai_close");
  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.borderColor = "#ef4444";
    closeBtn.style.color = "#ef4444";
    closeBtn.style.background = "rgba(239,68,68,0.07)";
  });
  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.borderColor = C.border;
    closeBtn.style.color = C.dim;
    closeBtn.style.background = "transparent";
  });

  // ── Helper: addBubble ─────────────────────────────────────────────────────
  function addBubble(container, role, text) {
    const b = document.createElement("div");
    Object.assign(b.style, {
      alignSelf:    role === "user" ? "flex-end" : "flex-start",
      background:   role === "user"
        ? "linear-gradient(135deg, #5b4de0, #7c6ff7)"
        : C.panel,
      color:        role === "user" ? "#fff" : C.text,
      border:       `1px solid ${role === "user" ? "#5548cc" : C.border}`,
      borderRadius: role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
      padding: "10px 13px", fontSize: "12.5px", lineHeight: "1.6",
      maxWidth: "87%", wordBreak: "break-word", whiteSpace: "pre-wrap",
      boxShadow: role === "user"
        ? "0 3px 14px rgba(109,91,230,0.28)"
        : "0 1px 4px rgba(0,0,0,0.04)",
      fontFamily: FONT,
    });
    b.textContent = text;
    container.appendChild(b);
    container.scrollTop = container.scrollHeight;
    return b;
  }

  // ── Helper: addActionBubble ───────────────────────────────────────────────
  function addActionBubble(text) {
    const b = document.createElement("div");
    Object.assign(b.style, {
      alignSelf: "flex-start",
      background: C.greenBg,
      border: "1px solid rgba(22,163,74,0.25)",
      borderRadius: "12px 12px 12px 4px",
      padding: "8px 12px", fontSize: "12px",
      color: C.green, fontWeight: "600",
      maxWidth: "92%", fontFamily: FONT,
      display: "flex", alignItems: "flex-start", gap: "6px",
    });
    b.textContent = text;
    msgs.appendChild(b);
    msgs.scrollTop = msgs.scrollHeight;
    return b;
  }

  // ── Helper: typing indicator ──────────────────────────────────────────────
  function addTyping() {
    const b = document.createElement("div");
    Object.assign(b.style, {
      alignSelf: "flex-start",
      background: C.panel, border: `1px solid ${C.border}`,
      borderRadius: "14px 14px 14px 4px",
      padding: "12px 16px", display: "flex", gap: "5px", alignItems: "center",
      boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
    });
    b.id = "__ai_typing";
    [0,1,2].forEach(i => {
      const dot = document.createElement("div");
      Object.assign(dot.style, {
        width: "7px", height: "7px", borderRadius: "50%",
        background: "linear-gradient(135deg, #6d5be6, #8b74f8)",
        animation: `__ai_dotBounce 1.2s ${i * 0.18}s infinite ease-in-out`,
      });
      b.appendChild(dot);
    });
    msgs.appendChild(b);
    msgs.scrollTop = msgs.scrollHeight;
    return b;
  }
  function removeTyping() { document.getElementById("__ai_typing")?.remove(); }
  function setStatus(text) {
    const bar = document.getElementById("__ai_status_bar");
    if (bar) bar.textContent = text;
  }

  // ── Helper: product card ──────────────────────────────────────────────────
  function buildProductCard(item) {
    const sc = STORE_COLORS[item.source] || C.accent;

    const card = document.createElement("div");
    Object.assign(card.style, {
      background: C.panel, border: `1.5px solid ${C.border}`,
      borderRadius: "11px", padding: "9px 11px",
      display: "flex", gap: "10px", alignItems: "flex-start",
      cursor: "pointer",
      transition: "border-color 0.15s, transform 0.18s, box-shadow 0.18s",
    });
    card.addEventListener("mouseenter", () => {
      card.style.borderColor = "#a89df0";
      card.style.transform = "translateY(-1px)";
      card.style.boxShadow = "0 4px 16px rgba(109,91,230,0.1)";
    });
    card.addEventListener("mouseleave", () => {
      card.style.borderColor = C.border;
      card.style.transform = "none";
      card.style.boxShadow = "none";
    });

    const thumb = document.createElement("div");
    Object.assign(thumb.style, {
      width: "40px", height: "40px", borderRadius: "8px",
      background: "#f4f2ee", flexShrink: "0", overflow: "hidden",
      display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px",
    });
    if (item.image) {
      const img = document.createElement("img");
      img.src = item.image;
      Object.assign(img.style, { width: "100%", height: "100%", objectFit: "contain", padding: "3px" });
      img.onerror = () => { img.remove(); thumb.textContent = "📦"; };
      thumb.appendChild(img);
    } else { thumb.textContent = "📦"; }

    const info = document.createElement("div");
    Object.assign(info.style, { flex: "1", minWidth: "0" });

    const titleEl = document.createElement("div");
    Object.assign(titleEl.style, {
      color: C.text, fontSize: "11.5px", fontWeight: "600",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      marginBottom: "5px", fontFamily: FONT,
    });
    titleEl.textContent = item.title || "Нэргүй бараа";

    const meta = document.createElement("div");
    Object.assign(meta.style, { display: "flex", gap: "5px", alignItems: "center" });

    const priceEl = document.createElement("span");
    Object.assign(priceEl.style, {
      color: C.accent, fontWeight: "800", fontSize: "13px", fontFamily: FONT,
    });
    priceEl.textContent = toMNT(item.price, item.price_text);

    const sourceEl = document.createElement("span");
    Object.assign(sourceEl.style, {
      background: `${sc}14`, border: `1px solid ${sc}30`,
      borderRadius: "4px", padding: "1px 6px",
      fontSize: "9.5px", color: sc, fontWeight: "700", fontFamily: FONT,
    });
    sourceEl.textContent = item.source;

    meta.appendChild(priceEl);
    meta.appendChild(sourceEl);
    info.appendChild(titleEl);
    info.appendChild(meta);

    const openBtn = document.createElement("button");
    Object.assign(openBtn.style, {
      padding: "4px 9px", background: "transparent",
      border: `1px solid ${C.border}`, borderRadius: "7px",
      color: C.dim, fontSize: "11px", cursor: "pointer",
      fontFamily: FONT, flexShrink: "0",
      transition: "all 0.15s",
    });
    openBtn.textContent = "↗";
    openBtn.title = "Нээх";
    const openIt = (e) => {
      e?.stopPropagation();
      if (item.url) chrome.runtime.sendMessage({ action: "OPEN_TAB", url: item.url });
    };
    openBtn.addEventListener("click", openIt);
    openBtn.addEventListener("mouseenter", () => {
      openBtn.style.borderColor = C.accent;
      openBtn.style.color = C.accent;
      openBtn.style.background = "rgba(109,91,230,0.07)";
    });
    openBtn.addEventListener("mouseleave", () => {
      openBtn.style.borderColor = C.border;
      openBtn.style.color = C.dim;
      openBtn.style.background = "transparent";
    });
    card.addEventListener("click", openIt);

    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(openBtn);
    return card;
  }

  // ── Helper: search results block ──────────────────────────────────────────
  function showSearchResults(query, items, understood) {
    const wrapper = document.createElement("div");
    Object.assign(wrapper.style, { alignSelf: "flex-start", width: "96%", marginBottom: "4px" });

    const resHeader = document.createElement("div");
    Object.assign(resHeader.style, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "8px 11px",
      background: C.panel,
      border: `1.5px solid ${C.border}`,
      borderRadius: "11px 11px 0 0", cursor: "pointer",
    });

    const label = document.createElement("span");
    Object.assign(label.style, {
      color: C.accent, fontSize: "11.5px", fontWeight: "700", fontFamily: FONT,
    });
    label.textContent = understood
      ? `🔍 ${understood} → "${query}"`
      : `🔍 "${query}"`;

    const countEl = document.createElement("span");
    Object.assign(countEl.style, { color: C.dim, fontSize: "10.5px", fontFamily: FONT });

    const priced   = items.filter(i => i.price && !i.is_search_link);
    const cheapest = priced.length > 0 ? priced.reduce((a, b) => a.price < b.price ? a : b) : null;
    countEl.textContent = `${priced.length} үр дүн`;
    resHeader.appendChild(label);
    resHeader.appendChild(countEl);

    const body = document.createElement("div");
    Object.assign(body.style, {
      border: `1.5px solid ${C.border}`, borderTop: "none",
      borderRadius: "0 0 11px 11px", overflow: "hidden",
      maxHeight: "300px", overflowY: "auto",
      background: C.bg, padding: "7px",
      display: "flex", flexDirection: "column", gap: "5px",
    });

    if (cheapest) {
      const badge = document.createElement("div");
      Object.assign(badge.style, {
        background: "linear-gradient(135deg, rgba(22,163,74,0.1), rgba(34,197,94,0.06))",
        border: "1px solid rgba(22,163,74,0.25)",
        borderRadius: "9px", padding: "7px 11px", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        transition: "border-color 0.15s",
      });
      badge.innerHTML = `<span style="color:#16a34a;font-size:11.5px;font-weight:800;font-family:${FONT};">✓ Хамгийн хямд: ${toMNT(cheapest.price, cheapest.price_text)} — ${cheapest.source}</span><span style="color:#16a34a;font-size:13px;">↗</span>`;
      badge.addEventListener("mouseenter", () => { badge.style.borderColor = "rgba(22,163,74,0.5)"; });
      badge.addEventListener("mouseleave", () => { badge.style.borderColor = "rgba(22,163,74,0.25)"; });
      badge.addEventListener("click", () => {
        if (cheapest.url) chrome.runtime.sendMessage({ action: "OPEN_TAB", url: cheapest.url });
      });
      body.appendChild(badge);
    }

    if (priced.length === 0 && items.length === 0) {
      const empty = document.createElement("div");
      Object.assign(empty.style, {
        color: C.dim, textAlign: "center", padding: "20px",
        fontSize: "12px", fontFamily: FONT,
      });
      empty.textContent = "Үр дүн олдсонгүй";
      body.appendChild(empty);
    } else {
      priced.forEach(item => body.appendChild(buildProductCard(item)));
      const links = items.filter(i => i.is_search_link);
      if (links.length > 0) {
        const linkRow = document.createElement("div");
        Object.assign(linkRow.style, { display: "flex", gap: "5px", flexWrap: "wrap", padding: "4px 2px" });
        links.forEach(r => {
          const sc2 = STORE_COLORS[r.source] || C.accent;
          const a = document.createElement("a");
          a.href = r.url; a.target = "_blank";
          Object.assign(a.style, {
            display: "inline-flex", alignItems: "center", gap: "3px",
            background: `${sc2}0e`, border: `1px solid ${sc2}38`,
            borderRadius: "6px", padding: "2px 9px",
            fontSize: "9.5px", color: sc2, fontWeight: "700",
            textDecoration: "none", fontFamily: FONT,
            transition: "background 0.15s",
          });
          a.textContent = `${r.source} ↗`;
          a.addEventListener("mouseenter", () => { a.style.background = `${sc2}1e`; });
          a.addEventListener("mouseleave", () => { a.style.background = `${sc2}0e`; });
          linkRow.appendChild(a);
        });
        body.appendChild(linkRow);
      }
    }

    let collapsed = false;
    resHeader.addEventListener("click", () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? "none" : "flex";
      countEl.textContent = collapsed ? "▶ нээх" : `${priced.length} үр дүн`;
    });

    wrapper.appendChild(resHeader);
    wrapper.appendChild(body);
    msgs.appendChild(wrapper);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ── Helper: promo bubble ──────────────────────────────────────────────────
  function addPromoBubble() {
    const b = document.createElement("div");
    Object.assign(b.style, {
      alignSelf: "flex-start",
      background: "rgba(109,91,230,0.07)",
      border: "1.5px solid rgba(109,91,230,0.2)",
      borderRadius: "14px 14px 14px 4px",
      padding: "11px 14px", fontSize: "12.5px", lineHeight: "1.65",
      maxWidth: "95%", wordBreak: "break-word", fontFamily: FONT,
    });
    const text = document.createElement("div");
    text.style.color = C.text;
    text.textContent = "💡 Манай вэб платформ дээр бүртгэл үүсгэж, олон дэлгүүрийн барааг харьцуулан хямд үнийг олоорой.";
    const link = document.createElement("a");
    link.href = WEB_URL; link.target = "_blank";
    link.style.cssText = `display:inline-flex;align-items:center;gap:5px;margin-top:9px;background:linear-gradient(135deg,#5b4de0,#8b74f8);color:#fff;text-decoration:none;border-radius:9px;padding:7px 16px;font-size:12px;font-weight:700;font-family:${FONT};box-shadow:0 3px 12px rgba(109,91,230,0.35);transition:opacity 0.15s;`;
    link.textContent = "🌐 AI Shop нээх →";
    link.addEventListener("mouseenter", () => { link.style.opacity = "0.88"; });
    link.addEventListener("mouseleave", () => { link.style.opacity = "1"; });
    b.appendChild(text);
    b.appendChild(document.createElement("br"));
    b.appendChild(link);
    msgs.appendChild(b);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function maybeShowPromo(forceAfterSearch = false) {
    const count = parseInt(sessionStorage.getItem(CHAT_COUNT_KEY) || "0");
    const shown = parseInt(sessionStorage.getItem(PROMO_KEY) || "0");
    if (forceAfterSearch && shown === 0) {
      addPromoBubble();
      sessionStorage.setItem(PROMO_KEY, "1");
    } else if (!forceAfterSearch && count > 0 && count % 10 === 0) {
      addPromoBubble();
    }
  }

  // ── Load history ──────────────────────────────────────────────────────────
  chatHistory = loadHistory();
  if (chatHistory.length > 0) {
    for (const m of chatHistory) addBubble(msgs, m.role, m.content);
  } else {
    addBubble(msgs, "ai",
      "Сайн байна уу! 👋\n" +
      "Монгол эсвэл англиар бараа хайж болно:\n" +
      "• \"smartphone хайж өг\"\n" +
      "• \"утас хайж өг\"\n" +
      "• \"dugui avna\" → дугуй\n\n" +
      "Бараа сонгоод тухайн барааны талаар асуугаарай."
    );
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  function openPanel() {
    isOpen = true;
    panel.style.display = "flex";
    requestAnimationFrame(() => {
      panel.style.opacity = "1";
      panel.style.transform = "scale(1) translateY(0)";
    });
    refreshProducts();
    textarea.focus();
  }
  function closePanel() {
    isOpen = false;
    panel.style.opacity = "0";
    panel.style.transform = "scale(0.94) translateY(14px)";
    setTimeout(() => { panel.style.display = "none"; }, 240);
  }

  let fabMoved = false;
  fab.addEventListener("mousedown", () => { fabMoved = false; });
  fab.addEventListener("mousemove", () => { fabMoved = true; });
  fab.addEventListener("click", () => { if (fabMoved) return; isOpen ? closePanel() : openPanel(); });
  closeBtn.addEventListener("click", closePanel);

  // ── Refresh products ──────────────────────────────────────────────────────
  function refreshProducts() {
    const detail = extractDetailProduct();
    if (detail) {
      currentProduct = detail;
      setStatus(`🛒 Бараа: ${detail.title.slice(0, 42)}`);
      return;
    }
    const products = extractProducts();
    currentProduct = products[0] || null;
    setStatus(
      products.length > 0
        ? `🛒 ${products.length} бараа — ${currentProduct?.title?.slice(0, 32) || "?"}`
        : "Бараа олдсонгүй — Refresh дарна уу"
    );
  }

  btnRefresh.addEventListener("click", refreshProducts);
  btnTranslate.addEventListener("click", async () => {
    if (isTranslating) return;
    if (!pageMn) {
      btnTranslate.textContent = "⏳ Орчуулж байна...";
      btnTranslate.disabled = true;
      await translatePage(msg => setStatus(msg));
      pageMn = true;
      btnTranslate.textContent = "↩️ Original буцаах";
      btnTranslate.disabled = false;
    } else {
      restorePage(msg => setStatus(msg));
      pageMn = false;
      btnTranslate.textContent = "🌍 Монгол хэлрүү";
    }
  });

  // ── Send message ──────────────────────────────────────────────────────────
  async function sendMessage() {
    const msg = textarea.value.trim();
    if (!msg || isLoading) return;

    textarea.value = "";
    textarea.style.height = "38px";
    addBubble(msgs, "user", msg);
    isLoading = true;
    sendBtn.style.opacity = "0.45";
    addTyping();
    setStatus("💭 AI хариулж байна...");

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);

      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message:             msg,
          product_title:       currentProduct?.title       || "",
          product_price:       currentProduct?.price       || "",
          product_url:         currentProduct?.url         || "",
          product_description: currentProduct?.description || "",
          history:             chatHistory.slice(-6),
        }),
      });
      clearTimeout(timer);
      const data = await res.json();
      removeTyping();

      // On errors (e.g. 429 "too many requests") the server sends `detail`
      const answer = data?.answer?.trim() || data?.detail || "Хариу хоосон байна.";
      addBubble(msgs, "ai", answer);
      setStatus("✅ Бэлэн");

      chatHistory.push({ role: "user", content: msg });
      chatHistory.push({ role: "ai", content: answer });
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
      saveHistory();

      const newCount = parseInt(sessionStorage.getItem(CHAT_COUNT_KEY) || "0") + 1;
      sessionStorage.setItem(CHAT_COUNT_KEY, String(newCount));
      maybeShowPromo(false);

      const searchTriggers = [
        "хайж өг","олоод өг","find me","show me","search for","look for","хайх","avna","haij og",
      ];
      const wantsSearch = data?.intent === "search" ||
        searchTriggers.some(t => msg.toLowerCase().includes(t));

      if (wantsSearch && data?.search_query) {
        const englishQuery = data.search_query;
        smartSearch(englishQuery);
        addActionBubble(`🔍 "${englishQuery}" дэлгүүрүүдэд хайж байна...`);
        setStatus(`🔍 "${englishQuery}" хайж байна...`);
        try {
          const cRes = await fetch(`${API_BASE}/compare`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: englishQuery, track: true }),
          });
          const cData = await cRes.json();
          const items = cData.results || [];
          const understood = cData.understood || "";
          showSearchResults(englishQuery, items, understood);
          setStatus(`✅ ${items.filter(i => !i.is_search_link).length} бараа олдлоо`);
          maybeShowPromo(true);
        } catch {
          addBubble(msgs, "ai", "⚠️ Хайлтын үр дүн авахад алдаа гарлаа.");
          setStatus("❌ Хайлт амжилтгүй");
        }
      }

    } catch (e) {
      removeTyping();
      if (e?.name === "AbortError") {
        addBubble(msgs, "ai", "⏱️ Хугацаа дууслаа (60с). Backend шалгана уу.");
      } else {
        addBubble(msgs, "ai", "⚠️ Backend холбогдсонгүй. Python server асаалттай эсэхийг шалга.");
      }
      setStatus("❌ Алдаа гарлаа");
    } finally {
      isLoading = false;
      sendBtn.style.opacity = "1";
    }
  }

  sendBtn.addEventListener("click", sendMessage);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
}

// ── Shopping site detection ───────────────────────────────────────────────────
function isShoppingSite() {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data  = JSON.parse(s.textContent);
      const nodes = [data, ...(data["@graph"] || [])];
      if (nodes.some(n => new Set(["Product","Offer","ItemList","ProductGroup"]).has(n["@type"]))) return true;
    } catch {}
  }
  if ((document.querySelector('meta[property="og:type"]')?.content || "").includes("product")) return true;
  if (Array.from(document.querySelectorAll("span,div,p,strong,b")).filter(n => PRICE_RE.test((n.innerText || "").trim())).length >= 2) return true;
  const CART_RE = /add\s+to\s+(cart|bag|basket)|buy\s+now|checkout|place\s+order/i;
  for (const btn of document.querySelectorAll("button,a,[role='button']")) {
    if (CART_RE.test(btn.innerText || "")) return true;
  }
  if (/amazon\.|ebay\.|aliexpress\.|taobao\.|jd\.com|shopify\.|etsy\.|walmart\.|wish\.|lazada\.|shopee\./i.test(location.hostname)) return true;
  return false;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { if (isShoppingSite()) injectWidget(); });
} else {
  if (isShoppingSite()) injectWidget();
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.action === "MVP_EXTRACT") {
    sendResponse({ ok: true, products: extractProducts() });
    return;
  }
  if (req.action === "PAGE_TRANSLATE_TOGGLE") {
    if (req.enabled) {
      translatePage().then(() => sendResponse({ ok: true }));
      return true;
    } else {
      restorePage();
      sendResponse({ ok: true });
    }
    return;
  }
  if (req.action === "SMART_SEARCH") {
    try { smartSearch(req.query || ""); sendResponse({ ok: true }); }
    catch (e) { sendResponse({ ok: false, error: String(e) }); }
    return;
  }
  if (req.action === "OPEN_TAB") {
    return;
  }
});
