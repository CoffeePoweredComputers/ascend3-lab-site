"""Normalizer: every platform's format collapses into one common JSON shape.

Two paths feed in (section 9):

  * Whole-account exports are parsed in the browser (static/parsers.js) so the
    unselected private conversations never reach the server. Those arrive here
    as turn lists that still need validating and cleaning.
  * Pasted or plain-text uploads arrive as raw text and are segmented here, so
    there is exactly one implementation of the heuristic and the preview a
    student sees is what actually gets stored.
"""

from __future__ import annotations

import hashlib
import html
import re
from datetime import datetime, timezone
from typing import Any, Iterable

ROLE_ALIASES = {
    "user": "user",
    "you": "user",
    "me": "user",
    "human": "user",
    "student": "user",
    "prompt": "user",
    "question": "user",
    "q": "user",
    "assistant": "assistant",
    "ai": "assistant",
    "bot": "assistant",
    "model": "assistant",
    "answer": "assistant",
    "a": "assistant",
    "chatgpt": "assistant",
    "gpt": "assistant",
    "claude": "assistant",
    "gemini": "assistant",
    "bard": "assistant",
    "copilot": "assistant",
    "cursor": "assistant",
    "perplexity": "assistant",
    "system": "system",
    "tool": "system",
    "developer": "system",
}

# Matches "You:", "**ChatGPT said:**", "### Assistant:", "> Human:" at line start.
# List-bullet decoration ("- ") is deliberately excluded: "- Cursor: an editor"
# inside an answer is prose, not a new speaker.
SPEAKER_RE = re.compile(
    r"^[ \t]*(?:[*_#>]{0,6}[ \t]*)?"
    r"(?P<name>" + "|".join(sorted(ROLE_ALIASES, key=len, reverse=True)) + r")"
    r"(?:[ \t]+said)?"
    r"[ \t]*[*_]{0,4}[ \t]*[:：][ \t]*"
    r"(?P<rest>.*)$",
    re.IGNORECASE,
)

FENCE_RE = re.compile(r"^[ \t]*(?:```|~~~)")

