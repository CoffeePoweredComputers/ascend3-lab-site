"""Backups are the study team's job on this VM, so they have to actually work."""

import gzip
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from backup_databases import compress, prune, snapshot, verify  # noqa: E402


def live_database(path: Path) -> sqlite3.Connection:
    """A database in the mode the service actually runs in."""
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("CREATE TABLE turns (id INTEGER PRIMARY KEY, content TEXT)")
    conn.executemany(
        "INSERT INTO turns (content) VALUES (?)", [(f"turn {n}",) for n in range(50)]
    )
    conn.commit()
    return conn


def test_a_backup_taken_while_the_database_is_open_restores_intact(tmp_path):
    """The realistic case: a deadline evening, students mid-submission.

    Copying the file with cp here can catch a torn page or miss the last minute
    of writes, because a WAL database is a file plus a live write-ahead log.
    """
    source = tmp_path / "research.db"
    conn = live_database(source)
    # Still open, still holding un-checkpointed writes, exactly as in service.
    conn.execute("INSERT INTO turns (content) VALUES ('written just now')")
    conn.commit()

    target = tmp_path / "copy.db"
    snapshot(source, target)
    verify(target)

    restored = sqlite3.connect(target)
    assert restored.execute("SELECT count(*) FROM turns").fetchone()[0] == 51
    assert restored.execute(
        "SELECT count(*) FROM turns WHERE content = 'written just now'"
    ).fetchone()[0] == 1
    restored.close()
    conn.close()


def test_a_backup_is_one_self_contained_file(tmp_path):
    """No -wal or -shm companion to move, compress or forget to move."""
    source = tmp_path / "research.db"
    conn = live_database(source)
    target = tmp_path / "out" / "copy.db"
    target.parent.mkdir()

    snapshot(source, target)
    conn.close()

    assert sorted(p.name for p in target.parent.iterdir()) == ["copy.db"]
    restored = sqlite3.connect(target)
    assert restored.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    restored.close()


def test_a_corrupt_copy_is_caught_rather_than_kept(tmp_path):
    """A backup nobody opened is a guess."""
    import pytest

    broken = tmp_path / "broken.db"
    broken.write_bytes(b"SQLite format 3\x00" + b"\x00" * 200)

    with pytest.raises(SystemExit):
        verify(broken)


def test_compression_round_trips(tmp_path):
    source = tmp_path / "research.db"
    conn = live_database(source)
    target = tmp_path / "copy.db"
    snapshot(source, target)
    conn.close()

    packed = compress(target)

    assert packed.name.endswith(".db.gz")
    assert not target.exists(), "the uncompressed copy is not left behind as well"
    restored = tmp_path / "restored.db"
    restored.write_bytes(gzip.decompress(packed.read_bytes()))
    assert sqlite3.connect(restored).execute("SELECT count(*) FROM turns").fetchone()[0] == 50


def test_retention_keeps_the_newest_and_only_touches_backups(tmp_path):
    folder = tmp_path / "research"
    folder.mkdir()
    for stamp in ("20260901", "20260902", "20260903", "20260904"):
        (folder / f"research-{stamp}T000000Z.db.gz").write_bytes(b"x")
    # Anything else in the directory is not ours to delete.
    (folder / "README.txt").write_text("restore instructions")

    removed = prune(folder, keep=2)

    assert [p.name for p in removed] == [
        "research-20260901T000000Z.db.gz",
        "research-20260902T000000Z.db.gz",
    ]
    assert (folder / "README.txt").exists()
    assert len(list(folder.glob("*.db.gz"))) == 2


def test_retention_does_nothing_when_there_is_nothing_to_drop(tmp_path):
    folder = tmp_path / "research"
    folder.mkdir()
    (folder / "research-20260901T000000Z.db.gz").write_bytes(b"x")

    assert prune(folder, keep=14) == []
    assert prune(folder, keep=0) == [], "keep=0 must not be read as 'delete everything'"
