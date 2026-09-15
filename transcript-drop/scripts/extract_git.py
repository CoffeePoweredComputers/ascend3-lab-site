#!/usr/bin/env python3
"""Researcher-side git extraction (sections 10 and 11).

Students install nothing and submit no commits: after the semester the research
team points this script at the course repositories and it pulls commit metadata,
per-file diffs, and the per-stage snapshots out of git itself.

    python scripts/extract_git.py --repos config/repos.csv
    python scripts/extract_git.py --repo ~/archive/team12 --team T12 --project P2

repos.csv columns: team_id,project_id,repo[,name]
  Optional. Without it, the repositories students submitted through the
  portal are used instead; the file is for archives and local checkouts.
  repo is a local path or a clone URL; URLs are mirrored into data/repos/.
  team_id is the team label ("T08"); each commit is attributed to whichever
  instance of that team was in force when it was authored.

A repository is collected only when every member of every instance of that team
has consented, because one repository mixes several students' work. Run
scripts/sync_roster.py first so that membership and consent are on record.

authors.csv columns: author_email,email
  Only for git identities that are not the student's VT email -- a commit
  authored from that address resolves on its own, since it is what identifies a
  participant. Commits from an address neither route resolves are still stored,
  just without a participant code.
"""

from __future__ import annotations

import argparse
import csv
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.config import CONFIG_DIR, DATA_DIR, course_config, project_stages  # noqa: E402
from app.db import research_db  # noqa: E402
from app.identity import participant_code_for  # noqa: E402
from app.timeutil import deadline_to_utc, to_utc  # noqa: E402

RECORD_SEP = "\x1e"
FIELD_SEP = "\x1f"
DIFF_HEADER_RE = re.compile(r'^diff --git "?a/(?P<a>.+?)"? "?b/(?P<b>.+?)"?$')


def run_git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        errors="replace",
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed in {repo}: {result.stderr.strip()}")
    return result.stdout


def ensure_repo(source: str, workdir: Path, name: str) -> Path:
    """Return a local repo path, mirroring the remote first if needed."""
    local = Path(source).expanduser()
    if local.exists():
        return local

    workdir.mkdir(parents=True, exist_ok=True)
    target = workdir / f"{name}.git"
    if target.exists():
        print(f"  refreshing mirror {target}")
        subprocess.run(["git", "-C", str(target), "fetch", "--all", "--prune"], check=True)
        return target

    print(f"  cloning {source} -> {target}")
    subprocess.run(["git", "clone", "--mirror", source, str(target)], check=True)
    return target


def remote_url(repo: Path) -> str | None:
    """The origin URL, so agentic logs that record a repo URL can be matched."""
    url = run_git(repo, "config", "--get", "remote.origin.url", check=False).strip()
    return url or None


def branch_map(repo: Path) -> dict[str, list[str]]:
    """hash -> branches containing it, built with one rev-list per branch."""
    listing = run_git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes")
    mapping: dict[str, list[str]] = {}
    for branch in [line.strip() for line in listing.splitlines() if line.strip()]:
        if branch.endswith("/HEAD"):
            continue
        for commit_hash in run_git(repo, "rev-list", branch, check=False).split():
            mapping.setdefault(commit_hash, []).append(branch)
    return mapping


def parse_log(repo: Path) -> list[dict]:
    """One pass over every reachable commit, with numstat file counts."""
    pretty = FIELD_SEP.join(["%H", "%an", "%ae", "%aI", "%cI", "%P", "%s", "%b"])
    raw = run_git(
        repo,
        "log",
        "--all",
        "--numstat",
        "-M",
        f"--pretty=format:{RECORD_SEP}{pretty}",
    )

    commits: list[dict] = []
    for chunk in raw.split(RECORD_SEP):
        if not chunk.strip():
            continue
        header, _, body = chunk.partition("\n")
        fields = header.split(FIELD_SEP)
        if len(fields) < 7:
            continue
        commit_hash, author_name, author_email, authored, committed, parents, subject = fields[:7]
        message_body = fields[7] if len(fields) > 7 else ""

        files = []
        for line in body.splitlines():
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            added, deleted, path = parts
            files.append(
                {
                    "path": path.strip(),
                    "insertions": 0 if added == "-" else int(added),
                    "deletions": 0 if deleted == "-" else int(deleted),
                }
            )

        commits.append(
            {
                "commit_hash": commit_hash,
                "author_name": author_name,
                "author_email": author_email.lower(),
                "authored_at": authored,
                "committed_at": committed,
                "is_merge": len(parents.split()) > 1,
                "message": (subject + ("\n" + message_body if message_body.strip() else "")).strip(),
                "files": files,
            }
        )
    return commits


