import os
import json
import re
import time
import hashlib
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from langdetect import detect
from dotenv import load_dotenv

from google import genai
from google.genai import types

# -----------------------
# ENV / CLIENT
# -----------------------
load_dotenv()

GEMINI_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()
GEMINI_MODEL = (os.getenv("GEMINI_MODEL") or "gemini-2.5-flash").strip()

client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# -----------------------
# FASTAPI
# -----------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev only
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------
# MODELS
# -----------------------
class AnalyzeRequest(BaseModel):
    title: str = ""
    price: str = ""
    url: str = ""
    description: str = ""
    question: str = ""


class PageTranslateRequest(BaseModel):
    # whole page text nodes (heavy)
    texts: List[str] = []


class ChatRequest(BaseModel):
    message: str = ""
    product_title: str = ""
    product_price: str = ""
    product_url: str = ""
    product_description: str = ""
    page_url: str = ""
    detected_language: str = ""


# -----------------------
# SMALL UTILS
# -----------------------
def trunc(s: str, n: int) -> str:
    s = (s or "").strip()
    return (s[:n] + "…") if len(s) > n else s


def safe_detect(text: str) -> str:
    try:
        t = (text or "").strip()
        if len(t) < 5:
            return "unknown"
        return detect(t)
    except Exception:
        return "unknown"


def sha_key(*parts: str) -> str:
    joined = "|".join([(p or "") for p in parts])
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


# -----------------------
# LRU + TTL CACHE
# -----------------------
class LruTtlCache:
    """
    Simple in-memory cache:
    - LRU eviction
    - TTL expiration
    """
    def __init__(self, max_items: int = 2000, ttl_seconds: int = 60 * 30):
        self.max_items = max_items
        self.ttl_seconds = ttl_seconds
        self._store: "OrderedDict[str, Tuple[float, Any]]" = OrderedDict()

    def get(self, key: str) -> Optional[Any]:
        item = self._store.get(key)
        if not item:
            return None
        ts, val = item
        if (time.time() - ts) > self.ttl_seconds:
            # expired
            try:
                del self._store[key]
            except Exception:
                pass
            return None
        # mark as recently used
        self._store.move_to_end(key, last=True)
        return val

    def set(self, key: str, val: Any) -> None:
        self._store[key] = (time.time(), val)
        self._store.move_to_end(key, last=True)
        # evict
        while len(self._store) > self.max_items:
            self._store.popitem(last=False)


ANALYZE_CACHE = LruTtlCache(max_items=2000, ttl_seconds=60 * 60)     # 1h
CHAT_CACHE = LruTtlCache(max_items=1500, ttl_seconds=60 * 20)        # 20m
TRANSLATE_CACHE = LruTtlCache(max_items=20000, ttl_seconds=60 * 60)  # 1h per line


# -----------------------
# GEMINI CORE (retry/backoff)
# -----------------------
def _parse_retry_seconds(msg: str) -> Optional[int]:
    """
    Example includes:
    'Please retry in 40.802218283s.' or RetryInfo retryDelay '40s'
    """
    m = re.search(r"retry in\s+(\d+)", msg, flags=re.IGNORECASE)
    if m:
        try:
            return int(m.group(1))
        except Exception:
            return None
    m2 = re.search(r"retryDelay'\s*:\s*'(\d+)s'", msg)
    if m2:
        try:
            return int(m2.group(1))
        except Exception:
            return None
    return None


