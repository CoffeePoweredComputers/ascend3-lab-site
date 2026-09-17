#!/usr/bin/env python3
"""Collect the AI coding-tool logs for one project into a single file to upload.

Claude Code, Codex, Copilot and Cursor have no "export" button: they write
session logs into hidden folders. This gathers the ones belonging to a single repository and
writes one bundle file that the submission page understands.

Only sessions whose working directory is inside the repository you name are
included, so work on other projects is never swept up. Nothing is uploaded --
you get a file, you look at it, you decide.

The bundle lands in <repo>/interaction-logging/, which this script excludes from
git the first time it creates it. Do not commit these: a repository is shared, so
committed conversations are readable by every teammate and stay in the history
afterwards.

    python3 scripts/collect_ai_logs.py --repo ~/cs2114/team12-project2
    python3 scripts/collect_ai_logs.py --repo . --since 2026-10-01 --dry-run

Standard library only: no install step.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BUNDLE_VERSION = 1
DEFAULT_OUTPUT_DIR = "interaction-logging"
HEAD_LINES = 80  # enough to reach the metadata record without reading whole files


def resolve(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def inside(child: str | None, parent: Path) -> bool:
    """True when a session's working directory sits inside the target repo."""
    if not child:
        return False
    try:
        candidate = Path(child).expanduser().resolve()
    except (OSError, ValueError):
        return False
    return candidate == parent or parent in candidate.parents


