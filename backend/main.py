import asyncio
import os
import json
import re
import time
import hashlib
from collections import OrderedDict
import threading
from typing import List, Optional
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse, quote_plus

import math
import httpx
import anthropic
from groq import Groq
from google import genai as google_genai
from google.genai import types as genai_types
from fastapi import FastAPI, Depends, HTTPException, Request, status
from security import (rate_limit, login_guard, client_ip, is_local_request,
                      fetch_public, BlockedURL)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from dotenv import load_dotenv
from pymongo import MongoClient, DESCENDING, ASCENDING
import bcrypt
from jose import JWTError, jwt
from bs4 import BeautifulSoup
from apscheduler.schedulers.background import BackgroundScheduler

# ─────────────────────────────────────────
# ENV
# ─────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

def _env(name: str, default: str) -> str:
    return (os.getenv(name) or default).strip()

SECRET_KEY    = _env("SECRET_KEY", "")
if not SECRET_KEY:
    # No key configured: generate a random one so tokens can't be forged.
    # Logins then reset on every restart, so set SECRET_KEY in .env.
    import secrets
    SECRET_KEY = secrets.token_urlsafe(48)
    print("[warn] SECRET_KEY not set in .env — using a random key; users must log in again after restart")
ALGORITHM     = "HS256"
TOKEN_EXPIRE  = 60 * 24 * 7
MONGO_URL     = _env("MONGODB_URL", "mongodb://localhost:27017")
MONGO_DB_NAME = _env("MONGODB_DB",  "aishop")

# Model names live in .env so a provider retiring a model is a config change.
GROQ_API_KEY    = _env("GROQ_API_KEY", "")
GROQ_CHAT_MODEL = _env("GROQ_CHAT_MODEL", "openai/gpt-oss-120b")
FAST_MODEL      = _env("GROQ_FAST_MODEL", "openai/gpt-oss-20b")

GEMINI_API_KEY     = _env("GEMINI_API_KEY", "")
GEMINI_MODEL       = _env("GEMINI_MODEL", "gemini-3.8-flash")
GEMINI_CHAT_MODEL  = _env("GEMINI_CHAT_MODEL", GEMINI_MODEL)
GEMINI_EMBED_MODEL = _env("GEMINI_EMBED_MODEL", "gemini-embedding-001")
EMBED_DIMS         = 768

ANTHROPIC_API_KEY = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
CLAUDE_MODEL      = (os.getenv("CLAUDE_MODEL") or "claude-haiku-4-5-20251001").strip()

groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

if GEMINI_API_KEY:
    # 30s cap: an overloaded Gemini call must not stall the whole provider chain
    gemini_client     = google_genai.Client(api_key=GEMINI_API_KEY,
                                            http_options=genai_types.HttpOptions(timeout=30000))
    _gemini_available = True
else:
    gemini_client     = None
    _gemini_available = False

if ANTHROPIC_API_KEY:
    claude_client    = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    _claude_available = True
else:
    claude_client    = None
    _claude_available = False


http_client = httpx.AsyncClient(timeout=40.0)

# Optional proxy for shop scraping. Amazon/Walmart block many cloud-server
# addresses; a residential or scraping proxy (e.g. http://user:pass@host:port)
# makes deployed search results closer to what you get at home. Empty = direct.
SCRAPER_PROXY = (os.getenv("SCRAPER_PROXY_URL") or "").strip() or None

# ─────────────────────────────────────────
# MONGODB
# ─────────────────────────────────────────
# Local MongoDB answers in milliseconds; a short timeout keeps requests fast
# (instead of hanging 5s per DB call) when the database is down.
mongo_client = MongoClient(
    MONGO_URL,
    serverSelectionTimeoutMS=10000 if MONGO_URL.startswith("mongodb+srv") else 2000,  # cloud Atlas needs longer
)
mdb          = mongo_client[MONGO_DB_NAME]

# Collections
users_col   = mdb["users"]
products_col = mdb["products"]
chat_col    = mdb["chat_history"]
counters_col = mdb["counters"]

_mongo_down_at_startup = False

def _safe_create_indexes(col, specs: list):
    """Create indexes, but don't crash startup if MongoDB is unreachable.
    /health then reports mongodb=false instead of the server dying."""
    global _mongo_down_at_startup
    if _mongo_down_at_startup:
        return  # already timed out once; don't wait again for every collection
    try:
        for keys, kwargs in specs:
            col.create_index(keys, **kwargs)
    except Exception as e:
        _mongo_down_at_startup = True
        print(f"[mongo] MongoDB not reachable at {MONGO_URL} ({e.__class__.__name__}). "
              "Starting anyway: chat and price search work, login/history/admin don't. "
              "Start it with:  net start MongoDB  (admin), then restart the backend.")

_safe_create_indexes(users_col, [
    ("username", {"unique": True}),
    ("email",    {"unique": True}),
])
_safe_create_indexes(products_col, [("category", {})])
_safe_create_indexes(chat_col, [
    ("session_id", {}),
    ("user_id", {}),
    ([("created_at", DESCENDING)], {}),
])


def next_id(name: str) -> int:
    """Auto-increment integer ID per collection."""
    result = counters_col.find_one_and_update(
        {"_id": name},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    return result["seq"]


def clean(doc: Optional[dict]) -> Optional[dict]:
    """Remove MongoDB _id field."""
    if doc is None:
        return None
    doc.pop("_id", None)
    return doc


def clean_many(docs) -> list:
    return [clean(d) for d in docs]


# ─────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def make_token(username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_EXPIRE)
    return jwt.encode({"sub": username, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


class UserObj:
    """Thin wrapper so code can use user.username, user.is_admin etc."""
    def __init__(self, d: dict):
        self.id         = d.get("id")
        self.username   = d.get("username", "")
        self.email      = d.get("email", "")
        self.is_admin   = d.get("is_admin", False)
        self.created_at = d.get("created_at")


def _find_user(username: str) -> Optional[dict]:
    return clean(users_col.find_one({"username": username}))


def get_current_user(token: str = Depends(oauth2_scheme)) -> Optional[UserObj]:
    if not token:
        return None
    try:
        payload  = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username:
            return None
    except JWTError:
        return None
    doc = _find_user(username)
    return UserObj(doc) if doc else None


def require_user(u: Optional[UserObj] = Depends(get_current_user)) -> UserObj:
    if not u:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Нэвтрэх шаардлагатай")
    return u


def require_admin(u: UserObj = Depends(require_user)) -> UserObj:
    if not u.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Admin эрх шаардлагатай")
    return u


# Earlier versions stored every password in plain text next to the hash.
# Login only ever uses the bcrypt hash, so drop the plain copies on startup.
try:
    if _mongo_down_at_startup:
        raise RuntimeError("mongo down")
    _r = users_col.update_many({"plain_password": {"$exists": True}}, {"$unset": {"plain_password": ""}})
    if _r.modified_count:
        print(f"[security] removed stored plain-text passwords from {_r.modified_count} user(s)")
except Exception:
    pass  # MongoDB down; will run on the next start



# ─────────────────────────────────────────
# FASTAPI
# ─────────────────────────────────────────
app = FastAPI(title="AI Shop API — MongoDB")
# Which websites may call this API. Default "*" because the Chrome extension
# calls it from whatever shop page you are on. To lock it to the web app only,
# set ALLOWED_ORIGINS=https://your-app.vercel.app (comma-separated for several).
# Logins use a Bearer token header, not cookies, so credentials stay off.
_origins = [o.strip().rstrip("/") for o in _env("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────
# PYDANTIC SCHEMAS
# ─────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    title: str = ""
    price: str = ""
    url: str = ""
    description: str = ""
    question: str = ""

class PageTranslateRequest(BaseModel):
    texts: List[str] = []
    source_lang: str = "en"

    def model_post_init(self, _):
        self.texts = self.texts[:500]
        self.source_lang = (self.source_lang or "en")[:5]

class ChatMessageSchema(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str = ""
    product_title: str = ""
    product_price: str = ""
    product_url: str = ""
    product_description: str = ""
    product_rating: str = ""
    product_review_count: str = ""
    product_source: str = ""
    history: List[ChatMessageSchema] = []
    session_id: Optional[str] = None
    search_context: str = ""   # active search query shown on screen (e.g. "Adidas shoes")

    def model_post_init(self, _):
        self.message             = (self.message or "")[:2000]
        self.product_title       = (self.product_title or "")[:300]
        self.product_description = (self.product_description or "")[:1000]
        self.search_context      = (self.search_context or "")[:200]
        self.history             = [ChatMessageSchema(role=m.role[:10], content=(m.content or "")[:2000])
                                    for m in self.history[-20:]]   # cap depth and size

class UserCreate(BaseModel):
    username: str
    email: str
    password: str

    def model_post_init(self, _):
        self.username = (self.username or "").strip()[:50]
        self.email    = (self.email or "").strip()[:200]
        if len(self.username) < 3:
            raise ValueError("Нэр хэтэрхий богино (3+ тэмдэгт)")
        if len(self.password) < 6:
            raise ValueError("Нууц үг хэтэрхий богино (6+ тэмдэгт)")
        if "@" not in self.email:
            raise ValueError("Email буруу байна")

class UserLoginRequest(BaseModel):
    username: str
    password: str

    def model_post_init(self, _):
        self.username = (self.username or "").strip()[:50]

class ProductCreate(BaseModel):
    name: str
    description: str = ""
    price: float
    image_url: str = ""
    category: str = ""
    stock: int = 0

# ─────────────────────────────────────────
# UTILS / CACHE
# ─────────────────────────────────────────
def trunc(s: str, n: int) -> str:
    s = (s or "").strip()
    return (s[:n] + "…") if len(s) > n else s

def sha_key(*parts: str) -> str:
    return hashlib.sha256("|".join(p or "" for p in parts).encode()).hexdigest()

class LruTtlCache:
    def __init__(self, max_items=2000, ttl_seconds=1800):
        self.max_items   = max_items
        self.ttl_seconds = ttl_seconds
        self._store: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            item = self._store.get(key)
            if not item:
                return None
            ts, val = item
            if (time.time() - ts) > self.ttl_seconds:
                self._store.pop(key, None)
                return None
            self._store.move_to_end(key)
            return val

    def set(self, key, val):
        with self._lock:
            self._store[key] = (time.time(), val)
            self._store.move_to_end(key)
            while len(self._store) > self.max_items:
                self._store.popitem(last=False)

ANALYZE_CACHE   = LruTtlCache(2000, 7200)    # 2h — product pages don't change often
CHAT_CACHE      = LruTtlCache(2000, 1800)    # 30min
TRANSLATE_CACHE = LruTtlCache(20000, 86400)  # 24h — translations never change



# ─────────────────────────────────────────
# CLAUDE (Anthropic)
# ─────────────────────────────────────────
def _claude_call(system_prompt: str, user_prompt: str, max_tokens: int) -> str:
    """Blocking Claude API call — run via run_in_executor from async context."""
    msg = claude_client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=max_tokens,
        system=system_prompt + "\n\nOutput ONLY valid JSON. No markdown, no explanation.",
        messages=[{"role": "user", "content": user_prompt}],
        temperature=0.2,
    )
    return (msg.content[0].text or "").strip()

def _parse_claude_json(raw: str) -> dict:
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.I)
    raw = re.sub(r"\s*```$", "", raw.strip())
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"(\{.*\}|\[.*\])", raw, re.DOTALL)
        if m:
            return json.loads(m.group(1))
        raise ValueError(f"Claude JSON parse failed: {raw[:200]}")

def claude_generate_json(system_prompt: str, user_prompt: str, max_tokens: int = 512, max_retries: int = 3) -> dict:
    if not _claude_available:
        raise Exception("ANTHROPIC_API_KEY байхгүй байна.")
    for attempt in range(max_retries):
        try:
            raw = _claude_call(system_prompt, user_prompt, max_tokens)
            return _parse_claude_json(raw)
        except Exception as e:
            err = str(e).lower()
            if "overloaded" in err or "529" in err or "rate" in err or "429" in err:
                time.sleep(min(4 * 2**attempt, 20))
                continue
            raise
    raise Exception("Claude overloaded. Түр хүлээгээд дахин оролдоорой.")

async def claude_generate_json_async(system_prompt: str, user_prompt: str, max_tokens: int = 512, max_retries: int = 3) -> dict:
    if not _claude_available:
        raise Exception("ANTHROPIC_API_KEY байхгүй байна.")
    loop = asyncio.get_event_loop()
    for attempt in range(max_retries):
        try:
            raw = await loop.run_in_executor(
                None, _claude_call, system_prompt, user_prompt, max_tokens
            )
            return _parse_claude_json(raw)
        except Exception as e:
            err = str(e).lower()
            if "overloaded" in err or "529" in err or "rate" in err or "429" in err:
                await asyncio.sleep(min(4 * 2**attempt, 20))
                continue
            raise
    raise Exception("Claude overloaded. Түр хүлээгээд дахин оролдоорой.")

# ─────────────────────────────────────────
# GROQ
# ─────────────────────────────────────────
def _groq_call(model: str, system_prompt: str, user_prompt: str, max_tokens: int) -> str:
    kwargs = {}
    if "gpt-oss" in model:
        # Reasoning models: hidden "thinking" tokens count toward max_tokens.
        # Low effort is ~3x faster, and extra headroom stops the reasoning
        # from using up the budget and returning an empty answer.
        kwargs["reasoning_effort"] = "low"
        max_tokens += 512
    resp = groq_client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        temperature=0.2,
        max_tokens=max_tokens,
        response_format={"type": "json_object"},
        **kwargs,
    )
    return (resp.choices[0].message.content or "").strip()

def _parse_groq_json(raw: str) -> dict:
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"(\{.*\}|\[.*\])", raw, re.DOTALL)
        if m:
            return json.loads(m.group(1))
        raise ValueError(f"JSON parse failed: {raw[:200]}")

def groq_generate_json(system_prompt, user_prompt, model=None, max_tokens=512, max_retries=3):
    if groq_client is None:
        raise Exception("GROQ_API_KEY байхгүй байна.")
    model = model or GROQ_CHAT_MODEL
    for attempt in range(max_retries):
        try:
            raw = _groq_call(model, system_prompt, user_prompt, max_tokens)
            return _parse_groq_json(raw)
        except Exception as e:
            if "rate_limit" in str(e).lower() or "429" in str(e):
                time.sleep(min(4 * 2**attempt, 20))
                continue
            raise
    raise Exception("Groq rate limit. Түр хүлээгээд дахин оролдоорой.")

async def groq_generate_json_async(system_prompt, user_prompt, model=None, max_tokens=512, max_retries=3):
    if groq_client is None:
        raise Exception("GROQ_API_KEY байхгүй байна.")
    model = model or GROQ_CHAT_MODEL
    loop = asyncio.get_event_loop()
    for attempt in range(max_retries):
        try:
            raw = await loop.run_in_executor(
                None, _groq_call, model, system_prompt, user_prompt, max_tokens
            )
            return _parse_groq_json(raw)
        except Exception as e:
            if "rate_limit" in str(e).lower() or "429" in str(e):
                await asyncio.sleep(min(4 * 2**attempt, 20))
                continue
            raise
    raise Exception("Groq rate limit. Түр хүлээгээд дахин оролдоорой.")

# ─────────────────────────────────────────
# GEMINI
# ─────────────────────────────────────────
def _gemini_call(system_prompt: str, user_prompt: str, max_tokens: int, model: str) -> str:
    clean_user = re.sub(r"\s*\nOutput:\s*$", "", user_prompt.rstrip())
    combined   = f"{system_prompt}\n\n{clean_user}"
    thinking_cfg = None
    try:
        if "2.5" in model:
            thinking_cfg = genai_types.ThinkingConfig(thinking_budget=0)
        elif "gemini-3" in model:
            # Gemini 3.x rejects thinking_budget=0 on some models; "low"
            # keeps answers fast and leaves the token budget for the JSON.
            thinking_cfg = genai_types.ThinkingConfig(thinking_level="low")
    except Exception:
        pass
    cfg = genai_types.GenerateContentConfig(
        response_mime_type="application/json",
        temperature=0.2,
        # Gemini 3 "thinking" tokens count toward this limit; without headroom a
        # short request (e.g. 200 tokens) gets cut off mid-sentence.
        max_output_tokens=max_tokens + (512 if "gemini-3" in model else 0),
    )
    if thinking_cfg is not None:
        cfg.thinking_config = thinking_cfg
    response = gemini_client.models.generate_content(
        model=model, contents=combined, config=cfg,
    )
    return (response.text or "").strip()

def _parse_gemini_json(raw: str) -> dict:
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.I)
    raw = re.sub(r"\s*```$", "", raw.strip())
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"(\{.*\}|\[.*\])", raw, re.DOTALL)
        if m:
            return json.loads(m.group(1))
        raise ValueError(f"Gemini JSON parse failed: {raw[:200]}")

def _gemini_skip_seconds(err: str) -> int:
    """How long to stop calling Gemini after this error (0 = don't skip).
    Quota/rate-limit and "model overloaded" errors won't fix themselves on an
    immediate retry, so we fall straight through to Groq instead of waiting."""
    err = err.lower()
    if "quota" in err or "429" in err or "resource_exhausted" in err:
        # daily quota: 1 hour; per-minute rate limit: 5 minutes
        return 3600 if ("per_day" in err or "per_project" in err or "limit: 0" in err) else 300
    if "503" in err or "unavailable" in err or "overloaded" in err:
        return 60
    return 0

def gemini_generate_json(system_prompt: str, user_prompt: str, max_tokens: int = 512, max_retries: int = 2, model: str = None) -> dict:
    if not _gemini_available:
        raise Exception("GEMINI_API_KEY байхгүй байна.")
    _model = model or GEMINI_MODEL
    for attempt in range(max_retries):
        try:
            raw = _gemini_call(system_prompt, user_prompt, max_tokens, _model)
            return _parse_gemini_json(raw)
        except Exception as e:
            if _gemini_skip_seconds(str(e)):
                raise  # let circuit breaker handle immediately
            if attempt < max_retries - 1:
                time.sleep(2)
                continue
            raise
    raise Exception("Gemini failed.")

async def gemini_generate_json_async(system_prompt: str, user_prompt: str, max_tokens: int = 512, max_retries: int = 2, model: str = None) -> dict:
    if not _gemini_available:
        raise Exception("GEMINI_API_KEY байхгүй байна.")
    _model = model or GEMINI_MODEL
    loop = asyncio.get_event_loop()
    for attempt in range(max_retries):
        try:
            raw = await loop.run_in_executor(
                None, _gemini_call, system_prompt, user_prompt, max_tokens, _model
            )
            return _parse_gemini_json(raw)
        except Exception as e:
            if _gemini_skip_seconds(str(e)):
                raise
            if attempt < max_retries - 1:
                await asyncio.sleep(2)
                continue
            raise
    raise Exception("Gemini failed.")

# ─────────────────────────────────────────
# OPENAI-COMPATIBLE FREE PROVIDERS  (OpenRouter, Mistral, any custom one)
# ─────────────────────────────────────────
# Many providers speak the same "OpenAI chat completions" protocol, so one
# small function covers them all. Each is enabled just by adding its key.
def _csv(name: str, default: str) -> list:
    return [x.strip() for x in _env(name, default).split(",") if x.strip()]