def gemini_generate_json(prompt: str, schema: Any, max_retries: int = 4) -> Any:
    if client is None:
        raise Exception("GEMINI_API_KEY байхгүй байна. backend/.env дотор GEMINI_API_KEY=... гэж тавь.")

    base_wait = 6  # seconds
    for attempt in range(max_retries):
        try:
            result = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.2,
                    response_mime_type="application/json",
                    response_json_schema=schema,
                ),
            )
            raw = (result.text or "").strip()

            # Direct JSON
            try:
                return json.loads(raw)
            except Exception:
                # Extract first JSON block
                m = re.search(r"(\{.*\}|\[.*\])", raw, flags=re.DOTALL)
                if m:
                    return json.loads(m.group(1))
                raise Exception(f"Gemini JSON parse failed. Snippet: {raw[:250]}")

        except Exception as e:
            msg = str(e)

            # 429 / RESOURCE_EXHAUSTED handling
            if ("RESOURCE_EXHAUSTED" in msg) or ("429" in msg):
                retry_s = _parse_retry_seconds(msg)
                if retry_s is None:
                    retry_s = base_wait * (2 ** attempt)  # 6,12,24,48
                # small cushion
                retry_s = int(retry_s) + 2
                time.sleep(retry_s)
                continue

            # other errors -> raise
            raise

    raise Exception("429: Quota хэтэрсэн байна. Түр хүлээгээд дахин оролдоорой.")


# -----------------------
# BUSINESS LOGIC
# -----------------------
def do_analyze(req: AnalyzeRequest) -> Dict[str, Any]:
    combined = f"{req.title}\n{req.description}".strip()
    lang = safe_detect(combined)

    # Cache by product payload (+ question)
    k = sha_key("analyze", req.title, req.price, req.url, req.description, req.question)
    cached = ANALYZE_CACHE.get(k)
    if cached:
        return cached

    schema = {
        "type": "object",
        "properties": {
            "mn_title": {"type": "string"},
            "mn_description": {"type": "string"},
            "ai_explanation": {"type": "string"},
            "question_answer": {"type": "string"},
        },
        "required": ["mn_title", "mn_description", "ai_explanation", "question_answer"],
    }

    prompt = f"""
Та онлайн худалдааны AI туслах.
Зорилго: Хэлний саадыг арилгах.
Хариуг ЗААВАЛ Монгол кирилл үсгээр өг (хэрэглэгч латин монголоор бичсэн ч).

Оролт:
- Title: {trunc(req.title, 220)}
- Price: {trunc(req.price, 60)}
- URL: {trunc(req.url, 300)}
- Description/Text: {trunc(req.description, 1600)}
- Detected language: {lang}
- User question: {trunc(req.question, 500)}

Даалгавар:
1) Title, Description-ийг Монгол хэл рүү ОРЧУУЛ.
2) 4-6 мөрөөр ойлгомжтой тайлбар (юунд хэрэгтэй, давуу тал, анхаарах зүйл).
3) Хэрвээ асуулт байгаа бол Монгол хэлээр тусад нь хариул (асуултгүй бол хоосон string).

Зөвхөн JSON буцаа.
"""

    out = gemini_generate_json(prompt, schema)

    resp = {
        "detected_language": lang,
        "mn": {
            "title": out.get("mn_title", ""),
            "description": out.get("mn_description", ""),
        },
        "explanation": out.get("ai_explanation", ""),
        "question_answer": out.get("question_answer", ""),
    }

    ANALYZE_CACHE.set(k, resp)
    return resp


def do_chat(req: ChatRequest) -> Dict[str, Any]:
    msg = (req.message or "").strip()
    if not msg:
        return {"answer": ""}

    # cache (same msg + same selected product context)
    k = sha_key("chat", req.message, req.product_title, req.product_price, req.product_url, req.product_description)
    cached = CHAT_CACHE.get(k)
    if cached:
        return cached

    schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
    }

    prompt = f"""
Та онлайн худалдааны чат туслах.
Хариуг ЗААВАЛ Монгол кирилл үсгээр өг.

Контекст:
- Product title: {trunc(req.product_title, 220)}
- Price: {trunc(req.product_price, 60)}
- Product URL: {trunc(req.product_url, 300)}
- Description: {trunc(req.product_description, 1200)}

Хэрэглэгчийн мессеж:
{trunc(req.message, 900)}

Дүрэм:
- Ойлгомжтой, товч, хэрэгтэй зөвлөгөө өг.
- Мэдээлэл дутуу бол 1-2 тодруулах асуулт асуу.
- “monglish” (латин монгол) байвал ойлгоод кириллээр хариул.

Зөвхөн JSON буцаа.
"""

    out = gemini_generate_json(prompt, schema)
    resp = {"answer": out.get("answer", "")}
    CHAT_CACHE.set(k, resp)
    return resp


