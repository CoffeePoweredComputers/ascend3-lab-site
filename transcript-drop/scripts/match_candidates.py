#!/usr/bin/env python3
"""Build candidate links between GenAI conversations and commits (section 12).

Conversations and commits are never forced into a 1:1 relationship. For each
conversation this writes a short ranked list of plausible commits into the
linkages table and a review CSV, leaving `linkage_confidence` empty for a
researcher to fill in.

    python scripts/match_candidates.py --project P2
    python scripts/match_candidates.py --min-score 0.3 --top 5

The report also counts the two asymmetric cases the design calls out: a
conversation with no plausible commit, and a commit with no submitted
conversation nearby -- which is recorded as "not observed", never as "written
without AI".
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import DATA_DIR, project_stages  # noqa: E402
from app.db import research_db  # noqa: E402
from app.matching import (  # noqa: E402
    commit_tokens,
    conversation_tokens,
    normalize_repo_url,
    rank_key,
    score_pair,
    stage_for,
)
from app.timeutil import deadline_to_utc, to_utc  # noqa: E402


def load_conversations(conn, project_id: str | None) -> list[dict]:
    query = "SELECT * FROM conversations"
    params: tuple = ()
    if project_id:
        query += " WHERE project_id = ?"
        params = (project_id,)

    conversations = []
    for row in conn.execute(query, params).fetchall():
        turns = conn.execute(
            "SELECT role, content FROM turns WHERE conversation_id = ? ORDER BY turn_id",
            (row["conversation_id"],),
        ).fetchall()
        conversation = dict(row)
        conversation["turns"] = [dict(turn) for turn in turns]
        # Only agentic tools populate this; chat conversations get an empty list
        # and fall through to the unchanged heuristic path.
        conversation["edits"] = [
            {"path": edit["path"], "occurred_at": to_utc(edit["occurred_at"])}
            for edit in conn.execute(
                "SELECT path, occurred_at FROM conversation_edits "
                "WHERE conversation_id = ? AND change_type != 'context'",
                (row["conversation_id"],),
            ).fetchall()
        ]
        conversations.append(conversation)
    return conversations


def load_commits(conn, project_id: str, team_id: str | None) -> list[dict]:
    """Commits for a team, across every instance of it.

    Scoping is by team label rather than team instance on purpose. The instances
    of one team share a repository and a line of development, so a conversation
    from before a membership change can still relate to a commit from after it.
    Both instances are recorded on the linkage instead, which tells a reviewer
    that the team composition differed without hiding the pair.
    """
    query = "SELECT * FROM commits WHERE project_id = ? AND is_merge = 0"
    params: list = [project_id]
    if team_id:
        query += " AND team_id = ?"
        params.append(team_id)

    commits = []
    for row in conn.execute(query, params).fetchall():
        files = conn.execute(
            "SELECT path, diff FROM commit_files WHERE commit_hash = ?",
            (row["commit_hash"],),
        ).fetchall()
        commit = dict(row)
        commit["files"] = [dict(entry) for entry in files]
        commit["authored_dt"] = to_utc(row["authored_at"])
        commits.append(commit)
    return commits


def in_window(conv_start, conv_end, commit_time, before_minutes, after_minutes) -> bool:
    """Timestamp-less conversations skip the window and rely on content alone."""
    if conv_start is None and conv_end is None:
        return True
    left = (conv_start or conv_end) - timedelta(minutes=before_minutes)
    right = (conv_end or conv_start) + timedelta(minutes=after_minutes)
    return left <= commit_time <= right


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", help="limit to one project id, e.g. P2")
    parser.add_argument("--before", type=int, default=180, help="minutes before the conversation")
    parser.add_argument("--after", type=int, default=2880, help="minutes after the conversation")
    parser.add_argument("--min-score", type=float, default=0.20)
    parser.add_argument("--top", type=int, default=10, help="candidates kept per conversation")
    parser.add_argument("--all-teams", action="store_true",
                        help="score against every team's commits instead of only the "
                             "conversation's own team (useful for calibration)")
    parser.add_argument("--out", default=str(DATA_DIR / "export" / "linkage_review.csv"))
    parser.add_argument("--reset", action="store_true",
                        help="drop candidates that no researcher has reviewed yet, then rebuild")
    args = parser.parse_args()

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    commit_cache: dict[tuple, list[dict]] = {}
    token_cache: dict[str, tuple] = {}
    rows_for_csv: list[dict] = []
    conversations_without_candidates = 0
    linked_commits: set[str] = set()

    with research_db() as conn:
        if args.reset:
            conn.execute("DELETE FROM linkages WHERE linkage_confidence IS NULL")

        conversations = load_conversations(conn, args.project)
        if not conversations:
            print("No conversations found. Has anyone submitted yet?")
            return

        for conversation in conversations:
            project_id = conversation["project_id"]
            team_id = None if args.all_teams else conversation["team_id"]
            cache_key = (project_id, team_id)
            if cache_key not in commit_cache:
                commit_cache[cache_key] = load_commits(conn, project_id, team_id)
            commits = commit_cache[cache_key]

            # An agentic log names the repository it ran against. When the
            # extracted commits also carry a remote URL, that pins the candidate
            # set to one repository instead of the whole team.
            conv_repo = normalize_repo_url(conversation.get("workspace_repo_url"))
            if conv_repo and any(normalize_repo_url(c["repo_url"]) == conv_repo for c in commits):
                commits = [c for c in commits if normalize_repo_url(c["repo_url"]) == conv_repo]

            conv_start = to_utc(conversation["conversation_start"])
            conv_end = to_utc(conversation["conversation_end"])
            conv_tokens = conversation_tokens(conversation["turns"])
            stages = project_stages(project_id)

            scored = []
            for commit in commits:
                commit_time = commit["authored_dt"]
                if commit_time is None:
                    continue
                if not in_window(conv_start, conv_end, commit_time, args.before, args.after):
                    continue

                if commit["commit_hash"] not in token_cache:
                    token_cache[commit["commit_hash"]] = commit_tokens(
                        commit["message"], commit["files"]
                    )

                result = score_pair(
                    conv_tokens=conv_tokens,
                    commit_tok=token_cache[commit["commit_hash"]],
                    conv_start=conv_start,
                    conv_end=conv_end,
                    commit_time=commit_time,
                    author_match=bool(
                        commit["participant_code"]
                        and commit["participant_code"] == conversation["participant_code"]
                    ),
                    edits=conversation["edits"],
                    commit_paths=[entry["path"] for entry in commit["files"]],
                )
                if result["candidate_score"] < args.min_score:
                    continue
                result["commit"] = commit
                result["stage"] = stage_for(commit_time, stages, deadline_to_utc)
                scored.append(result)

            scored.sort(key=rank_key, reverse=True)
            scored = scored[: args.top]
            if not scored:
                conversations_without_candidates += 1
                continue

            for result in scored:
                commit = result["commit"]
                linked_commits.add(commit["commit_hash"])
                shared = " ".join(result["shared_tokens"])
                matched = " ".join(result["matched_paths"])
                conn.execute(
                    "INSERT INTO linkages (conversation_id, commit_hash, candidate_score, "
                    "time_score, content_score, artifact_score, matched_paths, author_match, "
                    "time_delta_minutes, stage, shared_tokens, auto_band, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(conversation_id, commit_hash) DO UPDATE SET "
                    "candidate_score=excluded.candidate_score, time_score=excluded.time_score, "
                    "content_score=excluded.content_score, artifact_score=excluded.artifact_score, "
                    "matched_paths=excluded.matched_paths, author_match=excluded.author_match, "
                    "time_delta_minutes=excluded.time_delta_minutes, stage=excluded.stage, "
                    "shared_tokens=excluded.shared_tokens, auto_band=excluded.auto_band",
                    (
                        conversation["conversation_id"],
                        commit["commit_hash"],
                        result["candidate_score"],
                        result["time_score"],
                        result["content_score"],
                        result["artifact_score"],
                        matched,
                        int(result["author_match"]),
                        result["time_delta_minutes"],
                        result["stage"],
                        shared,
                        result["auto_band"],
                        now,
                    ),
                )
                rows_for_csv.append(
                    {
                        "conversation_id": conversation["conversation_id"],
                        "participant_code": conversation["participant_code"],
                        "team_id": conversation["team_id"],
                        "conversation_team_instance": conversation["team_instance_id"],
                        "commit_team_instance": commit["team_instance_id"],
                        "same_team_instance": int(
                            bool(conversation["team_instance_id"])
                            and conversation["team_instance_id"] == commit["team_instance_id"]
                        ),
                        "team_assignment": conversation["team_assignment"],
                        "project_id": project_id,
                        "stage": result["stage"],
                        "platform": conversation["platform"],
                        "conversation_title": conversation["title"],
                        "primary_purpose": conversation["primary_purpose"],
                        "reported_change": conversation["reported_change"],
                        "conversation_start": conversation["conversation_start"],
                        "commit_hash": commit["commit_hash"][:10],
                        "commit_authored_at": commit["authored_at"],
                        "commit_message": (commit["message"] or "").splitlines()[0][:120],
                        "files_changed": commit["files_changed"],
                        "candidate_score": result["candidate_score"],
                        "time_score": result["time_score"],
                        "content_score": result["content_score"],
                        "artifact_score": result["artifact_score"],
                        "matched_paths": matched,
                        "author_match": int(result["author_match"]),
                        "time_known": int(result["time_known"]),
                        "time_delta_minutes": result["time_delta_minutes"],
                        "auto_band": result["auto_band"],
                        "shared_tokens": shared,
                        "linkage_confidence": "",
                        "change_type": "",
                        "notes": "",
                    }
                )

        total_commits = sum(len(value) for value in commit_cache.values())
        unlinked_commits = total_commits - len(linked_commits)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if rows_for_csv:
        with out_path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(rows_for_csv[0].keys()))
            writer.writeheader()
            writer.writerows(rows_for_csv)

    print(f"conversations scored:            {len(conversations)}")
    print(f"candidate links written:         {len(rows_for_csv)}")
    print(f"conversations with no candidate: {conversations_without_candidates}")
    print(f"commits with no candidate link:  {unlinked_commits}")
    print("  (these are 'no corresponding GenAI interaction observed in the")
    print("   submitted logs', not evidence the work was done without AI)")
    if rows_for_csv:
        print(f"\nreview file: {out_path}")


if __name__ == "__main__":
    main()