COMPAT_PROVIDERS = {
    # OpenRouter: one free key, ~20 free models (ids ending in ":free").
    # Free accounts get ~50 requests/day (1000/day after a one-time $10 top-up).
    # The list is a fallback chain: OpenRouter tries the next model if one is busy.
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "api_key":  _env("OPENROUTER_API_KEY", ""),
        "models":      _csv("OPENROUTER_MODELS",
                            "nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free,"
                            "nvidia/nemotron-3-super-120b-a12b:free,openrouter/free"),
        "fast_models": _csv("OPENROUTER_FAST_MODELS",
                            "google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3.5-lightning:free,openrouter/free"),
        # Reasoning models (e.g. Nemotron Ultra): think briefly, and keep the
        # reasoning text out of the answer so only the JSON comes back.
        "extra": {"reasoning": {"effort": _env("OPENROUTER_REASONING_EFFORT", "low"), "exclude": True}},
    },
    # Mistral "Experiment" plan: free, very generous monthly quota.
    "mistral": {
        "base_url": "https://api.mistral.ai/v1",
        "api_key":  _env("MISTRAL_API_KEY", ""),
        "models":      _csv("MISTRAL_MODEL", "mistral-large-latest"),
        "fast_models": _csv("MISTRAL_FAST_MODEL", "mistral-small-latest"),
        "extra": {},
    },
    # Any other OpenAI-compatible service (Together, DeepSeek, a local Ollama, ...).
    "custom": {
        "base_url": _env("CUSTOM_AI_BASE_URL", "").rstrip("/"),
        "api_key":  _env("CUSTOM_AI_API_KEY", ""),
        "models":      _csv("CUSTOM_AI_MODEL", ""),
        "fast_models": _csv("CUSTOM_AI_FAST_MODEL", _env("CUSTOM_AI_MODEL", "")),
        "extra": {},
    },
}

_THINK_RE = re.compile(r"<think>.*?</think>", re.S | re.I)

def compat_generate_json(name: str, system_prompt: str, user_prompt: str, max_tokens: int, fast: bool) -> dict:
    cfg = COMPAT_PROVIDERS[name]
    models = (cfg["fast_models"] if fast else cfg["models"]) or cfg["models"]
    body = {
        "model": models[0],
        "messages": [
            {"role": "system", "content": system_prompt + "\n\nOutput ONLY valid JSON. No markdown, no explanation."},
            {"role": "user",   "content": user_prompt},
        ],
        "temperature": 0.2,
        "max_tokens": max_tokens + 512,          # headroom for models that think first
        "response_format": {"type": "json_object"},
        **cfg["extra"],
    }
    if name == "openrouter" and len(models) > 1:
        body["models"] = models                  # OpenRouter's built-in model fallback
    headers = {"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"}
    if name == "openrouter":
        headers.update({"HTTP-Referer": "https://github.com/sanki-69/diplom", "X-Title": "AI Shop"})
    r = httpx.post(f"{cfg['base_url']}/chat/completions", json=body, headers=headers, timeout=60)
    if r.status_code >= 400:
        raise Exception(f"{r.status_code} {r.text[:300]}")
    data = r.json()
    if data.get("error"):
        raise Exception(str(data["error"])[:300])
    raw = (data["choices"][0]["message"].get("content") or "").strip()
    raw = _THINK_RE.sub("", raw).strip()
    if not raw:
        raise ValueError("empty answer")
    return _parse_gemini_json(raw)   # same tolerant JSON parsing (strips ``` fences)

# ─────────────────────────────────────────
# UNIFIED AI CHAIN — tries providers in AI_PROVIDER_ORDER, skipping any
# without a key or temporarily rate-limited, until one answers.
# ─────────────────────────────────────────
# Gemini overload ("503 high demand") is per model, so the same free key can
# fall back to another Flash model. Fast tasks (query understanding, page
# translation) start with Flash-Lite, which answers in about a second.
GEMINI_MODELS      = _csv("GEMINI_MODELS", f"{GEMINI_MODEL},gemini-3.5-flash,gemini-3.5-flash-lite")
GEMINI_FAST_MODELS = _csv("GEMINI_FAST_MODELS", f"gemini-3.5-flash-lite,{GEMINI_MODEL}")

def _gemini_call_chain(system_prompt, user_prompt, max_tokens, fast):
    last_err = None
    for model in dict.fromkeys(GEMINI_FAST_MODELS if fast else GEMINI_MODELS):
        key = f"gemini:{model}"
        if time.time() < _down_until.get(key, 0):
            continue
        try:
            return gemini_generate_json(system_prompt, user_prompt, max_tokens, max_retries=1, model=model)
        except Exception as e:
            secs = _gemini_skip_seconds(str(e))
            if not secs:
                raise                      # not an overload (e.g. bad JSON): let the chain move on
            _mark_down(key, secs)          # this model is busy → try the next Gemini model
            last_err = e
    raise last_err or Exception("503 all Gemini models paused")

def _groq_call_chain(system_prompt, user_prompt, max_tokens, fast):
    model = FAST_MODEL if fast else GROQ_CHAT_MODEL
    # one attempt only: on a rate limit, move to the next provider instead of sleeping
    return groq_generate_json(system_prompt, user_prompt, model=model, max_tokens=max_tokens, max_retries=1)

PROVIDERS = {
    "gemini":     (lambda: _gemini_available,              _gemini_call_chain),
    "groq":       (lambda: groq_client is not None,        _groq_call_chain),
    "openrouter": (lambda: bool(COMPAT_PROVIDERS["openrouter"]["api_key"]),
                   lambda *a: compat_generate_json("openrouter", *a)),
    "mistral":    (lambda: bool(COMPAT_PROVIDERS["mistral"]["api_key"]),
                   lambda *a: compat_generate_json("mistral", *a)),
    "custom":     (lambda: bool(COMPAT_PROVIDERS["custom"]["base_url"] and COMPAT_PROVIDERS["custom"]["models"]),
                   lambda *a: compat_generate_json("custom", *a)),
}
AI_PROVIDER_ORDER = [p for p in _csv("AI_PROVIDER_ORDER", "gemini,mistral,openrouter,groq,custom") if p in PROVIDERS]
# Quick helper calls (search-query understanding, page translation) can use a
# different order, e.g. keep them on Gemini Flash-Lite so a small daily quota
# like OpenRouter's free plan is saved for real chat answers.
AI_FAST_PROVIDER_ORDER = [p for p in _csv("AI_FAST_PROVIDER_ORDER", ",".join(AI_PROVIDER_ORDER)) if p in PROVIDERS]

_down_until: dict = {}
_last_provider: dict = {"name": None}

def active_providers(fast: bool = False) -> list:
    order = AI_FAST_PROVIDER_ORDER if fast else AI_PROVIDER_ORDER
    return [p for p in order if PROVIDERS[p][0]()]

def _mark_down(name: str, seconds: int):
    _down_until[name] = time.time() + seconds
    print(f"[ai] {name} rate-limited/overloaded — skipping for {seconds}s")

def ai_generate_json(system_prompt: str, user_prompt: str, max_tokens: int = 512, fast: bool = False) -> dict:
    errors = []
    for name in active_providers(fast):
        if time.time() < _down_until.get(name, 0):
            continue
        try:
            out = PROVIDERS[name][1](system_prompt, user_prompt, max_tokens, fast)
            _last_provider["name"] = name
            return out
        except Exception as e:
            secs = _gemini_skip_seconds(str(e))   # 429 / quota / 503 → sideline for a while
            if secs:
                _mark_down(name, secs)
            else:
                print(f"[ai] {name} failed ({str(e)[:160]}), trying next provider")
            errors.append(f"{name}: {str(e)[:120]}")
    if not active_providers():
        raise Exception("AI provider байхгүй. .env файлд дор хаяж нэг AI түлхүүр (GEMINI/GROQ/OPENROUTER/MISTRAL) тохируулна уу.")
    raise Exception("Бүх AI provider түр ажиллахгүй байна: " + " | ".join(errors or ["all rate-limited"]))

async def ai_generate_json_async(system_prompt: str, user_prompt: str, max_tokens: int = 512, fast: bool = False) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, ai_generate_json, system_prompt, user_prompt, max_tokens, fast)


# ─────────────────────────────────────────
# EMBEDDINGS  (Gemini, model set by GEMINI_EMBED_MODEL)
# ─────────────────────────────────────────
EMBED_CACHE = LruTtlCache(10000, 86400)  # 24h — embeddings never change

# Vectors from different embedding models are not comparable, so every stored
# product embedding is tagged with the model that produced it. Search only uses
# vectors from the current model; POST /products/embed-all refreshes old ones.
EMBED_MODEL_FILTER = {"embedding": {"$exists": True}, "embedding_model": GEMINI_EMBED_MODEL}

def embedding_fields(vec: Optional[list]) -> dict:
    return {"embedding": vec, "embedding_model": GEMINI_EMBED_MODEL} if vec else {}

def embed_text(text: str) -> Optional[list]:
    """Return a 768-dim float vector. Returns None if Gemini unavailable."""
    if not _gemini_available or not text:
        return None
    text = text.strip()[:2000]
    ck = sha_key("embed", text)
    cached = EMBED_CACHE.get(ck)
    if cached is not None:
        return cached
    try:
        resp = gemini_client.models.embed_content(
            model=GEMINI_EMBED_MODEL, contents=text,
            config=genai_types.EmbedContentConfig(output_dimensionality=EMBED_DIMS),
        )
        vec = resp.embeddings[0].values
        EMBED_CACHE.set(ck, vec)
        return vec
    except Exception as e:
        print(f"[embed] {e}")
        return None

def cosine_similarity(a: list, b: list) -> float:
    dot    = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)

def embed_product_doc(doc: dict) -> Optional[list]:
    text = f"{doc.get('name','')} {doc.get('description','')} {doc.get('category','')}".strip()
    return embed_text(text)

def semantic_product_search(query: str, top_k: int = 3) -> list:
    """Top-K most similar products by cosine similarity against stored embeddings."""
    q_vec = embed_text(query)
    if q_vec is None:
        return []
    results = []
    for doc in products_col.find(
        EMBED_MODEL_FILTER,
        {"_id": 0, "embedding": 1, "name": 1, "price": 1, "description": 1, "category": 1, "id": 1},
    ):
        vec = doc.get("embedding")
        if vec:
            results.append((cosine_similarity(q_vec, vec), doc))
    results.sort(key=lambda x: x[0], reverse=True)
    out = []
    for score, doc in results[:top_k]:
        d = {k: v for k, v in doc.items() if k != "embedding"}
        d["similarity"] = round(score, 4)
        out.append(d)
    return out

# Cached flag — skip DB count on every chat if catalog has no embeddings
_rag_has_products: Optional[bool] = None
_rag_last_check: float = 0.0

def _rag_catalog_has_products() -> bool:
    global _rag_has_products, _rag_last_check
    now = time.time()
    if _rag_has_products is None or (now - _rag_last_check) > 60:
        try:
            _rag_has_products = products_col.count_documents(EMBED_MODEL_FILTER, limit=1) > 0
        except Exception:
            _rag_has_products = False  # MongoDB down: chat still works, just without catalog
        _rag_last_check = now
    return _rag_has_products

# ─────────────────────────────────────────
# TRANSLATION
# ─────────────────────────────────────────
MYMEMORY_URL = "https://api.mymemory.translated.net/get"

async def mymemory_translate_one(text: str) -> str:
    t = (text or "").strip()
    if not t: return text
    resp = await http_client.get(MYMEMORY_URL, params={"q": t, "langpair": "en|mn"})
    if resp.status_code != 200: raise Exception(f"MyMemory {resp.status_code}")
    data       = resp.json()
    translated = data.get("responseData", {}).get("translatedText", "")
    return translated if translated and "MYMEMORY WARNING" not in translated else text

def groq_translate_batch(texts: List[str], source_lang="en") -> List[str]:
    if not texts: return texts
    numbered  = "\n".join(f"{i+1}. {t}" for i, t in enumerate(texts))
    lang_name = "Chinese" if source_lang == "zh" else "English"
    result    = ai_generate_json(
        "You are a translator. Return ONLY valid JSON.",
        f"Translate each line from {lang_name} to Mongolian Cyrillic.\n"
        f'Return JSON: {{"translations": ["..."]}} same count as input.\n\n{numbered}',
        max_tokens=3000, fast=True,
    )
    translations = result.get("translations", [])
    if isinstance(translations, list) and len(translations) == len(texts):
        return translations
    return texts

async def do_translate_page(texts: List[str], source_lang="en"):
    if not texts: return {"translated": []}
    translated = list(texts)
    pending    = []
    for i, t in enumerate(texts):
        t0 = (t or "").strip()
        if not t0: continue
        ck     = sha_key(source_lang, t0)
        cached = TRANSLATE_CACHE.get(ck)
        if cached is not None:
            translated[i] = cached
        else:
            pending.append((i, t0[:400], ck))
    if not pending:
        return {"translated": translated}
    if source_lang == "zh":
        for start in range(0, len(pending), 50):
            chunk = pending[start:start+50]
            try:
                results = groq_translate_batch([t0 for _, t0, _ in chunk], "zh")
                for (i, _, ck), r in zip(chunk, results):
                    TRANSLATE_CACHE.set(ck, r); translated[i] = r
            except Exception as e:
                print(f"[translate] {e}")
    else:
        results = await asyncio.gather(*[mymemory_translate_one(t0) for _, t0, _ in pending], return_exceptions=True)
        for (i, _, ck), r in zip(pending, results):
            if not isinstance(r, Exception):
                TRANSLATE_CACHE.set(ck, r); translated[i] = r
    return {"translated": translated}

# ─────────────────────────────────────────
# BUSINESS LOGIC
# ─────────────────────────────────────────
def do_analyze(req: AnalyzeRequest):
    k      = sha_key("analyze", req.title, req.price, req.url, req.description, req.question)
    cached = ANALYZE_CACHE.get(k)
    if cached: return cached
    system = "Та орчуулагч бөгөөд бараа анализ хийдэг AI туслах. Зөвхөн JSON буцаа."
    user   = f"""Монгол кириллээр хариул.
Title: {trunc(req.title,150)}
Price: {trunc(req.price,40)}
Description: {trunc(req.description,800)}
Асуулт: {trunc(req.question,200)}
JSON:
{{"mn_title":"...","mn_description":"...","ai_explanation":"3-4 мөр тайлбар","question_answer":"..."}}"""
    out = ai_generate_json(system, user, max_tokens=400, fast=True)
    resp = {
        "mn":          {"title": out.get("mn_title",""), "description": out.get("mn_description","")},
        "explanation": out.get("ai_explanation",""),
        "question_answer": out.get("question_answer",""),
    }
    ANALYZE_CACHE.set(k, resp)
    return resp

_GARBAGE_PATTERNS = [
    "keyboard shortcut", "skip to", "skip to main", "screen reader",
    "add to cart", "add to bag", "javascript", "cookie", "privacy policy",
    "terms of service", "sign in", "log in", "create account",
    "shop on ebay", "results for", "see more", "view all",
    "advertisement", "sponsored content", "click here",
]

def _is_valid_product_title(title: str) -> bool:
    if not title:
        return False
    t = title.strip()
    if len(t) < 4 or len(t) > 300:
        return False
    low = t.lower()
    if any(pat in low for pat in _GARBAGE_PATTERNS):
        return False
    # Reject titles that are just numbers or single symbols
    if re.match(r"^[\d\s\W]+$", t):
        return False
    return True


# ─────────────────────────────────────────
# QUERY INTERPRETER
# Understands Mongolian Cyrillic, Latin-
# transliterated Mongolian, and English.
# Returns clean English product search terms.
# ─────────────────────────────────────────
INTERPRET_CACHE = LruTtlCache(8000, 28800)  # 8h — search terms repeat constantly

def _interpret_prompts(raw: str) -> tuple[str, str]:
    """Returns (system_prompt, user_prompt) tuple for query interpretation."""
    system = (
        "You are a product search query interpreter for a Mongolian e-commerce platform.\n"
        "Users write in Mongolian Cyrillic, Latin-transliterated Mongolian, English, or any mix.\n\n"
        "CRITICAL: Mongolian is agglutinative — roots take many case/possessive suffixes.\n"
        "The same product word appears in many inflected forms. Always strip suffixes mentally:\n"
        "  утас (phone) → утасны/utasny (gen), утасаар/utasaar (instr), утасдаа (dat+poss)\n"
        "  гутал (shoes) → гуталны/gutalny, гуталаа/gutalaa, гуталд/gutald\n"
        "  ноутбук (laptop) → ноутбукийн/noutbukiin, ноутбукаа/noutbukaa\n"
        "Treat all inflected forms as the same product.\n\n"
        "Your job: extract what product(s) the user wants and return short English search terms.\n\n"
        "RULES:\n"
        "1. 'queries' — short English product terms, 1-5 words. NEVER full sentences.\n"
        "2. Preserve brand names and model numbers EXACTLY: 'iPhone 15 Pro', 'RTX 4090', 'Nike Air Max 90'.\n"
        "3. Preserve specs: '128GB', '4K', '13 inch' — append to the query term.\n"
        "4. Prepend color if mentioned: 'хар утас'/'har utas' → 'black smartphone'.\n"
        "5. Prepend 'budget' only when user signals cheap/affordable (хямд/hyamd) and no specific model.\n"
        "6. 'understood' field — always in Mongolian Cyrillic.\n"
        "7. One array entry per distinct product the user mentions.\n"
        "8. Ignore action words: олоод өг, хайж өг, avna, find me, get me, look for, etc.\n"
        "9. Ignore quality words: saikhan, saain, good, nice — not product names.\n"
        "10. Handle ANY product category: food, sports, clothing, furniture, beauty, garden, automotive, books, music, toys, tools, baby, pet, office, industrial — not just electronics.\n\n"
        "CRITICAL DISTINCTIONS — never confuse these:\n"
        "  ноутбук/noutbuk/laptop → 'laptop' (portable, battery)\n"
        "  компьютер/komputer/PC/desktop → 'desktop computer' (stationary) — NOT 'laptop'\n"
        "  'computer', 'PC', 'laptop' typed in English → return EXACTLY as typed, do NOT change\n\n"
        "Common Mongolian→English mappings:\n"
        "  утас/utas → smartphone | ноутбук/noutbuk → laptop\n"
        "  компьютер/komputer → desktop computer (NOT laptop)\n"
        "  чихэвч/chihevch → headphones | гутал/gutul → shoes\n"
        "  дугуй/dugui → bicycle | майхан/maihan → camping tent\n"
        "  хямд/hyamd → budget signal\n"
        "  хар/har (standalone only) → black | цагаан/tsagaan → white | улаан/ulaan → red\n"
        "  haruulach/haruul/haraa = 'show me' action (NOT the color black)\n"
        "  хүүхдийн/huuhdiin → kids | наадгай/naadgai → toy | тоглоом/togloom → toy (NOT gaming PC)\n"
        "  үнэртэй ус/unertel us/unertei us/uner → perfume (NOT water)\n"
        "  цамц/tsamts → shirt | өмд/omd → pants | малгай/malgai → hat\n"
        "  хулгана/hulgana (in tech context) → computer mouse\n"
        "  зурагт/zuragt → television | камер/camr/kamer → camera\n"
        "  шампунь/shampun → shampoo | нүүрний тос/nuurnii tos → face cream\n"
        "  ном/nom → book | дэвтэр/devter → notebook | харандаа/harandaa → pencil\n"
        "  гитар/gitar → guitar | хэнгэрэг/hengered → drum | пиано/piano → piano\n"
        "  тавилга/tavilga → furniture | ширээ/shiree → desk/table | сандал/sandal → chair\n"
        "  хивс/hivs → carpet/rug | дэрний уут/dernii uut → pillowcase\n"
        "  спорт/sport → sports equipment | дугуй/dugui → bicycle | жингийн дамбар/zingin dambar → weights dumbbell\n"
        "  тоглоомын консол/togloomiin konsol → game console | геймпад/gamepad → gamepad\n"
        "  нохой/nohoi → dog supplies | муур/muur → cat supplies\n"
        "  шатар/shatar → chess | карт/kart → cards | тоглоом → toy\n"
        "  дрон/dron/drone → drone | гэрэл зураг/gerel zurag → photography\n\n"
        'Return ONLY valid JSON: {"queries":[...],"original_language":"mn_cyrillic|mn_latin|en","understood":"..."}'
    )
    return system, f'User input: "{raw}"'


