#!/usr/bin/env python3
"""Load team membership and consent into the research database.

Teams are rebuilt for each project, and a team that changes mid-project becomes a
new instance rather than an edited row. This turns config/roster.csv into that
shape: one team_instances row per instance, and one participant_team_membership
row per (participant, instance) with the window it was true for.

Every student on the roster gets a participant code here, not just the ones who
submitted a log. A teammate who never submitted still has to appear -- their
consent gates whether the team's repository can be collected at all.

    python scripts/sync_roster.py
    python scripts/sync_roster.py --roster config/roster.csv --consent config/consent.csv
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.db import research_db  # noqa: E402
from app.identity import resolve_participant_code  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--roster", default=str(config.ROSTER_CSV))
    parser.add_argument("--consent", default=str(config.CONSENT_CSV))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config.ROSTER_CSV = Path(args.roster)
    config.CONSENT_CSV = Path(args.consent)
    config.roster.cache_clear()
    config.consent.cache_clear()

    rows = config.roster()
    if not rows:
        raise SystemExit(f"No roster rows in {args.roster}. See config/roster.example.csv")

    instances: dict[str, dict] = {}
    for row in rows:
        instance = instances.setdefault(
            row["team_instance_id"],
            {
                "project_id": row["project_id"],
                "team_label": row["team_label"],
                "started_at": row["joined_at"],
                "ended_at": row["left_at"],
                "members": [],
            },
        )
        # The instance spans the earliest join to the latest departure; an open
        # membership leaves the instance open too.
        if row["joined_at"] and (not instance["started_at"] or row["joined_at"] < instance["started_at"]):
            instance["started_at"] = row["joined_at"]
        if not row["left_at"]:
            instance["ended_at"] = None
        elif instance["ended_at"] and row["left_at"] > instance["ended_at"]:
            instance["ended_at"] = row["left_at"]
        instance["members"].append(row)

    consented = 0
    unknown_consent = []
    for email in {row["email"] for row in rows}:
        if config.has_consented(email):
            consented += 1
        else:
            unknown_consent.append(email)

    print(f"roster:   {len(rows)} membership rows across {len(instances)} team instances")
    print(f"consent:  {consented} consented, {len(unknown_consent)} not consented or unrecorded")
    if args.dry_run:
        print("\nDry run: nothing written.")
        return

    codes: dict[str, str] = {}
    with research_db() as conn:
        for instance_id, instance in instances.items():
            conn.execute(
                "INSERT INTO team_instances (team_instance_id, project_id, team_label, "
                "started_at, ended_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(team_instance_id) DO UPDATE SET project_id=excluded.project_id, "
                "team_label=excluded.team_label, started_at=excluded.started_at, "
                "ended_at=excluded.ended_at",
                (
                    instance_id,
                    instance["project_id"],
                    instance["team_label"],
                    instance["started_at"],
                    instance["ended_at"],
                ),
            )
            for member in instance["members"]:
                email = member["email"]
                if email not in codes:
                    codes[email] = resolve_participant_code(email)
                conn.execute(
                    "INSERT INTO participant_team_membership (participant_code, "
                    "team_instance_id, project_id, joined_at, left_at) VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(participant_code, team_instance_id) DO UPDATE SET "
                    "joined_at=excluded.joined_at, left_at=excluded.left_at",
                    (
                        codes[email],
                        instance_id,
                        member["project_id"],
                        member["joined_at"],
                        member["left_at"],
                    ),
                )

        for email, code in codes.items():
            record = config.consent().get(email)
            conn.execute(
                "INSERT INTO participant_consent (participant_code, consented, recorded_at) "
                "VALUES (?, ?, ?) ON CONFLICT(participant_code) DO UPDATE SET "
                "consented=excluded.consented",
                (code, 1 if record else 0, None),
            )

    print(f"\nWrote {len(instances)} team instances and {len(rows)} memberships.")
    print(f"Participant codes now exist for all {len(codes)} roster students.")
    if unknown_consent:
        print(
            f"\n{len(unknown_consent)} student(s) have no recorded consent and are treated as "
            "non-consenting. Any team instance containing one of them will be skipped by "
            "scripts/extract_git.py."
        )


if __name__ == "__main__":
    main()