def git_remote(folder: Path) -> str | None:
    """Read the clone URL from the working folder.

    Claude Code and Copilot record a working directory but not a repository, so
    resolving it here is what lets those sessions be matched to one repository
    rather than only to a team.
    """
    import subprocess

    try:
        result = subprocess.run(
            ["git", "-C", str(folder), "config", "--get", "remote.origin.url"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def ensure_git_ignored(folder: Path) -> bool:
    """Keep collected logs out of git without touching the project's .gitignore.

    A .gitignore inside the folder containing "*" excludes the folder and itself,
    so nothing here can be committed by accident and the student's own ignore
    rules are left alone. This matters more than it looks: a repository is
    shared, so a committed bundle shows every teammate the full text of each
    other's conversations, and deleting it later does not remove it from history.

    Returns whether it created the file, so the caller can say so once.
    """
    marker = folder / ".gitignore"
    if marker.exists():
        return False
    marker.write_text(
        "# Collected AI logs. Everything here is ignored, this file included --\n"
        "# committing these would show your conversations to your teammates.\n"
        "*\n",
        encoding="utf-8",
    )
    return True


def project_dir_name(path: Path) -> str:
    """How Claude Code names a project's session folder.

    It flattens the absolute path, replacing every non-alphanumeric character
    with a hyphen: /Users/me/Projects/app -> -Users-me-Projects-app
    """
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def read_jsonl(path: Path, limit: int | None = None):
    records = []
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for index, line in enumerate(fh):
                if limit is not None and index >= limit:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return records


def newest_timestamp(records: list[dict]) -> str | None:
    stamps = [str(r.get("timestamp")) for r in records if isinstance(r, dict) and r.get("timestamp")]
    return max(stamps) if stamps else None


def vscode_roots() -> list[Path]:
    home = Path.home()
    candidates = [
        home / "Library/Application Support/Code/User/workspaceStorage",
        home / "Library/Application Support/Code - Insiders/User/workspaceStorage",
        home / ".config/Code/User/workspaceStorage",
        home / ".config/Code - Insiders/User/workspaceStorage",
    ]
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "Code/User/workspaceStorage")
    return [path for path in candidates if path.is_dir()]


def find_claude_code(repo: Path) -> list[dict]:
    """~/.claude/projects/<escaped-cwd>/<session>.jsonl"""
    root = Path.home() / ".claude" / "projects"
    if not root.is_dir():
        return []

    # A session that predates a folder move still records the old working
    # directory, but Claude Code re-files it under the new path. Matching the
    # folder name as well as the recorded cwd keeps that history instead of
    # silently dropping everything from before the move.
    expected_dir = project_dir_name(repo)

    sessions = []
    for session_file in sorted(root.glob("*/*.jsonl")):
        head = read_jsonl(session_file, limit=HEAD_LINES)
        cwd = next((r.get("cwd") for r in head if isinstance(r, dict) and r.get("cwd")), None)
        if not inside(cwd, repo) and session_file.parent.name != expected_dir:
            continue
        records = read_jsonl(session_file)
        if not records:
            continue
        branch = next((r.get("gitBranch") for r in records if isinstance(r, dict) and r.get("gitBranch")), None)
        sessions.append(
            {
                "tool": "claude_code",
                "source": session_file.name,
                "path": session_file,
                "records": records,
                "workspace": {
                    "cwd": cwd,
                    "repo_url": None,
                    "branch": branch,
                    "commit_hash": None,
                    "tool_origin": "claude_code",
                },
                "latest": newest_timestamp(records),
            }
        )
    return sessions


def find_codex(repo: Path) -> list[dict]:
    """~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl"""
    root = Path.home() / ".codex" / "sessions"
    if not root.is_dir():
        return []

    sessions = []
    for session_file in sorted(root.rglob("*.jsonl")):
        head = read_jsonl(session_file, limit=5)
        meta = next(
            (r.get("payload") for r in head if isinstance(r, dict) and r.get("type") == "session_meta"),
            None,
        )
        if not isinstance(meta, dict) or not inside(meta.get("cwd"), repo):
            continue
        records = read_jsonl(session_file)
        if not records:
            continue
        git = meta.get("git") or {}
        sessions.append(
            {
                "tool": "codex",
                "source": session_file.name,
                "path": session_file,
                "records": records,
                "workspace": {
                    "cwd": meta.get("cwd"),
                    "repo_url": git.get("repository_url"),
                    "branch": git.get("branch"),
                    "commit_hash": git.get("commit_hash"),
                    "tool_origin": meta.get("originator") or "codex",
                },
                "latest": newest_timestamp(records),
            }
        )
    return sessions


def replay_chat_journal(path: Path) -> dict | None:
    """Rebuild a VS Code chat session from its append-only journal.

    Newer VS Code writes chatSessions/*.jsonl instead of a single JSON object:
    line 0 is a snapshot, and each later line patches it. kind 1 sets the value
    at a key path, kind 2 appends to the list at one. Replaying that yields the
    same shape the older *.json files had, so the browser parser needs no change.
    """
    session: dict | None = None
    for record in read_jsonl(path):
        if not isinstance(record, dict):
            continue
        kind, keys, value = record.get("kind"), record.get("k"), record.get("v")

        if kind == 0 or keys is None:
            if isinstance(value, dict):
                session = value
            continue
        if session is None or not isinstance(keys, list) or not keys:
            continue

        node = session
        try:
            for key in keys[:-1]:
                node = node[key]
            last = keys[-1]
            if kind == 2:
                target = node.get(last) if isinstance(node, dict) else None
                if not isinstance(target, list):
                    target = []
                    node[last] = target
                target.extend(value if isinstance(value, list) else [value])
            else:
                node[last] = value
        except (KeyError, IndexError, TypeError):
            # A patch we cannot place is skipped rather than losing the session.
            continue
    return session


def load_chat_session(path: Path) -> dict | None:
    if path.suffix == ".jsonl":
        return replay_chat_journal(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def find_copilot(repo: Path) -> list[dict]:
    """VS Code keeps chat under workspaceStorage/<hash>/, keyed by workspace.json."""
    sessions = []
    for root in vscode_roots():
        for workspace_file in sorted(root.glob("*/workspace.json")):
            try:
                folder = json.loads(workspace_file.read_text(encoding="utf-8")).get("folder")
            except (OSError, json.JSONDecodeError):
                continue
            if not folder or not folder.startswith("file://"):
                continue
            from urllib.parse import unquote, urlparse

            folder_path = unquote(urlparse(folder).path)
            if not inside(folder_path, repo):
                continue

            chat_dir = workspace_file.parent / "chatSessions"
            for chat_file in sorted(
                [*chat_dir.glob("*.json"), *chat_dir.glob("*.jsonl")]
            ):
                data = load_chat_session(chat_file)
                if not data or not data.get("requests"):
                    continue  # empty session VS Code left behind
                sessions.append(
                    {
                        "tool": "copilot",
                        "source": chat_file.name,
                        "path": chat_file,
                        "records": [data],
                        "workspace": {
                            "cwd": folder_path,
                            "repo_url": None,
                            "branch": None,
                            "commit_hash": None,
                            "tool_origin": "copilot_vscode",
                        },
                        "latest": iso_or_none(
                            data.get("lastMessageDate")
                            or max(
                                (r.get("timestamp") or 0 for r in data["requests"]),
                                default=None,
                            )
                            or data.get("creationDate")
                        ),
                    }
                )
    return sessions



# ---------- Cursor ----------
#
# Cursor keeps one folder per workspace under ~/.cursor/projects, named after
# the flattened workspace path, and writes the transcript as JSONL inside it.
# Unlike the other tools it records no working directory in the file itself, so
# the folder name and the files the session edited are all there is to go on.

CURSOR_SKIP_DIRS = {
    ".git", "node_modules", "venv", ".venv", "env", "__pycache__",
    "build", "dist", "target", "out",
}

CURSOR_EDIT_TOOLS = re.compile(
    r"^(str_?replace|multi_?str_?replace|write|create_?file|edit_?file"
    r"|apply_?patch|search_?replace|delete_?file)",
    re.IGNORECASE,
)

CURSOR_WRITE_KEYS = ("new_string", "content", "contents", "file_text", "replacements")

CURSOR_MONTHS = {
    month: number
    for number, month in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
        start=1,
    )
}

CURSOR_TIMESTAMP_RE = re.compile(
    r"<timestamp>\s*(?:[A-Za-z]+,\s*)?"
    r"(?P<month>[A-Za-z]{3,9})\s+(?P<day>\d{1,2}),\s*(?P<year>\d{4}),?\s*"
    r"(?P<hour>\d{1,2}):(?P<minute>\d{2})\s*(?P<meridiem>[AaPp][Mm])"
    r"(?:\s*\(UTC(?P<sign>[+-])(?P<offset_hours>\d{1,2})(?::?(?P<offset_minutes>\d{2}))?\))?"
)


def cursor_project_name(path: Path) -> str:
    """How Cursor names a workspace's folder under ~/.cursor/projects.

    The same flattening Claude Code uses, without the leading separator:
    /Users/me/Projects/app -> Users-me-Projects-app
    """
    return project_dir_name(path).lstrip("-")


def cursor_workspace_names(repo: Path, max_depth: int = 3) -> set:
    """Folder names Cursor could have used for a workspace in this repository.

    The flattening turns both "/" and "-" into "-", so a name read on its own is
    ambiguous: ~/proj-old and ~/proj/old produce the same one. Generating the
    names from the repository's own folders, rather than pattern-matching the
    ones Cursor left behind, resolves that in the safe direction -- a name we did
    not generate is not ours, and another project is never swept in.
    """
    names = {cursor_project_name(repo)}
    for current, dirs, _files in os.walk(repo):
        try:
            depth = len(Path(current).relative_to(repo).parts)
        except ValueError:
            continue
        if depth >= max_depth:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in CURSOR_SKIP_DIRS]
        for name in dirs:
            names.add(cursor_project_name(Path(current) / name))
    return names