# ── Local keyword dictionary (fast path — zero AI calls needed) ───────────────
# Each entry: (compiled_regex, english_search_term, mongolian_display_label)
_MN_DICT: list[tuple[re.Pattern, str, str]] = [
    # Phones — require "utas" root OR explicit "gar utas" compound; NOT bare "ukhalag"
    (re.compile(
        r"\b(utas|utasna|utasny|utasnii|utasar|utasand|utanter|"
        r"ukhalag[\s\-]utas|gariin[\s\-]utas|gar[\s\-]?utas|"
        r"ухаалаг\s*утас|утас|garphone|gар утас)\b", re.I),
        "smartphone", "утас"),

    # Laptops / computers
    (re.compile(
        r"\b(noutbuk|noutbook|noutpuk|notbuk|laptop|lapttop|"
        r"komputer|kompyuter|computer|зөөврийн\s*компьютер|ноутбук)\b", re.I),
        "laptop", "зөөврийн компьютер"),

    # Headphones / earbuds
    (re.compile(
        r"\b(chihevch|chikhevchin|chihivch|chikhevch|chihewch|chikhivch|"
        r"chihev|earphone|earbuds|headphone|чихэвч|чихивч)\b", re.I),
        "headphones", "чихэвч"),

    # Tablets
    (re.compile(
        r"\b(plansheet|planshet|planshed|tablet|iPad|таблет|планшет)\b", re.I),
        "tablet", "таблет"),

    # Smartwatches  (require "tsag" + "smart/uhaan" OR explicit "smartwatch")
    (re.compile(
        r"\b(smartwatch|smart[\s\-]tsag|uhaan[\s\-]tsag|"
        r"ухаалаг\s*цаг|смарт\s*цаг)\b", re.I),
        "smartwatch", "ухаалаг цаг"),

    # Regular watches (bare "tsag" / "цаг" alone)
    (re.compile(r"\b(tsag|цаг)\b", re.I), "watch", "цаг"),

    # TVs
    (re.compile(
        r"\b(zuragt|zuragtat|television|tv\b|телевизор|зурагт)\b", re.I),
        "television", "телевизор"),

    # Cameras
    (re.compile(
        r"\b(camr|camra|kamr|camera|kamiera|камер|зураг\s*авагч)\b", re.I),
        "camera", "камер"),

    # Shoes / sneakers
    (re.compile(
        r"\b(gutul|guttul|guttal|gutal|shoe|shoes|sneaker|sneakers|гутал)\b", re.I),
        "shoes", "гутал"),

    # Clothes
    (re.compile(
        r"\b(huvtsas|huvtsaas|huvcas|хувцас|хувцаас|clothes|clothing|apparel)\b", re.I),
        "clothing", "хувцас"),

    # Books
    (re.compile(r"\b(nom|book|books|ном)\b", re.I), "book", "ном"),

    # Children's toys — MUST come before bare "togloom" to win priority
    (re.compile(
        r"\b(huuhdiin[\s\-]togloom|хүүхдийн[\s\-]тоглоом|naadgai|наадгай|"
        r"kids[\s\-]toy|children[\s\-]toy|toy\b|lego|konstruktor|конструктор|"
        r"togloom\b|тоглоом\b)\b", re.I),
        "toy", "тоглоом"),

    # Gaming consoles / digital games — ONLY explicit console/disc context
    (re.compile(
        r"\b(video\s*game|game\s*disc|game\s*cd|тоглоомын\s*диск|"
        r"gaming\s*pc|game\s*console|playstation|xbox|nintendo)\b", re.I),
        "game console", "тоглоомын диск"),

    # Computer mouse (must come before generic "mouse")
    (re.compile(
        r"\b(hulgana|хулгана|gaming[\s\-]mouse|wireless[\s\-]mouse|"
        r"компьютерийн[\s\-]хулгана|mouse\b)\b", re.I),
        "computer mouse", "хулгана"),

    # Speakers
    (re.compile(
        r"\b(speaker|speakers|chiangiin\s*huudag|чианги|bluetooth\s*speaker|чанга\s*яригч)\b", re.I),
        "bluetooth speaker", "чанга яригч"),

    # Keyboards
    (re.compile(
        r"\b(keyboard|клавиатур|механик[\s\-]гар)\b", re.I),
        "keyboard", "гар"),

    # Monitors / screens
    (re.compile(
        r"\b(monitor|дэлгэц|монитор)\b", re.I),
        "monitor", "дэлгэц"),

    # Webcam / camera for laptop
    (re.compile(
        r"\b(webcam|web[\s\-]camera|вэбкам)\b", re.I),
        "webcam", "вэбкам"),

    # Microphone
    (re.compile(
        r"\b(microphone|mikrofon|mic\b|микрофон)\b", re.I),
        "microphone", "микрофон"),

    # Printers
    (re.compile(
        r"\b(printer|хэвлэгч|принтер)\b", re.I),
        "printer", "хэвлэгч"),

    # Chargers / cables
    (re.compile(
        r"\b(charger|tsenagluur|цэнэглүүр|charging\s*cable|usb\s*cable|кабель)\b", re.I),
        "charger", "цэнэглүүр"),

    # Power banks
    (re.compile(
        r"\b(powerbank|power[\s\-]?bank|зарядны\s*банк|батарей)\b", re.I),
        "power bank", "батарей банк"),

    # Phone case / cover
    (re.compile(
        r"\b(phone[\s\-]case|utasny[\s\-]burhuul|утасны[\s\-]бүрхүүл|"
        r"утасны[\s\-]хайрцаг|phone[\s\-]cover)\b", re.I),
        "phone case", "утасны бүрхүүл"),

    # Screen protector
    (re.compile(
        r"\b(screen[\s\-]protector|delgetsiin[\s\-]hailt|дэлгэцний[\s\-]хамгаалалт|"
        r"tempered[\s\-]glass)\b", re.I),
        "screen protector", "дэлгэцний хамгаалалт"),

    # Bags / backpacks
    (re.compile(
        r"\b(tsuts|tsutsan|bag|backpack|цүнх|нуруувч)\b", re.I),
        "backpack", "цүнх"),

    # Shirts
    (re.compile(
        r"\b(tsamts|tsants|цамц|shirt|t[\s\-]shirt|tshirt)\b", re.I),
        "shirt", "цамц"),

    # Pants / trousers
    (re.compile(
        r"\b(omd|өмд|pants|trousers|jeans|джинс)\b", re.I),
        "pants", "өмд"),

    # Jacket / coat
    (re.compile(
        r"\b(kurtka|куртка|jacket|coat|winter[\s\-]coat|пальто|dalvuur)\b", re.I),
        "winter jacket", "куртка"),

    # Hat / cap
    (re.compile(
        r"\b(malgai|малгай|hat|cap|beanie)\b", re.I),
        "hat", "малгай"),

    # Gloves
    (re.compile(
        r"\b(beelii|бээлий|gloves|winter[\s\-]gloves)\b", re.I),
        "gloves", "бээлий"),

    # Socks
    (re.compile(
        r"\b(oims|оймс|socks|sock)\b", re.I),
        "socks", "оймс"),

    # Gaming chair (compound — must match before bare "chair")
    (re.compile(
        r"\b(gaming\s*chair|геймийн\s*сандал)\b", re.I),
        "gaming chair", "геймийн сандал"),

    # Regular chair
    (re.compile(
        r"\b(suudal|сандал|chair|office\s*chair)\b", re.I),
        "office chair", "сандал"),

    # Desk
    (re.compile(
        r"\b(desk|ширээ|shiree|computer\s*desk)\b", re.I),
        "desk", "ширээ"),

    # Notebook / journal
    (re.compile(
        r"\b(devter|дэвтэр|notebook\s*journal|тэмдэглэлийн\s*дэвтэр)\b", re.I),
        "notebook journal", "дэвтэр"),

    # Pen
    (re.compile(
        r"\b(uzeg|үзэг|pen\b|ballpen|ballpoint)\b", re.I),
        "pen", "үзэг"),

    # Perfume / body spray — catch all Latin variants: uner/unertei/unertel/unertu
    (re.compile(
        r"\b(uner\w*|унэр\w*|үнэр\w*|perfume|cologne|"
        r"үнэртэй\s*ус|парфюм|body\s*spray|eau\s*de)\b", re.I),
        "perfume", "үнэртэй ус"),

    # Shampoo
    (re.compile(
        r"\b(shampun|shampoo|шампунь|усны\s*шамп)\b", re.I),
        "shampoo", "шампунь"),

    # Face cream / skincare
    (re.compile(
        r"\b(nuurnii[\s\-]tos|нүүрний[\s\-]тос|face[\s\-]cream|"
        r"moisturizer|skincare|крем)\b", re.I),
        "face cream", "нүүрний тос"),

    # Lipstick / makeup
    (re.compile(
        r"\b(lipstick|uruuliin[\s\-]budag|уруулын[\s\-]будаг|makeup|cosmetics|косметик)\b", re.I),
        "lipstick", "уруулын будаг"),

    # Nail polish
    (re.compile(
        r"\b(nail[\s\-]polish|humsnii[\s\-]lak|хумсны[\s\-]лак)\b", re.I),
        "nail polish", "хумсны лак"),

    # Vacuum cleaners
    (re.compile(
        r"\b(vacuum|тоос\s*сорогч|шуурхай|toос sorогч)\b", re.I),
        "vacuum cleaner", "тоос сорогч"),

    # ── VEHICLES & OUTDOOR ─────────────────────────────────────────────────────

    # Bicycles / bikes (dugui / dugas / дугуй)
    (re.compile(
        r"\b(dugui|dugas|dugay|dugaa|дугуй|bicycle|bike|road[\s\-]bike|"
        r"mountain[\s\-]bike|cycling|cycle)\b", re.I),
        "bicycle", "дугуй"),

    # Electric scooters / kick scooters
    (re.compile(
        r"\b(scooter|elektr\s*dugui|electric\s*scooter|самокат|скутер)\b", re.I),
        "electric scooter", "электр дугуй"),

    # Motorcycles
    (re.compile(
        r"\b(moto|motocikl|motorcycle|motorbike|мотоцикл)\b", re.I),
        "motorcycle", "мотоцикл"),

    # Tents / camping
    (re.compile(
        r"\b(maihan|maakhan|tent|camping|маихан|майхан|палатка)\b", re.I),
        "camping tent", "майхан"),

    # Fishing rods / gear (require specific compound — bare "загасны" is too vague)
    (re.compile(
        r"\b(fishing\s*rod|fish\s*rod|загасны\s*саваа|zagasny\s*savaa)\b", re.I),
        "fishing rod", "загасны саваа"),

    # ── SPORTS & FITNESS ───────────────────────────────────────────────────────

    # Dumbbells / weights
    (re.compile(
        r"\b(dumbbell|dumbell|gantel|гантель|weight|weights|barbell)\b", re.I),
        "dumbbell", "гантель"),

    # Running shoes / sport shoes
    (re.compile(
        r"\b(uildver|sport\s*gutul|running\s*shoe|спортын\s*гутал|спорт)\b", re.I),
        "running shoes", "спортын гутал"),

    # Gym / exercise equipment
    (re.compile(
        r"\b(gym\s*equipment|treadmill|гүйх\s*зам|fitness)\b", re.I),
        "fitness equipment", "фитнесс тоног"),

    # ── HOME & KITCHEN ─────────────────────────────────────────────────────────

    # Refrigerators
    (re.compile(
        r"\b(huguurumj|хүйтэн\s*агуулах|refrigerator|fridge|хөргөгч|huguurumzh)\b", re.I),
        "refrigerator", "хөргөгч"),

    # Washing machines
    (re.compile(
        r"\b(ugaaguur|угаагуур|washing\s*machine|washer)\b", re.I),
        "washing machine", "угаагуур"),

    # Microwave / oven
    (re.compile(
        r"\b(microwave|pechin|печ|зуух|zuuh|oven)\b", re.I),
        "microwave oven", "зуух"),

    # Air conditioner
    (re.compile(
        r"\b(konditsioner|agaarjuulalt|кондиционер|air\s*conditioner|агааржуулагч)\b", re.I),
        "air conditioner", "агааржуулагч"),

    # ── TOOLS & HARDWARE ───────────────────────────────────────────────────────

    # Drills / power tools
    (re.compile(
        r"\b(drill|buren|perforator|перфоратор|өрмийн\s*машин)\b", re.I),
        "power drill", "өрөм"),

    # ── KIDS & TOYS ────────────────────────────────────────────────────────────

    # Kids toys (compound — must appear BEFORE individual "huuhdiin" and "togloom" entries)
    (re.compile(
        r"\b(huuhdiin[\s\-]+(naadgai|togloom)|хүүхдийн\s*(наадгай|тоглоом)|kids[\s\-]+toy)\b", re.I),
        "kids toy", "хүүхдийн тоглоом"),

    # Physical toys (non-digital) — only when NOT part of "huuhdiin togloom" compound
    (re.compile(
        r"(?<!huuhdiin\s)(?<!хүүхдийн\s)\b(naadgai|togloom|toy|toys|наадгай|тоглоом)\b", re.I),
        "toy", "тоглоом"),

    # Kids/baby products — huuhdiin without a following toy word
    (re.compile(
        r"\b(huuhdiin|хүүхдийн|baby|infant|toddler)\b(?![\s\-]*(naadgai|togloom|наадгай|тоглоом))", re.I),
        "kids product", "хүүхдийн бараа"),

    # ── BEAUTY & HEALTH ────────────────────────────────────────────────────────

    # Skincare / face cream
    (re.compile(
        r"\b(skincare|face\s*cream|moisturizer|нүүрний\s*тос|нүүрний)\b", re.I),
        "skincare", "нүүрний арчилгаа"),

    # Hair care
    (re.compile(
        r"\b(shampoo|usnii\s*ugaalguur|үсний|hair\s*care)\b", re.I),
        "hair care", "үсний арчилгаа"),

    # ── ACCESSORIES ────────────────────────────────────────────────────────────

    # Sunglasses
    (re.compile(
        r"\b(naran\s*shiltei|нарны\s*шилтэй|sunglasses|sunglass)\b", re.I),
        "sunglasses", "нарны шил"),

    # Wallet / purse
    (re.compile(
        r"\b(tulwur|тулгуур|wallet|purse|мөнгөний\s*хавтас)\b", re.I),
        "wallet", "мөнгөний хавтас"),

    # Helmet (NO малгай — that belongs to hat only)
    (re.compile(
        r"\b(helmet|дуулга|bike\s*helmet|moto\s*helmet)\b", re.I),
        "helmet", "дуулга"),

    # Mouse (computer peripheral)
    (re.compile(
        r"\b(mouse\b|хулгана|hulgana|компьютерийн\s*хулгана)\b", re.I),
        "computer mouse", "хулгана"),

    # USB / storage
    (re.compile(
        r"\b(flash\s*drive|usb\s*drive|hard\s*drive|ssd|external\s*drive)\b", re.I),
        "USB flash drive", "флаш диск"),

    # Router / networking
    (re.compile(
        r"\b(router|wifi|wi[\s\-]fi|роутер|сүлжээний)\b", re.I),
        "wifi router", "роутер"),

    # ── CLOTHING DETAILS ───────────────────────────────────────────────────────

    # Shirt / t-shirt
    (re.compile(
        r"\b(tsamts|tsants|tsomts|цамц|футболк|t[\s\-]?shirt|shirt|tshirt)\b", re.I),
        "shirt", "цамц"),

    # Pants / trousers
    (re.compile(
        r"\b(umdaa|umda|omd|өмд|trousers|pants|jeans|жинс)\b", re.I),
        "pants", "өмд"),

    # Jacket / coat
    (re.compile(
        r"\b(terlег|jacket|coat|palto|пальто|куртка|kurka|deveel|дэвэл)\b", re.I),
        "jacket", "куртка"),

    # Dress / skirt
    (re.compile(
        r"\b(dress|юбка|yubka|даашинз|daashinz|skirt)\b", re.I),
        "dress", "даашинз"),

    # Socks / underwear
    (re.compile(
        r"\b(oims|оймс|sock|socks|underwear|доторвош|дотуур\s*хувцас)\b", re.I),
        "socks", "оймс"),

    # Hat / cap
    (re.compile(
        r"\b(malgai|малгай|hat|cap|beanie|малгайны)\b", re.I),
        "hat", "малгай"),

    # Gloves
    (re.compile(
        r"\b(gurchuul|гурчуул|бээлий|beelii|glove|gloves|mittens)\b", re.I),
        "gloves", "бээлий"),

    # Belt
    (re.compile(
        r"\b(bus|бүс|belt|belts)\b", re.I),
        "belt", "бүс"),

    # ── HOME & LIFESTYLE ───────────────────────────────────────────────────────

    # Heater / electric heater
    (re.compile(
        r"\b(dulaachluur|дулаацлуур|heater|electric\s*heater|халаагуур)\b", re.I),
        "electric heater", "халаагуур"),

    # Fan / air fan
    (re.compile(
        r"\b(serüülegch|serüülüür|серүүлэгч|fan\b|agaarjuulalt|electric\s*fan)\b", re.I),
        "electric fan", "серүүлэгч"),

    # Iron (clothes iron)
    (re.compile(
        r"\b(ind?uul|индүү|iron\b|clothes\s*iron)\b", re.I),
        "clothes iron", "индүү"),

    # Mirror
    (re.compile(
        r"\b(toli|толь|mirror|looking\s*glass)\b", re.I),
        "mirror", "толь"),

    # Pillow / bedding
    (re.compile(
        r"\b(dеr|дэр|pillow|cushion|blanket|хөнжил|хонжил|honzhil)\b", re.I),
        "pillow", "дэр"),

    # Coffee maker / kettle
    (re.compile(
        r"\b(tsaidnii\s*ai|kettle|coffee\s*maker|кофе\s*машин|чайник|chainik)\b", re.I),
        "electric kettle", "чайник"),

    # Rice cooker / slow cooker
    (re.compile(
        r"\b(budaanii\s*togoo|rice\s*cooker|slow\s*cooker|мультиварк|multivark)\b", re.I),
        "rice cooker", "будаа чанагч"),

    # ── OPTICS & ACCESSORIES ───────────────────────────────────────────────────

    # Glasses / eyeglasses
    (re.compile(
        r"\b(nüdnii\s*shil|нүдний\s*шил|eyeglasses|glasses|spectacles|нүдний)\b", re.I),
        "eyeglasses", "нүдний шил"),

    # Earrings / jewelry
    (re.compile(
        r"\b(chikh\s*emit|чихний\s*зүүлт|earring|earrings|jewelry|jewellery|зүүлт)\b", re.I),
        "earrings", "зүүлт"),

    # Necklace
    (re.compile(
        r"\b(zuu|зүүлт|necklace|хүзүүний\s*зүүлт|gerdeg)\b", re.I),
        "necklace", "хүзүүний зүүлт"),

    # ── TECH EXTRAS ────────────────────────────────────────────────────────────

    # Phone case / cover
    (re.compile(
        r"\b(utasnii\s*bugh|phone\s*case|phone\s*cover|утасны\s*хайрцаг|утасны\s*бүрхүүл)\b", re.I),
        "phone case", "утасны хайрцаг"),

    # Screen protector
    (re.compile(
        r"\b(delgetsni\s*khameegch|screen\s*protector|tempered\s*glass|дэлгэцний\s*хамгаалалт)\b", re.I),
        "screen protector", "дэлгэцний хамгаалалт"),

    # Tripod / stand
    (re.compile(
        r"\b(tripod|тренога|гурван\s*хөл|camera\s*stand)\b", re.I),
        "tripod", "трипод"),

    # Drone
    (re.compile(
        r"\b(drone|дрон|квадрокоптер|quadcopter|дроны)\b", re.I),
        "drone", "дрон"),

    # Smart TV box
    (re.compile(
        r"\b(tv\s*box|android\s*tv|smart\s*box|приставк|андроид\s*тв)\b", re.I),
        "android tv box", "смарт тв бокс"),

    # Gaming console
    (re.compile(
        r"\b(playstation|xbox|nintendo|ps[45]|game\s*console|консол)\b", re.I),
        "gaming console", "тоглоомын консол"),

    # Projector
    (re.compile(
        r"\b(projector|проектор|проекторын)\b", re.I),
        "projector", "проектор"),

    # Microphone
    (re.compile(
        r"\b(microphone|mic\b|микрофон|дуу\s*авагч)\b", re.I),
        "microphone", "микрофон"),

    # Webcam
    (re.compile(
        r"\b(webcam|web\s*cam|вебкамер|видео\s*камер)\b", re.I),
        "webcam", "вебкамер"),

    # ── SPORTS & RECREATION ────────────────────────────────────────────────────

    # Sports ball — soccer/basketball/volleyball (context sets exact type)
    (re.compile(
        r"\b(bombog|бөмбөг|soccer\s*ball|football\s*ball|basketball\b|volleyball\b|"
        r"tennis\s*ball|sport\s*ball|rugby\s*ball)\b", re.I),
        "sports ball", "бөмбөг"),

    # ── MUSICAL INSTRUMENTS ────────────────────────────────────────────────────

    (re.compile(r"\b(gitar|guitar|гитар)\b", re.I), "guitar", "гитар"),
    (re.compile(r"\b(piano\b|пиано|фортепиано)\b", re.I), "piano keyboard", "пиано"),
    (re.compile(r"\b(khuur|хуур|morin[\s\-]khuur|морин\s*хуур|violin\b|fiddle\b)\b", re.I),
        "violin", "хуур"),
    (re.compile(r"\b(boshig|ятга|yatga|ukulele|bass\s*guitar)\b", re.I), "string instrument", "хөгжмийн зэмсэг"),

    # ── AUTOMOTIVE ─────────────────────────────────────────────────────────────

    # Dash cam
    (re.compile(
        r"\b(dashcam|dash\s*cam|авто\s*камер|авто\s*бичлэгч|видео\s*регистратор)\b", re.I),
        "dash cam", "авто камер"),

    # Car charger
    (re.compile(
        r"\b(car\s*charger|авто\s*цэнэглүүр|машины\s*цэнэг|auto\s*charger)\b", re.I),
        "car charger", "авто цэнэглүүр"),

    # Car seat cover / floor mat
    (re.compile(
        r"\b(car\s*seat\s*cover|машины\s*хүрэм|car\s*mat|авто\s*дэвсгэр)\b", re.I),
        "car seat cover", "машины дэвсгэр"),

    # ── OFFICE & STATIONERY ────────────────────────────────────────────────────

    # Physical notebook / copybook — devter ONLY (bare "notebook" means laptop in context)
    (re.compile(
        r"\b(devter|дэвтэр|copybook|exercise\s*book|тэмдэглэлийн\s*дэвтэр)\b", re.I),
        "notebook stationery", "дэвтэр"),

    # Pen / ballpoint
    (re.compile(r"\b(uzeg|үзэг|ballpen|ballpoint|felt[\s\-]tip\s*pen)\b", re.I), "pen", "үзэг"),

    # Printing paper (tsaas / цаас — avoid bare "paper" since it's ambiguous English)
    (re.compile(r"\b(tsaas|цаас|printing\s*paper|office\s*paper|a4\s*paper)\b", re.I),
        "printer paper", "цаас"),

    # ── PETS ───────────────────────────────────────────────────────────────────

    (re.compile(
        r"\b(pet\s*food|dog\s*food|cat\s*food|нохойны\s*хоол|муурны\s*хоол|"
        r"тэжээвэр\s*амьтны\s*хоол)\b", re.I),
        "pet food", "тэжээлийн хоол"),

    (re.compile(
        r"\b(pet\s*suppl|dog\s*collar|cat\s*toy|тэжээвэр\s*амьтан|нохойны\s*зах)\b", re.I),
        "pet supplies", "тэжээвэр амьтны хэрэгсэл"),

    # ── HEALTH & SUPPLEMENTS ───────────────────────────────────────────────────

    (re.compile(r"\b(vitamin\w*|витамин|supplement\b|нэмэлт\s*тэжээл|multivitamin)\b", re.I),
        "vitamins", "витамин"),

    (re.compile(
        r"\b(protein\b|protein\s*powder|whey\b|creatine\b|протейн|уургийн\s*нунтаг)\b", re.I),
        "protein powder", "протейн"),
]


