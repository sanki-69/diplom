import main
from conftest import auth, register


def test_root_landing(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.json()["health"] == "/health"


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_register_login_and_me(client):
    data = register(client, "alice", "secret123")
    assert data["user"]["is_admin"] is False

    r = client.post("/auth/login", json={"username": "alice", "password": "secret123"})
    assert r.status_code == 200
    token = r.json()["access_token"]

    me = client.get("/auth/me", headers=auth(token)).json()
    assert me["username"] == "alice"


def test_passwords_are_hashed_never_stored_plain(client):
    register(client, "alice", "secret123")
    doc = main.users_col.find_one({"username": "alice"})
    assert "plain_password" not in doc
    assert doc["hashed_password"] != "secret123"
    assert doc["hashed_password"].startswith("$2")          # bcrypt


def test_wrong_password_is_rejected(client):
    register(client, "alice", "secret123")
    r = client.post("/auth/login", json={"username": "alice", "password": "nope-nope"})
    assert r.status_code == 401


def test_login_locks_after_repeated_failures(client):
    register(client, "alice", "secret123")
    for _ in range(5):
        assert client.post("/auth/login", json={"username": "alice", "password": "bad"}).status_code == 401
    # even the right password is refused while locked
    r = client.post("/auth/login", json={"username": "alice", "password": "secret123"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_signups_are_rate_limited(client):
    for i in range(5):
        register(client, f"user{i}")
    r = client.post("/auth/register", json={"username": "user9", "email": "u9@test.mn", "password": "secret123"})
    assert r.status_code == 429


def test_admin_endpoints_need_login(client):
    assert client.get("/admin/stats").status_code == 401
    assert client.get("/admin/users").status_code == 401
    assert client.patch("/admin/users/1/toggle-admin").status_code == 401


def test_admin_endpoints_refuse_normal_users(client):
    token = register(client, "alice")["access_token"]
    assert client.get("/admin/stats", headers=auth(token)).status_code == 403
    assert client.get("/admin/db/users", headers=auth(token)).status_code == 403


def test_admin_usernames_become_admin(client):
    data = register(client, "boss")                  # ADMIN_USERNAMES=boss in conftest
    assert data["user"]["is_admin"] is True
    r = client.get("/admin/stats", headers=auth(data["access_token"]))
    assert r.status_code == 200
    users = client.get("/admin/users", headers=auth(data["access_token"])).json()
    assert all("hashed_password" not in u and "plain_password" not in u for u in users)


def test_first_admin_cannot_be_claimed_remotely(client):
    token = register(client, "stranger")["access_token"]
    r = client.post("/admin/make-first-admin", headers=auth(token))
    assert r.status_code == 403
    assert main.users_col.find_one({"username": "stranger"})["is_admin"] is False


def test_admin_cannot_delete_or_demote_self(client):
    data = register(client, "boss")
    uid, h = data["user"]["id"], auth(data["access_token"])
    assert client.delete(f"/admin/users/{uid}", headers=h).status_code == 400
    assert client.patch(f"/admin/users/{uid}/toggle-admin", headers=h).status_code == 400


def test_scrape_and_crawl_are_admin_only(client):
    assert client.post("/scrape", json={"query": "mouse"}).status_code == 401
    assert client.post("/crawl", json={"url": "https://example.com"}).status_code == 401
