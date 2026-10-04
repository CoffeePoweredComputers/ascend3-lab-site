"""The model client against a real HTTP server standing in for an
OpenAI-compatible endpoint: what it sends, and what it does when the far end
misbehaves."""

import json
import sys
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
    assert llm.mode() == "live" and not llm.agentic()
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "claude-code")
    assert llm.mode() == "live" and llm.agentic()


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


# ------------------------------------------------------------------ Claude Code


@pytest.fixture()
def claude(monkeypatch, tmp_path):
    """A stand-in for the claude program: it writes down how it was run and
    prints the replies the test queued, one per run, with the exit code given."""
    seen, replies = tmp_path / "seen.jsonl", tmp_path / "replies"
    replies.mkdir()
    program = tmp_path / "claude"
    program.write_text(f"""#!{sys.executable}
import json, os, sys
with open({str(seen)!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "stdin": sys.stdin.read(), "cwd": os.getcwd()}}) + "\\n")
path = os.path.join({str(replies)!r}, sorted(os.listdir({str(replies)!r}))[0])
code, out = open(path).read().split("\\n", 1)
os.remove(path)
sys.stdout.write(out)
sys.exit(int(code))
""")
    program.chmod(0o755)
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "claude-code")
    monkeypatch.setenv("ANNOTATE_CLAUDE_BIN", str(program))
    monkeypatch.delenv("ANNOTATE_LLM_MODEL", raising=False)
    count = iter(range(100))

    def queue(body, code=0):
        (replies / f"{next(count):03d}").write_text(f"{code}\n" + (body if isinstance(body, str) else json.dumps(body)))

    return queue, lambda: [json.loads(line) for line in seen.read_text().splitlines()]


def answered(text, **more):
    return {"type": "result", "is_error": False, "result": text, "stop_reason": "end_turn", **more}


def test_a_claude_code_call_is_one_run_with_no_tools(claude, monkeypatch, tmp_path):
    queue, runs = claude
    queue(answered('Here: {"codes": []}'))
    assert llm.json_of(llm.chat("be brief", "hello")) == {"codes": []}
    argv = runs()[0]["argv"]
    assert argv[0] == "-p" and runs()[0]["stdin"] == "hello" and runs()[0]["cwd"] != str(tmp_path)

    def after(flag):
        return argv[argv.index(flag) + 1]

    assert after("--model") == "opus" and after("--system-prompt") == "be brief" and after("--tools") == ""
    assert after("--output-format") == "json" and "--strict-mcp-config" in argv and "--no-session-persistence" in argv
    # The model is whatever the environment names.
    monkeypatch.setenv("ANNOTATE_LLM_MODEL", "sonnet")
    queue(answered("ok"))
    assert llm.chat("s", "u") == "ok" and runs()[1]["argv"][runs()[1]["argv"].index("--model") + 1] == "sonnet"


def test_a_failed_claude_code_run_is_tried_once_more_then_reported(claude):
    queue, runs = claude
    queue(answered("Overloaded", is_error=True), code=1)
    queue(answered("ok"))
    assert llm.chat("s", "u") == "ok" and len(runs()) == 2
    queue(answered("Invalid API key · Please run /login", is_error=True), code=1)
    queue("not json at all", code=1)
    with pytest.raises(RuntimeError, match="could not answer: not json at all"):
        llm.chat("s", "u")
    queue(answered('{"codes": [', stop_reason="max_tokens"))
    with pytest.raises(RuntimeError, match="ran out of room"):
        llm.chat("s", "u")


def test_claude_code_that_is_missing_or_slow_fails_with_a_plain_message(claude, monkeypatch, tmp_path):
    slow = tmp_path / "slow"
    slow.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(5)\n")
    slow.chmod(0o755)
    monkeypatch.setenv("ANNOTATE_CLAUDE_BIN", str(slow))
    monkeypatch.setenv("ANNOTATE_LLM_TIMEOUT", "0.5")
    with pytest.raises(RuntimeError, match="did not answer in time"):
        llm.chat("s", "u")
    monkeypatch.setenv("ANNOTATE_CLAUDE_BIN", str(tmp_path / "nowhere"))
    with pytest.raises(RuntimeError, match="not installed"):
        llm.chat("s", "u")