# ── Mongolian color words → English (used in _local_interpret) ────────────────
_COLOR_MN: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(har|хар)\b",                                re.I), "black"),
    (re.compile(r"\b(tsagaan|цагаан)\b",                         re.I), "white"),
    (re.compile(r"\b(ulaan|улаан)\b",                            re.I), "red"),
    (re.compile(r"\b(nogoon|ногоон)\b",                          re.I), "green"),
    (re.compile(r"\b(shar|шар)\b",                               re.I), "yellow"),
    (re.compile(r"\b(khukh|хөх|цэнхэр)\b",                        re.I), "blue"),
    (re.compile(r"\b(khuren|хүрэн|бор)\b",                       re.I), "brown"),
    (re.compile(r"\b(saral|саарал|grey|gray)\b",                  re.I), "gray"),
    (re.compile(r"\b(нил|нилбор|purple|violet)\b",                re.I), "purple"),
    (re.compile(r"\b(ягаан|pink)\b",                              re.I), "pink"),
    (re.compile(r"\b(orange|улбар\s*шар|улбар)\b",                re.I), "orange"),
]

# Cheap / budget signal
_CHEAP_RE = re.compile(
    r"\b(hyamd|hymdhan|hymdan|himdan|himd|hamgiin\s*hya?md|"
    r"хямд|хямдхан|хамгийн\s*хямд|cheap|cheapest|budget|affordable|low[\s\-]?price)\b",
    re.I,
)

# Action/imperative words to strip BEFORE product matching
# Keep ONLY true action words — never strip product-descriptive words
_ACTION_RE = re.compile(
    r"\b("
    r"olood\s*og|haij\s*og|haij|haidaj|avna|avah|avmaar|avahiig|tuslah|husdeg|"
    r"haruulach|haruulna|haruul|haraa\b|harj\s*og|harj|"   # show/display verbs (Latin MN)
    r"nada\b|nadad|нада\b|надад|"
    r"олоод\s*өг|хайж\s*өг|авна|тусла|олж\s*өг|авах|хайх|"
    r"find\s*me|get\s*me|search\s*for|looking\s*for|show\s*me|give\s*me|"
    r"i\s*want|i\s*need|please\b|"
    r"өг\b|авчирч\s*өг|авчир|харуул|харуулаач|санал\s*болго|зөвлө|"
    r"надад\s*зориулсан|nadan\b"
    r")\b",
    re.I,
)

# Detect whether input is already plain ASCII English (no MN transliteration)
_ASCII_LETTERS_RE = re.compile(r"^[a-z0-9\s\-\.,'\"!]+$", re.I)
_MN_SIGNALS_RE    = re.compile(
    r"[а-яёөүА-ЯЁӨҮ]|"  # Cyrillic characters — instant Mongolian signal
    r"\b(utas|noutbuk|chihevch|gutul|toglooh|hyamd|himd|nada|avna|haij|olood|"
    r"plansheet|planshet|ukhalag|gariin|zuragt|camr|kamr|huvtsas|tsag|nom|"
    r"utanter|utasna|komputer|chikhevch|chiangiin|"
    r"dugui|dugas|dugay|maihan|zagasny|ugaaguur|huguurumj|"
    r"caanan|saain|yamin|yamar|nadan|negen|togloom|naadgai|hymdhan|hymdan|"
    r"suudal|garchig|delguur|tsenagluur|tsuts|uner|unertei|unertel|unertu|"
    r"moto|motocikl|konditsioner|agaarjuulalt|gantel|"
    r"huuhdiin|usnii|naran|tulwur|hulgana|dugaar|"
    r"naadgai|togloom|naadgain|"
    # New words added
    r"tsamts|tsants|umdaa|umda|omd|malgai|gurchuul|beelii|oims|"
    r"dulaachluur|induu|toli|chainik|nuurnii|"
    r"shampun|kurtka|lipstick|uzeg|devter|webcam|mikrofon|"
    r"olood|avmaar|avahiig|haidaj|husdeg|"
    # Words from new dict entries
    r"bombog|gitar|khuur|tsaas|mashin|dashcam|"
    r"protein\b|vitamin\b|"
    # Games, sports, hobbies, food, misc
    r"shatar|shatriig|booliin|boksiin|tenisin|badminton|futbol|basketbol|"
    r"umnuh|undaa|hool|idee|nogoo|mahni|tsai|kafe|jirem|"
    r"togloomin|legoo|lego|puzzle|kart|drone|"
    r"niit|buh|hamgiin|hamsig|delgeh|"
    r"medeelel|tusgaar|humuun|hamtdaa|hamtran|"
    r"tsever|ugaah|chiiluurleg|gantsuuhan|"
    r"noton|huuhed|baavai|ohin|huuhen|eregt|"
    r"bichig|zurdag|bud|budeg|olgoi|"
    r"avch|iree|ireh|avah|abah)\b",
    re.I,
)


def _is_plain_english(text: str) -> bool:
    """Return True if text is pure English with no Mongolian signals — skip AI."""
    return bool(_ASCII_LETTERS_RE.match(text.strip())) and not bool(_MN_SIGNALS_RE.search(text))


# ── Brand name extractor ─────────────────────────────────────────────────────
_BRAND_RE = re.compile(
    r"\b(sony|сони|samsung|самсунг|apple|эппл|xiaomi|сяоми|huawei|хуавэй|"
    r"oppo|vivo|realme|google|pixel|lg|nokia|motorola|oneplus|nothing phone|"
    r"nike|adidas|puma|reebok|new\s*balance|converse|vans|"
    r"lenovo|asus|acer|dell|hp|msi|razer|logitech|corsair|"
    r"canon|nikon|fujifilm|gopro|"
    r"bose|jbl|anker|baseus|marshall|sennheiser|beats|"
    r"lego|dyson|philips|bosch|ikea|"
    r"iphone|ipad|macbook|airpods|galaxy|note\s*\d|redmi|poco)\b",
    re.I,
)
_BRAND_NORMALIZE = {
    "сони": "Sony", "самсунг": "Samsung", "эппл": "Apple",
    "сяоми": "Xiaomi", "хуавэй": "Huawei",
}

def _extract_brand(text: str) -> str:
    m = _BRAND_RE.search(text)
    if not m:
        return ""
    raw = m.group(0).strip()
    return _BRAND_NORMALIZE.get(raw.lower(), raw.title())

# ── Product modifier extractor (хөгжим, gaming, camera, etc.) ────────────────
_MODIFIER_PATTERNS = [
    (re.compile(r"\b(хөгжим|музик|music|дуу)\b", re.I), "music"),
    (re.compile(r"\b(тоглоомын|gaming|game)\b", re.I), "gaming"),
    (re.compile(r"\b(камерын|зураг\s*авагч|camera)\b", re.I), "camera"),
    (re.compile(r"\b(утасгүй|wireless)\b", re.I), "wireless"),
    (re.compile(r"\b(bluetooth)\b", re.I), "bluetooth"),
    (re.compile(r"\b(4k|ultra\s*hd|qled|oled)\b", re.I), "4K"),
]


def _local_interpret(raw: str) -> dict | None:
    """
    Fast keyword lookup — ONLY for Cyrillic Mongolian queries where word boundaries
    are unambiguous. Latin transliterations go to the AI to avoid mis-mappings
    (e.g. 'komputer' misread as laptop, 'haruulach' misread as color 'black').
    Returns a result dict or None (→ AI path).
    """
    # Skip entirely for Latin-script input — let the AI handle it correctly
    if not re.search(r"[а-яёөүА-ЯЁӨҮ]", raw):
        return None

    cleaned = _ACTION_RE.sub(" ", raw).strip()
    cheap   = bool(_CHEAP_RE.search(raw))

    # Brand extraction (Sony, Samsung, Apple …)
    brand = _extract_brand(raw)

    # Modifier extraction (music, gaming, camera …)
    modifiers = []
    for mod_re, mod_label in _MODIFIER_PATTERNS:
        if mod_re.search(raw):
            modifiers.append(mod_label)

    # Color — check cleaned text so action verbs like "haruulach" can't trigger it
    color_en = None
    for color_re, color_name in _COLOR_MN:
        if color_re.search(cleaned):
            color_en = color_name
            break

    matched_terms, matched_labels = [], []
    for pattern, eng, mn in _MN_DICT:
        if pattern.search(cleaned) and mn not in matched_labels:
            parts = []
            if brand:
                parts.append(brand)
            parts += modifiers
            if color_en:
                parts.append(color_en)
            parts.append(eng)
            term = " ".join(parts)
            term = f"budget {term}" if cheap else term
            matched_terms.append(term)
            matched_labels.append(mn)

    if not matched_terms:
        # No product type matched but brand was found — return brand alone
        if brand:
            return {
                "queries":           [brand],
                "original_language": "mn_cyrillic",
                "understood":        f"{brand} хайж байна",
            }
        return None

    mn_colors = {"black":"хар","white":"цагаан","red":"улаан","green":"ногоон",
                 "yellow":"шар","blue":"цэнхэр","brown":"хүрэн","gray":"саарал",
                 "purple":"нил ягаан","pink":"ягаан","orange":"улбар шар"}
    parts = []
    if cheap:
        parts.append("Хямд")
    if color_en:
        parts.append(mn_colors.get(color_en, color_en))
    parts += matched_labels

    return {
        "queries":           matched_terms,
        "original_language": "mn_latin" if _ASCII_LETTERS_RE.match(raw.strip()) else "mn_cyrillic",
        "understood":        f"{' '.join(parts)} хайж байна",
    }


def _sanitize_queries(queries: list, raw: str) -> list:
    """
    Strip sentence-like phrasing from AI output and validate results.
    For Mongolian inputs the AI is translating, so overlap check is skipped.
    """
    sentence_prefix_re = re.compile(
        r"^(user is (searching|looking) for a?\s*|find me a?\s*|"
        r"search for a?\s*|get me a?\s*|i (want|need) a?\s*|"
        r"the user (wants?|needs?|is looking for) a?\s*)",
        re.I,
    )
    raw_tokens  = set(re.split(r"\W+", raw.lower())) - {"", "me", "a", "an", "the", "for", "i"}
    # If the input has any Mongolian signals the AI is translating — skip overlap check
    is_mongolian = bool(_MN_SIGNALS_RE.search(raw))

    cleaned = []
    for q in queries:
        q = sentence_prefix_re.sub("", q.strip()).strip()
        if not q:
            continue
        q_tokens    = set(re.split(r"\W+", q.lower())) - {"", "budget"}
        has_overlap = bool(raw_tokens & q_tokens)
        has_model   = bool(re.search(r"\d", q))          # brand/model numbers
        few_tokens  = len(raw_tokens) <= 2
        if has_overlap or has_model or few_tokens or is_mongolian:
            cleaned.append(q)

    return cleaned if cleaned else [raw]


def interpret_query(raw: str) -> dict:
    """
    Interprets any user input (Mongolian Cyrillic/Latin, English, mixed) into
    English product search terms.
    Priority: cache → plain-English passthrough → keyword dict → AI model.
    """
    raw = raw.strip()
    if not raw:
        return {"queries": [], "original_language": "en", "understood": ""}
    k = sha_key("interpret", raw)
    cached = INTERPRET_CACHE.get(k)
    if cached:
        return cached
    # Fast path 1 — plain English: pass through unchanged, no AI needed
    if _is_plain_english(raw):
        result = {"queries": [raw], "original_language": "en", "understood": ""}
        INTERPRET_CACHE.set(k, result)
        return result
    # Fast path 2 — keyword dictionary
    local = _local_interpret(raw)
    if local:
        INTERPRET_CACHE.set(k, local)
        return local
    # Slow path — AI model (Claude → Gemini → Groq)
    system, user_prompt = _interpret_prompts(raw)
    try:
        out = ai_generate_json(system, user_prompt, max_tokens=200, fast=True)
        queries = out.get("queries", [])
        if not isinstance(queries, list):
            queries = [str(queries)]
        queries = _sanitize_queries(queries, raw)
        result  = {
            "queries":           queries,
            "original_language": out.get("original_language", "unknown"),
            "understood":        out.get("understood", ""),
        }
    except Exception as e:
        print(f"[interpret_query] {e}")
        # Fallback: try brand extraction at minimum so we don't search in Mongolian
        fallback_brand = _extract_brand(raw)
        fallback_q = fallback_brand if fallback_brand else raw
        result = {"queries": [fallback_q], "original_language": "unknown", "understood": ""}
    INTERPRET_CACHE.set(k, result)
    return result


async def interpret_query_async(raw: str) -> dict:
    """Non-blocking version of interpret_query for async route handlers."""
    raw = raw.strip()
    if not raw:
        return {"queries": [], "original_language": "en", "understood": ""}
    k = sha_key("interpret", raw)
    cached = INTERPRET_CACHE.get(k)
    if cached:
        return cached
    # Fast path 1 — plain English: pass through unchanged, no AI needed
    if _is_plain_english(raw):
        result = {"queries": [raw], "original_language": "en", "understood": ""}
        INTERPRET_CACHE.set(k, result)
        return result
    # Fast path 2 — keyword dictionary
    local = _local_interpret(raw)
    if local:
        INTERPRET_CACHE.set(k, local)
        return local
    # Slow path — AI model (Claude → Gemini → Groq, non-blocking)
    system, user_prompt = _interpret_prompts(raw)
    try:
        out = await ai_generate_json_async(system, user_prompt, max_tokens=200, fast=True)
        queries = out.get("queries", [])
        if not isinstance(queries, list):
            queries = [str(queries)]
        queries = _sanitize_queries(queries, raw)
        result  = {
            "queries":           queries,
            "original_language": out.get("original_language", "unknown"),
            "understood":        out.get("understood", ""),
        }
    except Exception as e:
        print(f"[interpret_query_async] {e}")
        fallback_brand = _extract_brand(raw)
        fallback_q = fallback_brand if fallback_brand else raw
        result = {"queries": [fallback_q], "original_language": "unknown", "understood": ""}
    INTERPRET_CACHE.set(k, result)
    return result


