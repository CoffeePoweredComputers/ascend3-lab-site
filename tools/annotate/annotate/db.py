"""SQLite schema, migrations and connections.

One file, /data/annotate.db. The deploy runner starts a new build on a scratch
port while the old container is still serving, and both mount the same /data,
so migrations are additive only and run under a write lock: two processes
starting at once is the normal case, not an accident.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from typing import Iterator

from annotate import config

BUSY_TIMEOUT_SECONDS = 15.0
KEEP_BACKUPS = 14
BACKUP_EVERY_SECONDS = 24 * 3600

# Enum-like columns (kind, status, role, mode) are validated in the app rather
# than with CHECK, so a later value such as item.kind = 'segment' needs no
# table rebuild.
MIGRATIONS = [
    """
    -- kind picks the study's settings in annotate/studies.py.
    CREATE TABLE dataset (
        id    INTEGER PRIMARY KEY,
        slug  TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        kind  TEXT NOT NULL DEFAULT 'decomp'
    );

    CREATE TABLE track (
        id         INTEGER PRIMARY KEY,
        dataset_id INTEGER NOT NULL REFERENCES dataset(id),
        slug       TEXT NOT NULL,
        title      TEXT NOT NULL,
        item_kind  TEXT NOT NULL,
        UNIQUE (dataset_id, slug)
    );

    -- The join keys. Coders never see these columns; only exports carry them.
    CREATE TABLE source (
        id            INTEGER PRIMARY KEY,
        dataset_id    INTEGER NOT NULL REFERENCES dataset(id),
        hash          TEXT NOT NULL,
        homework      TEXT NOT NULL,
        project       TEXT NOT NULL,
        submission_id TEXT NOT NULL DEFAULT '',
        UNIQUE (dataset_id, hash, homework, project)
    );

    -- One item is one student's whole submission or response: a photo, in
    -- studies that have one, and the written parts in item_text. token is what URLs
    -- carry; shuffle_key is the queue order. Both are random.
    CREATE TABLE item (
        id          INTEGER PRIMARY KEY,
        track_id    INTEGER NOT NULL REFERENCES track(id),
        source_id   INTEGER NOT NULL REFERENCES source(id),
        token       TEXT NOT NULL UNIQUE,
        kind        TEXT NOT NULL,
        raw_path    TEXT,
        sha256      TEXT,
        shuffle_key REAL NOT NULL,
        UNIQUE (track_id, source_id)
    );

    -- ord is the order the parts are shown in. A hidden part is kept for the
    -- export and never put on a page.
    CREATE TABLE item_text (
        item_id INTEGER NOT NULL REFERENCES item(id),
        part    TEXT NOT NULL,
        text    TEXT NOT NULL,
        n_words INTEGER NOT NULL,
        ord     INTEGER NOT NULL DEFAULT 0,
        hidden  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (item_id, part)
    );

    CREATE TABLE item_state (
        item_id     INTEGER PRIMARY KEY REFERENCES item(id),
        status      TEXT NOT NULL DEFAULT 'untriaged',
        rotation    INTEGER NOT NULL DEFAULT 0,
        crop_x      REAL,
        crop_y      REAL,
        crop_w      REAL,
        crop_h      REAL,
        legible     INTEGER NOT NULL DEFAULT 1,
        off_task    INTEGER NOT NULL DEFAULT 0,
        pii_visible INTEGER NOT NULL DEFAULT 0,
        low_content INTEGER NOT NULL DEFAULT 0,
        note        TEXT NOT NULL DEFAULT '',
        rev         INTEGER NOT NULL DEFAULT 0,
        updated_by  TEXT,
        updated_at  TEXT
    );

    -- Email stays here. Everything a coder produces is attributed to coder_code.
    CREATE TABLE roster (
        id         INTEGER PRIMARY KEY,
        track_id   INTEGER NOT NULL REFERENCES track(id),
        email      TEXT NOT NULL,
        uid        TEXT,
        coder_code TEXT NOT NULL,
        role       TEXT NOT NULL,
        active     INTEGER NOT NULL DEFAULT 1,
        UNIQUE (track_id, email),
        UNIQUE (track_id, coder_code)
    );

    -- Who has pressed Start on a study's first page.
    CREATE TABLE started (
        dataset_id INTEGER NOT NULL REFERENCES dataset(id),
        email      TEXT NOT NULL,
        at         TEXT NOT NULL,
        PRIMARY KEY (dataset_id, email)
    );

    CREATE TABLE stage_done (
        track_id INTEGER NOT NULL REFERENCES track(id),
        stage    INTEGER NOT NULL,
        done_by  TEXT NOT NULL,
        done_at  TEXT NOT NULL,
        PRIMARY KEY (track_id, stage)
    );

    CREATE TABLE codebook_version (
        id           INTEGER PRIMARY KEY,
        track_id     INTEGER NOT NULL REFERENCES track(id),
        n            INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'draft',
        note         TEXT NOT NULL DEFAULT '',
        created_by   TEXT NOT NULL,
        published_at TEXT,
        UNIQUE (track_id, n)
    );
    CREATE UNIQUE INDEX one_draft_per_track
        ON codebook_version(track_id) WHERE status = 'draft';

    -- key is the stable identity of a dimension or code across versions.
    -- part says what the dimension is a question about: the diagram or the
    -- reflection. The two are shown together but coded as separate questions.
    CREATE TABLE dimension (
        id         INTEGER PRIMARY KEY,
        version_id INTEGER NOT NULL REFERENCES codebook_version(id),
        key        TEXT NOT NULL,
        name       TEXT NOT NULL,
        mode       TEXT NOT NULL,
        part       TEXT NOT NULL DEFAULT 'diagram',
        ord        INTEGER NOT NULL DEFAULT 0,
        UNIQUE (version_id, key)
    );

    CREATE TABLE code (
        id           INTEGER PRIMARY KEY,
        dimension_id INTEGER NOT NULL REFERENCES dimension(id),
        key          TEXT NOT NULL,
        label        TEXT NOT NULL,
        definition   TEXT NOT NULL DEFAULT '',
        include      TEXT NOT NULL DEFAULT '',
        exclude      TEXT NOT NULL DEFAULT '',
        example      TEXT NOT NULL DEFAULT '',
        ord          INTEGER NOT NULL DEFAULT 0,
        UNIQUE (dimension_id, key)
    );

    CREATE TABLE batch (
        id         INTEGER PRIMARY KEY,
        track_id   INTEGER NOT NULL REFERENCES track(id),
        version_id INTEGER REFERENCES codebook_version(id),
        kind       TEXT NOT NULL,
        round_no   INTEGER NOT NULL,
        title      TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at  TEXT
    );

    CREATE TABLE batch_coder (
        batch_id     INTEGER NOT NULL REFERENCES batch(id),
        roster_id    INTEGER NOT NULL REFERENCES roster(id),
        submitted_at TEXT,
        PRIMARY KEY (batch_id, roster_id)
    );

    -- done_at separates "coded, and no multi-label code applies" from "not
    -- coded yet", which the agreement statistics treat as missing.
    -- The consensus for an item is one more assignment, with no coder.
    CREATE TABLE assignment (
        id           INTEGER PRIMARY KEY,
        batch_id     INTEGER NOT NULL REFERENCES batch(id),
        item_id      INTEGER NOT NULL REFERENCES item(id),
        roster_id    INTEGER REFERENCES roster(id),
        is_consensus INTEGER NOT NULL DEFAULT 0,
        done_at      TEXT,
        UNIQUE (batch_id, item_id, roster_id)
    );
    CREATE UNIQUE INDEX one_consensus_per_item
        ON assignment(batch_id, item_id) WHERE is_consensus = 1;

    CREATE TABLE annotation (
        assignment_id INTEGER NOT NULL REFERENCES assignment(id),
        code_id       INTEGER NOT NULL REFERENCES code(id),
        PRIMARY KEY (assignment_id, code_id)
    );

    -- kind: jotting (its author's alone until the merge), memo and rq
    -- (shared with the track).
    CREATE TABLE memo (
        id         INTEGER PRIMARY KEY,
        track_id   INTEGER NOT NULL REFERENCES track(id),
        roster_id  INTEGER NOT NULL REFERENCES roster(id),
        kind       TEXT NOT NULL,
        item_id    INTEGER REFERENCES item(id),
        batch_id   INTEGER REFERENCES batch(id),
        code_key   TEXT,
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    -- Frozen when a batch closes, so the history does not move when the
    -- codebook is later revised.
    CREATE TABLE agreement (
        id            INTEGER PRIMARY KEY,
        batch_id      INTEGER NOT NULL REFERENCES batch(id),
        dimension_key TEXT NOT NULL,
        code_key      TEXT,
        n_items       INTEGER NOT NULL,
        n_coders      INTEGER NOT NULL,
        pct           REAL,
        kappa         REAL,
        alpha         REAL,
        ac1           REAL,
        computed_at   TEXT NOT NULL
    );

    CREATE INDEX item_track ON item(track_id, shuffle_key);
    CREATE INDEX assignment_batch ON assignment(batch_id, roster_id);
    CREATE INDEX memo_track ON memo(track_id, kind);
    """,
    """
    -- Studies where everyone reads every item: who has been past which one.
    CREATE TABLE seen (
        item_id   INTEGER NOT NULL REFERENCES item(id),
        roster_id INTEGER NOT NULL REFERENCES roster(id),
        at        TEXT NOT NULL,
        PRIMARY KEY (item_id, roster_id)
    );

    -- A code the team is proposing after the merge of everyone's own codes.
    CREATE TABLE mcode (
        id         INTEGER PRIMARY KEY,
        track_id   INTEGER NOT NULL REFERENCES track(id),
        part       TEXT NOT NULL,
        name       TEXT NOT NULL,
        definition TEXT NOT NULL DEFAULT '',
        reason     TEXT NOT NULL DEFAULT '',
        ord        INTEGER NOT NULL DEFAULT 0
    );

    -- One person's own code from open coding. status: candidate (proposed by
    -- the model, not taken up) or own. Hidden from everyone else until the
    -- open-coding deck closes. At the merge it goes into an mcode, is dropped,
    -- or is still undecided (both empty).
    CREATE TABLE pcode (
        id              INTEGER PRIMARY KEY,
        track_id        INTEGER NOT NULL REFERENCES track(id),
        roster_id       INTEGER NOT NULL REFERENCES roster(id),
        name            TEXT NOT NULL,
        definition      TEXT NOT NULL DEFAULT '',
        part            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'own',
        origin          TEXT NOT NULL DEFAULT 'own',
        example_item_id INTEGER REFERENCES item(id),
        mcode_id        INTEGER REFERENCES mcode(id),
        dropped         INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
    );

    CREATE TABLE pcode_use (
        pcode_id INTEGER NOT NULL REFERENCES pcode(id),
        item_id  INTEGER NOT NULL REFERENCES item(id),
        PRIMARY KEY (pcode_id, item_id)
    );

    -- One model run. kind: candidates (one per person) or merge (one per
    -- track, roster_id 0). status: working, ready or failed. Each runs once;
    -- only a failed one can be started again.
    CREATE TABLE job (
        track_id    INTEGER NOT NULL REFERENCES track(id),
        kind        TEXT NOT NULL,
        roster_id   INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL,
        detail      TEXT NOT NULL DEFAULT '',
        started_by  TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (track_id, kind, roster_id)
    );

    CREATE INDEX pcode_owner ON pcode(track_id, roster_id);
    """,
    """
    -- A theme is the team's statement about a group of codes, made after the
    -- final pass. A code is in at most one theme. Codes are named by their
    -- keys, which stay the same across codebook versions.
    CREATE TABLE theme (
        id        INTEGER PRIMARY KEY,
        track_id  INTEGER NOT NULL REFERENCES track(id),
        name      TEXT NOT NULL,
        statement TEXT NOT NULL DEFAULT '',
        ord       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE theme_code (
        track_id      INTEGER NOT NULL REFERENCES track(id),
        dimension_key TEXT NOT NULL,
        code_key      TEXT NOT NULL,
        theme_id      INTEGER NOT NULL REFERENCES theme(id),
        PRIMARY KEY (track_id, dimension_key, code_key)
    );
    """,
    """
    -- Whose job it is to turn and crop a photo. Dealt out when the lead locks
    -- the team, and dealt again when someone is taken off it.
    CREATE TABLE cleaning (
        item_id   INTEGER PRIMARY KEY REFERENCES item(id),
        roster_id INTEGER NOT NULL REFERENCES roster(id)
    );
    """,
    """
    -- A recorded session: one video and its transcript. pid is a join key
    -- like source.hash and is never put on a page; alias is what a page
    -- shows. order_key is where the session's items sit in the reading order.
    CREATE TABLE session (
        id                 INTEGER PRIMARY KEY,
        dataset_id         INTEGER NOT NULL REFERENCES dataset(id),
        pid                TEXT NOT NULL,
        alias              TEXT NOT NULL,
        duration_ms        INTEGER NOT NULL,
        media_path         TEXT,
        media_sha256       TEXT,
        transcript_kind    TEXT NOT NULL,
        transcript_version TEXT NOT NULL,
        cut_rule           TEXT NOT NULL,
        order_key          REAL NOT NULL,
        UNIQUE (dataset_id, pid),
        UNIQUE (dataset_id, alias)
    );

    -- One transcript line. speaker is a role (R researcher, P participant,
    -- ? unknown), never a name. src_id and src_ordinal are the export's own.
    CREATE TABLE segment (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES session(id),
        seq         INTEGER NOT NULL,
        t_start_ms  INTEGER NOT NULL,
        t_end_ms    INTEGER NOT NULL,
        speaker     TEXT NOT NULL,
        text        TEXT NOT NULL,
        src_id      TEXT NOT NULL,
        src_ordinal INTEGER NOT NULL,
        UNIQUE (session_id, seq)
    );

    -- The stretch of a session that an item is. seg_first and seg_last are
    -- segment.seq, both inside the stretch.
    CREATE TABLE item_span (
        item_id    INTEGER PRIMARY KEY REFERENCES item(id),
        session_id INTEGER NOT NULL REFERENCES session(id),
        seq        INTEGER NOT NULL,
        t_start_ms INTEGER NOT NULL,
        t_end_ms   INTEGER NOT NULL,
        seg_first  INTEGER NOT NULL,
        seg_last   INTEGER NOT NULL,
        UNIQUE (session_id, seq)
    );
    """,
]


def _migrate(conn: sqlite3.Connection) -> None:
    if conn.execute("PRAGMA user_version").fetchone()[0] >= len(MIGRATIONS):
        return
    # Take the write lock before re-reading the version: the other starting
    # process may have migrated while this one waited.
    conn.execute("BEGIN IMMEDIATE")
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        for i in range(version, len(MIGRATIONS)):
            for statement in _statements(MIGRATIONS[i]):
                conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {i + 1}")
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def _statements(script: str) -> list[str]:
    """Split a migration into statements. executescript() would commit the
    surrounding transaction, which is the lock this relies on."""
    lines = [line for line in script.splitlines() if not line.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


def connect() -> sqlite3.Connection:
    path = config.db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_SECONDS, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init() -> None:
    conn = connect()
    try:
        _migrate(conn)
    finally:
        conn.close()


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """One transaction per request. BEGIN IMMEDIATE so a writer queues for the
    lock up front instead of failing halfway through on an upgrade."""
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def maybe_backup() -> bool:
    """Copy the database to /data/backups at most once a day, keeping the
    newest KEEP_BACKUPS. Same disk only: it guards against a bad edit, not
    against losing the server."""
    directory = config.backup_dir()
    directory.mkdir(parents=True, exist_ok=True)
    existing = sorted(directory.glob("annotate-*.db"))
    if existing and time.time() - existing[-1].stat().st_mtime < BACKUP_EVERY_SECONDS:
        return False
    target = directory / f"annotate-{time.strftime('%Y%m%d-%H%M%S')}.db"
    conn = connect()
    try:
        conn.execute("VACUUM INTO ?", (str(target),))
    except sqlite3.Error:
        return False  # the other container got there first, or the disk is full
    finally:
        conn.close()
    for old in sorted(directory.glob("annotate-*.db"))[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)
    return True
