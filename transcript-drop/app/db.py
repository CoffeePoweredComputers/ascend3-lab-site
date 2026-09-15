"""SQLite schemas and connections.

The identity database and the research database are deliberately separate files.
Nothing in this module joins them: code that resolves a student ID to a
participant code (app/identity.py) touches identity.db, and everything else
touches research.db, where only participant codes appear.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.config import DATA_DIR, IDENTITY_DB, RESEARCH_DB

IDENTITY_SCHEMA = """
CREATE TABLE IF NOT EXISTS identities (
    email            TEXT PRIMARY KEY,
    participant_code TEXT NOT NULL UNIQUE,
    first_seen       TEXT NOT NULL,
    last_seen        TEXT NOT NULL
);

-- Consent is about a named person, so it belongs on this side of the split and
-- never in research.db. form_version fingerprints the wording that was on
-- screen: "they consented" is a much weaker record than "they consented to
-- this text", and consent forms get revised.
CREATE TABLE IF NOT EXISTS consent_records (
    email        TEXT PRIMARY KEY,
    decision     TEXT NOT NULL,
    form_version TEXT NOT NULL,
    recorded_at  TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    -- The protocol requires eligibility to be confirmed in the portal before
    -- consent, so the confirmation is stored with it rather than assumed.
    is_adult     INTEGER NOT NULL DEFAULT 0
);
"""

RESEARCH_SCHEMA = """
CREATE TABLE IF NOT EXISTS submissions (
    submission_id    TEXT PRIMARY KEY,
    participant_code TEXT NOT NULL,
    project_id       TEXT NOT NULL,
    team_id          TEXT,
    completeness     TEXT NOT NULL,
    submitted_at     TEXT NOT NULL,
    client_note      TEXT,
    team_instance_id TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    conversation_id    TEXT PRIMARY KEY,
    submission_id      TEXT NOT NULL REFERENCES submissions(submission_id),
    participant_code   TEXT NOT NULL,
    project_id         TEXT NOT NULL,
    team_id            TEXT,
    platform           TEXT NOT NULL,
    platform_other     TEXT,
    title              TEXT,
    source_format      TEXT NOT NULL,
    parse_quality      TEXT NOT NULL,
    primary_purpose    TEXT NOT NULL,
    reported_change    TEXT NOT NULL,
    conversation_start TEXT,
    conversation_end   TEXT,
    turn_count         INTEGER NOT NULL,
    char_count         INTEGER NOT NULL,
    content_hash       TEXT NOT NULL,
    -- Populated only by IDE/agentic tools, which know where they ran.
    workspace_cwd      TEXT,
    workspace_repo_url TEXT,
    workspace_branch   TEXT,
    workspace_commit   TEXT,
    tool_origin        TEXT,
    models             TEXT,
    tool_version       TEXT,
    metadata_json      TEXT,
    -- Which team the student was in when this happened, and how sure we are.
    team_instance_id   TEXT,
    team_assignment    TEXT,
    -- The tool's own id for this conversation. A session grows between
    -- submissions, so its text is not a stable identity; this is.
    source_session_id  TEXT,
    -- Where a link-imported conversation came from, so a reviewer can reopen it.
    source_url         TEXT
);

CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
    turn_id         INTEGER NOT NULL,
    role            TEXT NOT NULL,
    timestamp       TEXT,
    content         TEXT NOT NULL,
    char_count      INTEGER NOT NULL,
    model           TEXT,
    UNIQUE (conversation_id, turn_id)
);

-- Files the AI itself touched, as recorded by the tool rather than inferred.
-- change_type "context" means the file was only shown to the model.
CREATE TABLE IF NOT EXISTS conversation_edits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
    path            TEXT NOT NULL,
    change_type     TEXT,
    occurred_at     TEXT,
    patch           TEXT
);