def _detect_user_tone(history: list) -> str:
    """Infer casual / formal / neutral style from recent user messages."""
    if not history:
        return "neutral"
    user_msgs = [m.content for m in history if m.role == "user"]
    if len(user_msgs) < 2:
        return "neutral"
    combined = " ".join(user_msgs[-5:]).lower()
    casual = sum(1 for s in [
        "haha", "lol", "wow", "ok", "okay", "tnx", "thx", "cool", "nice",
        "аа", "яах вэ", "болоо", "за тэгье", "сайхан", "оо", "хэхэ",
    ] if s in combined)
    formal = sum(1 for s in [
        "та", "танд", "байна уу", "болно уу", "хүсэлт", "гуйя", "боломжтой юу",
    ] if s in combined)
    if casual > formal + 1:
        return "casual"
    if formal > casual:
        return "formal"
    return "neutral"


def _extract_session_context(history: list, current_msg: str) -> dict:
    """Extract budget level and brand preference from the conversation so far."""
    ctx: dict = {"budget": None, "brand": None}
    all_text = " ".join([m.content for m in history[-10:]] + [current_msg])
    if _CHEAP_RE.search(all_text):
        ctx["budget"] = "low"
    elif re.search(r"\b(premium|flagship|дээд|шилдэг|high.end|best quality)\b", all_text, re.I):
        ctx["budget"] = "high"
    bm = _BRAND_RE.search(all_text)
    if bm:
        raw = bm.group(0).strip()
        ctx["brand"] = _BRAND_NORMALIZE.get(raw.lower(), raw.title())
    return ctx


def do_chat(req: ChatRequest):
    msg = (req.message or "").strip()
    if not msg:
        return {"answer":"","intent":"chat","search_query":""}
    # Include a hash of recent history so different conversations don't share the same cached reply
    history_hash = sha_key(*[f"{m.role}:{m.content[:80]}" for m in req.history[-6:]])
    k      = sha_key("chat", req.message, req.product_title, req.product_price,
                     req.product_url, req.product_description, history_hash)
    cached = CHAT_CACHE.get(k)
    if cached: return cached

    history_block = ""
    if req.history:
        turns         = req.history[-6:]
        history_block = "\n[Өмнөх яриа]\n" + "\n".join(
            f"{'Х' if m.role=='user' else 'AI'}: {trunc(m.content,250)}" for m in turns
        ) + "\n"

    # Validate product context
    valid_product = _is_valid_product_title(req.product_title)
    has_product   = valid_product and bool(req.product_title)

    # Build product block — include rating/reviews/source when available
    if has_product:
        rating_line = ""
        if req.product_rating:
            stars = req.product_rating
            rc    = f" · {req.product_review_count} үнэлгээ" if req.product_review_count else ""
            rating_line = f"\nҮнэлгээ: ⭐ {stars}/5{rc}"
        source_line = f"\nДэлгүүр: {req.product_source}" if req.product_source else ""
        product_block = (
            f"[Одоогийн бараа]\n"
            f"Нэр: {trunc(req.product_title,150)}\n"
            f"Үнэ: {trunc(req.product_price,40)}{source_line}{rating_line}\n"
            f"Тайлбар: {trunc(req.product_description,400)}"
        )
    else:
        product_block = "[Бараа сонгогдоогүй]"

    search_block = (
        f"\n[Хайлт: \"{trunc(req.search_context,80)}\" — өнгө/брэнд/үнэ шүүлт хүсвэл intent=filter]\n"
        if req.search_context else ""
    )

    # ── Product rating analysis ──────────────────────────────────────────
    try:
        rv = float(req.product_rating or 0)
    except ValueError:
        rv = 0

    review_count = 0
    try:
        review_count = int(str(req.product_review_count or "0").replace(",", ""))
    except (ValueError, TypeError):
        review_count = 0

    if rv >= 4.5 and review_count >= 500:
        rating_verdict = "шилдэг — олон хэрэглэгч баталгаажуулсан, итгэж болно"
        buy_signal = "🟢 АВАХЫГ ЗӨВЛӨНӨ"
    elif rv >= 4.3:
        rating_verdict = "маш сайн үнэлгээтэй — авахыг дэмжинэ"
        buy_signal = "🟢 АВАХЫГ ЗӨВЛӨНӨ"
    elif rv >= 3.7:
        rating_verdict = "дундаж сайн — тохиромжтой боловч жишиг хар"
        buy_signal = "🟡 БОЛГООМЖТОЙ АВЧ БОЛНО"
    elif rv > 0:
        rating_verdict = "үнэлгээ дундаас доогуур — болгоомжтой байгаарай"
        buy_signal = "🔴 БОЛГООМЖЛОХ"
    else:
        rating_verdict = "үнэлгээ байхгүй — тайлбараас үнэлэн дүгнэ"
        buy_signal = "⚪ МЭДЭЭЛЭЛ ДУТМАГ"

    product_signal = f"{buy_signal} ({rating_verdict})" if has_product else ""

    tone     = _detect_user_tone(req.history)
    sess_ctx = _extract_session_context(req.history, msg)

    if tone == "casual":
        tone_line = "Хэрэглэгч нөхөрсөг дотно хэлцэл ярьдаг — чи ч тийм байж, дотно найрсаг байдлаар хариул."
    elif tone == "formal":
        tone_line = "Хэрэглэгч албан ёсны хэлбэрт ярьдаг — та гэж хандаж, тодорхой эелдэг байдлаар хариул."
    else:
        tone_line = "Найрсаг, тусламжтай — хэт хатуу ч биш, хэт хэлцэл ч биш."

    budget_line = ""
    if sess_ctx["budget"] == "low":
        budget_line = "Хэрэглэгч хямд үнийг хайж байна — үнэ хэмнэх, мөнгөний хувьд зохистой сонголтуудыг онцол.\n"
    elif sess_ctx["budget"] == "high":
        budget_line = "Хэрэглэгч чанар/шилдэг бараанд дуртай — чанар, гүйцэтгэл, давуу онцлогуудыг онцол.\n"

    system = (
        f"Чи онлайн худалдааны мэдлэгтэй найз-зөвлөгч. {tone_line}\n"
        "Монгол кириллээр хариул. Жагсаалт, bullet, header хэрэглэхгүй — хүн шиг өгүүлбэрээр ярь.\n"
        + ("Яриа дундуур хариулт эхлэхэд 'Сайн байна уу' гэх мэт мэндчилгээг давтахгүй — шууд агуулгаас эхэл.\n"
           if req.history else "")
        + (f"Бараа: {buy_signal} | {rating_verdict} | {review_count} сэтгэгдэл\n" if has_product else "")
        + budget_line
        + "ЗОРИЛГО: Хэрэглэгчийн жинхэнэ хэрэгцээг ойлгож, тохирсон зөвлөгөө өг.\n"
        "Богино асуулт=богино хариу (1-2 өгүүлбэр). Нарийвчилсан асуулт=4-6 өгүүлбэр.\n"
        "INTENT ДҮРЭМ (ЭНЭ МАШ ЧУХАЛ):\n"
        "  search → хэрэглэгч бараа ХАЙХЫГ хүсвэл: 'i need X', 'i want X', 'find me X', 'X хайж өг', 'X heregtei', 'X авмаар байна'\n"
        "  filter → одоогийн хайлтын үр дүнг өнгө/брэнд/үнээр ШҮҮХИЙГ хүсвэл: 'хар өнгөтэй', '100 доллараас хямд'\n"
        "  chat   → зөвлөгөө/асуулт/харьцуулалт хүсвэл\n"
        "Хэрэглэгч 'i need/want/looking for X' гэвэл ЗААВАЛ intent=search, search_query=X (цэвэр англи бараа нэр + брэнд + хэмжээ)\n"
        "Хэрэглэгч нэгэнт бараа нэрлэсэн бол тодруулах асуулт БИШ, шууд хайж өг.\n"
        "Хариулт дахь дагалдах асуулт: хэнд авч байна, ямар ашиглалтад — зөвхөн зөвлөгөө асуухад хэрэглэ.\n"
        "utas=утас|noutbuk=ноутбук|chihevch=чихэвч|har=хар|komputer=суурин PC\n"
        "intent: search(хайж өг/i need/i want/find me) | filter(өнгө/брэнд/үнэ шүүх) | chat(зөвлөгөө/асуулт)\n"
        'JSON: {"answer":"...","intent":"chat|search|filter","search_query":"(англи бараа нэр+брэнд+хэмжээ, хайлт үед)",'
        '"filters":{"color":null,"brand":null,"keyword":null,"max_price":null,"min_price":null,"store":null}}'
    )
    # RAG: inject semantically similar internal products as context
    rag_block = ""
    if _gemini_available and _rag_catalog_has_products():
        try:
            rag_hits = semantic_product_search(req.message, top_k=3)
            if rag_hits:
                lines = [
                    f"• {p['name']} (${p['price']:.2f}) — {trunc(p.get('description',''),80)}"
                    if p.get("price") else
                    f"• {p['name']} — {trunc(p.get('description',''),80)}"
                    for p in rag_hits
                ]
                rag_block = "\n[Дотоод бараа]\n" + "\n".join(lines) + "\n"
        except Exception as e:
            print(f"[rag] {e}")

    user_prompt = (
        f"{product_block}{search_block}{rag_block}{history_block}\n"
        f"[Хэрэглэгчийн мессеж]\n{trunc(req.message,500)}"
    )
    max_tok = 700 if has_product else 500
    out = ai_generate_json(system, user_prompt, max_tokens=max_tok)
    intent = out.get("intent", "chat")
    if intent not in ("chat", "search", "filter"):
        intent = "chat"

    # Override to search only on unambiguous search imperatives.
    # "авна/авах" intentionally excluded — they also appear in advice questions like "авах уу?".
    search_triggers = [
        "хайж өг", "олоод өг", "хайх", "хайна", "хайж",
        "haij og", "olood og", "haih", "haij",
        "find me", "search for", "look for",
        "i need", "i want", "show me", "get me",
        "heregtei", "авмаар байна", "авмаар",
    ]
    # Question markers in Mongolian — these indicate advice/chat, not search
    mn_question_re = re.compile(r"(уу|үү|юу|ю)\s*[?？]?\s*$", re.I)
    is_question = msg.endswith("?") or bool(mn_question_re.search(msg))
    has_search_trigger = any(t in msg.lower() for t in search_triggers)
    if intent in ("chat", "filter") and has_search_trigger and not is_question:
        intent = "search"

    # Strip English purchase-intent prefixes to get a clean product search query
    _purchase_prefix_re = re.compile(
        r"^(?:i\s+(?:need|want|am\s+looking\s+for)|show\s+me|get\s+me|find\s+me)\s+(?:a\s+|an\s+|some\s+)?",
        re.I,
    )

    # For Mongolian inputs with search intent, always use interpret_query
    # so the reliable vocabulary dict drives the search term, not Gemini's guess
    if intent == "search" and _MN_SIGNALS_RE.search(msg):
        interpreted = interpret_query(msg)
        if interpreted["queries"]:
            out["search_query"] = interpreted["queries"][0]
    elif intent == "search":
        sq = out.get("search_query") or ""
        if not sq:
            # Strip "i need / i want / ..." prefix to get clean product term
            sq = _purchase_prefix_re.sub("", msg).strip()
        out["search_query"] = sq or msg

    # Normalise filter object — ensure all expected keys exist
    raw_filters = out.get("filters") or {}
    filters = {
        "color":     raw_filters.get("color")     or None,
        "brand":     raw_filters.get("brand")     or None,
        "keyword":   raw_filters.get("keyword")   or None,
        "max_price": raw_filters.get("max_price") or None,
        "min_price": raw_filters.get("min_price") or None,
        "store":     raw_filters.get("store")     or None,
    } if intent == "filter" else None

    resp = {
        "answer":       out.get("answer", ""),
        "intent":       intent,
        "search_query": out.get("search_query", ""),
        "filters":      filters,
    }
    CHAT_CACHE.set(k, resp)
    return resp

# ═══════════════════════════════════════════
# CRAWLER / SCRAPER / COMPARE
# ═══════════════════════════════════════════

# MongoDB collection for scraped external product data
scraped_col = mdb["scraped_products"]
_safe_create_indexes(scraped_col, [
    ([("query", ASCENDING), ("scraped_at", DESCENDING)], {}),
    ("source", {}),
])

SCRAPE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-CH-UA": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
}

# Fallback UA pool — rotated on retry when a store returns 403/503
_UA_POOL = [
    # Firefox on Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    # Edge on Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    # Chrome on Mac
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    # Safari on Mac
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
]

# Per-shop extra headers
_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
SHOP_EXTRA_HEADERS = {
    "AliExpress": {"Referer": "https://www.aliexpress.com/"},
    "eBay":       {"Referer": "https://www.google.com/", "Accept-Language": "en-US,en;q=0.9"},
    "Walmart":    {"Referer": "https://www.google.com/", "Accept-Language": "en-US,en;q=0.9"},
    "Amazon":     {"Referer": "https://www.google.com/", "User-Agent": _MOBILE_UA},
    "Newegg":     {"Referer": "https://www.newegg.com/", "Accept-Language": "en-US,en;q=0.9"},
    "BestBuy":    {"Referer": "https://www.google.com/", "Accept-Language": "en-US,en;q=0.9"},
}

# ── Shop search URL builders ───────────────────────────────────────────────────
SHOPS = {
    "AliExpress": lambda q: f"https://www.aliexpress.com/wholesale?SearchText={quote_plus(q)}",
    "eBay":       lambda q: f"https://www.ebay.com/sch/i.html?_nkw={quote_plus(q)}&_ipg=25&LH_TitleDesc=0",
    "Walmart":    lambda q: f"https://www.walmart.com/search?q={quote_plus(q)}",
    "Amazon":     lambda q: f"https://www.amazon.com/s?k={quote_plus(q)}",
    "Newegg":     lambda q: f"https://www.newegg.com/p/pl?d={quote_plus(q)}",
    "BestBuy":    lambda q: f"https://www.bestbuy.com/site/searchpage.jsp?st={quote_plus(q)}",
}

_MNT_PER_USD = 3450  # conversion rate used everywhere

_MONTHLY_RE = re.compile(
    r"\$?([\d,]+\.?\d*)\s*/\s*mo(?:nth)?\.?\b", re.IGNORECASE
)
_MONTHS_COUNT_RE = re.compile(
    r"for\s+(\d+)\s*mo(?:nth)?s?|(\d+)\s*mo(?:nth)?s?\s*,?\s*0\s*%\s*APR", re.IGNORECASE
)


def _parse_price(text: str) -> Optional[float]:
    """
    Extract a USD price from scraped text. Returns USD float or None.
    Handles: "$29.99", "US $9.99", "MNT 322,074" (Amazon geo-locates to MNT),
             "From $49.99", "$29.99 – $49.99", "1,299.99 USD" etc.
    Monthly installment prices ("$5.53/month for 36 months") are converted to
    their total cost; bare monthly prices with no duration are skipped.
    """
    t = (text or "").strip()
    # Immediately reject known non-price strings
    if not t or t.lower() in ("none", "null", "n/a", "—", "-", "not available",
                               "check price", "see price", "add to cart", "out of stock"):
        return None

    # Handle monthly installment prices BEFORE any other processing
    mo_m = _MONTHLY_RE.search(t)
    if mo_m:
        try:
            monthly = float(mo_m.group(1).replace(",", ""))
            cnt_m   = _MONTHS_COUNT_RE.search(t)
            months  = int(cnt_m.group(1) or cnt_m.group(2)) if cnt_m else None
            if months and 0 < monthly * months <= 10000:
                return round(monthly * months, 2)
        except (ValueError, TypeError):
            pass
        return None  # monthly price with unknown duration — caller should use full price

    # Detect MNT prices BEFORE stripping (Amazon geo-localises to Mongolia when
    # the server IP is Mongolian → shows "MNT 322,074.21" instead of "$93.35")
    is_mnt = bool(re.search(r"\bMNT\b|₮", t, re.IGNORECASE))

    # 1. Handle ranges — keep only the first (lower) price
    t = re.split(r"\s+to\s+|\s*[–—]\s*|\s+-\s+", t, maxsplit=1)[0].strip()
    # 2. Strip currency symbols and codes
    t = re.sub(r"[₮€£¥₩₽]", "", t)
    t = re.sub(r"\b(USD|MNT|CAD|AUD|GBP|CNY|JPY|EUR|US)\b", "", t, flags=re.IGNORECASE).strip()
    # 3. Strip non-numeric/non-$ prefix
    t = re.sub(r"^[^\d$]+", "", t)
    # 4. Remove comma thousands separators
    t = t.replace(",", "")
    # 5. Strip leading $
    t = t.lstrip("$").strip()
    # 6. Find first decimal number
    m = re.search(r"(\d+(?:\.\d+)?)", t)
    if m:
        try:
            val = float(m.group(1))
            if is_mnt:
                # Convert MNT back to USD so the frontend can re-multiply correctly
                val = round(val / _MNT_PER_USD, 2)
            # Cap: filters review counts and absurd marketplace prices
            if val <= 0 or val > 10000:
                return None
            return val
        except ValueError:
            pass
    return None


# ── Title garbage patterns ────────────────────────────────────────────────────
_TITLE_STRIP_RE = re.compile(
    r"(?i)^(new\s+listing|sponsored|ad\b|best\s+seller|"
    r"amazon'?s?\s+choice|flash\s+sale|limited\s+time)\s*[:\-]?\s*"
)
_TITLE_PROMO_RE = re.compile(
    r"(?i)\s+(free\s+shi?pping|fast\s+delivery|ships?\s+free|"
    r"great\s+deal|hot\s+deal|top\s+rated|brand\s+new\s+sealed|"
    r"\d+[-–]\d+\s+day\s+ship(ping)?)\b.*$"
)
_TITLE_STORE_SUFFIX_RE = re.compile(
    r"(?i)\s*[\|—]\s*(amazon|ebay|walmart|bestbuy|aliexpress|newegg)\s*$"
)
_TITLE_VISIT_RE = re.compile(r"(?i)\s*visit\s+the\s+.{1,50}\s+store\s*$")


def _clean_title(title: str) -> str:
    """Remove junk prefixes/suffixes scraped along with product titles."""
    t = (title or "").strip()
    if not t:
        return t
    t = _TITLE_STRIP_RE.sub("", t).strip()      # "New Listing iPhone…" → "iPhone…"
    t = _TITLE_PROMO_RE.sub("", t).strip()      # strip trailing promo words
    t = _TITLE_STORE_SUFFIX_RE.sub("", t).strip()
    t = _TITLE_VISIT_RE.sub("", t).strip()
    # Remove ALL-CAPS standalone promo words
    t = re.sub(r"\b(FREE SHIPPING|FAST DELIVERY|NEW ARRIVAL|HOT DEAL|SALE NOW)\b", "", t)
    # Collapse multiple spaces/punctuation
    t = re.sub(r"\s{2,}", " ", t).strip(" ,|-.–")
    return t


