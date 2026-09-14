"""The team's GitHub repository for one project, handed in by a student.

The protocol allows participants to submit the URL of their team repository;
its history is what the donated conversations are eventually linked against. It
is collected here rather than assembled by the research team because the student
is the one who knows which repository they actually worked in.

A repository belongs to a *team*, not a person, so it is stored once per (team,
project) and any member can hand it in. Which member did is recorded as a
participant code -- useful when two members disagree about the URL, and no more
identifying than anything else in research.db.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from app.db import research_db
from app.matching import normalize_repo_url


class InvalidRepositoryURL(ValueError):
    pass


# Deliberately GitHub-only and deliberately strict. The course runs on GitHub,
# and a URL that is merely "plausible" is worse than a rejected one: it is
# discovered to be wrong months later, at extraction, when the student is gone.
GITHUB_URL_RE = re.compile(
    r"^(?:https?://)?(?:www\.)?github\.com/"
    r"(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)/"
    r"(?P<name>[A-Za-z0-9._-]{1,100}?)"
    r"(?:\.git)?/?$",
    re.IGNORECASE,
)

SSH_URL_RE = re.compile(
    r"^git@github\.com:"
    r"(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)/"
    r"(?P<name>[A-Za-z0-9._-]{1,100}?)"
    r"(?:\.git)?/?$",
    re.IGNORECASE,
)


def normalize(raw: str) -> str:
    """Reduce what a student pasted to a canonical https clone URL.

    Students paste whatever the address bar or the green button gave them: an
    https URL, an SSH remote, a link with a branch path stuck on the end. All of
    those name the same repository, and storing them as typed would leave the
    extractor comparing strings that differ only in how they were copied.
    """
    text = (raw or "").strip()
    if not text:
        raise InvalidRepositoryURL("Paste the link to your team's repository.")

    # A link copied from a page rather than the clone button: strip /tree/main,
    # /pull/3, ?tab=..., #readme and the like before matching.
    text = re.sub(r"[?#].*$", "", text)
    parts = text.split("github.com/", 1)
    if len(parts) == 2:
        segments = [s for s in parts[1].split("/") if s]
        if len(segments) > 2:
            text = parts[0] + "github.com/" + "/".join(segments[:2])

    match = GITHUB_URL_RE.match(text) or SSH_URL_RE.match(text)
    if not match:
        raise InvalidRepositoryURL(
            "That does not look like a GitHub repository link. It should look "
            "like https://github.com/your-org/your-repo."
        )
    return f"https://github.com/{match.group('owner')}/{match.group('name')}"


def for_team(project_id: str, team_id: str) -> dict | None:
    with research_db() as conn:
        row = conn.execute(
            "SELECT repo_url, submitted_by, submitted_at, updated_at "
            "FROM team_repositories WHERE project_id = ? AND team_id = ?",
            (project_id, team_id),
        ).fetchone()
    return dict(row) if row else None


def record(
    project_id: str,
    team_id: str,
    repo_url: str,
    participant_code: str,
    team_instance_id: str | None,
) -> dict:
    """Store the team's repository, replacing whatever was there before.

    Replacing rather than refusing: a team that renamed or re-created their
    repository has to be able to correct it, and the alternative is an email to
    the instructor for something the student can fix in ten seconds.
    """
    canonical = normalize(repo_url)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with research_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO team_repositories (project_id, team_id, repo_url, "
            "normalized_url, submitted_by, team_instance_id, submitted_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(project_id, team_id) DO UPDATE SET "
            "repo_url = excluded.repo_url, normalized_url = excluded.normalized_url, "
            "submitted_by = excluded.submitted_by, "
            "team_instance_id = excluded.team_instance_id, "
            "updated_at = excluded.updated_at",
            (
                project_id,
                team_id,
                canonical,
                normalize_repo_url(canonical),
                participant_code,
                team_instance_id,
                now,
                now,
            ),
        )
    return for_team(project_id, team_id)