def parse_diffs(repo: Path, commit_hash: str, max_bytes: int) -> dict[str, dict]:
    """Per-file diff text and change type for one commit."""
    raw = run_git(
        repo,
        "show",
        "--format=",
        "-M",
        "--unified=2",
        "--no-color",
        commit_hash,
        check=False,
    )
    if not raw:
        return {}

    per_file: dict[str, dict] = {}
    current: dict | None = None
    for line in raw.splitlines():
        header = DIFF_HEADER_RE.match(line)
        if header:
            path = header.group("b")
            current = {"path": path, "old_path": None, "change_type": "M", "lines": []}
            per_file[path] = current
            continue
        if current is None:
            continue
        if line.startswith("new file mode"):
            current["change_type"] = "A"
        elif line.startswith("deleted file mode"):
            current["change_type"] = "D"
        elif line.startswith("rename from "):
            current["change_type"] = "R"
            current["old_path"] = line[len("rename from ") :]
        current["lines"].append(line)

    for entry in per_file.values():
        text = "\n".join(entry["lines"])
        entry["diff"] = text[:max_bytes]
        entry.pop("lines")
    return per_file


def participant_for_author(author_map: dict, author_email: str) -> str | None:
    """Who wrote a commit, preferring the address git already recorded.

    Participants are identified by their VT email, and most students commit from
    it, so the commit resolves on its own with no mapping file involved. The
    override table is consulted first all the same: an entry there is an explicit
    statement by the researcher, and should win over the inference.
    """
    address = (author_email or "").strip().lower()
    if not address:
        return None
    return author_map.get(address) or participant_code_for(address)


def load_author_map(path: Path) -> dict[str, str]:
    """author_email -> participant code, resolved through the identity database.

    Only needed for addresses that are not the student's VT email. Since a
    participant is identified by that email, a commit authored from it resolves
    directly; this file covers the rest -- GitHub noreply aliases and personal
    addresses left in a local git config.
    """
    if not path.exists():
        return {}
    mapping: dict[str, str] = {}
    unresolved: list[str] = []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            author = (row.get("author_email") or "").strip().lower()
            email = (row.get("email") or "").strip().lower()
            if not author or not email:
                continue
            code = participant_code_for(email)
            if code:
                mapping[author] = code
            else:
                unresolved.append(author)
    if unresolved:
        print(
            f"  note: {len(unresolved)} author email(s) map to students who never "
            "submitted a GenAI log; their commits are stored without a participant code."
        )
    return mapping


def team_instances_for(conn, project_id: str, team_label: str) -> list[dict]:
    """Every instance of one team, oldest first. A mid-project change makes two."""
    rows = conn.execute(
        "SELECT * FROM team_instances WHERE project_id = ? AND team_label = ? "
        "ORDER BY COALESCE(started_at, '')",
        (project_id, team_label),
    ).fetchall()
    return [dict(row) for row in rows]


def consent_blockers(conn, instances: list[dict]) -> list[str]:
    """Participants on this team who have not consented.

    A repository mixes several students' work, so one non-consenting member is
    enough to keep the whole repository out: collecting it would pull in their
    code, commit messages and design decisions too. This is checked across every
    instance of the team, since a member who left mid-project still authored part
    of the history.
    """
    if not instances:
        return []
    placeholders = ",".join("?" for _ in instances)
    rows = conn.execute(
        f"""SELECT m.participant_code
              FROM participant_team_membership m
              LEFT JOIN participant_consent c ON c.participant_code = m.participant_code
             WHERE m.team_instance_id IN ({placeholders})
               AND COALESCE(c.consented, 0) = 0""",
        [instance["team_instance_id"] for instance in instances],
    ).fetchall()
    return sorted({row["participant_code"] for row in rows})