def _relevance_score(title: str, query: str) -> int:
    """
    0–100 score: how well the product title matches the search query.
    Used to rank and filter results after scraping.
    """
    if not title or not query:
        return 0
    title_l = title.lower()
    query_l = query.lower()

    # Full query appears in title → perfect match
    if query_l in title_l:
        return 100

    STOP = {"", "a", "an", "the", "for", "and", "with", "in", "of", "to", "budget"}
    q_tokens = set(re.split(r"\W+", query_l)) - STOP
    t_tokens = set(re.split(r"\W+", title_l))
    if not q_tokens:
        return 50

    matched = q_tokens & t_tokens
    score = int(len(matched) / len(q_tokens) * 75)

    # Bonus for matching model numbers exactly (e.g. "4090", "XM5", "15 Pro")
    for tok in re.findall(r"\b[a-z]*\d+[a-z0-9]*\b", query_l):
        if tok in title_l:
            score = min(100, score + 20)

    return score


def _make_item(title, price_txt, href, img, source, base_url="", description="", rating="", review_count="") -> dict:
    cleaned_title = _clean_title(title)
    # Sanitise price_txt — Python's str(None) produces "None" which breaks parsing
    safe_price_txt = str(price_txt) if price_txt not in (None, "None", "null") else ""
    price = _parse_price(safe_price_txt)
    url   = urljoin(base_url, href) if (href and base_url) else href
    safe_rating = str(rating) if rating not in (None, "None", "null") else ""
    safe_rc     = str(review_count) if review_count not in (None, "None", "null") else ""
    return {
        "title":        cleaned_title,
        "price":        price,
        "price_text":   safe_price_txt,
        "url":          url,
        "image":        img,
        "source":       source,
        "description":  description[:300] if description else "",
        "rating":       safe_rating,
        "review_count": safe_rc,
    }


def _json_raw(txt: str, marker: str) -> Optional[dict]:
    """Find `marker` in txt, then parse the JSON object/array that follows."""
    idx = txt.find(marker)
    if idx < 0:
        return None
    start = txt.find("{", idx)
    start_arr = txt.find("[", idx)
    if start < 0 and start_arr < 0:
        return None
    if start < 0 or (start_arr >= 0 and start_arr < start):
        start = start_arr
    try:
        obj, _ = json.JSONDecoder().raw_decode(txt, start)
        return obj
    except Exception:
        return None

def _scrape_amazon(soup: BeautifulSoup, _: str) -> list:
    results = []
    # Strategy 1: embedded search result JSON (Amazon sometimes embeds it)
    for tag in soup.find_all("script"):
        txt = tag.string or ""
        if '"asin"' not in txt or '"title"' not in txt:
            continue
        data = _json_raw(txt, '"searchResultData"')
        if not data:
            data = _json_raw(txt, '"searchResult"')
        if data:
            for item in (data.get("products") or data.get("items") or [])[:12]:
                title = item.get("title","") or item.get("name","")
                price = item.get("price","") or item.get("priceString","")
                img   = item.get("image","") or item.get("thumbnailImage","")
                url   = item.get("url","") or item.get("detailPageURL","")
                if title:
                    results.append(_make_item(title, str(price), url, img, "Amazon", "https://www.amazon.com"))
            if results:
                return results
    # Strategy 2: JSON-LD ItemList
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
            if isinstance(data, dict) and data.get("@type") == "ItemList":
                for elem in data.get("itemListElement", [])[:12]:
                    item = elem.get("item", elem)
                    title = item.get("name","")
                    url   = item.get("url","")
                    img   = item.get("image","")
                    offer = item.get("offers", {})
                    price_txt = str(offer.get("price","")) if offer else ""
                    if title:
                        results.append(_make_item(title, price_txt, url, img, "Amazon"))
        except Exception:
            pass
    if results:
        return results
    # Strategy 3: CSS selectors. ".sg-col-inner" sits *inside* each search-result
    # card, so selecting both returned every product twice; only use it as a
    # fallback when Amazon serves a layout without the s-search-result markers.
    cards = soup.select("[data-component-type='s-search-result']") or soup.select(".sg-col-inner")
    for card in cards[:15]:
        title_el  = card.select_one("h2 a span, h2 span")
        # Prefer non-struck-through current price; fall back to whole+fraction build
        price_el  = (
            card.select_one(".a-price:not([data-a-strike]) .a-offscreen") or
            card.select_one(".a-price .a-offscreen")
        )
        # Build price text from whole+fraction if offscreen text looks wrong
        price_text = price_el.get_text(strip=True) if price_el else ""
        if not price_text or _parse_price(price_text) is None:
            whole = card.select_one(".a-price-whole")
            frac  = card.select_one(".a-price-fraction")
            if whole:
                price_text = f"${whole.get_text(strip=True).rstrip('.')}.{frac.get_text(strip=True) if frac else '00'}"
        img_el    = card.select_one("img.s-image, img[data-image-latency]")
        link_el   = card.select_one("h2 a, a.a-link-normal")
        rating_el = card.select_one(".a-icon-alt")
        if not title_el:
            continue
        title = title_el.get_text(strip=True)
        if not title or len(title) < 5:
            continue
        # Amazon lazy-loads images; real URL is in data-src, not src (which is a placeholder)
        img_url = ""
        if img_el:
            for attr in ("data-src", "src"):
                v = (img_el.get(attr) or "").strip()
                if v and not v.startswith("data:"):
                    img_url = v
                    break
        results.append(_make_item(
            title,
            price_text,
            link_el.get("href","") if link_el else "",
            img_url,
            "Amazon", "https://www.amazon.com", "",
            rating_el.get_text(strip=True) if rating_el else "",
        ))
    return results[:12]

def _scrape_ebay(soup: BeautifulSoup, _: str) -> list:
    results = []
    # eBay is server-rendered — CSS is most reliable
    for card in soup.select("li.s-item, div.s-item")[:30]:
        title_el     = card.select_one(".s-item__title")
        price_el     = card.select_one(".s-item__price")
        img_el       = card.select_one(".s-item__image-img")
        link_el      = card.select_one("a.s-item__link")
        condition_el = card.select_one(".SECONDARY_INFO, .s-item__subtitle")
        if not title_el:
            continue
        title = title_el.get_text(strip=True)
        # Strip "New Listing" prefix — do NOT skip the item
        title = re.sub(r'(?i)^new\s+listing\s*', '', title).strip()
        if not title or "shop on ebay" in title.lower() or len(title) < 5:
            continue
        price_text = ""
        if price_el:
            price_text = price_el.get_text(strip=True).split(" to ")[0].strip()
        img_src = ""
        if img_el:
            # Try the largest available src attribute; eBay s-l*.jpg are actual thumbs
            img_src = (img_el.get("data-defer-src")
                       or img_el.get("data-src")
                       or img_el.get("src", ""))
        href = link_el.get("href","") if link_el else ""
        if not href:
            continue
        results.append(_make_item(
            title, price_text, href, img_src, "eBay",
            description=condition_el.get_text(strip=True) if condition_el else "",
        ))
    if results:
        return results[:12]
    # Fallback: JSON-LD
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data  = json.loads(tag.string or "")
            items = data if isinstance(data, list) else [data]
            for item in items:
                if item.get("@type") in ("Product", "Offer"):
                    title = item.get("name","")
                    url   = item.get("url","")
                    img   = item.get("image","")
                    offer = item.get("offers", item)
                    price_txt = str(offer.get("price","")) if offer else ""
                    if title:
                        results.append(_make_item(title, price_txt, url, img, "eBay"))
        except Exception:
            pass
    return results[:12]

def _scrape_walmart(soup: BeautifulSoup, _: str) -> list:
    results = []
    tag = soup.find("script", id="__NEXT_DATA__")
    if tag:
        try:
            data  = json.loads(tag.string or "")
            stacks = (data.get("props",{}).get("pageProps",{})
                          .get("initialData",{}).get("searchResult",{})
                          .get("itemStacks",[]))
            for stack in stacks:
                for item in stack.get("items",[]):
                    if item.get("__typename") not in (None, "Product"):
                        continue
                    title  = item.get("name","")
                    p_info = item.get("priceInfo",{}) or {}
                    line_price = (p_info.get("linePriceDisplay","")
                                  or p_info.get("linePrice","")
                                  or p_info.get("itemPrice",""))
                    # If linePriceDisplay is a monthly installment, prefer the full price
                    def _is_monthly_str(s):
                        return bool(re.search(r"/\s*mo(?:nth)?\.?\b|per\s+month", s or "", re.I))
                    if _is_monthly_str(line_price):
                        full = (p_info.get("wasPrice","") or p_info.get("currentPrice","")
                                or p_info.get("unitPrice","") or p_info.get("priceRangeMinPrice",""))
                        price_text_wm = full if full and not _is_monthly_str(full) else line_price
                    else:
                        price_text_wm = line_price
                    price = p_info.get("minPrice") or None
                    if price is None and price_text_wm:
                        m = re.search(r"[\d]+\.?\d*", price_text_wm.replace(",", ""))
                        if m:
                            try: price = float(m.group())
                            except: pass
                    img    = (item.get("imageInfo",{}) or {}).get("thumbnailUrl","")
                    url    = "https://www.walmart.com" + (item.get("canonicalUrl","") or "")
                    rating = str(item.get("averageRating",""))
                    rev    = str(item.get("numberOfReviews",""))
                    if title:
                        results.append(_make_item(
                            title,
                            price_text_wm or (f"${price:.2f}" if price else ""),
                            url, img, "Walmart",
                            rating=rating, review_count=rev,
                        ))
                    if len(results) >= 12:
                        break
                if len(results) >= 12:
                    break
        except Exception as e:
            print(f"[walmart-json] {e}")
    if results:
        return results
    # CSS fallback
    for card in soup.select("[data-item-id], [data-testid='item-stack']")[:15]:
        title_el = card.select_one("[itemprop='name'], span.normal")
        price_el = card.select_one("[itemprop='price']")
        img_el   = card.select_one("img")
        link_el  = card.select_one("a")
        if not title_el:
            continue
        results.append(_make_item(
            title_el.get_text(strip=True),
            price_el.get("content","") if price_el else "",
            urljoin("https://www.walmart.com", link_el.get("href","")) if link_el else "",
            img_el.get("src","") if img_el else "",
            "Walmart",
        ))
    return results[:12]

def _scrape_bestbuy(soup: BeautifulSoup, _: str) -> list:
    results = []
    # Strategy 1: BestBuy embeds product data in a script with "sku" and price info
    for tag in soup.find_all("script"):
        txt = tag.string or ""
        if len(txt) < 200:
            continue
        # Try multiple key patterns BestBuy uses
        for key in ('"regularPrice"', '"salePrice"', '"customerReviewAverage"'):
            if key not in txt:
                continue
            # Extract a JSON object or array containing products
            data = _json_raw(txt, '"products"')
            if not data:
                data = _json_raw(txt, '"items"')
            if not data:
                continue
            prod_list = data if isinstance(data, list) else (data.get("products") or data.get("items") or [])
            for p in prod_list[:12]:
                title = p.get("name","") or p.get("shortDescription","")
                price = p.get("salePrice") or p.get("regularPrice") or p.get("currentPrice","")
                img   = p.get("thumbnailImage","") or p.get("image","")
                slug  = p.get("url","") or f"/site/{p.get('sku','')}.p?skuId={p.get('sku','')}"
                url   = slug if slug.startswith("http") else "https://www.bestbuy.com" + slug
                rating = str(p.get("customerReviewAverage",""))
                rev    = str(p.get("customerReviewCount",""))
                if title:
                    results.append(_make_item(title, f"${price}" if price else "", url, img, "BestBuy",
                                              rating=rating, review_count=rev))
            break
        if results:
            break
    if results:
        return results[:12]
    # Strategy 2: CSS selectors
    for card in soup.select(".sku-item, [class*='sku-item']")[:15]:
        title_el = card.select_one(".sku-title a, h4.sku-title, [class*='sku-title']")
        price_el = card.select_one(".priceView-customer-price span, [class*='priceView']")
        img_el   = card.select_one("img.product-image, img[class*='product-image']")
        link_el  = card.select_one("a.image-link, .sku-title a, a[class*='image-link']")
        if not title_el:
            continue
        title = title_el.get_text(strip=True)
        if not title:
            continue
        results.append(_make_item(
            title,
            price_el.get_text(strip=True) if price_el else "",
            urljoin("https://www.bestbuy.com", link_el.get("href","")) if link_el else "",
            img_el.get("src","") if img_el else "",
            "BestBuy",
        ))
    return results[:12]

# ── AliExpress helpers (module-level so async strategy can use them) ─────────

def _ali_fix_url(u: str) -> str:
    return ("https:" + u) if u and u.startswith("//") else u

def _ali_deep_price(obj) -> str:
    if isinstance(obj, dict):
        for key in ("formattedPrice", "displayAmount", "priceStr",
                    "salePrice", "tradePrice", "minPrice", "price",
                    "originalPrice", "minAmount", "value"):
            v = obj.get(key)
            if v is None:
                continue
            if isinstance(v, (int, float)) and 0 < v < 10000:
                return f"${v:.2f}"
            if isinstance(v, str) and v not in ("None", "null", ""):
                if re.search(r"\d", v):
                    return v
            if isinstance(v, dict):
                sub = _ali_deep_price(v)
                if sub:
                    return sub
    return ""

def _ali_parse_items(items: list) -> list:
    out = []
    for it in items:
        raw_title = it.get("title", "")
        if isinstance(raw_title, dict):
            title = (raw_title.get("displayTitle") or raw_title.get("seoTitle")
                     or raw_title.get("value") or "")
        else:
            title = str(raw_title)
        if not title or len(title) < 3:
            continue
        prices = it.get("prices", {}) or {}
        sale   = prices.get("salePrice", {}) or {}
        orig   = prices.get("originalPrice", {}) or {}
        price_txt = (
            sale.get("formattedPrice") or
            orig.get("formattedPrice") or
            sale.get("displayAmount") or
            (f"${sale['minAmount']['value']}" if isinstance(sale.get("minAmount"), dict) and sale["minAmount"].get("value") else "") or
            (f"${it['tradePrice']:.2f}" if isinstance(it.get("tradePrice"), (int, float)) and it["tradePrice"] > 0 else "") or
            (f"${it['price']:.2f}" if isinstance(it.get("price"), (int, float)) and it["price"] > 0 else "") or
            _ali_deep_price(prices) or _ali_deep_price(it) or ""
        )
        if price_txt and re.match(r"^\d+\.?\d*$", price_txt.strip()):
            price_txt = f"${price_txt.strip()}"
        img_raw = it.get("image", {}) or {}
        if isinstance(img_raw, dict):
            img_url = _ali_fix_url(img_raw.get("imgUrl", "") or img_raw.get("src", ""))
        else:
            img_url = _ali_fix_url(str(img_raw)) if img_raw else ""
        img_url = img_url or _ali_fix_url(it.get("imageUrl", "") or it.get("img", ""))
        item_url = _ali_fix_url(
            it.get("itemHref", "") or it.get("detail_url", "") or it.get("url", "")
        )
        if not item_url:
            item_id = it.get("itemId") or it.get("productId") or it.get("id")
            if item_id:
                item_url = f"https://www.aliexpress.com/item/{item_id}.html"
        out.append(_make_item(title, price_txt, item_url, img_url, "AliExpress"))
    return out

_ALI_JSON_PATHS = [
    lambda d: d["data"]["root"]["fields"]["mods"]["itemList"]["content"],
    lambda d: d["mods"]["itemList"]["content"],
    lambda d: d["data"]["resultList"],
    lambda d: d["result"]["mods"]["itemList"]["content"],
    lambda d: d["data"]["items"],
    lambda d: d["items"],
    lambda d: d["data"]["searchProductList"]["products"],
]

async def _fetch_aliexpress_api(query: str) -> list:
    """
    Strategy 0: hit AliExpress's internal search JSON endpoint directly.
    Returns parsed items or [] on failure.
    """
    base_url = "https://www.aliexpress.com/fn/search-pc/index"
    params   = f"SearchText={quote_plus(query)}&page=1&g=y&isrefine=y"
    headers  = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept":          "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer":         f"https://www.aliexpress.com/wholesale?SearchText={quote_plus(query)}",
        "Origin":          "https://www.aliexpress.com",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest":  "empty",
        "Sec-Fetch-Mode":  "cors",
        "Sec-Fetch-Site":  "same-origin",
    }
    try:
        async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=True, proxy=SCRAPER_PROXY) as cl:
            r = await cl.get(f"{base_url}?{params}")
        if r.status_code != 200:
            return []
        data  = r.json()
        items = []
        for path_fn in _ALI_JSON_PATHS:
            try:
                items = path_fn(data)
                if isinstance(items, list) and items:
                    break
            except (KeyError, TypeError):
                pass
        return _ali_parse_items(items[:15]) if items else []
    except Exception:
        return []

async def _fetch_aliexpress_mobile(query: str) -> list:
    """
    Strategy 6: AliExpress mobile site — lighter JS, sometimes has JSON islands.
    """
    mob_url = f"https://m.aliexpress.com/wholesale?SearchText={quote_plus(query)}"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        ),
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer":         "https://m.aliexpress.com/",
    }
    try:
        async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=True, proxy=SCRAPER_PROXY) as cl:
            r = await cl.get(mob_url)
        if r.status_code != 200:
            return []
        soup = BeautifulSoup(r.text, "html.parser")
        # Mobile page often has __INIT_DATA__ or similar JSON blocks
        for tag in soup.find_all("script"):
            txt = tag.string or ""
            if len(txt) < 200:
                continue
            for marker in ('"items"', '"itemList"', '"productList"', '"resultList"'):
                data = _json_raw(txt, marker)
                if data is None:
                    continue
                items = data if isinstance(data, list) else (
                    data.get("items") or data.get("content") or
                    data.get("resultList") or data.get("productList") or []
                )
                if items and isinstance(items, list):
                    parsed = _ali_parse_items(items[:15])
                    if parsed:
                        return parsed
        # CSS fallback for mobile
        return_items = []
        for card in soup.select("[class*='product']")[:15]:
            title_el = card.select_one("[class*='title']") or card.select_one("h3")
            price_el = card.select_one("[class*='price']")
            link_el  = card.select_one("a")
            img_el   = card.select_one("img")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            if len(title) < 3:
                continue
            href = _ali_fix_url(link_el.get("href", "") if link_el else "")
            if href and not href.startswith("http"):
                href = "https://m.aliexpress.com" + href
            img = img_el.get("src") or img_el.get("data-src") or "" if img_el else ""
            price = price_el.get_text(strip=True) if price_el else ""
            return_items.append(_make_item(title, price, href, img, "AliExpress"))
        return return_items
    except Exception:
        return []


