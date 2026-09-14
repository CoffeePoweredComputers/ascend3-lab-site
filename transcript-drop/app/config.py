"""Course configuration and filesystem paths.

Everything the instructor edits between semesters lives in config/, not in code.
"""

from __future__ import annotations

import csv
import os
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = Path(os.environ.get("GENAI_DATA_DIR", ROOT / "data"))
STATIC_DIR = ROOT / "static"

# Two separate database files, never joined by the application (section 2).
# identity.db is the only place a real student ID exists.
IDENTITY_DB = DATA_DIR / "identity.db"
RESEARCH_DB = DATA_DIR / "research.db"

PROJECTS_YAML = CONFIG_DIR / "projects.yaml"
ROSTER_CSV = CONFIG_DIR / "roster.csv"
CONSENT_CSV = CONFIG_DIR / "consent.csv"

ENV_FILE = ROOT / ".env"


def load_env_file(path: Path = ENV_FILE) -> None:
    """Read KEY=VALUE lines from .env into the environment. For development.

    The format is deliberately the same one systemd's EnvironmentFile takes, so
    the settings that make sign-in work are written once and the same four lines
    go into /etc/genai-submission.env on the server.

    The real environment always wins. In production systemd supplies these
    names, and the deploy copies the working tree -- so a developer's .env can
    land on the VM. Assigning here instead of defaulting would let a laptop's
    test Firebase project quietly replace the live one.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        os.environ.setdefault(name.strip(), value.strip().strip("'\""))


load_env_file()


@lru_cache(maxsize=1)
def course_config() -> dict:
    with PROJECTS_YAML.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def project_ids() -> list[str]:
    return [p["id"] for p in course_config()["projects"]]


def project_stages(project_id: str) -> list[dict]:
    for project in course_config()["projects"]:
        if project["id"] == project_id:
            return project.get("stages", [])
    return []


def project_window(project_id: str) -> tuple[str | None, str | None]:
    """Rough calendar span of a project, used to pre-filter a long log dump.

    A student who saved every conversation all semester should not have to scroll
    past September to find their P3 work. The span runs from the end of the
    previous project (or three weeks before this one's first deadline, for the
    first project) to a week after the last deadline -- generous on purpose,
    since it only reorders what is offered, never what may be submitted.
    """
    projects = course_config()["projects"]
    index = next((i for i, p in enumerate(projects) if p["id"] == project_id), None)
    if index is None:
        return None, None

    stages = projects[index].get("stages") or []
    if not stages:
        return None, None
    deadlines = sorted(str(stage["deadline"]) for stage in stages)

    previous = projects[index - 1].get("stages") if index > 0 else None
    if previous:
        start = max(str(stage["deadline"]) for stage in previous)
    else:
        start = (datetime.fromisoformat(deadlines[0]) - timedelta(days=21)).isoformat()

    end = (datetime.fromisoformat(deadlines[-1]) + timedelta(days=7)).isoformat()
    return start, end


def admins() -> set[str]:
    """Staff accounts, from config/projects.yaml.

    They are not research participants. They exist so the people running the
    study can walk the real submission flow, and scripts/export_dataset.py drops
    their records from the exported corpus. They are *not* exempt from the
    consent screen: it is the first thing every student sees, so it is the first
    thing a test account has to be able to check.
    """
    return {str(email).strip().lower() for email in course_config().get("admins", [])}


def visible_projects() -> list[dict]:
    """Projects offered to students. A hidden one is reachable but not listed."""
    return [p for p in course_config()["projects"] if not p.get("hidden")]


def allowed_ids(key: str) -> set[str]:
    """Valid option ids for a form field, e.g. allowed_ids("platforms")."""
    return {item["id"] for item in course_config().get(key, [])}


def _cached_file(path_fn, load_fn):
    """Cache a parsed config file, reloading it when the file changes on disk.

    Rosters change all semester -- students add, drop, and swap teams -- and
    consent arrives late. An ordinary lru_cache would pin whatever was read at
    start-up, so an instructor's edit would silently do nothing until someone
    restarted the service, and submissions in between would be attributed to a
    stale team. Keying on (path, mtime) picks the edit up on the next request.
    """
    cache: dict = {"key": None, "value": None}

    def get():
        path = path_fn()
        try:
            stamp = path.stat().st_mtime_ns
        except OSError:
            stamp = None
        key = (str(path), stamp)
        if cache["key"] != key:
            cache["value"] = load_fn(path)
            cache["key"] = key
        return cache["value"]

    get.cache_clear = lambda: cache.update(key=None, value=None)
    return get


def _csv_rows(path: Path):
    """DictReader over a CSV, ignoring "#" comment lines.

    The example files carry instructions at the top; without this the first
    comment would be read as the header row.
    """
    with path.open(encoding="utf-8-sig", newline="") as fh:
        lines = [line for line in fh if not line.lstrip().startswith("#")]
    return csv.DictReader(lines)


def _load_roster(path: Path) -> list[dict]:
    """Team membership as a temporal relation, not an attribute.

    Teams are rebuilt for every project, and a team can also change mid-project.
    Both are represented the same way: one row per (student, team instance), each
    with the window it was true for. A membership change never edits an existing
    row -- it closes it and opens a new instance -- so a conversation or commit
    can always be attributed to whoever the team was at that moment.

    Columns: email, project_id, team_instance_id, [team_label, joined_at,
    left_at]. An empty left_at means the membership is still open. The
    identifier is the student's university email: it is what they type on the
    form, and it is also what git records as a commit's author.
    """
    if not path.exists():
        return []

    rows: list[dict] = []
    for row in _csv_rows(path):
        email = (row.get("email") or "").strip().lower()
        project_id = (row.get("project_id") or "").strip()
        instance = (row.get("team_instance_id") or "").strip()
        if not (email and project_id and instance):
            continue
        rows.append(
            {
                "email": email,
                "project_id": project_id,
                "team_instance_id": instance,
                "team_label": (row.get("team_label") or "").strip()
                or team_label_of(instance, project_id),
                "joined_at": (row.get("joined_at") or "").strip() or None,
                "left_at": (row.get("left_at") or "").strip() or None,
            }
        )
    return rows


roster = _cached_file(lambda: ROSTER_CSV, _load_roster)


def team_label_of(team_instance_id: str, project_id: str) -> str:
    """"P2_T08b" -> "T08": the team's identity across its instances.

    Instances of one team share a repository, so the label is what ties a
    mid-project membership change back to a single line of development.
    """
    label = team_instance_id
    if label.startswith(f"{project_id}_"):
        label = label[len(project_id) + 1 :]
    return re.sub(r"[a-z]+$", "", label) or label


def _covers(row: dict, when: datetime | None) -> bool:
    """Whether a membership row was in force at a moment."""
    if when is None:
        return True
    joined = _as_datetime(row.get("joined_at"))
    left = _as_datetime(row.get("left_at"))
    if joined and when < joined:
        return False
    if left and when > left:
        return False
    return True


def _as_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def memberships(email: str, project_id: str) -> list[dict]:
    key = (email or "").strip().lower()
    return [
        row
        for row in roster()
        if row["email"] == key and row["project_id"] == project_id
    ]


def lookup_team_instance(
    email: str, project_id: str, when: datetime | None = None
) -> tuple[str | None, str]:
    """Which team instance a student belonged to at a given moment.

    Returns (team_instance_id, how) where `how` records the confidence:
    "roster" when the moment falls inside exactly one membership window,
    "ambiguous" when the student had several instances this project and the
    moment cannot separate them, and "unknown" when the roster says nothing.
    A conversation with no timestamp of its own is resolved against the
    submission time by the caller, which is why the ambiguity has to be visible
    rather than silently resolved.
    """
    rows = memberships(email, project_id)
    if not rows:
        return None, "unknown"
    if len(rows) == 1:
        return rows[0]["team_instance_id"], "roster"

    covering = [row for row in rows if _covers(row, when)]
    if len(covering) == 1:
        return covering[0]["team_instance_id"], "roster"
    # Several instances and nothing to choose between them: pick the latest that
    # started, but say so.
    ordered = sorted(rows, key=lambda row: row.get("joined_at") or "")
    return ordered[-1]["team_instance_id"], "ambiguous"



def team_labels(email: str, project_id: str) -> list[str]:
    """Every distinct team this student was on for one project, in order.

    Usually one. It is more when a student changed teams mid-project, and that
    is the only case where the portal still has to ask which team they mean:
    instances of the *same* team share a label, so a routine membership edit
    does not produce a question.
    """
    seen: list[str] = []
    for row in sorted(memberships(email, project_id), key=lambda r: r.get("joined_at") or ""):
        label = row["team_label"]
        if label not in seen:
            seen.append(label)
    return seen


def normalize_team_label(value: str | None) -> str:
    """Reduce a team label to what identifies it, so formatting cannot fail a match.

    Students type "T08", "t8", "Team 08" and "8" for the same team. Accepting all
    of them costs nothing -- a wrong team is still wrong after normalising -- and
    refusing them would turn a formatting slip into "you are not on this roster",
    which is the one error message a student cannot act on.
    """
    text = re.sub(r"[\s_\-]+", "", str(value or "")).upper()
    text = re.sub(r"^(?:TEAM|GROUP)", "", text)
    text = re.sub(r"^T(?=\d)", "", text)
    return re.sub(r"^0+(?=\d)", "", text)


def verify_team(
    email: str, project_id: str, typed_team: str | None, when: datetime | None = None
) -> str | None:
    """The team instance a student named correctly, or None if they did not.

    This is the gate on submission: the student types both their email and their
    team, and only a pair the roster agrees on is let through. It catches a
    mistyped address almost every time, since a wrong one will not also carry the
    right team -- but it is a check, not authentication. Teams number a few
    dozen, and a teammate knows both values already.

    Every instance the student held this project is eligible, not just the one
    covering `when`: after a mid-project team change they may be submitting
    conversations from either side of it, and both labels are truthfully theirs.
    """
    typed = normalize_team_label(typed_team)
    if not typed:
        return None

    matching = [
        row
        for row in memberships(email, project_id)
        if normalize_team_label(row["team_label"]) == typed
    ]
    if not matching:
        return None

    covering = [row for row in matching if _covers(row, when)]
    chosen = (
        covering[0]
        if covering
        else sorted(matching, key=lambda row: row.get("joined_at") or "")[-1]
    )
    return chosen["team_instance_id"]


def _load_consent(path: Path) -> dict[str, bool]:
    """email -> consented. Anyone absent counts as NOT consenting.

    Consent is recorded through the IRB's own process; this file just mirrors the
    result so collection can be gated on it. Defaulting an unknown student to
    "no" is the only safe direction: a teammate who never submitted still has to
    consent before their commits enter the dataset.
    """
    if not path.exists():
        return {}

    truthy = {"yes", "y", "true", "1", "consented"}
    result: dict[str, bool] = {}
    for row in _csv_rows(path):
        email = (row.get("email") or "").strip().lower()
        if email:
            result[email] = (row.get("consent") or "").strip().lower() in truthy
    return result


consent = _cached_file(lambda: CONSENT_CSV, _load_consent)


def has_consented(email: str) -> bool:
    return consent().get((email or "").strip().lower(), False)
