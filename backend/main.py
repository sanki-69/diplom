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
            try:
                del self._store[key]
            except Exception:
                pass
            return None
        self._store.move_to_end(key, last=True)
        return val

    def set(self, key: str, val: Any) -> None:
        self._store[key] = (time.time(), val)
        self._store.move_to_end(key, last=True)
        while len(self._store) > self.max_items:
            self._store.popitem(last=False)


ANALYZE_CACHE = LruTtlCache(max_items=2000, ttl_seconds=60 * 60)
CHAT_CACHE = LruTtlCache(max_items=1500, ttl_seconds=60 * 20)
TRANSLATE_CACHE = LruTtlCache(max_items=20000, ttl_seconds=60 * 60)


# -----------------------
# GEMINI CORE (retry/backoff)
# -----------------------
def _parse_retry_seconds(msg: str) -> Optional[int]:
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

    base_wait = 6
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

            try:
                return json.loads(raw)
            except Exception:
                m = re.search(r"(\{.*\}|\[.*\])", raw, flags=re.DOTALL)
                if m:
                    return json.loads(m.group(1))
                raise Exception(f"Gemini JSON parse failed. Snippet: {raw[:250]}")

        except Exception as e:
            msg = str(e)

            if ("RESOURCE_EXHAUSTED" in msg) or ("429" in msg):
                retry_s = _parse_retry_seconds(msg)
                if retry_s is None:
                    retry_s = base_wait * (2 ** attempt)
                retry_s = int(retry_s) + 2
                time.sleep(retry_s)
                continue

            raise

    raise Exception("429: Quota хэтэрсэн байна. Түр хүлээгээд дахин оролдоорой.")


# -----------------------
# BUSINESS LOGIC
# -----------------------
def do_analyze(req: AnalyzeRequest) -> Dict[str, Any]:
    combined = f"{req.title}\n{req.description}".strip()
    lang = safe_detect(combined)

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
        return {"answer": "", "intent": "chat", "search_query": ""}

    k = sha_key(
        "chat",
        req.message,
        req.product_title,
        req.product_price,
        req.product_url,
        req.product_description,
    )
    cached = CHAT_CACHE.get(k)
    if cached:
        return cached

    schema = {
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "intent": {"type": "string"},
            "search_query": {"type": "string"},
        },
        "required": ["answer", "intent", "search_query"],
    }

    prompt = f"""
Та онлайн худалдааны AI чат туслах.
Хариуг ЗААВАЛ Монгол кирилл үсгээр өг.

Контекст:
- Product title: {trunc(req.product_title, 220)}
- Price: {trunc(req.product_price, 60)}
- Product URL: {trunc(req.product_url, 300)}
- Description: {trunc(req.product_description, 1200)}

Хэрэглэгчийн мессеж:
{trunc(req.message, 900)}

Даалгавар:
1) Хэрвээ хэрэглэгч shop дотроос бараа хайхыг хүсэж байвал intent = "search"
2) Үгүй бол intent = "chat"
3) Хэрвээ intent = "search" бол search_query-д англи хэл дээр богино, ойлгомжтой keyword өг
   Жишээ:
   - "хүүхдийн хувцас байна уу" -> "baby clothes"
   - "gaming mouse хайгаад өг" -> "gaming mouse"
   - "computer stuff" -> "computer accessories"
4) answer талбарт хэрэглэгчид Монгол хэлээр юу хийж байгаагаа товч тайлбарла
5) “monglish” байвал ойлгоод кириллээр хариул

Зөвхөн JSON буцаа.

JSON format:
{{
  "answer": "...",
  "intent": "search" эсвэл "chat",
  "search_query": "..."
}}
"""

    out = gemini_generate_json(prompt, schema)

    intent = out.get("intent", "chat")
    if intent not in ["chat", "search"]:
        intent = "chat"

    resp = {
        "answer": out.get("answer", ""),
        "intent": intent,
        "search_query": out.get("search_query", ""),
    }

    CHAT_CACHE.set(k, resp)
    return resp


def _chunk_texts_for_page(texts: List[str], max_chars_per_chunk: int = 7000) -> List[List[str]]:
    chunks: List[List[str]] = []
    cur: List[str] = []
    cur_len = 0

    for t in texts:
        s = (t or "")
        if not s.strip():
            cur.append(s)
            continue

        if len(s) > 800:
            s = s[:800] + "…"

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
    if not texts:
        return {"translated": []}

    translated: List[str] = [""] * len(texts)

    uncached_indices: List[int] = []
    uncached_texts: List[str] = []

    for i, t in enumerate(texts):
        t0 = t or ""
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

    if not uncached_texts:
        return {"translated": translated}

    chunks = _chunk_texts_for_page(uncached_texts, max_chars_per_chunk=6500)

    schema = {"type": "array", "items": {"type": "string"}}

    out_texts: List[str] = []
    for chunk in chunks:
        prompt = (
            "Дараах JSON массив дахь мөр бүрийг Монгол хэл рүү орчуул. "
            "Дарааллыг яг хэвээр хадгал. Зөвхөн JSON array буцаа.\n\n"
            + json.dumps(chunk, ensure_ascii=False)
        )
        arr = gemini_generate_json(prompt, schema)
        if not isinstance(arr, list):
            raise Exception("Translate response is not array")

        if len(arr) != len(chunk):
            if len(arr) < len(chunk):
                arr = arr + [""] * (len(chunk) - len(arr))
            else:
                arr = arr[: len(chunk)]

        out_texts.extend([str(x) for x in arr])

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
        return {
            "error": str(e),
            "answer": "ALDAА: Chat дээр алдаа гарлаа.",
            "intent": "chat",
            "search_query": "",
        }


@app.post("/translate_page")
def translate_page(req: PageTranslateRequest):
    try:
        texts = req.texts[:1200]
        return do_translate_page(texts)
    except Exception as e:
        return {"error": str(e)}