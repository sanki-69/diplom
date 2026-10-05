import { useState, useRef, useEffect, useCallback } from "react";
import { compareProducts, API } from "../api.js";
import {
  PhoneArt, HeadphonesArt, LaptopArt, SneakerArt, WatchArt, BagArt, Icons, G,
} from "../components/Art.jsx";

const STORES = ["AliExpress", "Amazon", "eBay", "Walmart", "BestBuy", "Newegg"];

const USD_TO_MNT = 3450;

function toMNT(price, priceText) {
  if (price && price > 0) return `₮${Math.round(price * USD_TO_MNT).toLocaleString()}`;
  const rawText = String(priceText || "").trim();
  if (rawText && rawText !== "None" && rawText !== "—") {
    const first = rawText.split(/\s+to\s+|\s*[–—]\s*|\s+-\s+/)[0];
    const cleaned = first.replace(/\b(USD|CAD|AUD|GBP|CNY|US)\b/gi, "").replace(/[₮€£¥₩₽]/g, "").trim();
    const m = cleaned.match(/\$?([\d,]+\.?\d*)/);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(num) && num > 0 && num < 10000) return `₮${Math.round(num * USD_TO_MNT).toLocaleString()}`;
    }
  }
  return "—";
}

/* ── Home page content ─────────────────────────────────────────────── */

const HERO_SLIDES = [
  { kicker: "Шинэ загварууд",  title: "Ухаалаг утас",       sub: "6 дэлгүүрийн үнийг нэг дор",      query: "smartphone",          Art: PhoneArt },
  { kicker: "Дуу чимээгүй",    title: "Утасгүй чихэвч",     sub: "Хамгийн хямдыг AI олж өгнө",       query: "wireless headphones", Art: HeadphonesArt },
  { kicker: "Ажил & тоглоом",  title: "Зөөврийн компьютер", sub: "Үнэ, үнэлгээг нэг дор харьцуул",   query: "laptop",              Art: LaptopArt },
];

const TILES = [
  { title: "Пүүз гутал",  query: "sneakers",    Art: SneakerArt },
  { title: "Бугуйн цаг",  query: "wrist watch", Art: WatchArt },
  { title: "Цүнх",        query: "handbag",     Art: BagArt },
];

const TRENDING = {
  "Эрэлттэй": [
    ["iPhone 15 Pro", "Ухаалаг утас", "phone"],
    ["Sony WH-1000XM5", "Чихэвч", "headphones"],
    ["gaming mouse", "Тоглоомын хулгана", "mouse"],
    ["Apple Watch", "Ухаалаг цаг", "watch"],
    ["Nike Air Force 1", "Пүүз", "shoe"],
    ["MacBook Air", "Зөөврийн компьютер", "laptop"],
    ["PS5 controller", "Жойстик", "gamepad"],
    ["GoPro camera", "Экшн камер", "camera"],
  ],
  "Электрон": [
    ["4K monitor", "Дэлгэц", "monitor"],
    ["mechanical keyboard", "Механик гар", "keyboard"],
    ["bluetooth speaker", "Чанга яригч", "speaker"],
    ["iPad", "Таблет", "tablet"],
    ["wireless earbuds", "Утасгүй чихэвч", "headphones"],
    ["Samsung Galaxy", "Андройд утас", "phone"],
    ["gaming laptop", "Тоглоомын ноутбук", "laptop"],
    ["webcam", "Вэб камер", "camera"],
  ],
  "Загвар": [
    ["sneakers", "Пүүз гутал", "shoe"],
    ["running shoes", "Гүйлтийн гутал", "shoe"],
    ["smart watch", "Ухаалаг цаг", "watch"],
    ["leather backpack", "Арьсан үүргэвч", "bag"],
    ["handbag", "Гар цүнх", "bag"],
    ["hoodie", "Малгайтай цамц", "shirt"],
    ["t-shirt", "Футболк", "shirt"],
    ["leather wallet", "Түрийвч", "bag"],
  ],
};

/* ── Small pieces ──────────────────────────────────────────────────── */

