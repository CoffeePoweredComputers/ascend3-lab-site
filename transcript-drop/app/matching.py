"""Candidate scoring for GenAI conversation <-> commit linkage (section 12).

Nothing here decides that a conversation caused a commit. It narrows thousands
of (conversation, commit) pairs down to a handful a researcher can actually look
at, using the three signals the two data sources genuinely share: the same
participant/team/project scope, nearby timestamps, and overlapping identifiers.

The output is deliberately a ranked candidate list with separate sub-scores, so
a reviewer can see *why* a pair surfaced before judging it.
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Iterable

CODE_EXTENSIONS = (
    "java|py|js|jsx|ts|tsx|c|cc|cpp|h|hpp|cs|rb|go|rs|kt|swift|scala|"
    "html|css|scss|md|xml|json|yml|yaml|sql|sh|txt|gradle|properties"
)

FILENAME_RE = re.compile(rf"\b([\w\-]+)\.({CODE_EXTENSIONS})\b", re.IGNORECASE)
CAMEL_RE = re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b")
SNAKE_RE = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b")
CALL_RE = re.compile(r"\b([A-Za-z_]\w{2,})\s*\(")
PATH_SPLIT_RE = re.compile(r"[/\\]")

# Tokens that appear in nearly every Java conversation and every Java diff.
# Keeping them would make every pair look related.
STOPWORDS = {
    "public", "private", "protected", "static", "final", "void", "class",
    "interface", "extends", "implements", "import", "package", "return",
    "this", "super", "new", "null", "true", "false", "string", "integer",
    "boolean", "double", "float", "char", "long", "object", "system",
    "println", "printf", "print", "args", "main", "override", "param",
    "params", "throws", "throw", "try", "catch", "finally", "exception",
    "length", "size", "tostring", "equals", "hashcode", "getclass",
    "for", "while", "if", "else", "int", "src", "com", "org", "java",
    "test", "tests", "assert", "asserttrue", "assertequals", "junit",
}


def _keep(token: str) -> bool:
    token = token.lower()
    return len(token) >= 3 and token not in STOPWORDS


def extract_identifiers(text: str) -> set[str]:
    """Pull the identifier-ish tokens out of prose, code, or a diff."""
    if not text:
        return set()
    tokens: set[str] = set()
    for match in CAMEL_RE.finditer(text):
        tokens.add(match.group(0).lower())
    for match in SNAKE_RE.finditer(text):
        tokens.add(match.group(0).lower())
    for match in CALL_RE.finditer(text):
        tokens.add(match.group(1).lower())
    return {token for token in tokens if _keep(token)}


def extract_filenames(text: str) -> set[str]:
    """File-level tokens: both "inputvalidator.java" and its stem."""
    if not text:
        return set()
    tokens: set[str] = set()
    for match in FILENAME_RE.finditer(text):
        stem, extension = match.group(1).lower(), match.group(2).lower()
        tokens.add(f"{stem}.{extension}")
        if _keep(stem):
            tokens.add(stem)
    return tokens


def conversation_tokens(turns: list[dict]) -> tuple[set[str], set[str]]:
    text = "\n".join(turn.get("content", "") for turn in turns)
    return extract_identifiers(text), extract_filenames(text)


def commit_tokens(message: str, files: list[dict]) -> tuple[set[str], set[str]]:
    """Identifiers from the message and changed lines; paths from file names.

    Only added and removed lines count, not diff context: unchanged surrounding
    code says nothing about what this commit was actually about.
    """
    identifiers = extract_identifiers(message or "")
    paths = extract_filenames(message or "")

    for entry in files:
        path = entry.get("path") or ""
        paths |= extract_filenames(path)
        for segment in PATH_SPLIT_RE.split(path):
            stem = re.sub(rf"\.({CODE_EXTENSIONS})$", "", segment, flags=re.IGNORECASE)
            if _keep(stem):
                paths.add(stem.lower())

        diff = entry.get("diff") or ""
        changed = "\n".join(
            line[1:]
            for line in diff.splitlines()
            if line[:1] in "+-" and not line.startswith(("+++", "---"))
        )
        identifiers |= extract_identifiers(changed)
        paths |= extract_filenames(changed)

    return identifiers, paths


def _saturate(count: int, k: float) -> float:
    """Diminishing returns: the first shared token matters far more than the tenth."""
    return count / (count + k) if count > 0 else 0.0


def content_score(
    conversation: tuple[set[str], set[str]],
    commit: tuple[set[str], set[str]],
) -> tuple[float, list[str]]:
    """Overlap between what the conversation talked about and what the commit did.

    Scores are relative, not probabilities: a genuinely strong pair (the
    conversation names the class, the commit creates the file) lands around
    0.5-0.7, and only near-identical vocabulary approaches 1.0. What matters is
    the gap between a real pair and an unrelated one, which is close to zero.
    """
    conv_ids, conv_paths = conversation
    commit_ids, commit_paths = commit

    shared_ids = conv_ids & commit_ids
    # A file named in the conversation and touched by the commit is the single
    # strongest content signal, so paths are scored separately from identifiers
    # and the first shared path already carries most of that term's weight.
    shared_paths = (conv_paths | conv_ids) & commit_paths

    path_component = 0.0 if not shared_paths else 0.5 + 0.5 * _saturate(len(shared_paths) - 1, 1.0)
    id_component = _saturate(len(shared_ids), 2.0)

    score = 0.55 * path_component + 0.45 * id_component
    shared = sorted(shared_paths) + sorted(shared_ids - shared_paths)
    return min(1.0, score), shared[:20]


def normalize_repo_url(url: str | None) -> str | None:
    """Reduce a clone URL to host/owner/name so SSH and HTTPS forms compare equal."""
    if not url:
        return None
    text = str(url).strip()
    text = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", text)
    text = re.sub(r"^[^@/]+@", "", text)  # git@github.com:owner/repo
    text = text.replace(":", "/", 1) if "/" not in text.split(":", 1)[0] else text
    text = re.sub(r"\.git$", "", text.rstrip("/"))
    return text.lower() or None


def shared_edit_paths(edit_paths: Iterable[str], commit_paths: Iterable[str]) -> set[str]:
    """Commit files that an agentic tool recorded itself editing.

    Tools log absolute paths ("/Users/x/proj/app/db.py") while git records
    repository-relative ones ("app/db.py"), so a commit path counts as matched
    when it is a whole trailing path segment of an edited path. Comparing only
    basenames would collide on every Main.java in the course.
    """
    normalised = [str(path).replace("\\", "/").lower().lstrip("./") for path in edit_paths if path]
    matched = set()
    for commit_path in commit_paths:
        target = str(commit_path).replace("\\", "/").lower()
        for edited in normalised:
            if edited == target or edited.endswith("/" + target):
                matched.add(commit_path)
                break
    return matched


def artifact_score(edit_paths: Iterable[str], commit_paths: Iterable[str]) -> tuple[float, list[str]]:
    """How much of this commit the AI is recorded as having written.

    This is evidence, not inference: it comes from the tool's own log of what it
    edited. One matched file already carries most of the weight; the rest scales
    with how much of the commit that accounts for.
    """
    commit_paths = list(commit_paths)
    if not commit_paths:
        return 0.0, []
    matched = shared_edit_paths(edit_paths, commit_paths)
    if not matched:
        return 0.0, []
    coverage = len(matched) / len(commit_paths)
    return min(1.0, 0.6 + 0.4 * coverage), sorted(matched)


def edits_before(edits: Iterable, commit_time: datetime | None) -> list[str]:
    """Paths the AI is recorded as writing *before* a commit was authored.

    An edit logged after a commit cannot have produced it, so counting it would
    let a conversation claim credit for work that already existed. Edits with no
    timestamp are kept: some tools record only that a file was involved, and
    dropping those would lose real evidence rather than filter noise.

    Accepts plain paths as well as {path, occurred_at} entries.
    """
    paths = []
    for edit in edits:
        if isinstance(edit, str):
            paths.append(edit)
            continue
        path = edit.get("path")
        if not path:
            continue
        when = edit.get("occurred_at")
        if when is None or commit_time is None or when <= commit_time:
            paths.append(path)
    return paths


def time_delta_minutes(
    start: datetime | None, end: datetime | None, commit_time: datetime
) -> float | None:
    """Signed minutes from the conversation to the commit; 0 while overlapping."""
    if start is None and end is None:
        return None
    left = start or end
    right = end or start
    if commit_time < left:
        return (commit_time - left).total_seconds() / 60.0
    if commit_time > right:
        return (commit_time - right).total_seconds() / 60.0
    return 0.0


def time_score(delta_minutes: float | None, tau_after_h: float = 8.0, tau_before_h: float = 3.0) -> float:
    """Decay with distance, faster for commits that precede the conversation.

    A commit made after the conversation can plausibly contain its suggestion; a
    commit made before it can only have prompted the question, so it decays out
    of the running more sharply.
    """
    if delta_minutes is None:
        return 0.0
    hours = abs(delta_minutes) / 60.0
    tau = tau_after_h if delta_minutes >= 0 else tau_before_h
    return math.exp(-hours / tau)


BAND_RANK = {"direct": 3, "high": 2, "moderate": 1, "weak": 0}


def rank_key(result: dict) -> tuple[int, float, float]:
    """Sort key for review triage: band, then evidence, then score.

    Ranking on the raw score alone would let a well-scoring guess outrank a
    recorded edit, and the per-conversation `--top` cut would then discard the
    one candidate that is not a guess. Within the "direct" band the combined
    score saturates, so how much of the commit the AI actually wrote is the
    more informative tiebreak.
    """
    return (
        BAND_RANK.get(result.get("auto_band", "weak"), 0),
        result.get("artifact_score", 0.0),
        result.get("candidate_score", 0.0),
    )


def band(score: float, content: float, artifact: float = 0.0) -> str:
    """Bucket a candidate for review triage.

    "direct" is a different kind of claim from the rest: the tool itself logged
    editing a file this commit changed, so the link is recorded rather than
    inferred. Everything below it is a heuristic ranking.

    Content overlap gates the remaining upper bands on purpose. Being made by
    the same student on the same afternoon is not evidence about a specific
    commit -- every conversation is near *some* commit -- so a pair with nothing
    in common but timing stays "weak" no matter how close the timestamps are.
    """
    if artifact > 0.0:
        return "direct"
    if content <= 0.0:
        return "weak"
    if score >= 0.60:
        return "high"
    if score >= 0.40:
        return "moderate"
    return "weak"


def score_pair(
    *,
    conv_tokens: tuple[set[str], set[str]],
    commit_tok: tuple[set[str], set[str]],
    conv_start: datetime | None,
    conv_end: datetime | None,
    commit_time: datetime,
    author_match: bool,
    edits: Iterable = (),
    commit_paths: Iterable[str] = (),
) -> dict:
    """Combine the signals into one candidate score.

    Conversations pasted without timestamps are common, so timing is not
    required. When it is missing the weight is redistributed onto content rather
    than assumed, and `time_known` is recorded so a reviewer can tell the two
    kinds of candidate apart instead of comparing scores that mean different
    things.
    """
    delta = time_delta_minutes(conv_start, conv_end, commit_time)
    time_component = time_score(delta)
    content_component, shared = content_score(conv_tokens, commit_tok)
    author_component = 1.0 if author_match else 0.0

    if delta is None:
        total = 0.75 * content_component + 0.25 * author_component
    else:
        total = 0.50 * time_component + 0.35 * content_component + 0.15 * author_component

    # Logged edits are added on top rather than folded into the weights, so a
    # chat-tool conversation scores exactly as it did before this existed. Only
    # edits that precede the commit count, so "direct" cannot be claimed
    # backwards in time.
    artifact_component, matched_paths = artifact_score(
        edits_before(edits, commit_time), commit_paths
    )
    total = min(1.0, total + 0.35 * artifact_component)

    return {
        "candidate_score": round(total, 4),
        "time_score": round(time_component, 4),
        "content_score": round(content_component, 4),
        "artifact_score": round(artifact_component, 4),
        "author_match": author_component == 1.0,
        "time_delta_minutes": None if delta is None else round(delta, 1),
        "time_known": delta is not None,
        "shared_tokens": shared,
        "matched_paths": matched_paths,
        "auto_band": band(total, content_component, artifact_component),
    }


def stage_for(commit_time: datetime, stages: list[dict], deadline_to_utc) -> str | None:
    """Which project stage a commit falls in: the first deadline it precedes."""
    for stage in stages:
        cutoff = deadline_to_utc(str(stage["deadline"]))
        if cutoff and commit_time <= cutoff:
            return stage["key"]
    return "POST_FINAL" if stages else None
