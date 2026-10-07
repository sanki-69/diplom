"""Test setup: an in-memory fake MongoDB and no real AI keys, so the tests
need no internet, no API keys and no running database."""
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# Blank every external key BEFORE main.py loads .env (load_dotenv never
# overrides variables that already exist, even empty ones).
for key in ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY",
            "ANTHROPIC_API_KEY", "CUSTOM_AI_BASE_URL", "CUSTOM_AI_MODEL", "SCRAPER_PROXY_URL",
            "CLIENT_IP_HEADER", "ALLOWED_ORIGINS"]:
    os.environ[key] = ""
os.environ["SECRET_KEY"] = "test-secret-key"
os.environ["ADMIN_USERNAMES"] = "boss"
os.environ["MONGODB_URL"] = "mongodb://localhost:27017"
os.environ["MONGODB_DB"] = "aishop_test"

import mongomock   # noqa: E402
import pymongo     # noqa: E402

pymongo.MongoClient = mongomock.MongoClient   # main.py does `from pymongo import MongoClient`

import pytest                                  # noqa: E402
from fastapi.testclient import TestClient      # noqa: E402

import main        # noqa: E402
import security    # noqa: E402


@pytest.fixture(autouse=True)
def clean_state():
    for name in main.mdb.list_collection_names():
        main.mdb.drop_collection(name)
    security.limiter.reset()
    security.login_guard.reset()
    main._down_until.clear()
    yield


@pytest.fixture
def client():
    return TestClient(main.app)


def register(client, username, password="secret123", **kw):
    r = client.post("/auth/register", json={"username": username, "email": f"{username}@test.mn",
                                            "password": password}, **kw)
    assert r.status_code == 200, r.text
    return r.json()


def auth(token):
    return {"Authorization": f"Bearer {token}"}