function SectionTitle({ title, sub }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <div className="ornament"><G.ornament /></div>
      {sub && <p>{sub}</p>}
    </div>
  );
}

function StarRating({ rating }) {
  const n = Math.round(parseFloat(rating));
  return (
    <div style={{ display: "flex", gap: 2, justifyContent: "center" }} aria-label={`${rating} од`}>
      {[1, 2, 3, 4, 5].map(s => (
        <svg key={s} width="10" height="10" viewBox="0 0 24 24"
          fill={s <= n ? "var(--ink)" : "none"} stroke={s <= n ? "var(--ink)" : "#c8c8c8"} strokeWidth="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ))}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="p-card" style={{ pointerEvents: "none" }}>
      <div className="skeleton" style={{ aspectRatio: "1 / 1" }} />
      <div className="p-body" style={{ alignItems: "center" }}>
        <div className="skeleton" style={{ height: 11, width: "90%" }} />
        <div className="skeleton" style={{ height: 11, width: "65%" }} />
        <div className="skeleton" style={{ height: 18, width: "40%", marginTop: 6 }} />
        <div className="skeleton" style={{ height: 28, width: "60%", marginTop: 6 }} />
      </div>
    </div>
  );
}

function ResultCard({ r, isBest, minPrice, onSelect, index }) {
  const price = r.price || 0;
  const savePct = (minPrice != null) && minPrice && price && !isBest
    ? Math.round(((price - minPrice) / minPrice) * 100) : 0;
  const monthly = /\/\s*mo(?:nth)?\.?\b/i.test(r.price_text || "");

  return (
    <div className="p-card fade-up" style={{ animationDelay: `${Math.min(index * 0.04, 0.4)}s` }}>
      <div className="p-img">
        <span className="tag" style={{ top: 10, left: 10 }}>{r.source}</span>
        {isBest && <span className="tag sale" style={{ top: 10, right: 10 }}>Хамгийн хямд</span>}

        <a href={r.url} target="_blank" rel="noreferrer" aria-label={r.title} style={{ display: "block", width: "100%", height: "100%" }}>
          {r.image
            ? <img
                src={r.image}
                alt={r.title}
                loading="lazy"
                onError={e => {
                  if (!e.target.dataset.proxied) {
                    e.target.dataset.proxied = "1";
                    e.target.src = `${API}/proxy-image?url=${encodeURIComponent(r.image)}`;
                  } else {
                    e.target.style.display = "none";
                  }
                }}
              />
            : <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#c8c8c8" }}>
                <G.package size={44} sw={1.2} />
              </div>
          }
        </a>

        {/* Slides up on hover */}
        <a className="p-quick btn btn-block" href={r.url} target="_blank" rel="noreferrer">
          Дэлгүүрт үзэх <G.arrow size={13} />
        </a>
      </div>

      <div className="p-body">
        {r.rating && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <StarRating rating={r.rating} />
            {r.review_count && <span style={{ color: "var(--mute)", fontSize: 10.5 }}>({Number(r.review_count).toLocaleString()})</span>}
          </div>
        )}

        <a href={r.url} target="_blank" rel="noreferrer" className="p-title" title={r.title}>{r.title}</a>

        <div style={{ marginTop: "auto" }}>
          {monthly ? (
            <>
              <div className="p-price">{r.price_text}</div>
              <div style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--mute)" }}>Сарын төлбөр</div>
            </>
          ) : (
            <>
              <div className="p-price" style={{ color: isBest ? "var(--sale)" : "var(--ink)" }}>{toMNT(price, r.price_text)}</div>
              {savePct > 0 && (
                <div style={{ fontSize: 10.5, color: "var(--mute)" }}>+{savePct}% илүү үнэтэй</div>
              )}
            </>
          )}
        </div>

        {onSelect && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ alignSelf: "center", marginTop: 6 }}
            onClick={() => onSelect({ name: r.title, price: r.price, url: r.url, description: r.description, rating: r.rating, review_count: r.review_count, source: r.source })}
          >
            <G.spark size={12} /> AI зөвлөгөө
          </button>
        )}
      </div>
    </div>
  );
}

