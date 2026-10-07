import pytest

import main
import security
from conftest import auth, register


# ── URL guard (image proxy / crawler) ────────────────────────────────────────
@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8000/admin/users",
    "http://localhost/",
    "http://10.0.0.5/",
    "http://192.168.1.1/router",
    "http://169.254.169.254/latest/meta-data/",      # cloud metadata service
    "http://[::1]/",
    "file:///etc/passwd",
    "ftp://93.184.216.34/file",
    "http://93.184.216.34:22/",                      # non-web port
    "http://user:pass@93.184.216.34/",
    "not a url",
])
def test_private_or_odd_urls_are_blocked(url):
    assert security.is_public_url(url) is False


def test_public_ip_url_is_allowed():
    assert security.is_public_url("https://93.184.216.34/image.jpg") is True


def test_image_proxy_refuses_internal_addresses(client):
    r = client.get("/proxy-image", params={"url": "http://127.0.0.1:8000/admin/users"})
    assert r.status_code == 400


# ── Rate limiting ────────────────────────────────────────────────────────────
def test_rate_limiter_counts_per_key():
    rl = security.RateLimiter()
    assert [rl.hit("k", 3, 60) for _ in range(3)] == [0, 0, 0]
    assert rl.hit("k", 3, 60) > 0          # 4th is refused with a wait time
    assert rl.hit("other", 3, 60) == 0     # other visitors unaffected


@pytest.fixture
def fake_chat(monkeypatch):
    monkeypatch.setattr(main, "do_chat", lambda req: {"answer": "ok", "intent": "chat"})


def test_chat_is_rate_limited_per_visitor(client, fake_chat):
    for _ in range(20):
        assert client.post("/chat", json={"message": "hi"}).status_code == 200
    r = client.post("/chat", json={"message": "hi"})
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) > 0
    assert "хүсэлт" in r.json()["detail"]


def test_global_daily_cap_protects_ai_quota(client, fake_chat, monkeypatch):
    monkeypatch.setitem(security.GLOBAL_DAILY, "chat", 2)
    assert client.post("/chat", json={"message": "a"}).status_code == 200
    assert client.post("/chat", json={"message": "b"}).status_code == 200
    r = client.post("/chat", json={"message": "c"})
    assert r.status_code == 429
    assert "Өнөөдрийн" in r.json()["detail"]


def test_proxy_header_separates_visitors(client, fake_chat, monkeypatch):
    monkeypatch.setattr(security, "CLIENT_IP_HEADER", "cf-connecting-ip")
    monkeypatch.setitem(security.LIMITS, "chat", [(1, 60)])
    a = {"cf-connecting-ip": "1.1.1.1"}
    b = {"cf-connecting-ip": "8.8.8.8"}
    assert client.post("/chat", json={"message": "x"}, headers=a).status_code == 200
    assert client.post("/chat", json={"message": "x"}, headers=a).status_code == 429
    assert client.post("/chat", json={"message": "x"}, headers=b).status_code == 200


# ── Input handling ───────────────────────────────────────────────────────────
def test_chat_history_is_capped():
    req = main.ChatRequest(message="x" * 5000,
                           history=[{"role": "user", "content": "y" * 9000}] * 50)
    assert len(req.message) == 2000
    assert len(req.history) == 20
    assert all(len(m.content) <= 2000 for m in req.history)


def test_product_search_treats_text_literally(client):
    token = register(client, "boss")["access_token"]
    r = client.post("/products", headers=auth(token),
                    json={"name": "Mouse (wireless)", "price": 10, "category": "pc"})
    assert r.status_code == 200
    # regex special characters must not crash or match everything
    found = client.get("/products", params={"search": "(wireless)"}).json()
    assert [p["name"] for p in found] == ["Mouse (wireless)"]
    assert client.get("/products", params={"search": ".*"}).json() == []
