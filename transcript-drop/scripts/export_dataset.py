#!/usr/bin/env python3
"""Export the linked dataset for analysis (section 15).

    python scripts/export_dataset.py --out data/export

Writes participant-coded CSVs plus one JSONL file per conversation-with-turns.
Conversation text is excluded unless --include-content is passed, so the default
export can be shared with collaborators who do not need the raw transcripts.
No file produced here contains a student ID.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.config import DATA_DIR  # noqa: E402
from app.db import research_db  # noqa: E402
from app.identity import participant_code_for  # noqa: E402

TABLE_QUERIES = {
    "submissions": "SELECT * FROM submissions ORDER BY submitted_at",
    "conversations": (
        "SELECT conversation_id, submission_id, participant_code, project_id, team_id, "
        "team_instance_id, team_assignment, "
        "platform, platform_other, title, source_format, parse_quality, primary_purpose, "
        "reported_change, conversation_start, conversation_end, turn_count, char_count "
        "FROM conversations ORDER BY project_id, participant_code"
    ),
    "commits": (
        "SELECT commit_hash, repo, team_id, team_instance_id, project_id, participant_code, author_name, "
        "authored_at, committed_at, branches, is_merge, files_changed, insertions, deletions, "
        "REPLACE(message, char(10), ' ') AS message FROM commits ORDER BY project_id, authored_at"
    ),
    "commit_files": (
        "SELECT commit_hash, path, old_path, change_type, insertions, deletions "
        "FROM commit_files ORDER BY commit_hash, path"
    ),
    "stage_snapshots": "SELECT * FROM stage_snapshots ORDER BY project_id, team_id, stage",
    "team_instances": "SELECT * FROM team_instances ORDER BY project_id, team_label, started_at",
    # The membership table is the temporal join: who was on which team, when.
    "participant_team_membership": (
        "SELECT m.*, t.team_label FROM participant_team_membership m "
        "JOIN team_instances t ON t.team_instance_id = m.team_instance_id "
        "ORDER BY m.project_id, m.team_instance_id, m.participant_code"
    ),
    "participant_consent": "SELECT * FROM participant_consent ORDER BY participant_code",
    "linkages": (
        "SELECT l.*, c.participant_code, c.project_id, c.team_id, c.platform, "
        "c.primary_purpose, c.reported_change FROM linkages l "
        "JOIN conversations c ON c.conversation_id = l.conversation_id "
        "ORDER BY l.candidate_score DESC"
    ),
}


def write_csv(rows, path: Path) -> int:
    if not rows:
        path.write_text("", encoding="utf-8")
        return 0
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(dict(row))
    return len(rows)


def staff_participant_codes() -> set:
    """Participant codes belonging to the admin accounts.

    They walked the real flow to check it worked, so their submissions look like
    anyone else's in the database. They are not research data, and the export is
    the last place to catch that -- a test conversation in the published corpus
    is not a mistake anyone notices later.
    """
    codes = set()
    for email in config.admins():
        code = participant_code_for(email)
        if code:
            codes.add(code)
    return codes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(DATA_DIR / "export"))
    parser.add_argument("--include-content", action="store_true",
                        help="also write conversations.jsonl with every turn's text")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    staff = staff_participant_codes()
    if staff:
        print(f"excluding {len(staff)} staff account(s) from the export\n")

    with research_db() as conn:
        for name, query in TABLE_QUERIES.items():
            rows = [
                row
                for row in (dict(r) for r in conn.execute(query).fetchall())
                if row.get("participant_code") not in staff
            ]
            count = write_csv(rows, out_dir / f"{name}.csv")
            print(f"{name:<16} {count:>6} rows")

        if args.include_content:
            path = out_dir / "conversations.jsonl"
            written = 0
            with path.open("w", encoding="utf-8") as fh:
                for row in conn.execute("SELECT * FROM conversations").fetchall():
                    conversation = dict(row)
                    if conversation.get("participant_code") in staff:
                        continue
                    conversation["turns"] = [
                        dict(turn)
                        for turn in conn.execute(
                            "SELECT turn_id, role, timestamp, content FROM turns "
                            "WHERE conversation_id = ? ORDER BY turn_id",
                            (row["conversation_id"],),
                        ).fetchall()
                    ]
                    fh.write(json.dumps(conversation, ensure_ascii=False) + "\n")
                    written += 1
            print(f"{'conversations.jsonl':<16} {written:>6} records (includes raw text)")

    print(f"\nWritten to {out_dir}")


if __name__ == "__main__":
    main()
