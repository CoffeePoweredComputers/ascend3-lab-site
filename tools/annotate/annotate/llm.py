"""One call to a chat model: over any OpenAI-compatible endpoint, or through
Claude Code.

Set in the tool's environment (on the server, its secrets file):

    ANNOTATE_LLM_BASE_URL   e.g. https://llm-api.arc.vt.edu/api/v1
    ANNOTATE_LLM_API_KEY
    ANNOTATE_LLM_MODEL
    ANNOTATE_LLM_TIMEOUT    seconds, default 120

or, for Claude Code (the `claude` program in the image, run once per call
with every tool switched off, so it can only read the prompt and answer):

    ANNOTATE_LLM_BASE_URL=claude-code
    ANNOTATE_LLM_MODEL      default opus
    ANNOTATE_LLM_TIMEOUT    seconds, default 300
    ANTHROPIC_API_KEY  or  CLAUDE_CODE_OAUTH_TOKEN   read by claude itself

With no base URL the tool works without a model: nobody gets candidate codes
and the merge groups by shared cards and names alone. ANNOTATE_LLM_BASE_URL=mock
is a stand-in for a developer's machine that never leaves the process.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request

CLAUDE_CODE = "claude-code"
# Each Claude Code call is a process of some 250 MB and the tool's container
# has 512 MB, so two people generating at once take turns call by call.
_one_claude = threading.Lock()


def mode() -> str:
    """'off', 'mock' or 'live'."""
    base = os.environ.get("ANNOTATE_LLM_BASE_URL", "").strip()
    return "off" if not base else "mock" if base == "mock" else "live"


def agentic() -> bool:
    """Whether the model is reached through Claude Code. Candidate codes are
    then built in steps (steps.py), each a call of its own, instead of in one."""
    return os.environ.get("ANNOTATE_LLM_BASE_URL", "").strip() == CLAUDE_CODE


def chat(system: str, user: str, max_tokens: int = 8000) -> str:
    """The model's reply as text. Raises RuntimeError with a message fit to
    show a person; one retry on a busy or failing server. A reasoning model's
    thinking counts against max_tokens, and 8000 is the most VT ARC accepts
    on a reply that is not streamed."""
    if agentic():
        return _claude(system, user)
    base = os.environ["ANNOTATE_LLM_BASE_URL"].rstrip("/")
    body = json.dumps({
        "model": os.environ.get("ANNOTATE_LLM_MODEL", ""),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }).encode()
    request = urllib.request.Request(
        f"{base}/chat/completions", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('ANNOTATE_LLM_API_KEY', '')}"},
    )
    timeout = float(os.environ.get("ANNOTATE_LLM_TIMEOUT", "120"))
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                reply = json.load(response)
            break
        except urllib.error.HTTPError as error:
            if attempt == 1 and (error.code == 429 or error.code >= 500):
                continue
            raise RuntimeError(f"The model's server answered {error.code}.") from error
        except (OSError, ValueError) as error:
            if attempt == 1:
                continue
            raise RuntimeError("The model's server could not be reached.") from error
    try:
        choice = reply["choices"][0]
        text = choice["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("The model's reply was not in the expected shape.") from error
    if choice.get("finish_reason") == "length":
        raise RuntimeError("The model ran out of room before finishing its reply.")
    return text


def _claude(system: str, user: str) -> str:
    """One run of `claude -p`: our system prompt in place of its own, no tools,
    no MCP servers, nothing saved. Each run starts from nothing, so no call
    sees another's reply. One retry, as for a failing server."""
    command = [
        os.environ.get("ANNOTATE_CLAUDE_BIN", "claude"), "-p",
        "--model", os.environ.get("ANNOTATE_LLM_MODEL", "").strip() or "opus",
        "--system-prompt", system,
        "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
        "--output-format", "json",
    ]
    timeout = float(os.environ.get("ANNOTATE_LLM_TIMEOUT", "300"))
    for attempt in (1, 2):
        try:
            with _one_claude:
                done = subprocess.run(command, input=user, capture_output=True, text=True, timeout=timeout, cwd=tempfile.gettempdir())
        except FileNotFoundError as error:
            raise RuntimeError("Claude Code is not installed where the tool runs.") from error
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("Claude Code did not answer in time.") from error
        try:
            reply = json.loads(done.stdout)
            text, failed = reply["result"] or "", bool(reply.get("is_error")) or done.returncode != 0
        except (ValueError, KeyError, TypeError):
            text, failed, reply = (done.stderr or done.stdout).strip(), True, {}
        if not failed:
            break
        if attempt == 2:
            raise RuntimeError(f"Claude Code could not answer: {text[:200] or 'no reason given'}")
    if reply.get("stop_reason") == "max_tokens":
        raise RuntimeError("The model ran out of room before finishing its reply.")
    return text


def json_of(text: str) -> dict:
    """The JSON object in a reply, whatever the model wrapped around it."""
    start, end = text.find("{"), text.rfind("}")
    try:
        value = json.loads(text[start:end + 1])
    except ValueError as error:
        raise RuntimeError("The model's reply was not readable.") from error
    if not isinstance(value, dict):
        raise RuntimeError("The model's reply was not readable.")
    return value
