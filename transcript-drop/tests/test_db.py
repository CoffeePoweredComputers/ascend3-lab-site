"""Schema migration: columns added mid-semester must reach existing databases."""

import sqlite3

from app.db import ADDED_COLUMNS, ensure_columns

# The shape of the conversations/turns/linkages tables before workspace context,
# AI edits and per-turn models existed.
LEGACY_SCHEMA = """
CREATE TABLE submissions (
    submission_id TEXT PRIMARY KEY,
    participant_code TEXT NOT NULL,
    project_id TEXT NOT NULL,
    team_id TEXT,
    completeness TEXT NOT NULL,
    submitted_at TEXT NOT NULL
);
CREATE TABLE conversations (
    conversation_id TEXT PRIMARY KEY,
    participant_code TEXT NOT NULL,
    project_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    turn_count INTEGER NOT NULL,
    content_hash TEXT NOT NULL
);
CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    turn_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL
);
CREATE TABLE linkages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    candidate_score REAL NOT NULL
);
CREATE TABLE commits (
    commit_hash TEXT PRIMARY KEY,
    repo TEXT NOT NULL
);
"""


def legacy_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(LEGACY_SCHEMA)
    conn.execute(
        "INSERT INTO conversations VALUES ('C-1', 'S001', 'P2', 'claude', 2, 'hash')"
    )
    conn.execute("INSERT INTO turns (conversation_id, turn_id, role, content) VALUES ('C-1', 1, 'user', 'hi')")
    return conn


def test_missing_columns_are_added():
    conn = legacy_connection()

    added = ensure_columns(conn)

    assert "conversations.workspace_repo_url" in added
    assert "turns.model" in added
    assert "linkages.artifact_score" in added
    assert "commits.repo_url" in added
    assert "conversations.team_instance_id" in added
    assert "submissions.team_instance_id" in added


def test_existing_rows_survive_the_migration():
    conn = legacy_connection()

    ensure_columns(conn)

    row = conn.execute("SELECT * FROM conversations").fetchone()
    assert row["conversation_id"] == "C-1"
    assert row["turn_count"] == 2
    assert row["workspace_repo_url"] is None  # new column, no value invented


def test_migration_is_idempotent():
    conn = legacy_connection()

    ensure_columns(conn)
    assert ensure_columns(conn) == []


def test_every_added_column_is_writable_after_migration():
    conn = legacy_connection()
    ensure_columns(conn)

    for table, columns in ADDED_COLUMNS.items():
        present = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        assert set(columns) <= present, f"{table} is missing {set(columns) - present}"


def test_a_queued_writer_waits_for_the_lock_instead_of_failing(tmp_path):
    """A submission held up behind another must wait, not come back 500.

    SQLite in WAL mode admits one writer at a time, so submissions serialise. On
    a deadline evening that queue is the whole class, and a busy timeout shorter
    than the queue turns a wait into "database is locked" -- which reaches the
    student as an upload that vanished. Measured against the real endpoint: at 15
    seconds, six of forty concurrent 35 MB submissions failed; at 60 they all
    landed, and the batch drained no slower.
    """
    import threading
    import time

    from app import db

    assert db.BUSY_TIMEOUT_SECONDS >= 30, "shorter than a realistic write queue"

    path = tmp_path / "busy.db"
    setup = sqlite3.connect(path)
    setup.execute("PRAGMA journal_mode = WAL")
    setup.execute("CREATE TABLE t (v TEXT)")
    setup.commit()
    setup.close()

    holding = threading.Event()

    def hold_the_lock():
        # The connection has to be made in the thread that uses it.
        conn = sqlite3.connect(path, timeout=db.BUSY_TIMEOUT_SECONDS)
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT INTO t VALUES ('first')")
        holding.set()
        time.sleep(0.4)
        conn.commit()
        conn.close()

    writer = threading.Thread(target=hold_the_lock)
    writer.start()
    assert holding.wait(timeout=5)

    second = sqlite3.connect(path, timeout=db.BUSY_TIMEOUT_SECONDS)
    started = time.perf_counter()
    second.execute("INSERT INTO t VALUES ('second')")  # blocks on the lock
    second.commit()
    waited = time.perf_counter() - started
    writer.join()

    assert waited > 0.2, "should have queued behind the first writer"
    assert second.execute("SELECT count(*) FROM t").fetchone()[0] == 2
    second.close()


def test_an_identities_table_from_before_the_email_switch_is_carried_over(tmp_path):
    """The identifier changed after the table already existed on running copies.

    CREATE TABLE IF NOT EXISTS is a no-op on a table that is already there, and
    ensure_columns only ever adds, so neither reaches a renamed column. Without
    the rename, every lookup would miss and every returning student would be
    handed a second participant code.
    """
    from app.db import rename_student_id_to_email

    path = tmp_path / "identity.db"
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE identities (student_id TEXT PRIMARY KEY, "
        "participant_code TEXT NOT NULL UNIQUE, first_seen TEXT NOT NULL, "
        "last_seen TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO identities VALUES ('905123456', 'S001', '2026-08-01', '2026-08-01')"
    )
    conn.commit()

    assert rename_student_id_to_email(conn) is True

    row = conn.execute("SELECT email, participant_code FROM identities").fetchone()
    assert (row["email"], row["participant_code"]) == ("905123456", "S001")
    # The code survives, so a student who submitted before the switch keeps it.
    assert rename_student_id_to_email(conn) is False, "must be safe to run again"
    conn.close()
