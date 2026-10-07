"""Abuse protection for the public API.

* RateLimiter / rate_limit(): per-visitor (and optional global) request limits
  for the expensive endpoints (AI chat, scraping, translation).
* LoginGuard: locks a username or IP after too many wrong passwords.
* is_public_url() / fetch_public(): only lets the image proxy and crawler
  fetch public internet addresses, never localhost or private networks.

Everything is in memory, which fits a single server process (the free Render
plan runs one). Limits reset when the server restarts.
"""
import asyncio
import ipaddress
import os
import socket
import threading
import time
from collections import defaultdict, deque
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import HTTPException, Request


# ── Client IP ────────────────────────────────────────────────────────────────
# Behind a proxy every request comes from the proxy's address, so the real
# visitor IP must come from a header. Only trust a header the proxy itself
# sets (and visitors can't forge): on Render that is Cloudflare's
# "cf-connecting-ip". Locally the setting is empty and the socket address is used.
CLIENT_IP_HEADER = (os.getenv("CLIENT_IP_HEADER") or "").strip().lower()


def client_ip(request: Request) -> str:
    if CLIENT_IP_HEADER:
        value = request.headers.get(CLIENT_IP_HEADER, "").split(",")[0].strip()
        if value:
            return value
    return request.client.host if request.client else "unknown"


def is_local_request(request: Request) -> bool:
    """True only for requests made on this machine (not through a proxy)."""
    if CLIENT_IP_HEADER and request.headers.get(CLIENT_IP_HEADER):
        return False
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost")


# ── Rate limiting ────────────────────────────────────────────────────────────
class RateLimiter:
    """Sliding-window counter: at most `limit` hits per `window` seconds per key."""

    def __init__(self):
        self._hits: dict = defaultdict(deque)
        self._lock = threading.Lock()
        self._last_sweep = time.time()

    def hit(self, key: str, limit: int, window: int) -> int:
        """Record a hit. Returns 0 if allowed, else seconds until a slot frees up."""
        now = time.time()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                return max(1, int(q[0] + window - now) + 1)
            q.append(now)
            if now - self._last_sweep > 300:          # forget idle visitors
                self._last_sweep = now
                for k in [k for k, v in self._hits.items() if not v]:
                    del self._hits[k]
            return 0

    def reset(self):
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()


def _limit(name: str, default: str) -> list:
    """Read limits like "20/60,300/86400" (count/seconds) from env RATE_<NAME>."""
    raw = os.getenv(f"RATE_{name.upper()}", default)
    rules = []
    for part in raw.split(","):
        if "/" in part:
            count, secs = part.split("/", 1)
            rules.append((int(count), int(secs)))
    return rules


# Per-visitor limits. Each can be overridden with an env var, e.g.
# RATE_CHAT="30/60,500/86400". A value like "0/1" blocks the endpoint.
LIMITS = {
    "chat":      _limit("chat",      "20/60,300/86400"),
    "search":    _limit("search",    "10/60,150/86400"),
    "translate": _limit("translate", "10/60,200/86400"),
    "light":     _limit("light",     "60/60"),
    "image":     _limit("image",     "240/60"),
    "register":  _limit("register",  "5/3600"),
    "login":     _limit("login",     "20/600"),
}
# Whole-site daily caps that protect the free AI quotas even if many different
# visitors (or a botnet) show up. Override with GLOBAL_DAILY_<NAME>.
GLOBAL_DAILY = {
    "chat":      int(os.getenv("GLOBAL_DAILY_CHAT", "3000")),
    "search":    int(os.getenv("GLOBAL_DAILY_SEARCH", "2000")),
    "translate": int(os.getenv("GLOBAL_DAILY_TRANSLATE", "2000")),
}

LIMIT_MESSAGE = "Хэт олон хүсэлт илгээлээ. {secs} секундын дараа дахин оролдоно уу."
GLOBAL_MESSAGE = "Өнөөдрийн үнэгүй хязгаар дууслаа. Маргааш дахин оролдоно уу."


def rate_limit(name: str):
    """FastAPI dependency: `Depends(rate_limit("chat"))`."""
    def dependency(request: Request):
        ip = client_ip(request)
        for count, window in LIMITS[name]:
            wait = limiter.hit(f"{name}:{window}:{ip}", count, window)
            if wait:
                raise HTTPException(429, detail=LIMIT_MESSAGE.format(secs=wait),
                                    headers={"Retry-After": str(wait)})
        cap = GLOBAL_DAILY.get(name)
        if cap:
            wait = limiter.hit(f"global:{name}", cap, 86400)
            if wait:
                raise HTTPException(429, detail=GLOBAL_MESSAGE, headers={"Retry-After": str(wait)})
    return dependency


