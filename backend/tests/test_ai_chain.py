"""The AI provider chain: order, fallback, pausing, and response parsing."""
import time

import pytest

import main


def fake(answer=None, error=None, calls=None, name=""):
    def run(system_prompt, user_prompt, max_tokens, fast):
        if calls is not None:
            calls.append(name)
        if error:
            raise Exception(error)
        return answer
    return run


@pytest.fixture
def providers(monkeypatch):
    """Replace real providers with fakes; returns a dict to configure them."""
    calls = []
    table = {}

    def setup(order, behaviours, fast_order=None):
        for name, (available, answer, error) in behaviours.items():
            table[name] = (lambda a=available: a, fake(answer, error, calls, name))
        monkeypatch.setattr(main, "PROVIDERS", table)
        monkeypatch.setattr(main, "AI_PROVIDER_ORDER", order)
        monkeypatch.setattr(main, "AI_FAST_PROVIDER_ORDER", fast_order or order)
        return calls
    return setup


def test_first_working_provider_answers(providers):
    calls = providers(["a", "b"], {"a": (True, {"answer": "A"}, None),
                                   "b": (True, {"answer": "B"}, None)})
    assert main.ai_generate_json("sys", "hi") == {"answer": "A"}
    assert calls == ["a"]
    assert main._last_provider["name"] == "a"


def test_providers_without_keys_are_skipped(providers):
    calls = providers(["a", "b"], {"a": (False, {"answer": "A"}, None),
                                   "b": (True, {"answer": "B"}, None)})
    assert main.ai_generate_json("sys", "hi") == {"answer": "B"}
    assert calls == ["b"]


def test_overloaded_provider_is_paused_and_next_answers(providers):
    calls = providers(["a", "b"], {"a": (True, None, "503 UNAVAILABLE high demand"),
                                   "b": (True, {"answer": "B"}, None)})
    assert main.ai_generate_json("sys", "hi") == {"answer": "B"}
    assert main._down_until["a"] > time.time()          # paused
    main.ai_generate_json("sys", "hi")
    assert calls == ["a", "b", "b"]                     # paused one not retried


def test_rate_limited_provider_is_paused(providers):
    providers(["a", "b"], {"a": (True, None, "429 RESOURCE_EXHAUSTED quota"),
                           "b": (True, {"answer": "B"}, None)})
    main.ai_generate_json("sys", "hi")
    assert main._down_until["a"] - time.time() > 200     # quota → long pause


def test_quick_tasks_use_their_own_order(providers):
    calls = providers(["slow", "quick"],
                      {"slow": (True, {"answer": "S"}, None), "quick": (True, {"answer": "Q"}, None)},
                      fast_order=["quick", "slow"])
    assert main.ai_generate_json("sys", "hi", fast=True) == {"answer": "Q"}
    assert main.ai_generate_json("sys", "hi") == {"answer": "S"}
    assert calls == ["quick", "slow"]


def test_all_failing_gives_a_readable_error(providers):
    providers(["a"], {"a": (True, None, "boom")})
    with pytest.raises(Exception, match="AI provider"):
        main.ai_generate_json("sys", "hi")


def test_no_keys_at_all_explains_setup(providers):
    providers(["a"], {"a": (False, None, None)})
    with pytest.raises(Exception, match="AI provider байхгүй"):
        main.ai_generate_json("sys", "hi")


# ── OpenAI-compatible providers (OpenRouter, Mistral, custom) ────────────────
class FakeResponse:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


@pytest.fixture
def compat(monkeypatch):
    sent = {}
    monkeypatch.setitem(main.COMPAT_PROVIDERS["custom"], "base_url", "https://ai.example.com/v1")
    monkeypatch.setitem(main.COMPAT_PROVIDERS["custom"], "api_key", "k")
    monkeypatch.setitem(main.COMPAT_PROVIDERS["custom"], "models", ["model-x"])
    monkeypatch.setitem(main.COMPAT_PROVIDERS["custom"], "fast_models", ["model-x"])

    def use(content, status=200):
        def post(url, json, headers, timeout):
            sent.update(url=url, body=json, headers=headers)
            return FakeResponse(status, {"choices": [{"message": {"content": content}}]})
        monkeypatch.setattr(main.httpx, "post", post)
        return sent
    return use


def test_compat_provider_parses_json_and_strips_thinking(compat):
    sent = compat('<think>let me think {not json}</think>```json\n{"answer": "Сайн уу"}\n```')
    out = main.compat_generate_json("custom", "sys", "hi", 100, False)
    assert out == {"answer": "Сайн уу"}
    assert sent["url"] == "https://ai.example.com/v1/chat/completions"
    assert sent["body"]["model"] == "model-x"
    assert sent["headers"]["Authorization"] == "Bearer k"


def test_compat_provider_http_error_raises(compat):
    compat("", status=429)
    with pytest.raises(Exception, match="429"):
        main.compat_generate_json("custom", "sys", "hi", 100, False)