def instance_at(instances: list[dict], when) -> str | None:
    """Which instance of the team was in force when a commit was authored.

    Instances are ordered, so the answer is the last one that had started by
    then. A commit that predates every instance -- setup work before the roster
    window opened -- belongs to the first instance rather than the last; falling
    through to the newest would attribute early history to a team that did not
    exist yet.
    """
    if not instances:
        return None
    if when is None:
        return instances[-1]["team_instance_id"]

    chosen = None
    for instance in instances:
        started = to_utc(instance.get("started_at"))
        if started is None or started <= when:
            chosen = instance["team_instance_id"]
    return chosen or instances[0]["team_instance_id"]


def store_repo(
    repo: Path,
    repo_name: str,
    team_id: str,
    project_id: str,
    author_map: dict[str, str],
    max_diff_bytes: int,
    with_diffs: bool,
) -> int:
    commits = parse_log(repo)
    branches = branch_map(repo)
    origin = remote_url(repo)
    team_label = config.team_label_of(team_id, project_id)

    with research_db() as conn:
        instances = team_instances_for(conn, project_id, team_label)
        for commit in commits:
            diffs = (
                parse_diffs(repo, commit["commit_hash"], max_diff_bytes)
                if with_diffs and not commit["is_merge"]
                else {}
            )
            conn.execute(
                "INSERT OR REPLACE INTO commits (commit_hash, repo, repo_url, team_instance_id, "
                "team_id, project_id, "
                "participant_code, author_name, author_email, authored_at, committed_at, "
                "message, branches, is_merge, files_changed, insertions, deletions) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    commit["commit_hash"],
                    repo_name,
                    origin,
                    instance_at(instances, to_utc(commit["authored_at"])),
                    team_id,
                    project_id,
                    participant_for_author(author_map, commit["author_email"]),
                    commit["author_name"],
                    commit["author_email"],
                    commit["authored_at"],
                    commit["committed_at"],
                    commit["message"],
                    ",".join(branches.get(commit["commit_hash"], [])),
                    int(commit["is_merge"]),
                    len(commit["files"]),
                    sum(f["insertions"] for f in commit["files"]),
                    sum(f["deletions"] for f in commit["files"]),
                ),
            )
            conn.execute("DELETE FROM commit_files WHERE commit_hash = ?", (commit["commit_hash"],))
            for file_entry in commit["files"]:
                detail = diffs.get(file_entry["path"], {})
                conn.execute(
                    "INSERT OR REPLACE INTO commit_files (commit_hash, path, old_path, "
                    "change_type, insertions, deletions, diff) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        commit["commit_hash"],
                        file_entry["path"],
                        detail.get("old_path"),
                        detail.get("change_type", "M"),
                        file_entry["insertions"],
                        file_entry["deletions"],
                        detail.get("diff"),
                    ),
                )
    return len(commits)


def record_stage_snapshots(repo_name: str, team_id: str, project_id: str) -> int:
    """Freeze the state of each project stage at its deadline (section 11).

    The snapshot is the last commit authored at or before the deadline, which is
    what turns a flat commit list into P2_SPEC / P2_PROTOTYPE / P2_FINAL states.
    """
    stages = project_stages(project_id)
    if not stages:
        return 0

    with research_db() as conn:
        rows = conn.execute(
            "SELECT commit_hash, authored_at FROM commits "
            "WHERE repo = ? AND team_id = ? AND project_id = ?",
            (repo_name, team_id, project_id),
        ).fetchall()
        dated = sorted(
            (
                (authored_at, row["commit_hash"])
                for row in rows
                if (authored_at := to_utc(row["authored_at"])) is not None
            ),
            key=lambda pair: pair[0],
        )

        written = 0
        for stage in stages:
            cutoff = deadline_to_utc(str(stage["deadline"]))
            latest = None
            for authored_at, commit_hash in dated:
                if cutoff and authored_at <= cutoff:
                    latest = commit_hash
                else:
                    break
            conn.execute(
                "INSERT OR REPLACE INTO stage_snapshots (project_id, stage, team_id, repo, "
                "deadline, commit_hash) VALUES (?, ?, ?, ?, ?, ?)",
                (project_id, stage["key"], team_id, repo_name, str(stage["deadline"]), latest),
            )
            written += 1
    return written


