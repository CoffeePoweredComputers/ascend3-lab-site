"""The model client against a real HTTP server standing in for an
OpenAI-compatible endpoint: what it sends, and what it does when the far end
misbehaves."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from annotate import llm


@pytest.fixture()
def endpoint(monkeypatch):
    """A server whose replies are queued by the test: (status, body) each."""
    replies, seen = [], []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            seen.append((self.path, self.headers["Authorization"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            status, body = replies.pop(0)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1/")
    monkeypatch.setenv("ANNOTATE_LLM_API_KEY", "secret-key")
    monkeypatch.setenv("ANNOTATE_LLM_MODEL", "some-model")
    yield replies, seen
    server.shutdown()


def said(text, finish="stop"):
    return {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": finish}]}


def test_mode_follows_the_environment(monkeypatch):
    monkeypatch.delenv("ANNOTATE_LLM_BASE_URL", raising=False)
    assert llm.mode() == "off"
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "mock")
    assert llm.mode() == "mock"
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "https://example.edu/v1")
    assert llm.mode() == "live"


def test_a_call_is_one_openai_style_request(endpoint):
    replies, seen = endpoint
    replies.append((200, said('Sure. {"codes": []}')))
    assert llm.json_of(llm.chat("be brief", "hello", max_tokens=50)) == {"codes": []}
    path, auth, body = seen[0]
    assert path == "/v1/chat/completions" and auth == "Bearer secret-key"
    assert body["model"] == "some-model" and body["max_tokens"] == 50
    assert [m["role"] for m in body["messages"]] == ["system", "user"] and body["messages"][1]["content"] == "hello"


def test_a_busy_server_is_tried_once_more(endpoint):
    replies, seen = endpoint
    replies += [(503, {}), (200, said("ok"))]
    assert llm.chat("s", "u") == "ok" and len(seen) == 2
    replies += [(429, {}), (500, {})]
    with pytest.raises(RuntimeError, match="answered 500"):
        llm.chat("s", "u")
    # A refusal is not retried: asking again would get the same answer.
    replies.append((401, {}))
    with pytest.raises(RuntimeError, match="answered 401"):
        llm.chat("s", "u")
    assert len(seen) == 5


def test_a_cut_off_or_misshapen_reply_is_an_error_not_a_result(endpoint):
    replies, _ = endpoint
    replies.append((200, said('{"codes": [', finish="length")))
    with pytest.raises(RuntimeError, match="ran out of room"):
        llm.chat("s", "u")
    replies.append((200, {"unexpected": True}))
    with pytest.raises(RuntimeError, match="expected shape"):
        llm.chat("s", "u")
    replies += [(200, b"not json"), (200, b"still not json")]
    with pytest.raises(RuntimeError, match="could not be reached"):
        llm.chat("s", "u")
    for text in ("no braces here", "[1, 2]", "{broken"):
        with pytest.raises(RuntimeError, match="not readable"):
            llm.json_of(text)


def test_an_unreachable_server_fails_with_a_plain_message(monkeypatch):
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("ANNOTATE_LLM_TIMEOUT", "2")
    with pytest.raises(RuntimeError, match="could not be reached"):
        llm.chat("s", "u")