function HeroCarousel({ onSearch }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const n = HERO_SLIDES.length;

  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => setI(v => (v + 1) % n), 6000);
    return () => clearTimeout(t);
  }, [i, paused, n]);

  const s = HERO_SLIDES[i];
  return (
    <section
      className="hero"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-roledescription="carousel"
    >
      <div className="hero-num" aria-hidden="true">0{i + 1}</div>

      <div className="hero-art hero-slide" key={`art-${i}`}><s.Art /></div>

      <div className="hero-copy hero-slide" key={`copy-${i}`}>
        <div className="eyebrow" style={{ marginBottom: 14 }}>{s.kicker}</div>
        <h1>{s.title}</h1>
        <div className="hero-sub">{s.sub}</div>
        <button className="btn" onClick={() => onSearch(s.query)}>
          Одоо хайх <G.arrow size={13} />
        </button>
      </div>

      <button className="icon-btn hero-nav" style={{ left: 16 }} aria-label="Өмнөх" onClick={() => setI(v => (v - 1 + n) % n)}>
        <G.left size={16} />
      </button>
      <button className="icon-btn hero-nav" style={{ right: 16 }} aria-label="Дараах" onClick={() => setI(v => (v + 1) % n)}>
        <G.right size={16} />
      </button>

      <div className="hero-dots">
        {HERO_SLIDES.map((_, k) => (
          <button key={k} className={k === i ? "active" : ""} aria-label={`Слайд ${k + 1}`} onClick={() => setI(k)} />
        ))}
      </div>
    </section>
  );
}