CREATE TABLE IF NOT EXISTS commits (
    commit_hash      TEXT PRIMARY KEY,
    repo             TEXT NOT NULL,
    repo_url         TEXT,
    team_id          TEXT,
    team_instance_id TEXT,
    project_id       TEXT,
    participant_code TEXT,
    author_name      TEXT,
    author_email     TEXT,
    authored_at      TEXT NOT NULL,
    committed_at     TEXT,
    message          TEXT,
    branches         TEXT,
    is_merge         INTEGER NOT NULL DEFAULT 0,
    files_changed    INTEGER NOT NULL DEFAULT 0,
    insertions       INTEGER NOT NULL DEFAULT 0,
    deletions        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS commit_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    commit_hash TEXT NOT NULL REFERENCES commits(commit_hash),
    path        TEXT NOT NULL,
    old_path    TEXT,
    change_type TEXT,
    insertions  INTEGER NOT NULL DEFAULT 0,
    deletions   INTEGER NOT NULL DEFAULT 0,
    diff        TEXT,
    UNIQUE (commit_hash, path)
);

CREATE TABLE IF NOT EXISTS stage_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL,
    stage       TEXT NOT NULL,
    team_id     TEXT NOT NULL,
    repo        TEXT NOT NULL,
    deadline    TEXT NOT NULL,
    commit_hash TEXT,
    UNIQUE (project_id, stage, team_id, repo)
);

CREATE TABLE IF NOT EXISTS linkages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id     TEXT NOT NULL REFERENCES conversations(conversation_id),
    commit_hash         TEXT NOT NULL REFERENCES commits(commit_hash),
    candidate_score     REAL NOT NULL,
    time_score          REAL NOT NULL,
    content_score       REAL NOT NULL,
    artifact_score      REAL NOT NULL DEFAULT 0,
    matched_paths       TEXT,
    author_match        INTEGER NOT NULL DEFAULT 0,
    time_delta_minutes  REAL,
    stage               TEXT,
    shared_tokens       TEXT,
    auto_band           TEXT NOT NULL,
    linkage_confidence  TEXT,
    change_type         TEXT,
    reviewer            TEXT,
    reviewed_at         TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL,
    UNIQUE (conversation_id, commit_hash)
);

-- Teams are rebuilt every project, and a mid-project membership change opens a
-- new instance rather than editing the old one. team_label ties the instances of
-- one team together, because they share a repository.
-- One repository per team per project, handed in by whichever member gets to
-- it first. Keyed on the team *label* rather than an instance: instances of one
-- team share a repository, which is the whole reason the label exists.
CREATE TABLE IF NOT EXISTS team_repositories (
    project_id       TEXT NOT NULL,
    team_id          TEXT NOT NULL,
    repo_url         TEXT NOT NULL,
    normalized_url   TEXT NOT NULL,
    submitted_by     TEXT NOT NULL,
    team_instance_id TEXT,
    submitted_at     TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (project_id, team_id)
);

CREATE TABLE IF NOT EXISTS team_instances (
    team_instance_id TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL,
    team_label       TEXT NOT NULL,
    started_at       TEXT,
    ended_at         TEXT
);

-- Membership as a temporal relation, not an attribute of a participant.
CREATE TABLE IF NOT EXISTS participant_team_membership (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_code TEXT NOT NULL,
    team_instance_id TEXT NOT NULL REFERENCES team_instances(team_instance_id),
    project_id       TEXT NOT NULL,
    joined_at        TEXT,
    left_at          TEXT,
    UNIQUE (participant_code, team_instance_id)
);