def cursor_timestamp(text: str) -> str | None:
    """Read the <timestamp> tag Cursor puts in front of every student message.

    Cursor writes it for the model to read -- "Friday, Aug 21, 2026, 3:47 PM
    (UTC-4)" -- and stores no machine-readable time anywhere else, so this is the
    only clock the transcript carries. The offset has to be honoured rather than
    assumed: linking a conversation to a commit compares instants, and reading a
    UTC-4 log as though it were local time moves it by hours.
    """
    match = CURSOR_TIMESTAMP_RE.search(text or "")
    if not match:
        return None
    month = CURSOR_MONTHS.get(match.group("month")[:3].lower())
    if not month:
        return None

    hour = int(match.group("hour")) % 12
    if match.group("meridiem").lower() == "pm":
        hour += 12

    zone = timezone.utc
    if match.group("sign"):
        minutes = int(match.group("offset_hours")) * 60 + int(match.group("offset_minutes") or 0)
        zone = timezone(timedelta(minutes=-minutes if match.group("sign") == "-" else minutes))

    try:
        when = datetime(
            int(match.group("year")), month, int(match.group("day")),
            hour, int(match.group("minute")), tzinfo=zone,
        )
    except ValueError:
        return None
    return when.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def cursor_blocks(records, role: str | None = None):
    """Every content block in a transcript, optionally for one role only."""
    for record in records:
        if not isinstance(record, dict):
            continue
        if role and record.get("role") != role:
            continue
        content = (record.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict):
                yield block


def cursor_edit_path(name, payload) -> str | None:
    """The file a Cursor tool call wrote, or None if it only looked.

    Matched on shape as well as on name: Cursor renames its tools between
    versions, but a call carrying replacement text is a write whatever it is
    called, and a call with nothing but a path is a read.
    """
    if not isinstance(payload, dict):
        return None
    path = payload.get("path") or payload.get("file_path") or payload.get("target_file")
    if not isinstance(path, str) or not path:
        return None
    writes = any(key in payload for key in CURSOR_WRITE_KEYS)
    return path if writes or CURSOR_EDIT_TOOLS.match(str(name or "")) else None


def cursor_edited_paths(records) -> list:
    return [
        path
        for block in cursor_blocks(records)
        if block.get("type") == "tool_use"
        for path in [cursor_edit_path(block.get("name"), block.get("input"))]
        if path
    ]