# "View source" on a chat page yields a full HTML document: megabytes of CSS and
# bundle names with the conversation buried inside. The file-upload path strips
# that in the browser, and these let the paste path do the same. The trigger is
# deliberately narrow -- a document opening with <!doctype html> or <html> --
# so a conversation that merely discusses HTML is left alone.
HTML_DOC_RE = re.compile(r"^\s*(?:<!doctype\s+html|<html\b)", re.IGNORECASE)
SCRIPT_STYLE_RE = re.compile(r"<(script|style|head)\b.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
BLOCK_END_RE = re.compile(r"</(p|div|li|h[1-6]|tr|section|article)\s*>|<br\s*/?>", re.IGNORECASE)
TAG_RE = re.compile(r"<[^>]+>")

MAX_TURNS = 4000
MAX_TURN_CHARS = 200_000


def normalize_role(raw: Any) -> str:
    key = str(raw or "").strip().lower()
    return ROLE_ALIASES.get(key, "unknown")


def normalize_timestamp(raw: Any) -> str | None:
    """Accept epoch seconds, epoch millis, or an ISO-ish string; emit ISO 8601."""
    if raw is None or raw == "":
        return None

    if isinstance(raw, (int, float)):
        seconds = float(raw)
        if seconds > 1e11:  # milliseconds
            seconds /= 1000.0
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat(
                timespec="seconds"
            )
        except (OverflowError, OSError, ValueError):
            return None

    text = str(raw).strip()
    if not text:
        return None
    candidate = text.replace("Z", "+00:00").replace(" ", "T", 1)
    try:
        return datetime.fromisoformat(candidate).isoformat(timespec="seconds")
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y/%m/%d %H:%M:%S", "%b %d, %Y, %I:%M %p"):
        try:
            return datetime.strptime(text, fmt).isoformat(timespec="seconds")
        except ValueError:
            continue
    return None


def strip_html_document(text: str) -> str | None:
    """Reduce a pasted HTML page to its readable text, or None if it is not one.

    Returns None for ordinary text so callers can tell "not HTML" apart from
    "HTML that contained no readable text".
    """
    if not HTML_DOC_RE.match(text or ""):
        return None

    body = SCRIPT_STYLE_RE.sub(" ", text)
    body = BLOCK_END_RE.sub("\n", body)
    body = TAG_RE.sub(" ", body)
    body = html.unescape(body)

    lines = (re.sub(r"[^\S\n]+", " ", line).strip() for line in body.split("\n"))
    return "\n".join(line for line in lines if line)


def _speaker_boundaries(lines: list[str]) -> dict[int, tuple[str, str]]:
    """Find the line indexes that start a new speaker turn.

    Two guards keep prose from being mistaken for a transcript: labels inside
    fenced code blocks are ignored (a pasted diff is full of colon lines), and
    the whole document must show at least two distinct speaker roles before any
    boundary is honoured. Failing that guard costs nothing -- the caller keeps
    the text as a single unsegmented turn rather than shredding it.
    """
    candidates: dict[int, tuple[str, str]] = {}
    in_fence = False

    for index, line in enumerate(lines):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = SPEAKER_RE.match(line)
        if not match:
            continue
        name = match.group("name")
        # "a:" / "q:" are common in prose and code; only accept them shouted.
        if len(name) == 1 and not name.isupper():
            continue
        role = normalize_role(name)
        if role == "unknown":
            continue
        candidates[index] = (role, match.group("rest"))

    if len({role for role, _ in candidates.values()}) < 2:
        return {}
    return candidates


def segment_text(text: str) -> tuple[list[dict], str]:
    """Split pasted conversation text into turns.

    Returns (turns, parse_quality). Speaker labels inside fenced code blocks are
    ignored -- a pasted diff or code sample routinely contains lines that would
    otherwise look like a new speaker.
    """
    if not text or not text.strip():
        return [], "empty"

    unwrapped = strip_html_document(text)
    if unwrapped is not None:
        text = unwrapped
        if not text.strip():
            return [], "empty"

    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    boundaries = _speaker_boundaries(lines)

    if not boundaries:
        body = text.strip()
        return (
            [{"turn_id": 1, "role": "unknown", "timestamp": None, "content": body}],
            "unsegmented",
        )

    segments: list[dict] = []
    current: dict | None = None
    preamble: list[str] = []

    for index, line in enumerate(lines):
        boundary = boundaries.get(index)
        if boundary is not None:
            role, rest = boundary
            current = {"role": role, "lines": [rest]}
            segments.append(current)
        elif current is not None:
            current["lines"].append(line)
        else:
            preamble.append(line)

    if "".join(preamble).strip():
        segments.insert(0, {"role": "unknown", "lines": preamble})

    turns: list[dict] = []
    for segment in segments:
        content = "\n".join(segment["lines"]).strip()
        if not content:
            continue
        turns.append(
            {
                "turn_id": len(turns) + 1,
                "role": segment["role"],
                "timestamp": None,
                "content": content,
            }
        )

    if not turns:
        return [], "empty"
    return turns, "heuristic"


def clean_turns(raw_turns: Iterable[dict]) -> list[dict]:
    """Validate and renumber turns produced by a browser-side parser."""
    turns: list[dict] = []
    for raw in raw_turns:
        if not isinstance(raw, dict):
            continue
        content = raw.get("content")
        if isinstance(content, list):  # some exports store content as blocks
            content = "\n\n".join(
                block.get("text", "") if isinstance(block, dict) else str(block)
                for block in content
            )
        content = (content or "").strip()
        if not content:
            continue
        turns.append(
            {
                "turn_id": len(turns) + 1,
                "role": normalize_role(raw.get("role")),
                "timestamp": normalize_timestamp(raw.get("timestamp")),
                "content": content[:MAX_TURN_CHARS],
                # Which model answered can change mid-conversation, so it is
                # kept per turn rather than only on the conversation.
                "model": (raw.get("model") or None),
            }
        )
        if len(turns) >= MAX_TURNS:
            break
    return turns


def content_hash(turns: list[dict]) -> str:
    digest = hashlib.sha256()
    for turn in turns:
        digest.update(turn["role"].encode("utf-8"))
        digest.update(b"\x1f")
        digest.update(turn["content"].encode("utf-8"))
        digest.update(b"\x1e")
    return digest.hexdigest()


def conversation_bounds(turns: list[dict]) -> tuple[str | None, str | None]:
    stamps = sorted(turn["timestamp"] for turn in turns if turn.get("timestamp"))
    if not stamps:
        return None, None
    return stamps[0], stamps[-1]


def build_conversation(
    *,
    platform: str,
    title: str | None,
    source_format: str,
    turns: list[dict],
    parse_quality: str,
    conversation_start: Any = None,
    conversation_end: Any = None,
) -> dict:
    """Assemble the common-format conversation body (timing, hash, counts)."""
    cleaned = clean_turns(turns)
    derived_start, derived_end = conversation_bounds(cleaned)
    return {
        "platform": platform,
        "title": (title or "").strip()[:300] or None,
        "source_format": source_format,
        "parse_quality": parse_quality,
        "conversation_start": normalize_timestamp(conversation_start) or derived_start,
        "conversation_end": normalize_timestamp(conversation_end) or derived_end,
        "turns": cleaned,
        "turn_count": len(cleaned),
        "char_count": sum(len(turn["content"]) for turn in cleaned),
        "content_hash": content_hash(cleaned),
    }
