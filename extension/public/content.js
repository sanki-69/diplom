console.log("✅ AI Shopping Assistant injected:", location.href);

function clean(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

const PRICE_RE = /(?:₮|¥|\$|€|£)\s?\d[\d.,\s]*/;

function extractProducts() {
  const results = [];
  const seen = new Set();

  // 1️⃣ First find price elements (most reliable anchor)
  const priceElements = Array.from(
    document.querySelectorAll("span, div, p, strong")
  ).filter(el => {
    const txt = clean(el.innerText);
    return txt && txt.length < 50 && PRICE_RE.test(txt);
  });

  for (const pel of priceElements) {
    let card = pel.closest("article, li, div, a");
    let depth = 0;

    // 2️⃣ Climb up to find a container with image + link
    while (card && depth < 10) {
      const hasImg = !!card.querySelector("img");
      const hasLink = !!card.querySelector("a[href]") || card.tagName.toLowerCase() === "a";

      if (hasImg && hasLink) break;

      card = card.parentElement;
      depth++;
    }

    if (!card) continue;

    const fullText = clean(card.innerText);
    const priceMatch = fullText.match(PRICE_RE);
    if (!priceMatch) continue;

    const price = clean(priceMatch[0]);

    // 3️⃣ Image
    const img = card.querySelector("img");
    const image =
      img?.getAttribute("src") ||
      img?.getAttribute("data-src") ||
      img?.getAttribute("srcset")?.split(" ")[0] ||
      "";

    // 4️⃣ Link
    const linkEl =
      card.tagName.toLowerCase() === "a"
        ? card
        : card.querySelector("a[href]");

    const url = linkEl
      ? new URL(linkEl.getAttribute("href"), location.href).toString()
      : "";

    // 5️⃣ Title extraction priority
    let title =
      clean(linkEl?.getAttribute("aria-label")) ||
      clean(linkEl?.getAttribute("title")) ||
      clean(img?.getAttribute("alt"));

    if (!title) {
      title = fullText.replace(price, "").slice(0, 100);
      title = clean(title);
    }

    if (!title || title.length < 4) continue;

    // 6️⃣ Description (better cleaning)
    let description = fullText;
    description = description.replace(title, "");
    description = description.replace(price, "");
    description = clean(description);

    if (description.length > 400) {
      description = description.slice(0, 400) + "...";
    }

    const key = `${title}-${price}-${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      title,
      price,
      url,
      image,
      description,
      rawText: fullText
    });

    if (results.length >= 25) break;
  }

  return results;
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === "MVP_EXTRACT") {
    try {
      const products = extractProducts();
      sendResponse({
        ok: true,
        products,
        pageUrl: location.href,
        count: products.length
      });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err.toString()
      });
    }
  }
});