-- Mirrors the IRB consent record. Absence means "not consented".
CREATE TABLE IF NOT EXISTS participant_consent (
    participant_code TEXT PRIMARY KEY,
    consented        INTEGER NOT NULL,
    recorded_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_conv_session
    ON conversations(participant_code, project_id, source_session_id);
CREATE INDEX IF NOT EXISTS idx_edits_conv ON conversation_edits(conversation_id);
CREATE INDEX IF NOT EXISTS idx_membership_team ON participant_team_membership(team_instance_id);
CREATE INDEX IF NOT EXISTS idx_membership_participant ON participant_team_membership(participant_code, project_id);
CREATE INDEX IF NOT EXISTS idx_edits_path ON conversation_edits(path);
CREATE INDEX IF NOT EXISTS idx_conv_scope
    ON conversations(project_id, team_id, participant_code);
CREATE INDEX IF NOT EXISTS idx_commit_scope
    ON commits(project_id, team_id, authored_at);
CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_files_commit ON commit_files(commit_hash);
"""


# CREATE TABLE IF NOT EXISTS is a no-op on a database that already exists, so
# columns added after a semester has started need an explicit ALTER.
ADDED_COLUMNS = {
    "conversations": {
        "workspace_cwd": "TEXT",
        "workspace_repo_url": "TEXT",
        "workspace_branch": "TEXT",
        "workspace_commit": "TEXT",
        "tool_origin": "TEXT",
        "models": "TEXT",
        "tool_version": "TEXT",
        "metadata_json": "TEXT",
        "team_instance_id": "TEXT",
        "team_assignment": "TEXT",
        "source_session_id": "TEXT",
        "source_url": "TEXT",
    },
    "turns": {"model": "TEXT"},
    "linkages": {"artifact_score": "REAL NOT NULL DEFAULT 0", "matched_paths": "TEXT"},
    "commits": {"repo_url": "TEXT", "team_instance_id": "TEXT"},
    "submissions": {"team_instance_id": "TEXT"},
}


def ensure_columns(conn: sqlite3.Connection) -> list[str]:
    """Add any missing columns in place. Returns what it added, for tests."""
    added = []
    for table, columns in ADDED_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if not existing:
            continue  # table itself is new; the schema already created it
        for name, declaration in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
                added.append(f"{table}.{name}")
    return added


# How long a writer waits for the lock before giving up. SQLite in WAL mode
# still admits one writer at a time, so submissions queue -- and on a deadline
# evening the queue is the whole class. Measured on the real endpoint: 40
# simultaneous submissions at 35 MB each take ~50 s to drain, and at a 15 s
# timeout six of the forty came back 500 "database is locked", which to a
# student means their upload vanished. At 60 s all forty succeeded and the batch
# drained no slower -- the failures were simply waits that had been cut short.
BUSY_TIMEOUT_SECONDS = 60.0


def rename_student_id_to_email(conn: sqlite3.Connection) -> bool:
    """Carry an identities table created before the identifier became an email.

    CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, and
    ensure_columns only ever adds, so neither reaches a renamed column. Returns
    whether it renamed anything, for tests.
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(identities)")}
    if "student_id" not in columns or "email" in columns:
        return False
    conn.execute("ALTER TABLE identities RENAME COLUMN student_id TO email")
    return True


def _connect(path: Path, schema: str) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(schema)
    return conn


# Same reason as ADDED_COLUMNS on the research side: CREATE TABLE IF NOT EXISTS
# is a no-op once the table exists, so a column added later never reaches a
# running copy.
IDENTITY_ADDED_COLUMNS = {
    "consent_records": {"is_adult": "INTEGER NOT NULL DEFAULT 0"},
}


def ensure_identity_columns(conn: sqlite3.Connection) -> list[str]:
    added = []
    for table, columns in IDENTITY_ADDED_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if not existing:
            continue
        for name, declaration in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
                added.append(f"{table}.{name}")
    return added


def identity_connection() -> sqlite3.Connection:
    conn = _connect(IDENTITY_DB, IDENTITY_SCHEMA)
    changed = rename_student_id_to_email(conn)
    changed = bool(ensure_identity_columns(conn)) or changed
    if changed:
        conn.commit()
    return conn


def research_connection() -> sqlite3.Connection:
    conn = _connect(RESEARCH_DB, RESEARCH_SCHEMA)
    if ensure_columns(conn):
        conn.commit()
    return conn


@contextmanager
def identity_db() -> Iterator[sqlite3.Connection]:
    conn = identity_connection()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


@contextmanager
def research_db() -> Iterator[sqlite3.Connection]:
    conn = research_connection()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_databases() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    identity_connection().close()
    research_connection().close()