function Trending({ onSearch }) {
  const tabs = Object.keys(TRENDING);
  const [tab, setTab] = useState(tabs[0]);
  return (
    <section style={{ marginTop: 72 }}>
      <SectionTitle title="Эрэлттэй хайлтууд" />
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 26 }}>
        <div className="tabs">
          {tabs.map(t => (
            <button key={t} className={`tab ${t === tab ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
      </div>
      <div key={tab} className="grid-4">
        {TRENDING[tab].map(([query, label, icon], k) => {
          const Icon = Icons[icon];
          return (
            <button key={query} className="q-card fade-up" style={{ animationDelay: `${k * 0.04}s` }} onClick={() => onSearch(query)}>
              <div className="q-art">
                <span className="q-num">{String(k + 1).padStart(2, "0")}</span>
                <Icon size={58} sw={1.1} />
              </div>
              <div className="q-body" style={{ width: "100%" }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{query}</div>
                <div style={{ fontSize: 11, color: "var(--mute)", marginTop: 2 }}>{label}</div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Marquee() {
  const row = STORES.flatMap(s => [s, "/"]);
  return (
    <div className="marquee" style={{ marginTop: 80 }} aria-label="Дэлгүүрүүд">
      <div className="track">
        {[...row, ...row].map((s, k) => (
          <span key={k} className={s === "/" ? "sep" : ""}>{s}</span>
        ))}
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ["01", "Хай", "Монгол, англи эсвэл латин үсгээр бичихэд AI ойлгоод англи хайлт болгоно."],
    ["02", "Харьцуул", "6 дэлгүүрийн үр дүнг төгрөгөөр харуулж, хамгийн хямдыг тодруулна."],
    ["03", "Асуу", "Бараа бүрийн давуу, сул талыг AI туслахаас монголоор асуугаарай."],
  ];
  return (
    <section className="container" style={{ padding: "76px 32px 90px" }}>
      <SectionTitle title="Хэрхэн ажилладаг вэ" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 1, background: "var(--line)", border: "1px solid var(--line)" }}>
        {steps.map(([n, t, d]) => (
          <div key={n} style={{ background: "var(--paper)", padding: "34px 30px" }}>
            <div style={{ fontFamily: "var(--display)", fontSize: 54, fontWeight: 700, lineHeight: 1, color: "transparent", WebkitTextStroke: "1px var(--ink)" }}>{n}</div>
            <h3 style={{ fontSize: 20, margin: "16px 0 8px" }}>{t}</h3>
            <p style={{ color: "var(--mute)", fontSize: 13 }}>{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Page ──────────────────────────────────────────────────────────── */

export default function OpenClawPage({ chatSearch, onChatSearchUsed, chatFilter, onChatFilterUsed, onQueryChange, onSelectProduct }) {
  const [input, setInput]             = useState("");
  const [results, setResults]         = useState([]);
  const [searchLinks, setSearchLinks] = useState([]);
  const [loading, setLoading]         = useState(false);
  const [understood, setUnderstood]   = useState("");
  const [error, setError]             = useState("");
  const [sortBy, setSortBy]           = useState("default");
  const [filterStore, setFilterStore] = useState("");
  const [aiFilters, setAiFilters]     = useState(null);
  const [searched, setSearched]       = useState(false);
  const inputRef        = useRef(null);
  const currentQueryRef = useRef("");
  const debounceRef     = useRef(null);

  const CHEAP_KEYWORDS = [
    "хямд","хямдаар","хамгийн хямд","хямд хайж",
    "hyamd","himd","hamgiin hyamd",
    "cheap","cheapest","budget","lowest price","affordable","best price",
  ];

  const runSearch = useCallback(async (q, preserveFilters = null) => {
    if (!q || loading) return;
    setInput(q);
    currentQueryRef.current = q;
    setLoading(true);
    setResults([]);
    setSearchLinks([]);
    setError("");
    setUnderstood("");
    setFilterStore("");
    setAiFilters(null);
    setSearched(true);
    const wantsCheap = CHEAP_KEYWORDS.some(kw => q.toLowerCase().includes(kw));
    setSortBy(wantsCheap ? "price_asc" : "default");
    window.scrollTo({ top: 0, behavior: "smooth" });

    try {
      const data  = await compareProducts(q);
      const all   = data.results || [];
      const real  = all.filter(r => !r.is_search_link);
      const links = all.filter(r =>  r.is_search_link);
      setResults(real);
      setSearchLinks(links);
      if (preserveFilters) setAiFilters(preserveFilters);
      const translatedTo = (data.query || "").trim();
      const summary      = (data.understood || "").trim();
      if (translatedTo && translatedTo.toLowerCase() !== q.toLowerCase()) {
        setUnderstood(summary ? `${summary} → "${translatedTo}"` : `"${translatedTo}"`);
      }
      if (!real.length && !links.length) {
        setError("Үр дүн олдсонгүй. Өөр нэршлээр хайж үзнэ үү.");
      } else if (!real.length && links.length > 0) {
        setError("Дэлгүүрүүд бараа олдсонгүй. Доорх холбоосоор шууд хайж үзнэ үү.");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  // Shareable links: /search?q=headphones starts that search on load.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) runSearch(q);
  }, []);
  useEffect(() => { if (!chatSearch) return; setAiFilters(null); runSearch(chatSearch.query); onChatSearchUsed(); }, [chatSearch]);
  useEffect(() => {
    if (!chatFilter) return;
    onChatFilterUsed();
    const { color, brand, keyword, max_price, min_price, store } = chatFilter;
    const searchTerms = [color, brand, keyword].filter(Boolean);
    if (searchTerms.length > 0) {
      // Embed color/brand/keyword into the query so scraped results actually contain them.
      // Price & store remain as client-side filters after the new results load.
      const base = currentQueryRef.current || "";
      const enriched = [...searchTerms, base].filter(Boolean).join(" ").trim();
      const postFilters = (max_price || min_price || store)
        ? { color, brand, keyword, max_price, min_price, store }
        : null;
      runSearch(enriched, postFilters);
    } else {
      // Price / store only — no need to re-fetch, client-side filter is enough
      setAiFilters(chatFilter);
    }
  }, [chatFilter]);
  useEffect(() => { if (onQueryChange) onQueryChange(input); }, [input]);

  const doSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(input.trim()), 300);
  };

  const resetSearch = () => {
    setInput(""); setResults([]); setSearched(false); setUnderstood(""); setError("");
    inputRef.current?.focus();
  };

  const activeStores = [...new Set(results.map(r => r.source).filter(Boolean))];
  const filtered = results
    .filter(r => !filterStore || r.source === filterStore)
    .filter(r => {
      if (!aiFilters) return true;
      const title = (r.title || "").toLowerCase();
      if (aiFilters.color   && !title.includes(aiFilters.color.toLowerCase()))   return false;
      if (aiFilters.brand   && !title.includes(aiFilters.brand.toLowerCase()))   return false;
      if (aiFilters.keyword && !title.includes(aiFilters.keyword.toLowerCase())) return false;
      if (aiFilters.store   && r.source !== aiFilters.store)                     return false;
      if (aiFilters.max_price && r.price && r.price > Number(aiFilters.max_price)) return false;
      if (aiFilters.min_price && r.price && r.price < Number(aiFilters.min_price)) return false;
      return true;
    })
    .sort((a, b) =>
      sortBy === "price_asc"  ? (a.price || 0) - (b.price || 0) :
      sortBy === "price_desc" ? (b.price || 0) - (a.price || 0) : 0
    );
  const minPrice = Math.min(...filtered.filter(r => r.price > 0).map(r => r.price));

  const filterChips = aiFilters ? [
    aiFilters.color     && `өнгө: ${aiFilters.color}`,
    aiFilters.brand     && `брэнд: ${aiFilters.brand}`,
    aiFilters.keyword   && `"${aiFilters.keyword}"`,
    aiFilters.max_price && `≤ ${toMNT(Number(aiFilters.max_price))}`,
    aiFilters.min_price && `≥ ${toMNT(Number(aiFilters.min_price))}`,
    aiFilters.store     && aiFilters.store,
  ].filter(Boolean) : [];

  return (
    <div style={{ paddingBottom: searched ? 90 : 0 }}>

      {/* ── Search bar ── */}
      <div className="container" style={{ paddingTop: 28, paddingBottom: searched ? 8 : 28 }}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>AI хайлт — монгол, англи, латин үсгээр</div>
        <div style={{ display: "flex", border: "1px solid var(--ink)", height: 58, background: "var(--paper)" }}>
          <span style={{ display: "flex", alignItems: "center", padding: "0 6px 0 20px", color: "var(--mute)" }}>
            <G.search size={18} />
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doSearch()}
            placeholder="Бараа хайх... жишээ нь: хямд чихэвч, nada gar utas, iPhone 15"
            aria-label="Бараа хайх"
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 15, padding: "0 12px" }}
          />
          {input && (
            <button onClick={resetSearch} aria-label="Арилгах" style={{ background: "none", border: "none", padding: "0 14px", color: "var(--mute)" }}>
              <G.x size={16} />
            </button>
          )}
          <button className="btn" onClick={doSearch} disabled={!input.trim() || loading} style={{ height: "100%", minWidth: 130 }}>
            {loading ? <><span className="spinner" /> Хайж байна</> : "Хайх"}
          </button>
        </div>
      </div>

      {/* ══════════ HOME ══════════ */}
      {!searched && (
        <>
          <div className="container">
            <HeroCarousel onSearch={runSearch} />

            <div className="tiles" style={{ marginTop: 20 }}>
              {TILES.map(({ title, query, Art }) => (
                <button key={query} className="tile" onClick={() => runSearch(query)}>
                  <Art />
                  <div>
                    <h3>{title}</h3>
                    <span className="btn btn-sm">Хайх</span>
                  </div>
                </button>
              ))}
            </div>

            <Trending onSearch={runSearch} />
          </div>
          <Marquee />
          <HowItWorks />
        </>
      )}

      {/* ══════════ RESULTS ══════════ */}
      {searched && (
        <div className="container">

          {/* Heading row */}
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", padding: "26px 0 18px", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div className="eyebrow">Хайлтын үр дүн</div>
              <h1 style={{ fontSize: 34, marginTop: 6 }}>{currentQueryRef.current || input}</h1>
              {understood && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--mute)", display: "flex", alignItems: "center", gap: 6 }}>
                  <G.spark size={13} /> AI ойлгосон: <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{understood}</strong>
                </div>
              )}
            </div>
            {!loading && results.length > 0 && (
              <div className="tabs" role="group" aria-label="Эрэмбэлэх">
                <button className={`tab ${sortBy === "default" ? "active" : ""}`}    onClick={() => setSortBy("default")}>Хамааралтай</button>
                <button className={`tab ${sortBy === "price_asc" ? "active" : ""}`}  onClick={() => setSortBy("price_asc")}>Хямд нь эхэндээ</button>
                <button className={`tab ${sortBy === "price_desc" ? "active" : ""}`} onClick={() => setSortBy("price_desc")}>Үнэтэй нь эхэндээ</button>
              </div>
            )}
          </div>

          {/* Store filter */}
          {!loading && activeStores.length > 1 && (
            <div style={{ display: "flex", gap: 26, flexWrap: "wrap", alignItems: "center", padding: "14px 0", borderBottom: "1px solid var(--line)" }}>
              <button className={`link-tab ${!filterStore ? "active" : ""}`} onClick={() => setFilterStore("")}>Бүгд ({results.length})</button>
              {activeStores.map(s => (
                <button key={s} className={`link-tab ${filterStore === s ? "active" : ""}`} onClick={() => setFilterStore(filterStore === s ? "" : s)}>
                  {s} ({results.filter(r => r.source === s).length})
                </button>
              ))}
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--mute)", letterSpacing: ".1em", textTransform: "uppercase" }}>
                {filtered.length} бараа
              </span>
            </div>
          )}

          {/* AI filter banner */}
          {aiFilters && (
            <div className="fade-in" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 18, padding: "12px 16px", background: "var(--mist)" }}>
              <G.filter size={14} />
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>AI шүүлт</span>
              {filterChips.map(c => (
                <span key={c} style={{ border: "1px solid var(--ink)", padding: "2px 9px", fontSize: 11.5, background: "var(--paper)" }}>{c}</span>
              ))}
              <span style={{ color: "var(--mute)", fontSize: 12 }}>({filtered.length}/{results.length})</span>
              <button className="btn btn-outline btn-sm" style={{ marginLeft: "auto" }} onClick={() => setAiFilters(null)}>
                <G.x size={12} /> Арилгах
              </button>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="grid-products" style={{ marginTop: 26 }}>
              {Array.from({ length: 8 }).map((_, k) => <SkeletonCard key={k} />)}
            </div>
          )}

          {/* Error / empty */}
          {error && !loading && (
            <div className="fade-up" style={{ textAlign: "center", padding: "80px 20px 40px" }}>
              <h2 style={{ fontSize: 26 }}>{error}</h2>
              <p style={{ color: "var(--mute)", fontSize: 13, marginTop: 10 }}>Өөр үгээр хайж үзнэ үү · AI туслахаас асуугаарай</p>
              <button className="btn btn-outline" style={{ marginTop: 22 }} onClick={resetSearch}>Нүүр хуудас руу</button>
            </div>
          )}

          {/* Results grid */}
          {!loading && filtered.length > 0 && (
            <div className="grid-products" style={{ marginTop: 26 }}>
              {filtered.map((r, k) => (
                <ResultCard
                  key={r.url || k}
                  index={k}
                  r={r}
                  isBest={sortBy === "price_asc" && r.price > 0 && r.price === minPrice}
                  minPrice={sortBy === "price_asc" ? minPrice : null}
                  onSelect={onSelectProduct}
                />
              ))}
            </div>
          )}

          {/* External search links */}
          {!loading && searchLinks.length > 0 && (
            <div style={{ marginTop: filtered.length > 0 ? 56 : 10, paddingTop: 28, borderTop: "1px solid var(--line)" }}>
              <div className="eyebrow" style={{ marginBottom: 14 }}>
                {filtered.length > 0 ? "Мөн эндээс хайж үзээрэй" : "Эндээс хайж үзээрэй"}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {searchLinks.map((r, k) => (
                  <a key={k} href={r.url} target="_blank" rel="noreferrer" className="btn btn-outline btn-sm">
                    {r.source} дээр хайх <G.arrow size={12} />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
