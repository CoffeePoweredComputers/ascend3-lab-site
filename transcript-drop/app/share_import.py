"""Import a ChatGPT conversation from its public share link.

Motivation: account exports are not dependable. One real Claude export arrived
with zero conversations, and ChatGPT's can take up to seven days. A share link
is something a student can produce in seconds.

What works and what does not, established by testing against a real link:

  * chatgpt.com/backend-api/share/<id> answers 403 to an unauthenticated
    request, so the obvious JSON route is closed.
  * The share *page* does carry the conversation, embedded in React Router's
    streamed payload as an interned table where strings and objects reference
    each other by index. Resolving that table recovers the whole conversation,
    including per-message timestamps and the model that answered.

That second route is a private detail of someone else's frontend and will break
without notice. Every failure here is therefore reported as "paste it instead"
rather than treated as an error the student caused.

Only conversations the student has already chosen to share are reachable this
way: a normal /c/ link requires their session and cannot be fetched at all.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

# Deliberately strict: this is the whole SSRF defence. Nothing but a share URL
# on a known host is ever fetched, and redirects are refused rather than
# followed, so a redirect cannot walk the request onto another host.
SHARE_URL_RE = re.compile(
    r"^https://(?:chatgpt\.com|chat\.openai\.com)/share/(?P<id>[0-9a-fA-F-]{16,64})/?$"
)

# Claude share links cannot be read this way and never will be by fetching:
# the page is a client-side shell holding no conversation, and the API that
# fills it sits behind bot protection. Getting past that would mean defeating
# an access control the site owner put there, so the student is told what does
# work instead of being given a puzzling rejection.
CLAUDE_SHARE_RE = re.compile(r"^https://claude\.ai/share/", re.IGNORECASE)

# Gemini's share page renders fine in a browser but is filled in afterwards by
# Google's internal batchexecute RPC, whose replies are positional arrays with
# no field names and whose requests need a session id and a dated build label
# scraped from the page. Depending on array positions in an undocumented
# internal API would break mid-semester and do it quietly, so the student is
# pointed at the copy that takes ten seconds and cannot rot.
GEMINI_SHARE_RE = re.compile(
    r"^https://(?:share\.gemini\.google/|gemini\.google\.com/share/)", re.IGNORECASE
)
ENQUEUE_RE = re.compile(r'streamController\.enqueue\((".*?")\)\s*;', re.S)

MAX_BYTES = 4 * 1024 * 1024
TIMEOUT_SECONDS = 20
USER_AGENT = "Mozilla/5.0 (compatible; GenAI-log-collection/1.0)"


class ShareImportError(Exception):
    """Anything that should send the student to the paste box instead."""


def share_id(url: str) -> str | None:
    match = SHARE_URL_RE.match((url or "").strip())
    return match.group("id") if match else None


def fetch_share_page(url: str) -> str:
    if CLAUDE_SHARE_RE.match((url or "").strip()):
        raise ShareImportError(
            "Claude share links cannot be read automatically. Open the link, "
            "select the conversation text and paste it below — or upload your "
            "Claude export instead."
        )
    if GEMINI_SHARE_RE.match((url or "").strip()):
        raise ShareImportError(
            "Gemini share links cannot be read automatically. Open the link, "
            "select the conversation text and paste it below — the shared page "
            "shows the model and dates too, so paste all of it."
        )
    if not share_id(url):
        raise ShareImportError(
            "That is not a ChatGPT share link. Open the conversation, choose "
            "Share, and copy the link it gives you."
        )

    class NoRedirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(NoRedirects)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise ShareImportError(f"That link answered {response.status}.")
            return response.read(MAX_BYTES).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise ShareImportError(
            "That link could not be opened. Check it is still shared, or paste "
            "the conversation instead."
        ) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise ShareImportError("Could not reach ChatGPT to read that link.") from exc


def decode_stream(html: str):
    """Rebuild the page's data from React Router's interned value table.

    Entries reference one another by index: an object is {"_<keyIndex>": valueIndex},
    an array is a list of indexes, and a negative index is an absent value.
    """
    chunks = ENQUEUE_RE.findall(html)
    table = None
    for raw in chunks:
        try:
            payload = json.loads(json.loads(raw))
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(payload, list) and len(payload) > 1:
            table = payload
            break
    if table is None:
        raise ShareImportError(
            "That page did not contain a readable conversation. Paste the "
            "conversation instead."
        )

    def resolve(index, depth=0):
        if depth > 80:
            return None
        if isinstance(index, int):
            if index < 0 or index >= len(table):
                return None
            value = table[index]
        else:
            return index
        if isinstance(value, dict):
            resolved = {}
            for key, ref in value.items():
                name = resolve(int(key[1:]), depth + 1) if key.startswith("_") else key
                resolved[str(name)] = resolve(ref, depth + 1)
            return resolved
        if isinstance(value, list):
            return [resolve(item, depth + 1) for item in value]
        return value

    return resolve(0)


def _find(node, key, depth=0):
    if depth > 30:
        return None
    if isinstance(node, dict):
        if key in node:
            return node[key]
        for value in node.values():
            found = _find(value, key, depth + 1)
            if found is not None:
                return found
    if isinstance(node, list):
        for value in node:
            found = _find(value, key, depth + 1)
            if found is not None:
                return found
    return None


def conversation_from_page(html: str, url: str) -> dict:
    """Turn a fetched share page into the same shape the browser parsers emit."""
    root = decode_stream(html)
    nodes = _find(root, "linear_conversation")
    if not isinstance(nodes, list):
        raise ShareImportError(
            "That page did not contain a readable conversation. Paste the "
            "conversation instead."
        )

    turns = []
    models: list[str] = []
    for node in nodes:
        message = node.get("message") if isinstance(node, dict) else None
        if not isinstance(message, dict):
            continue
        role = ((message.get("author") or {}).get("role")) or "unknown"
        if role == "system":
            continue
        content = message.get("content") or {}
        if content.get("content_type") != "text":
            continue  # tool payloads and editable-context blocks are not turns
        text = "\n\n".join(
            part for part in (content.get("parts") or []) if isinstance(part, str) and part.strip()
        ).strip()
        if not text:
            continue
        metadata = message.get("metadata") or {}
        model = metadata.get("model_slug") or metadata.get("default_model_slug")
        if role == "assistant" and model and model not in models:
            models.append(model)
        turns.append(
            {
                "role": role,
                "content": text,
                "timestamp": message.get("create_time"),
                "model": model if role == "assistant" else None,
            }
        )

    if not turns:
        raise ShareImportError(
            "That link opened, but held no conversation text. Paste it instead."
        )

    return {
        "title": _find(root, "title") or "Shared ChatGPT conversation",
        "turns": turns,
        "models": models,
        "source_session_id": share_id(url),
        "source_url": url,
        "conversation_start": _find(root, "create_time"),
        "conversation_end": _find(root, "update_time"),
    }


def import_share_link(url: str) -> dict:
    return conversation_from_page(fetch_share_page(url), url)
