"""One call to a chat model, over any OpenAI-compatible endpoint.

Set in the tool's environment (on the server, its secrets file):

    ANNOTATE_LLM_BASE_URL   e.g. https://llm-api.arc.vt.edu/api/v1
    ANNOTATE_LLM_API_KEY
    ANNOTATE_LLM_MODEL
    ANNOTATE_LLM_TIMEOUT    seconds, default 120

With no base URL the tool works without a model: nobody gets candidate codes
and the merge groups by shared cards and names alone. ANNOTATE_LLM_BASE_URL=mock
is a stand-in for a developer's machine that never leaves the process.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


def mode() -> str:
    """'off', 'mock' or 'live'."""
    base = os.environ.get("ANNOTATE_LLM_BASE_URL", "").strip()
    return "off" if not base else "mock" if base == "mock" else "live"


def chat(system: str, user: str, max_tokens: int = 3000) -> str:
    """The model's reply as text. Raises RuntimeError with a message fit to
    show a person; one retry on a busy or failing server."""
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
