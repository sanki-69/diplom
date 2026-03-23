console.log("✅ content.js injected");

function clean(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

const PRICE_RE = /(?:₮|¥|\$|€|£)\s?\d|(\d[\d.,\s]{1,}\s?(₮|¥|\$|€|£))/;

// =====================
// PRODUCT EXTRACTION
// =====================
function extractProducts() {
  const nodes = Array.from(document.querySelectorAll("span,div,p,strong"))
    .filter((n) => PRICE_RE.test(clean(n.innerText)));

  const results = [];
  const seen = new Set();

  for (const el of nodes) {
    const card = el.closest("a,article,li,div");
    if (!card) continue;

    const text = clean(card.innerText);
    const price = (text.match(PRICE_RE) || [""])[0];
    const img = card.querySelector("img");
    const link = card.querySelector("a[href]");

    const title = clean(img?.alt) || clean(text.replace(price, "")).slice(0, 80);
    const url = link ? new URL(link.href, location.href).toString() : "";

    if (!title || !price) continue;
    const key = `${title}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      title,
      price,
      url,
      description: text.slice(0, 300),
      rawText: text,
    });

    if (results.length >= 20) break;
  }

  return results;
}

// =====================
// WHOLE PAGE TRANSLATE
// =====================
let backup = null;

function collectTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const t = clean(node.nodeValue);
    const parentTag = node.parentElement?.tagName?.toLowerCase() || "";

    if (
      t.length > 1 &&
      t.length < 500 &&
      !["script", "style", "noscript", "textarea", "input"].includes(parentTag)
    ) {
      nodes.push(node);
    }
  }

  return nodes;
}

async function translatePage() {
  if (backup) return;

  const nodes = collectTextNodes();
  backup = new Map();
  const texts = [];

  for (const n of nodes) {
    backup.set(n, n.nodeValue);
    texts.push(n.nodeValue);
  }

  const res = await fetch("http://127.0.0.1:8000/translate_page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });

  const data = await res.json();
  if (!data.translated) return;

  nodes.forEach((n, i) => {
    if (data.translated[i]) n.nodeValue = data.translated[i];
  });
}

function restorePage() {
  if (!backup) return;

  for (const [node, txt] of backup.entries()) {
    try {
      node.nodeValue = txt;
    } catch {}
  }

  backup = null;
}

// =====================
// SMART SEARCH
// =====================
let searchOverlay = null;

function showSearchOverlay(text) {
  removeSearchOverlay();

  searchOverlay = document.createElement("div");
  searchOverlay.id = "__ai_shop_search_overlay";
  searchOverlay.textContent = text;

  Object.assign(searchOverlay.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "999999",
    background: "rgba(15,17,21,0.95)",
    color: "#fff",
    padding: "10px 14px",
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.15)",
    boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
    fontSize: "13px",
    fontWeight: "600",
    maxWidth: "320px",
    lineHeight: "1.35",
  });

  document.body.appendChild(searchOverlay);
}

function removeSearchOverlay() {
  if (searchOverlay && searchOverlay.parentNode) {
    searchOverlay.parentNode.removeChild(searchOverlay);
  }
  searchOverlay = null;
}

function clearSearchHighlights() {
  document.querySelectorAll("[data-ai-search-highlight='1']").forEach((el) => {
    el.style.outline = "";
    el.style.background = "";
    el.style.scrollMarginTop = "";
    el.removeAttribute("data-ai-search-highlight");
  });
}

function highlightMatches(keyword) {
  clearSearchHighlights();

  const els = Array.from(document.querySelectorAll("a, article, li, div"));
  let found = 0;
  let firstMatch = null;

  for (const el of els) {
    const text = el.innerText?.toLowerCase() || "";
    if (!text || text.length < 8) continue;

    if (text.includes(keyword.toLowerCase())) {
      el.style.outline = "2px solid #00ff99";
      el.style.background = "rgba(0,255,150,0.08)";
      el.style.scrollMarginTop = "80px";
      el.setAttribute("data-ai-search-highlight", "1");

      if (!firstMatch) firstMatch = el;
      found++;
    }
  }

  if (firstMatch) {
    firstMatch.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  showSearchOverlay(
    found > 0
      ? `🔍 "${keyword}" хайлтаар ${found} тохирох хэсэг оллоо`
      : `❌ "${keyword}" хайлтаар тохирох зүйл олдсонгүй`
  );

  setTimeout(removeSearchOverlay, 4000);

  return found;
}

function setNativeInputValue(input, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findSearchInput() {
  // Amazon-specific
  const amazon = document.querySelector("#twotabsearchtextbox");
  if (amazon) return amazon;

  // Common search selectors
  const selectors = [
    "input[type='search']",
    "input[name='field-keywords']",
    "input[placeholder*='Search']",
    "input[placeholder*='search']",
    "input[aria-label*='Search']",
    "input[aria-label*='search']",
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      return el;
    }
  }

  // fallback visible input
  const inputs = Array.from(document.querySelectorAll("input")).filter(
    (el) => el.offsetParent !== null
  );

  return inputs[0] || null;
}

function submitClosestForm(input) {
  const form = input.closest("form");

  if (form) {
    const btn = form.querySelector("input[type='submit'], button[type='submit']");
    if (btn) {
      btn.click();
      return true;
    }

    try {
      form.submit();
      return true;
    } catch {}
  }

  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    })
  );

  input.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    })
  );

  return false;
}

function searchUsingSite(keyword) {
  const input = findSearchInput();
  if (!input) return false;

  try {
    input.focus();
    setNativeInputValue(input, keyword);

    setTimeout(() => {
      submitClosestForm(input);
    }, 300);

    return true;
  } catch (e) {
    console.error("searchUsingSite error:", e);
    return false;
  }
}

function smartSearch(query) {
  const keyword = clean(query);
  if (!keyword) return;

  console.log("🔍 SEARCH TRIGGERED:", keyword);
  showSearchOverlay(`🔍 Shop дотор хайж байна: "${keyword}"`);

  const usedSearch = searchUsingSite(keyword);

  if (!usedSearch) {
    const found = highlightMatches(keyword);
    console.log("Fallback highlight results:", found);
  } else {
    setTimeout(removeSearchOverlay, 2500);
  }
}

// =====================
// MESSAGE LISTENER
// =====================
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === "MVP_EXTRACT") {
    sendResponse({ ok: true, products: extractProducts() });
    return;
  }

  if (req.action === "PAGE_TRANSLATE_TOGGLE") {
    if (req.enabled) translatePage();
    else restorePage();
    sendResponse({ ok: true });
    return;
  }

  if (req.action === "SMART_SEARCH") {
    try {
      smartSearch(req.query || "");
      sendResponse({ ok: true });
    } catch (e) {
      console.error("SMART_SEARCH error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
    return;
  }
});