def _chunk_texts_for_page(texts: List[str], max_chars_per_chunk: int = 7000) -> List[List[str]]:
    """
    Whole-page translation is heavy.
    We batch many short texts into one request to reduce request count.
    """
    chunks: List[List[str]] = []
    cur: List[str] = []
    cur_len = 0

    for t in texts:
        s = (t or "")
        if not s.strip():
            cur.append(s)
            continue

        if len(s) > 800:
            # Too long text node -> truncate to avoid huge prompts
            s = s[:800] + "…"

        # if exceed chunk
        if cur_len + len(s) + 1 > max_chars_per_chunk and cur:
            chunks.append(cur)
            cur = []
            cur_len = 0

        cur.append(s)
        cur_len += len(s) + 1

    if cur:
        chunks.append(cur)

    return chunks


def do_translate_page(texts: List[str]) -> Dict[str, Any]:
    """
    Heavy: translate many text nodes.
    Strategy:
    1) per-line cache (TRANSLATE_CACHE)
    2) only send uncached texts to Gemini
    3) batch into chunks to reduce request count
    """
    if not texts:
        return {"translated": []}

    # Keep original length/order
    translated: List[str] = [""] * len(texts)

    # Decide which need translation
    uncached_indices: List[int] = []
    uncached_texts: List[str] = []

    for i, t in enumerate(texts):
        t0 = t or ""
        # Fast skip: whitespace-only
        if not t0.strip():
            translated[i] = t0
            continue

        ck = sha_key("t", t0)
        hit = TRANSLATE_CACHE.get(ck)
        if hit is not None:
            translated[i] = hit
        else:
            uncached_indices.append(i)
            uncached_texts.append(t0)

    # If everything cached
    if not uncached_texts:
        return {"translated": translated}

    # batch
    chunks = _chunk_texts_for_page(uncached_texts, max_chars_per_chunk=6500)

    schema = {"type": "array", "items": {"type": "string"}}

    out_texts: List[str] = []
    for chunk in chunks:
        # IMPORTANT: order must be preserved for this chunk
        prompt = (
            "Дараах JSON массив дахь мөр бүрийг Монгол хэл рүү орчуул. "
            "Дарааллыг яг хэвээр хадгал. Зөвхөн JSON array буцаа.\n\n"
            + json.dumps(chunk, ensure_ascii=False)
        )
        arr = gemini_generate_json(prompt, schema)
        if not isinstance(arr, list):
            raise Exception("Translate response is not array")
        # normalize length
        if len(arr) != len(chunk):
            # If mismatch, best-effort: pad/cut
            if len(arr) < len(chunk):
                arr = arr + [""] * (len(chunk) - len(arr))
            else:
                arr = arr[: len(chunk)]
        out_texts.extend([str(x) for x in arr])

    # Put back into translated in original indices + cache them
    for idx, mn in zip(uncached_indices, out_texts):
        original = texts[idx] or ""
        if not original.strip():
            translated[idx] = original
            continue
        translated[idx] = mn
        TRANSLATE_CACHE.set(sha_key("t", original), mn)

    return {"translated": translated}


# -----------------------
# ROUTES
# -----------------------
@app.get("/health")
def health():
    return {"ok": True, "model": GEMINI_MODEL, "has_key": bool(GEMINI_API_KEY)}


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    try:
        return do_analyze(req)
    except Exception as e:
        return {"error": str(e)}


@app.post("/chat")
def chat(req: ChatRequest):
    try:
        return do_chat(req)
    except Exception as e:
        return {"error": str(e), "answer": "ALDAA: Chat дээр алдаа гарлаа."}


@app.post("/translate_page")
def translate_page(req: PageTranslateRequest):
    try:
        # Heavy mode: you may send huge amount; keep it somewhat safe
        texts = req.texts[:1200]  # hard cap to prevent popup freeze
        return do_translate_page(texts)
    except Exception as e:
        return {"error": str(e)}