def _scrape_aliexpress(soup: BeautifulSoup, _: str) -> list:
    # Uses module-level helpers: _ali_fix_url, _ali_deep_price, _ali_parse_items
    results = []

    # ── Strategy 1: window.__INIT_DATA__ ──
    for tag in soup.find_all("script"):
        txt = tag.string or ""
        if "window.__INIT_DATA__" not in txt:
            continue
        idx   = txt.find("window.__INIT_DATA__")
        start = txt.find("{", idx)
        if start < 0:
            continue
        try:
            raw, _ = json.JSONDecoder().raw_decode(txt, start)
            paths = [
                lambda d: d["data"]["root"]["fields"]["mods"]["itemList"]["content"],
                lambda d: d["mods"]["itemList"]["content"],
                lambda d: d["data"]["resultList"],
                lambda d: d["result"]["mods"]["itemList"]["content"],
                lambda d: d["data"]["items"],
                lambda d: d["items"],
            ]
            for path_fn in paths:
                try:
                    items = path_fn(raw)
                    if isinstance(items, list) and items:
                        results = _ali_parse_items(items[:15])
                        break
                except (KeyError, TypeError):
                    pass
        except Exception:
            pass
        if results:
            break

    if results:
        return results

    # ── Strategy 2: any script block containing price signals ──
    for tag in soup.find_all("script"):
        txt = tag.string or ""
        if len(txt) < 200:
            continue
        has_price = any(k in txt for k in ('"tradePrice"','"salePrice"','"formattedPrice"','"itemList"'))
        if not has_price:
            continue
        for marker in ('"items"', '"itemList"', '"resultList"', '"content"'):
            data = _json_raw(txt, marker)
            if data is None:
                continue
            items = data if isinstance(data, list) else (
                data.get("items") or data.get("content") or data.get("resultList") or []
            )
            if items and isinstance(items, list):
                results = _ali_parse_items(items[:15])
                break
        if results:
            break

    if results:
        return results

    # ── Strategy 3: regex price extraction matched to items in script ──
    for tag in soup.find_all("script"):
        txt = tag.string or ""
        if '"itemId"' not in txt and '"productId"' not in txt:
            continue
        # Find all price strings via regex
        price_map: dict = {}  # itemId -> price_str
        for m in re.finditer(r'"itemId"\s*:\s*"?(\d+)"?.*?"(?:tradePrice|formattedPrice|salePrice)"\s*:\s*"?([^",}]{1,30})"?', txt):
            price_map[m.group(1)] = m.group(2)
        # Also find titles
        title_map: dict = {}
        for m in re.finditer(r'"itemId"\s*:\s*"?(\d+)"?.*?"title"\s*:\s*"([^"]{3,200})"', txt):
            title_map[m.group(1)] = m.group(2)
        for item_id, price_str in price_map.items():
            title = title_map.get(item_id, "")
            if not title:
                continue
            item_url = f"https://www.aliexpress.com/item/{item_id}.html"
            results.append(_make_item(title, price_str, item_url, "", "AliExpress"))
        if results:
            break

    if results:
        return results

    # ── Strategy 4: JSON-LD ──
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data  = json.loads(tag.string or "")
            items = data if isinstance(data, list) else [data]
            for item in items:
                if item.get("@type") == "Product":
                    title = item.get("name","")
                    offer = item.get("offers",{})
                    if isinstance(offer, list):
                        offer = offer[0] if offer else {}
                    price_txt = str(offer.get("price","")) if offer else ""
                    url = item.get("url","")
                    img = item.get("image","")
                    if isinstance(img, list): img = img[0] if img else ""
                    if title:
                        results.append(_make_item(title, price_txt, url, img, "AliExpress"))
        except Exception:
            pass

    if results:
        return results

    # ── Strategy 5: CSS selectors ──
    css_configs = [
        ("[class*='manhattan--container']", "[class*='titleText']", "[class*='price']"),
        ("[class*='search-card']",          "[class*='title']",     "[class*='price']"),
        (".search-card-item",               ".item-title",          ".price"),
        ("article.card-out-wrapper",        "h3",                   "[class*='price']"),
        ("[class*='product-card']",         "[class*='title']",     "[class*='price']"),
    ]
    for container, title_sel, price_sel in css_configs:
        for card in soup.select(container)[:15]:
            title_el = card.select_one(title_sel) or card.select_one("h3") or card.select_one("h2")
            price_el = card.select_one(price_sel)
            img_el   = card.select_one("img")
            link_el  = card.select_one("a")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            if not title:
                continue
            raw_href = link_el.get("href","") if link_el else ""
            href = _ali_fix_url(raw_href)
            if href and not href.startswith("http"):
                href = "https://www.aliexpress.com" + href
            img_src = ""
            if img_el:
                img_src = (img_el.get("src") or img_el.get("data-src")
                           or img_el.get("data-lazy-src") or "")
            results.append(_make_item(
                title,
                price_el.get_text(strip=True) if price_el else "",
                href, img_src, "AliExpress",
            ))
        if results:
            break

    return results[:12]

def _scrape_newegg(soup: BeautifulSoup, _: str) -> list:
    results = []
    for card in soup.select(".item-cell")[:20]:
        title_el = card.select_one("a.item-title")
        price_el = card.select_one(".price-current")
        img_el   = card.select_one("img.item-img, img")
        if not title_el:
            continue
        title = title_el.get_text(strip=True).rstrip("-").strip()
        if not title or len(title) < 5:
            continue
        price_raw = price_el.get_text(strip=True) if price_el else ""
        # Newegg price format: "$279.99" sometimes with extra symbols — keep only digits/dots
        price_clean = re.sub(r"[^\d.]", "", price_raw)
        price_text  = f"${price_clean}" if price_clean else ""
        img_src = ""
        if img_el:
            img_src = img_el.get("src","") or img_el.get("data-src","")
        href = title_el.get("href","")
        results.append(_make_item(title, price_text, href, img_src, "Newegg"))
    return results[:12]

def _scrape_ubmart(soup: BeautifulSoup, query: str) -> list:
    results = []
    # Strategy 1: JSON-LD structured data
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
            items = data if isinstance(data, list) else [data]
            for item in items:
                if item.get("@type") not in ("Product", "ItemList"):
                    continue
                if item.get("@type") == "ItemList":
                    for el in item.get("itemListElement", []):
                        item = el.get("item", el)
                        title = item.get("name", "")
                        offers = item.get("offers", {})
                        price_text = str(offers.get("price", ""))
                        url = item.get("url", "")
                        img = (item.get("image", "") or "")
                        if isinstance(img, list):
                            img = img[0] if img else ""
                        if title:
                            results.append(_make_item(title, f"₮{price_text}" if price_text else "", url, img, "UBmart"))
                else:
                    title = item.get("name", "")
                    offers = item.get("offers", {})
                    if isinstance(offers, list):
                        offers = offers[0] if offers else {}
                    price_text = str(offers.get("price", ""))
                    url = item.get("url", "")
                    img = item.get("image", "")
                    if isinstance(img, list):
                        img = img[0] if img else ""
                    if title:
                        results.append(_make_item(title, f"₮{price_text}" if price_text else "", url, img, "UBmart"))
        except Exception:
            pass
    if results:
        return results[:12]
    # Strategy 2: CSS selectors for product cards
    selectors = [
        (".product-item, .product-card, [class*='product']", ".product-name, .product-title, h3, h4", ".price, .product-price, [class*='price']"),
        (".item, .search-item", "a, span.title", ".amount, .price"),
    ]
    for card_sel, title_sel, price_sel in selectors:
        for card in soup.select(card_sel)[:20]:
            title_el = card.select_one(title_sel)
            price_el = card.select_one(price_sel)
            img_el   = card.select_one("img")
            link_el  = card.select_one("a[href]")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            if len(title) < 4:
                continue
            price_raw = price_el.get_text(strip=True) if price_el else ""
            href = urljoin("https://ubmart.mn", link_el.get("href", "")) if link_el else ""
            img_src = ""
            if img_el:
                img_src = img_el.get("src", "") or img_el.get("data-src", "")
                if img_src and not img_src.startswith("http"):
                    img_src = urljoin("https://ubmart.mn", img_src)
            results.append(_make_item(title, price_raw, href, img_src, "UBmart"))
        if results:
            break
    return results[:12]


SCRAPERS = {
    "AliExpress": _scrape_aliexpress,
    "eBay":       _scrape_ebay,
    "Walmart":    _scrape_walmart,
    "Amazon":     _scrape_amazon,
    "Newegg":     _scrape_newegg,
    "BestBuy":    _scrape_bestbuy,
}

def _search_link(shop: str, query: str, url: str) -> dict:
    """Fallback item — marked as search link, not a real product."""
    return {"title": f"Search '{query}' on {shop}", "price": None,
            "price_text": "—", "url": url, "image": "", "source": shop,
            "is_search_link": True}


def _is_blocked_page(html: str) -> bool:
    """Return True when the site returned 200 OK but the page is a CAPTCHA / bot-wall."""
    low = html[:6000].lower()
    return any(s in low for s in [
        "captcha", "recaptcha", "i'm not a robot", "are you a robot",
        "just a moment", "enable javascript and cookies to continue",
        "access denied", "403 forbidden", "unusual traffic",
        "verify you are human", "ddos protection by cloudflare",
        "your request has been blocked", "bot protection",
        "press & hold to confirm", "checking your browser",
    ])


async def _fetch_url(url: str, headers: dict, timeout: int = 25) -> "httpx.Response":
    async with httpx.AsyncClient(headers=headers, timeout=timeout, follow_redirects=True, proxy=SCRAPER_PROXY) as cl:
        return await cl.get(url)


async def _fetch_and_scrape(shop: str, query: str) -> list:
    url = SHOPS[shop](query)

    # ── AliExpress: try JSON API + mobile before HTML scrape ──────────────────
    if shop == "AliExpress":
        items = await _fetch_aliexpress_api(query)
        if items:
            print(f"[scrape:AliExpress] JSON API hit ({len(items)} items)")
            return items
        items = await _fetch_aliexpress_mobile(query)
        if items:
            print(f"[scrape:AliExpress] mobile hit ({len(items)} items)")
            return items
        print("[scrape:AliExpress] falling back to HTML scrape")

    # ── eBay: try mobile URL first (same HTML selectors, weaker bot-detection) ─
    if shop == "eBay":
        mob_url = f"https://m.ebay.com/sch/i.html?_nkw={quote_plus(query)}&_ipg=25"
        mob_hdrs = {
            **SCRAPE_HEADERS,
            "User-Agent": _MOBILE_UA,
            "Referer": "https://m.ebay.com/",
            "Accept-Language": "en-US,en;q=0.9",
        }
        try:
            r = await _fetch_url(mob_url, mob_hdrs)
            if r.status_code == 200 and not _is_blocked_page(r.text):
                soup  = BeautifulSoup(r.text, "html.parser")
                items = _scrape_ebay(soup, query)
                if items:
                    print(f"[scrape:eBay] mobile hit ({len(items)} items)")
                    return items
        except Exception as e:
            print(f"[scrape:eBay] mobile attempt failed: {e}")

    # ── BestBuy: try internal search API before HTML scrape ───────────────────
    if shop == "BestBuy":
        api_url = (
            f"https://www.bestbuy.com/api/2.0/json/search"
            f"?q={quote_plus(query)}&type=product&start=0&numItems=12"
        )
        api_hdrs = {
            **SCRAPE_HEADERS,
            "Accept": "application/json, text/plain, */*",
            "Referer": f"https://www.bestbuy.com/site/searchpage.jsp?st={quote_plus(query)}",
            "X-Requested-With": "XMLHttpRequest",
        }
        try:
            r = await _fetch_url(api_url, api_hdrs, timeout=15)
            if r.status_code == 200:
                data = r.json()
                products = (data.get("products") or data.get("items")
                            or data.get("jsonGraph", {}).get("products", {}).values() or [])
                results = []
                for p in list(products)[:12]:
                    if isinstance(p, dict):
                        name  = p.get("name", "") or p.get("shortDescription", "")
                        price = p.get("salePrice") or p.get("regularPrice") or ""
                        img   = p.get("thumbnailImage", "") or p.get("image", "")
                        sku   = p.get("sku", "")
                        link  = p.get("url", "") or (f"https://www.bestbuy.com/site/{sku}.p?skuId={sku}" if sku else "")
                        if name:
                            results.append(_make_item(name, f"${price}" if price else "", link, img, "BestBuy"))
                if results:
                    print(f"[scrape:BestBuy] API hit ({len(results)} items)")
                    return results
        except Exception as e:
            print(f"[scrape:BestBuy] API attempt failed: {e}")

    base_headers = {**SCRAPE_HEADERS, **SHOP_EXTRA_HEADERS.get(shop, {})}
    # Try default headers first, then rotate through UA pool on block/CAPTCHA
    ua_attempts = [None] + _UA_POOL[:3]
    for attempt, alt_ua in enumerate(ua_attempts):
        headers = {**base_headers, **({"User-Agent": alt_ua} if alt_ua else {})}
        try:
            r = await _fetch_url(url, headers)
            blocked = r.status_code in (403, 503, 429) or (r.status_code == 200 and _is_blocked_page(r.text))
            if blocked:
                if attempt < len(ua_attempts) - 1:
                    print(f"[scrape:{shop}] blocked (status={r.status_code}), retrying with alt UA #{attempt+1}…")
                    await asyncio.sleep(0.4)
                    continue
                print(f"[scrape:{shop}] blocked after {attempt+1} attempts")
                return [_search_link(shop, query, url)]
            soup  = BeautifulSoup(r.text, "html.parser")
            items = SCRAPERS[shop](soup, query)
            if items:
                return items
            print(f"[scrape:{shop}] no items parsed (status {r.status_code})")
            return [_search_link(shop, query, url)]
        except Exception as e:
            if attempt < len(ua_attempts) - 1:
                print(f"[scrape:{shop}] error ({e}), retrying…")
                await asyncio.sleep(0.4)
                continue
            print(f"[scrape:{shop}] {e}")
            return [_search_link(shop, query, url)]
    return [_search_link(shop, query, url)]

def _dedupe_items(items) -> list:
    """Drop repeated products (same shop + same link, or same title and price).
    Shops often list one product twice (sponsored + organic slot)."""
    seen, out = set(), []
    for item in items:
        url = (item.get("url") or "").split("?")[0].rstrip("/")
        title = (item.get("title") or "").strip().lower()
        keys = {(item.get("source"), "t", title, item.get("price"))}
        if url:
            keys.add((item.get("source"), "u", url))
        if keys & seen:
            continue
        seen |= keys
        out.append(item)
    return out

async def scrape_all_shops(query: str) -> list:
    tasks = [_fetch_and_scrape(shop, query) for shop in SHOPS]
    results_nested = await asyncio.gather(*tasks)
    all_items = _dedupe_items(item for group in results_nested for item in group)
    # Save to MongoDB — build doc separately to avoid mutating the returned items
    now = datetime.now(timezone.utc).isoformat()
    try:
        for item in all_items:
            doc = {**item, "query": query, "scraped_at": now}
            scraped_col.update_one(
                {"query": query, "url": item["url"]},
                {"$set": doc},
                upsert=True,
            )
    except Exception as e:
        print(f"[scrape] cache save skipped (MongoDB unavailable?): {e.__class__.__name__}")
    return all_items

# ── Daily scraper scheduler ────────────────────────────────────────────────────
TRACKED_QUERIES_KEY = "tracked_queries"

def get_tracked_queries() -> list:
    doc = mdb["settings"].find_one({"_id": TRACKED_QUERIES_KEY})
    return doc.get("queries", []) if doc else []

MAX_TRACKED_QUERIES = int(_env("MAX_TRACKED_QUERIES", "100"))

def add_tracked_query(query: str):
    try:
        col = mdb["settings"]
        col.update_one({"_id": TRACKED_QUERIES_KEY}, {"$pull": {"queries": query}}, upsert=True)
        col.update_one(   # move to the end, keep only the newest N
            {"_id": TRACKED_QUERIES_KEY},
            {"$push": {"queries": {"$each": [query], "$slice": -MAX_TRACKED_QUERIES}}},
        )
    except Exception as e:
        print(f"[track] could not save tracked query (MongoDB unavailable?): {e.__class__.__name__}")

def daily_scrape_job():
    queries = get_tracked_queries()
    print(f"[scheduler] Daily scrape: {len(queries)} queries")
    for q in queries:
        asyncio.run(scrape_all_shops(q))
        print(f"[scheduler] Scraped: {q}")

scheduler = BackgroundScheduler()
scheduler.add_job(daily_scrape_job, "cron", hour=3, minute=0, id="daily_scrape")
scheduler.start()

# ── Pydantic models ────────────────────────────────────────────────────────────
class ScrapeRequest(BaseModel):
    query: str
    track: bool = True   # add to daily re-scrape list

    def model_post_init(self, _):
        self.query = (self.query or "")[:200]

class CrawlRequest(BaseModel):
    url: str             # starting URL to crawl for product links

# ═══════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════

from fastapi.responses import Response as FastAPIResponse