def repos_from_submissions() -> list:
    """The repositories students handed in, one per team per project."""
    with research_db() as conn:
        rows = conn.execute(
            "SELECT project_id, team_id, repo_url FROM team_repositories "
            "ORDER BY project_id, team_id"
        ).fetchall()
    return [
        {
            "repo": row["repo_url"],
            "team_id": row["team_id"],
            "project_id": row["project_id"],
            "name": f"{row['team_id'].lower()}-{row['project_id'].lower()}",
        }
        for row in rows
    ]


def repo_targets(args: argparse.Namespace) -> list[dict]:
    if args.repo:
        if not (args.team and args.project):
            raise SystemExit("--repo also needs --team and --project")
        name = args.name or Path(args.repo).expanduser().name
        return [{"repo": args.repo, "team_id": args.team, "project_id": args.project, "name": name}]

    path = Path(args.repos)
    if not path.exists():
        # Students hand their repository in through the portal, so the usual
        # case is that nobody maintains repos.csv at all. Fall back to what they
        # submitted rather than making the researcher transcribe it.
        submitted = repos_from_submissions()
        if submitted:
            print(f"  {path} not found; using {len(submitted)} repositories handed in by students")
            return submitted
        raise SystemExit(
            f"{path} not found, and no repositories have been submitted. "
            "See config/repos.example.csv"
        )

    targets = []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            source = (row.get("repo") or "").strip()
            if not source:
                continue
            targets.append(
                {
                    "repo": source,
                    "team_id": (row.get("team_id") or "").strip(),
                    "project_id": (row.get("project_id") or "").strip(),
                    "name": (row.get("name") or "").strip()
                    or re.sub(r"\.git$", "", source.rstrip("/").split("/")[-1]),
                }
            )
    return targets


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repos", default=str(CONFIG_DIR / "repos.csv"))
    parser.add_argument("--repo", help="single repository path or URL")
    parser.add_argument("--team")
    parser.add_argument("--project")
    parser.add_argument("--name", help="repository name to record for a single --repo")
    parser.add_argument("--authors", default=str(CONFIG_DIR / "authors.csv"))
    parser.add_argument("--workdir", default=str(DATA_DIR / "repos"))
    parser.add_argument("--max-diff-bytes", type=int, default=200_000)
    parser.add_argument("--no-diffs", action="store_true", help="metadata only, much faster")
    parser.add_argument(
        "--ignore-consent",
        action="store_true",
        help="collect regardless of consent. For pilot data with no human subjects only.",
    )
    args = parser.parse_args()

    known_projects = {p["id"] for p in course_config()["projects"]}
    author_map = load_author_map(Path(args.authors))
    workdir = Path(args.workdir)

    total_commits = 0
    skipped: list[str] = []
    for target in repo_targets(args):
        print(f"{target['name']}  team={target['team_id']}  project={target['project_id']}")
        if target["project_id"] not in known_projects:
            print(f"  skipped: unknown project {target['project_id']!r}")
            continue
        if not args.ignore_consent:
            with research_db() as conn:
                label = config.team_label_of(target["team_id"], target["project_id"])
                instances = team_instances_for(conn, target["project_id"], label)
                blockers = consent_blockers(conn, instances)
            if not instances:
                print(
                    "  skipped: no team instance on record. Run scripts/sync_roster.py first, "
                    "so consent can be checked."
                )
                skipped.append(target["name"])
                continue
            if blockers:
                print(
                    f"  skipped: {len(blockers)} member(s) have not consented "
                    f"({', '.join(blockers)}). A repository mixes everyone's work, so the "
                    "whole repository stays out."
                )
                skipped.append(target["name"])
                continue

        repo_path = ensure_repo(target["repo"], workdir, target["name"])
        count = store_repo(
            repo_path,
            target["name"],
            target["team_id"],
            target["project_id"],
            author_map,
            args.max_diff_bytes,
            not args.no_diffs,
        )
        stages = record_stage_snapshots(target["name"], target["team_id"], target["project_id"])
        total_commits += count
        print(f"  {count} commits, {stages} stage snapshots")

    print(f"\nDone. {total_commits} commits written to the research database.")
    if skipped:
        print(f"{len(skipped)} repository/ies skipped on consent grounds: {', '.join(skipped)}")


if __name__ == "__main__":
    main()
