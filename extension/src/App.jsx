import { useEffect, useState } from "react";

export default function App() {
  const [status, setStatus] = useState("idle");
  const [products, setProducts] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");

  // backend response
  const [mnTitle, setMnTitle] = useState("");
  const [mnDesc, setMnDesc] = useState("");
  const [answer, setAnswer] = useState("");
  const [detectedLang, setDetectedLang] = useState("");

  const load = () => {
    setStatus("loading");
    setError("");
    setAnswer("");
    setMnTitle("");
    setMnDesc("");
    setDetectedLang("");
    setSelectedIndex(-1);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) {
        setError("Tab олдсонгүй");
        setStatus("error");
        return;
      }

      chrome.tabs.sendMessage(tabId, { action: "MVP_EXTRACT" }, (res) => {
        if (chrome.runtime.lastError) {
          setError("Content script inject болоогүй. Page refresh (F5).");
          setStatus("error");
          return;
        }
        setProducts(res?.products || []);
        setStatus("ready");
      });
    });
  };

  useEffect(() => {
    load();
  }, []);

  const explain = async () => {
    if (selectedIndex < 0) {
      setError("Эхлээд нэг бүтээгдэхүүн сонгоно уу.");
      return;
    }

    const p = products[selectedIndex];

    setStatus("asking");
    setError("");
    setAnswer("");
    setMnTitle("");
    setMnDesc("");
    setDetectedLang("");

    try {
      const res = await fetch("http://127.0.0.1:8000/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: p.title || "",
          price: p.price || "",
          url: p.url || "",
          description: p.description || p.rawText || "", // ✅ send text for translation
          question: question || ""
        })
      });

      const data = await res.json();

      setDetectedLang(data.detected_language || "");
      setMnTitle(data?.mn?.title || "");
      setMnDesc(data?.mn?.description || "");
      setAnswer(data.explanation || "Хариу хоосон байна.");

      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError("Backend холбогдсонгүй. Python server асаалттай эсэхийг шалга.");
    }
  };

  const selected = selectedIndex >= 0 ? products[selectedIndex] : null;

  return (
    <div style={{ width: 380, padding: 12, fontFamily: "Arial" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>🛒 Орчуулгатай Худалдааны Туслах</h3>
        <button onClick={load}>↻</button>
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: "#777" }}>
        Status: <b>{status}</b>
      </div>

      {error && (
        <div style={{ marginTop: 8, color: "crimson", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}

      {/* Product list */}
      <div style={{ marginTop: 10, border: "1px solid #ddd", borderRadius: 8, padding: 8, maxHeight: 200, overflowY: "auto" }}>
        {products.length === 0 ? (
          <div style={{ fontSize: 13 }}>Бүтээгдэхүүн олдсонгүй</div>
        ) : (
          products.map((p, i) => (
            <div
              key={i}
              onClick={() => setSelectedIndex(i)}
              style={{
                padding: 8,
                borderBottom: "1px solid #eee",
                cursor: "pointer",
                background: selectedIndex === i ? "#e8fff3" : "transparent"
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 12 }}>{p.title}</div>
              <div style={{ fontSize: 12 }}>Үнэ: {p.price}</div>
            </div>
          ))
        )}
      </div>

      {/* Selected preview */}
      {selected && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#444" }}>
          <b>Сонгосон:</b> {selected.title}
          {selected.description && (
            <div style={{ marginTop: 6, color: "#666" }}>
              {selected.description}
            </div>
          )}
        </div>
      )}

      {/* Question */}
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Асуулт (ж: Энэ юунд хэрэглэдэг вэ? Ямар хэмжээтэй вэ?)"
        style={{ width: "100%", height: 60, marginTop: 10 }}
      />

      <button
        onClick={explain}
        disabled={status === "asking"}
        style={{ width: "100%", marginTop: 8 }}
      >
        {status === "asking" ? "Орчуулж байна..." : "Монгол хэлээр тайлбарла"}
      </button>

      {/* Translation / Output */}
      {(mnTitle || mnDesc || answer) && (
        <div style={{ marginTop: 10, border: "1px solid #ddd", borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 12, color: "#777" }}>
            Илэрсэн хэл: <b>{detectedLang || "unknown"}</b>
          </div>

          {mnTitle && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Монгол нэр:</div>
              <div style={{ fontSize: 13 }}>{mnTitle}</div>
            </div>
          )}

          {mnDesc && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Монгол тайлбар (орчуулга):</div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{mnDesc}</div>
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>AI тайлбар:</div>
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{answer}</div>
          </div>
        </div>
      )}
    </div>
  );
}