@app.get("/proxy-image")
async def proxy_image(url: str, _rl=Depends(rate_limit("image"))):
    """Proxy product images to bypass hotlink-protection on stores like Amazon.
    Only public http(s) addresses, only image responses, at most 5 MB."""
    if not url or not url.startswith("http") or len(url) > 2000:
        raise HTTPException(400, "Invalid URL")
    _img_headers = {
        "User-Agent": _MOBILE_UA,
        "Referer":    "https://www.google.com/",
        "Accept":     "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    try:
        r = await fetch_public(url, headers=_img_headers, timeout=12)
    except BlockedURL:
        raise HTTPException(400, "URL not allowed")
    except Exception:
        raise HTTPException(502, "Image fetch failed")
    ct = (r.content_type or "").split(";")[0].strip().lower()
    if r.status_code != 200:
        raise HTTPException(404)
    if not ct.startswith("image/") or ct == "image/svg+xml":   # SVG can carry scripts
        raise HTTPException(415, "Not an image")
    return FastAPIResponse(content=r.content, media_type=ct,
                           headers={"Cache-Control": "public, max-age=86400",
                                    "X-Content-Type-Options": "nosniff"})


@app.get("/health")
def health():
    try:
        mongo_client.admin.command("ping")
        mongo_ok = True
    except Exception:
        mongo_ok = False
    return {
        "ok":               True,
        "mongodb":          mongo_ok,
        "database":         MONGO_DB_NAME,
        "ai_providers":     active_providers(),
        "ai_last_used":     _last_provider["name"],
        "ai_paused":        {k: int(v - time.time()) for k, v in _down_until.items() if v > time.time()},
        "embed_model":      GEMINI_EMBED_MODEL if _gemini_available else None,
        "has_claude_key":   _claude_available,
        "has_gemini_key":   _gemini_available,
        "has_groq_key":     bool(GROQ_API_KEY),
    }

# ── AUTH ──────────────────────────────────
# Usernames listed in ADMIN_USERNAMES become admin automatically when they
# sign up or log in. This is the safe way to create the first admin on a server.
ADMIN_USERNAMES = {u.lower() for u in _csv("ADMIN_USERNAMES", "sanki")}

def _promote_if_listed(doc: dict) -> dict:
    if doc and doc.get("username", "").lower() in ADMIN_USERNAMES and not doc.get("is_admin"):
        users_col.update_one({"id": doc["id"]}, {"$set": {"is_admin": True}})
        doc["is_admin"] = True
    return doc

@app.post("/auth/register")
def register(body: UserCreate, _rl=Depends(rate_limit("register"))):
    if users_col.find_one({"username": body.username}):
        raise HTTPException(400, detail="Нэр аль хэдийн бүртгэлтэй байна")
    if users_col.find_one({"email": body.email}):
        raise HTTPException(400, detail="Email аль хэдийн бүртгэлтэй байна")
    user_doc = {
        "id":              next_id("users"),
        "username":        body.username,
        "email":           body.email,
        "hashed_password": hash_password(body.password),
        "is_admin":        False,
        "created_at":      datetime.now(timezone.utc).isoformat(),
    }
    users_col.insert_one(user_doc)
    _promote_if_listed(user_doc)
    token = make_token(body.username)
    return {
        "access_token": token,
        "token_type":   "bearer",
        "user":         {"id": user_doc["id"], "username": body.username,
                         "email": body.email, "is_admin": user_doc["is_admin"]},
    }

@app.post("/auth/login")
def login(body: UserLoginRequest, request: Request, _rl=Depends(rate_limit("login"))):
    ip = client_ip(request)
    login_guard.check(body.username, ip)          # 429 while locked out
    doc = users_col.find_one({"username": body.username})
    if not doc or not verify_password(body.password[:200], doc["hashed_password"]):
        login_guard.failed(body.username, ip)
        raise HTTPException(401, detail="Нэр эсвэл нууц үг буруу байна")
    login_guard.succeeded(body.username, ip)
    _promote_if_listed(doc)
    token = make_token(body.username)
    return {
        "access_token": token,
        "token_type":   "bearer",
        "user":         {"id": doc["id"], "username": doc["username"],
                         "email": doc["email"], "is_admin": doc.get("is_admin", False)},
    }

@app.get("/auth/me")
def me(current_user: UserObj = Depends(require_user)):
    return {"id": current_user.id, "username": current_user.username,
            "email": current_user.email, "is_admin": current_user.is_admin}

# ── PRODUCTS ──────────────────────────────
@app.get("/products")
def list_products(category: Optional[str] = None, search: Optional[str] = None):
    query = {}
    if category: query["category"] = category
    if search:   query["name"]     = {"$regex": re.escape(search[:100]), "$options": "i"}
    docs = list(products_col.find(query, {"_id": 0}).sort("id", ASCENDING))
    return docs

@app.get("/products/categories")
def list_categories():
    return products_col.distinct("category")

@app.get("/products/{product_id}")
def get_product(product_id: int):
    doc = clean(products_col.find_one({"id": product_id}))
    if not doc:
        raise HTTPException(404, detail="Бараа олдсонгүй")
    return doc

@app.post("/products")
def create_product(body: ProductCreate, current_user: UserObj = Depends(require_user)):
    if not current_user.is_admin:
        raise HTTPException(403, detail="Admin эрх шаардлагатай")
    doc = {
        "id":         next_id("products"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        **body.model_dump(),
    }
    doc.update(embedding_fields(embed_product_doc(doc)))
    products_col.insert_one(doc)
    return clean(doc)

@app.put("/products/{product_id}")
def update_product(product_id: int, body: ProductCreate, current_user: UserObj = Depends(require_user)):
    if not current_user.is_admin:
        raise HTTPException(403, detail="Admin эрх шаардлагатай")
    update_data = body.model_dump()
    update_data.update(embedding_fields(embed_product_doc(update_data)))
    result = products_col.find_one_and_update(
        {"id": product_id},
        {"$set": update_data},
        return_document=True,
    )
    if not result:
        raise HTTPException(404, detail="Бараа олдсонгүй")
    return clean(result)

@app.post("/products/embed-all")
def embed_all_products(current_user: UserObj = Depends(require_user)):
    """Embed every product that has no embedding, or one from an older model."""
    global _rag_has_products
    if not current_user.is_admin:
        raise HTTPException(403, detail="Admin эрх шаардлагатай")
    if not _gemini_available:
        raise HTTPException(503, detail="GEMINI_API_KEY байхгүй — embedding боломжгүй")
    docs = list(products_col.find(
        {"embedding_model": {"$ne": GEMINI_EMBED_MODEL}},
        {"_id": 0, "embedding": 0},
    ))
    updated = 0
    for doc in docs:
        fields = embedding_fields(embed_product_doc(doc))
        if fields:
            products_col.update_one({"id": doc["id"]}, {"$set": fields})
            updated += 1
    _rag_has_products = None  # re-check the catalog on the next chat
    return {"ok": True, "embedded": updated, "total": len(docs)}

@app.delete("/products/{product_id}")
def delete_product(product_id: int, current_user: UserObj = Depends(require_user)):
    if not current_user.is_admin:
        raise HTTPException(403, detail="Admin эрх шаардлагатай")
    r = products_col.delete_one({"id": product_id})
    if r.deleted_count == 0:
        raise HTTPException(404, detail="Бараа олдсонгүй")
    return {"ok": True}

# ── CHAT ──────────────────────────────────
@app.post("/chat")
async def chat(req: ChatRequest, current_user: Optional[UserObj] = Depends(get_current_user),
               _rl=Depends(rate_limit("chat"))):
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, do_chat, req)
        # Save to MongoDB — non-critical, never crash the response
        try:
            if req.session_id and req.message.strip():
                uid = current_user.id if current_user else None
                now = datetime.now(timezone.utc).isoformat()
                chat_col.insert_one({
                    "id":              next_id("chat_history"),
                    "user_id":         uid,
                    "session_id":      req.session_id,
                    "role":            "user",
                    "content":         req.message.strip(),
                    "product_context": req.product_title or None,
                    "created_at":      now,
                })
                if result.get("answer"):
                    chat_col.insert_one({
                        "id":              next_id("chat_history"),
                        "user_id":         uid,
                        "session_id":      req.session_id,
                        "role":            "ai",
                        "content":         result["answer"],
                        "product_context": req.product_title or None,
                        "created_at":      datetime.now(timezone.utc).isoformat(),
                    })
        except Exception as db_err:
            print(f"[chat/db] {db_err}")
        return result
    except Exception as e:
        print(f"[chat/error] {e}")  # full details stay in the server log
        return {"error": "chat_failed", "answer": "Алдаа гарлаа. Дахин оролдоно уу.", "intent": "chat", "search_query": ""}

# ── CHAT HISTORY ──────────────────────────
@app.get("/chat/history")
def get_chat_history(
    session_id: Optional[str] = None,
    limit: int = 100,
    current_user: UserObj = Depends(require_user),
):
    query = {"user_id": current_user.id}
    if session_id: query["session_id"] = session_id
    docs = list(chat_col.find(query, {"_id": 0}).sort("created_at", DESCENDING).limit(limit))
    return docs

@app.get("/chat/sessions")
def get_chat_sessions(current_user: UserObj = Depends(require_user)):
    pipeline = [
        {"$match": {"user_id": current_user.id}},
        {"$group": {
            "_id":           "$session_id",
            "last_at":       {"$max": "$created_at"},
            "message_count": {"$sum": 1},
            "last_content":  {"$last": "$content"},
        }},
        {"$sort": {"last_at": -1}},
        {"$limit": 50},
    ]
    rows = list(chat_col.aggregate(pipeline))
    return [{"session_id": r["_id"], "last_at": r["last_at"],
             "message_count": r["message_count"], "preview": (r["last_content"] or "")[:80]}
            for r in rows]

# ── ADMIN ─────────────────────────────────
# Every /admin endpoint requires a logged-in admin. CORS allows any origin,
# so without this check any website the user visits could call these.
@app.get("/admin/stats")
def admin_stats(_: UserObj = Depends(require_admin)):
    return {
        "total_users":    users_col.count_documents({}),
        "total_products": products_col.count_documents({}),
        "total_messages": chat_col.count_documents({}),
        "total_sessions": len(chat_col.distinct("session_id")),
    }

@app.get("/admin/users")
def admin_list_users(_: UserObj = Depends(require_admin)):
    docs = list(users_col.find({}, {"_id": 0, "hashed_password": 0, "plain_password": 0}).sort("id", ASCENDING))
    return docs

@app.post("/admin/users")
def admin_create_user(body: UserCreate, _: UserObj = Depends(require_admin)):
    if users_col.find_one({"username": body.username}):
        raise HTTPException(400, detail="Нэр аль хэдийн бүртгэлтэй байна")
    user_doc = {
        "id":              next_id("users"),
        "username":        body.username,
        "email":           body.email,
        "hashed_password": hash_password(body.password),
        "is_admin":        False,
        "created_at":      datetime.now(timezone.utc).isoformat(),
    }
    users_col.insert_one(user_doc)
    return {"id": user_doc["id"], "username": body.username, "email": body.email, "is_admin": False, "created_at": user_doc["created_at"]}

@app.patch("/admin/users/{user_id}/toggle-admin")
def admin_toggle_admin(user_id: int, me: UserObj = Depends(require_admin)):
    if user_id == me.id:
        raise HTTPException(400, detail="Өөрийн admin эрхийг хасах боломжгүй")
    doc = users_col.find_one({"id": user_id})
    if not doc: raise HTTPException(404)
    new_val = not doc.get("is_admin", False)
    users_col.update_one({"id": user_id}, {"$set": {"is_admin": new_val}})
    return {"id": user_id, "username": doc["username"], "is_admin": new_val}

@app.delete("/admin/users/{user_id}")
def admin_delete_user(user_id: int, me: UserObj = Depends(require_admin)):
    if user_id == me.id:
        raise HTTPException(400, detail="Өөрийгөө устгах боломжгүй")
    r = users_col.delete_one({"id": user_id})
    if r.deleted_count == 0: raise HTTPException(404)
    return {"ok": True}

@app.post("/admin/make-first-admin")
def make_first_admin(request: Request, me: UserObj = Depends(require_user)):
    """Bootstrap: the logged-in caller becomes admin, but only while no admin
    exists AND the request comes from this computer (or the user is listed in
    ADMIN_USERNAMES). On a public server a stranger therefore can't claim it."""
    if not (is_local_request(request) or me.username.lower() in ADMIN_USERNAMES):
        raise HTTPException(403, detail="Admin тохиргоог зөвхөн сервер дээрээс эсвэл ADMIN_USERNAMES-р хийнэ")
    if users_col.find_one({"is_admin": True}):
        raise HTTPException(400, detail="Admin аль хэдийн байна")
    users_col.update_one({"id": me.id}, {"$set": {"is_admin": True}})
    return {"ok": True, "username": me.username, "message": f"{me.username} admin боллоо"}

# ── ADMIN DB VIEWER ────────────────────────
ALLOWED_COLLECTIONS = {
    "users":        (users_col,    ["id","username","email","is_admin","created_at"]),
    "products":     (products_col, ["id","name","category","price","stock","description","image_url","created_at"]),
    "chat_history": (chat_col,     ["id","user_id","session_id","role","content","product_context","created_at"]),
}

@app.get("/admin/db/{collection_name}")
def admin_db_view(
    collection_name: str,
    page: int = 1,
    per_page: int = 20,
    _: UserObj = Depends(require_admin),
):
    page, per_page = max(page, 1), min(max(per_page, 1), 100)
    if collection_name not in ALLOWED_COLLECTIONS:
        raise HTTPException(404, detail=f"Collection олдсонгүй. Байгаа: {list(ALLOWED_COLLECTIONS)}")
    col, columns = ALLOWED_COLLECTIONS[collection_name]
    total = col.count_documents({})
    docs  = list(col.find({}, {"_id": 0}).sort("id", DESCENDING).skip((page-1)*per_page).limit(per_page))
    def fmt(v):
        if v is None: return None
        return str(v)
    rows = [{c: fmt(d.get(c)) for c in columns} for d in docs]
    return {
        "table":    collection_name,
        "total":    total,
        "page":     page,
        "per_page": per_page,
        "pages":    max(1, (total + per_page - 1) // per_page),
        "columns":  columns,
        "rows":     rows,
    }

@app.delete("/admin/db/{collection_name}/{row_id}")
def admin_db_delete_row(collection_name: str, row_id: int, _: UserObj = Depends(require_admin)):
    if collection_name not in ALLOWED_COLLECTIONS:
        raise HTTPException(404)
    col, _ = ALLOWED_COLLECTIONS[collection_name]
    r = col.delete_one({"id": row_id})
    if r.deleted_count == 0: raise HTTPException(404, detail="Мөр олдсонгүй")
    return {"ok": True}

# ── ANALYZE / TRANSLATE ───────────────────
@app.post("/analyze")
def analyze(req: AnalyzeRequest, _rl=Depends(rate_limit("chat"))):
    try:    return do_analyze(req)
    except Exception as e:
        print(f"[analyze/error] {e}")
        return {"error": "analyze_failed"}

@app.post("/translate_page")
async def translate_page(req: PageTranslateRequest, _rl=Depends(rate_limit("translate"))):
    try:    return await do_translate_page(req.texts[:500], req.source_lang)
    except Exception as e:
        print(f"[translate/error] {e}")
        return {"error": "translate_failed"}


# ── COMPARE / SCRAPE / CRAWL ──────────────

class InterpretRequest(BaseModel):
    query: str

@app.post("/search/understand")
def search_understand(req: InterpretRequest, _rl=Depends(rate_limit("light"))):
    """
    Interpret any user query (Mongolian Latin, Cyrillic, English) into
    clean English product search terms.
    """
    result = interpret_query(req.query.strip()[:200])
    return result

@app.get("/search/semantic")
def search_semantic(q: str, limit: int = 5, _rl=Depends(rate_limit("light"))):
    q = (q or "").strip()[:200]
    if not q:
        raise HTTPException(400, detail="q шаардлагатай")
    if not _gemini_available:
        raise HTTPException(503, detail="GEMINI_API_KEY байхгүй — semantic search боломжгүй")
    limit = min(max(limit, 1), 20)
    results = semantic_product_search(q, top_k=limit)
    return {"query": q, "results": results, "count": len(results)}

@app.post("/compare")
async def compare_products(req: ScrapeRequest, _rl=Depends(rate_limit("search"))):
    """
    Compare a product query across Amazon, eBay, Walmart, AliExpress, BestBuy.
    Auto-interprets Mongolian (Latin/Cyrillic) or English input.
    Returns scraped results sorted by price (cheapest first).
    Results cached in MongoDB; re-scraped if older than 6 hours.
    """
    raw_query = req.query.strip()
    if not raw_query:
        raise HTTPException(400, detail="query шаардлагатай")

    # Interpret the user's query into English search terms (non-blocking)
    interpreted = await interpret_query_async(raw_query)
    # Use the first interpreted query for single-product compare
    query = interpreted["queries"][0] if interpreted["queries"] else raw_query

    # Check cache (45-min window, up to 60 items so we get 10-12 per store)
    cache_cutoff = (datetime.now(timezone.utc) - timedelta(minutes=45)).isoformat()
    try:
        cached = list(scraped_col.find(
            {"query": query, "scraped_at": {"$gte": cache_cutoff}},
            {"_id": 0}
        ).limit(60))
    except Exception:
        cached = []  # MongoDB down: just scrape live

    if cached:
        items = cached
    else:
        items = await scrape_all_shops(query)
        if req.track:
            add_tracked_query(query)

    # ── Relevance filter ──────────────────────────────────────────────────────
    # Score every item; keep search-links and items above minimum threshold
    MIN_RELEVANCE = 25   # drop items with very low match (clearly wrong products)
    scored = []
    for item in items:
        if item.get("is_search_link"):
            scored.append((0, item))
            continue
        score = _relevance_score(item.get("title", ""), query)
        scored.append((score, item))

    # Only filter if we have enough results — don't leave the user with nothing
    relevant = [(s, i) for s, i in scored if not i.get("is_search_link") and s >= MIN_RELEVANCE]
    if len(relevant) >= 5:
        items = [i for s, i in relevant] + [i for s, i in scored if i.get("is_search_link")]
    # else keep all items (sparse scrape result)

    # ── Deduplication ─────────────────────────────────────────────────────────
    # Key by URL first; fall back to a normalised title fingerprint to catch
    # the same listing appearing under two slightly different URLs.
    def _title_fp(t: str) -> str:
        t = re.sub(r"\W+", " ", (t or "").lower()).strip()
        tokens = sorted(set(t.split()))          # sort tokens so order doesn't matter
        return " ".join(tokens[:12])             # first 12 unique tokens as fingerprint

    seen: dict = {}
    for item in items:
        url = (item.get("url") or "").strip()
        fp  = f"{item.get('source','')}|{_title_fp(item.get('title',''))}"
        key = url if url else fp
        # Also check title fingerprint to catch duplicate URLs with different params
        if key not in seen and fp not in seen:
            seen[key] = item
            seen[fp]  = item   # register both so either lookup hits

    deduped = list({id(v): v for v in seen.values()}.values())  # unique by identity

    # ── Sort: relevance desc → price asc ──────────────────────────────────────
    def _sort_key(item):
        if item.get("is_search_link"):
            return (0, 999999)
        score = _relevance_score(item.get("title", ""), query)
        price = item.get("price") or 999999
        # Primary: higher relevance first; secondary: lower price first
        return (-score, price)

    priced   = sorted([i for i in deduped if i.get("price") and not i.get("is_search_link")],  key=_sort_key)
    unpriced = sorted([i for i in deduped if not i.get("price") and not i.get("is_search_link")], key=_sort_key)
    links    = [i for i in deduped if i.get("is_search_link")]

    return {
        "query":             query,
        "original_query":    raw_query,
        "understood":        interpreted.get("understood", ""),
        "original_language": interpreted.get("original_language", ""),
        "all_interpreted":   interpreted["queries"],
        "results":           priced + unpriced + links,
        "total":             len(deduped),
    }


@app.post("/scrape")
async def scrape_shop(req: ScrapeRequest, _: UserObj = Depends(require_admin)):
    """
    Manually trigger a fresh scrape for a query across all shops.
    Always fetches live data (ignores cache).
    """
    query = req.query.strip()
    if not query:
        raise HTTPException(400, detail="query шаардлагатай")
    items = await scrape_all_shops(query)
    if req.track:
        add_tracked_query(query)
    priced   = sorted([i for i in items if i.get("price")], key=lambda x: x["price"])
    unpriced = [i for i in items if not i.get("price")]
    return {"query": query, "results": priced + unpriced, "total": len(items), "fresh": True}


@app.post("/crawl")
async def crawl_url(req: CrawlRequest, _: UserObj = Depends(require_admin)):
    """
    Crawl a given URL and extract all product-looking links from the page.
    Returns up to 30 links with title + href.
    """
    url = req.url.strip()
    if not url:
        raise HTTPException(400, detail="url шаардлагатай")
    try:
        r = await fetch_public(url, headers=SCRAPE_HEADERS, timeout=15)
        soup = BeautifulSoup(r.text, "html.parser")
        base = f"{urlparse(r.url).scheme}://{urlparse(r.url).netloc}"

        links = []
        seen  = set()
        for a in soup.find_all("a", href=True):
            href  = urljoin(base, a["href"])
            title = a.get_text(strip=True)[:120]
            if not title or href in seen: continue
            # Only keep links that look like product pages
            if re.search(r"/product|/item|/dp/|/p/|/pd/|/goods|detail|sku=", href, re.I):
                seen.add(href)
                links.append({"title": title, "url": href})
            if len(links) >= 30: break

        # If no product-specific links, fall back to all links
        if not links:
            for a in soup.find_all("a", href=True)[:30]:
                href  = urljoin(base, a["href"])
                title = a.get_text(strip=True)[:120]
                if title and href not in seen:
                    seen.add(href)
                    links.append({"title": title, "url": href})

        return {"url": url, "links": links, "total": len(links)}
    except BlockedURL:
        raise HTTPException(400, detail="Зөвхөн нийтэд нээлттэй вэб хаяг зөвшөөрөгдөнө")
    except Exception as e:
        print(f"[crawl/error] {e}")
        raise HTTPException(502, detail="Хуудсыг татаж чадсангүй")


@app.get("/compare/cached")
def get_cached_queries():
    """Return list of tracked queries and their last scrape time."""
    queries = get_tracked_queries()
    result = []
    for q in queries:
        latest = scraped_col.find_one({"query": q}, {"_id": 0, "scraped_at": 1},
                                       sort=[("scraped_at", DESCENDING)])
        result.append({"query": q, "last_scraped": latest["scraped_at"] if latest else None})
    return {"tracked": result}