def cursor_latest(records) -> str | None:
    """Cursor stamps only the student's own messages, so those set the span."""
    stamps = [
        stamp
        for block in cursor_blocks(records, role="user")
        if block.get("type") == "text"
        for stamp in [cursor_timestamp(block.get("text") or "")]
        if stamp
    ]
    return max(stamps) if stamps else None


def find_cursor(repo: Path) -> list:
    """~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl"""
    root = Path.home() / ".cursor" / "projects"
    if not root.is_dir():
        return []

    workspaces = cursor_workspace_names(repo)

    sessions = []
    for transcript in sorted(root.glob("*/agent-transcripts/*/*.jsonl")):
        records = read_jsonl(transcript)
        if not records:
            continue
        # Two ways a session qualifies, because the folder name alone is not
        # always enough: it was run with this repository open, or it was run
        # somewhere else and edited files inside it. A session that only *read*
        # a file here is left out -- reading is incidental, editing is not.
        workspace_name = transcript.parent.parent.parent.name
        if workspace_name not in workspaces and not any(
            inside(path, repo) for path in cursor_edited_paths(records)
        ):
            continue
        sessions.append(
            {
                "tool": "cursor",
                "source": transcript.name,
                "path": transcript,
                "records": records,
                "workspace": {
                    # The transcript records no working directory and the folder
                    # name cannot be turned back into one, so this says which
                    # project the logs are being submitted for, which is what the
                    # rest of the pipeline uses it for anyway.
                    "cwd": str(repo),
                    "repo_url": None,
                    "branch": None,
                    "commit_hash": None,
                    "tool_origin": "cursor",
                },
                # Only the student's messages are stamped; if none could be read,
                # when the file was last written is the best remaining evidence.
                "latest": cursor_latest(records) or iso_or_none(transcript.stat().st_mtime * 1000),
            }
        )
    return sessions


def iso_or_none(epoch_ms) -> str | None:
    try:
        return datetime.fromtimestamp(float(epoch_ms) / 1000.0, tz=timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def after_cutoff(session: dict, cutoff: str | None) -> bool:
    if not cutoff:
        return True
    latest = session.get("latest")
    return True if not latest else latest >= cutoff


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--repo", default=".", help="the project folder these logs belong to")
    parser.add_argument("--since", help="only sessions on or after this date (YYYY-MM-DD)")
    parser.add_argument(
        "--out", help=f"where to write the bundle (default: <repo>/{DEFAULT_OUTPUT_DIR}/)"
    )
    parser.add_argument("--dry-run", action="store_true", help="list what would be included, write nothing")
    args = parser.parse_args()

    repo = resolve(args.repo)
    if not repo.is_dir():
        raise SystemExit(f"Not a folder: {repo}")

    sessions = [
        session
        for finder in (find_claude_code, find_codex, find_copilot, find_cursor)
        for session in finder(repo)
        if after_cutoff(session, args.since)
    ]

    origin = git_remote(repo)
    for session in sessions:
        if origin and not session["workspace"].get("repo_url"):
            session["workspace"]["repo_url"] = origin

    print(f"Project folder: {repo}")
    if not sessions:
        print("\nNo AI coding-tool sessions found for this folder.")
        print("If you used a browser or desktop chat app instead, submit that export directly.")
        return

    by_tool: dict[str, list[dict]] = {}
    for session in sessions:
        by_tool.setdefault(session["tool"], []).append(session)

    print("\nFound:")
    for tool, group in sorted(by_tool.items()):
        print(f"  {tool:<12} {len(group)} session(s)")
        for session in group:
            when = (session.get("latest") or "unknown date")[:10]
            print(f"      {when}  {session['source']}")

    if args.dry_run:
        print("\nDry run: nothing written.")
        return

    out_path = (
        Path(args.out).expanduser()
        if args.out
        else repo / DEFAULT_OUTPUT_DIR / f"genai-logs-{repo.name}.jsonl"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    newly_ignored = ensure_git_ignored(out_path.parent)

    lines = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for session in sessions:
            for record in session["records"]:
                fh.write(
                    json.dumps(
                        {
                            "b": "genai-logs",
                            "v": BUNDLE_VERSION,
                            "tool": session["tool"],
                            "source": session["source"],
                            "workspace": session["workspace"],
                            "record": record,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                lines += 1

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"\nWrote {out_path}")
    print(f"  {len(sessions)} session(s), {lines} records, {size_mb:.1f} MB")
    if newly_ignored:
        print(f"  added {out_path.parent.name}/.gitignore so these never reach GitHub")
    print("\nUpload that file on the submission page. You will still choose which")
    print("conversations to include before anything is sent.")


if __name__ == "__main__":
    main()