# ── Login brute-force protection ─────────────────────────────────────────────
class LoginGuard:
    """After MAX_FAILS wrong passwords for a username (or from one IP) within
    WINDOW seconds, refuse logins for LOCK seconds."""

    MAX_FAILS = int(os.getenv("LOGIN_MAX_FAILS", "5"))
    WINDOW = 15 * 60
    LOCK = int(os.getenv("LOGIN_LOCK_SECONDS", str(15 * 60)))

    def __init__(self):
        self._fails: dict = defaultdict(deque)
        self._locked: dict = {}
        self._lock = threading.Lock()

    def _keys(self, username: str, ip: str):
        return (f"user:{username.lower()}", f"ip:{ip}")

    def check(self, username: str, ip: str):
        now = time.time()
        with self._lock:
            for k in self._keys(username, ip):
                until = self._locked.get(k, 0)
                if until > now:
                    mins = max(1, int((until - now) / 60 + 0.99))
                    raise HTTPException(
                        429,
                        detail=f"Олон удаа буруу нууц үг оруулсан тул түр хаагдлаа. {mins} минутын дараа оролдоно уу.",
                        headers={"Retry-After": str(int(until - now) + 1)},
                    )

    def failed(self, username: str, ip: str):
        now = time.time()
        with self._lock:
            for k in self._keys(username, ip):
                q = self._fails[k]
                while q and q[0] <= now - self.WINDOW:
                    q.popleft()
                q.append(now)
                # an IP gets more tries than a single username (shared networks)
                allowed = self.MAX_FAILS if k.startswith("user:") else self.MAX_FAILS * 4
                if len(q) >= allowed:
                    self._locked[k] = now + self.LOCK
                    q.clear()

    def succeeded(self, username: str, ip: str):
        with self._lock:
            self._fails.pop(f"user:{username.lower()}", None)

    def reset(self):
        with self._lock:
            self._fails.clear()
            self._locked.clear()


login_guard = LoginGuard()


# ── Safe outbound fetching (image proxy / crawler) ───────────────────────────
ALLOWED_PORTS = {None, 80, 443}


def _resolve(host: str) -> list:
    try:
        return [info[4][0] for info in socket.getaddrinfo(host, None)]
    except socket.gaierror:
        return []


def is_public_url(url: str) -> bool:
    """True only for http(s) URLs on default ports whose host resolves
    exclusively to public internet addresses."""
    try:
        parts = urlparse(url)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    try:
        if parts.port not in ALLOWED_PORTS:
            return False
    except ValueError:
        return False
    if parts.username or parts.password:
        return False
    addresses = _resolve(parts.hostname)
    if not addresses:
        return False
    for addr in addresses:
        ip = ipaddress.ip_address(addr.split("%")[0])
        if not ip.is_global or ip.is_multicast:
            return False
    return True


class BlockedURL(Exception):
    pass


class FetchResult:
    def __init__(self, status_code: int, content_type: str, content: bytes, url: str, encoding: str):
        self.status_code = status_code
        self.content_type = content_type
        self.content = content
        self.url = url
        self._encoding = encoding or "utf-8"

    @property
    def text(self) -> str:
        return self.content.decode(self._encoding, errors="replace")


async def fetch_public(url: str, *, headers: Optional[dict] = None, timeout: float = 12,
                       max_bytes: int = 5 * 1024 * 1024, max_redirects: int = 4) -> FetchResult:
    """GET a public URL. Every redirect hop is checked again, so a public page
    can't bounce the request to an internal address. Large bodies are refused."""
    async with httpx.AsyncClient(headers=headers, timeout=timeout, follow_redirects=False) as client:
        for _ in range(max_redirects + 1):
            if not await asyncio.to_thread(is_public_url, url):
                raise BlockedURL(url)
            async with client.stream("GET", url) as resp:
                if resp.is_redirect and resp.headers.get("location"):
                    url = urljoin(url, resp.headers["location"])
                    continue
                body = bytearray()
                async for chunk in resp.aiter_bytes():        # already decompressed
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise BlockedURL("response too large")
                return FetchResult(resp.status_code, resp.headers.get("content-type", ""),
                                   bytes(body), url, resp.encoding)
        raise BlockedURL("too many redirects")
