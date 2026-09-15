#!/usr/bin/env python3
"""Take a consistent copy of both databases while the service keeps running.

Backups are the study team's responsibility, not the cluster's: the VM comes as
a bare install, and the acceptable-use rules allow it to be switched off without
notice if it ever becomes a security risk. Whatever is only on that disk is
whatever gets lost.

    python scripts/backup_databases.py /mnt/vt-research/genai-backups
    python scripts/backup_databases.py /mnt/... --keep 30 --no-compress

Point it somewhere off the VM. A copy on the same disk survives a mistaken
DELETE and nothing else.

Uses sqlite3's own backup API rather than copying the file. A SQLite database in
WAL mode is two files plus a live write-ahead log, and `cp` while a student is
submitting can produce a copy that is torn or simply missing the last minute of
writes. The backup API takes a consistent snapshot of a database that is being
written to, which is exactly the situation every night at a deadline.

Standard library only.
"""

from __future__ import annotations

import argparse
import gzip
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import IDENTITY_DB, RESEARCH_DB  # noqa: E402

# One subdirectory each, so the two can be given different permissions. The
# whole design keeps "who this is" apart from "what they wrote"; restoring both
# into one folder with one ACL would quietly put them back together.
SOURCES = {"identity": IDENTITY_DB, "research": RESEARCH_DB}


def snapshot(source: Path, target: Path) -> None:
    """Copy a live database, consistently, into one self-contained file."""
    origin = sqlite3.connect(source)
    copy = sqlite3.connect(target)
    try:
        origin.backup(copy)
        # The copy inherits WAL mode, which means it expects a -wal companion
        # that is not part of the backup. Switching it to DELETE makes the
        # backup exactly one file -- which is what can be moved, compressed and
        # restored without anybody having to know about journal companions.
        copy.execute("PRAGMA journal_mode = DELETE")
    finally:
        copy.close()
        origin.close()

    # backup() opens the copy in the journal mode it inherited, so a -shm can be
    # left beside it even after the switch to DELETE. A backup directory should
    # contain backups and nothing else.
    for companion in ("-wal", "-shm"):
        leftover = target.with_name(target.name + companion)
        if leftover.exists():
            leftover.unlink()


def verify(path: Path) -> None:
    """Open the copy and ask SQLite whether it is intact.

    A backup nobody has opened is a guess. This is cheap and catches the failure
    that matters -- a truncated or corrupt file that looks fine in `ls`.
    """
    conn = sqlite3.connect(path)
    try:
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
    except sqlite3.DatabaseError as exc:
        # A file damaged badly enough is not a database at all, and SQLite says
        # so by raising rather than reporting. Both are the same news to whoever
        # is reading the cron output, so both end the run the same way.
        raise SystemExit(f"{path} is not a readable database: {exc}") from exc
    finally:
        conn.close()
    if result != "ok":
        raise SystemExit(f"integrity check failed for {path}: {result}")


def compress(path: Path) -> Path:
    target = path.with_suffix(path.suffix + ".gz")
    with path.open("rb") as raw, gzip.open(target, "wb") as packed:
        shutil.copyfileobj(raw, packed)
    path.unlink()
    return target


def prune(folder: Path, keep: int) -> list[Path]:
    """Drop all but the newest `keep` backups. Names sort chronologically."""
    existing = sorted(
        path
        for path in folder.iterdir()
        if path.is_file() and (path.suffix == ".db" or path.name.endswith(".db.gz"))
    )
    removed = existing[:-keep] if keep > 0 and len(existing) > keep else []
    for path in removed:
        path.unlink()
    return removed


def human(size: int) -> str:
    return f"{size / 1024 ** 2:.1f} MB"


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("destination", help="backup directory, ideally not on this machine")
    parser.add_argument("--keep", type=int, default=14, help="how many backups to retain (default 14)")
    parser.add_argument("--no-compress", action="store_true", help="leave the copies uncompressed")
    args = parser.parse_args()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = Path(args.destination).expanduser()

    for name, source in SOURCES.items():
        if not source.exists():
            print(f"{name:<9} skipped, {source} does not exist")
            continue

        folder = destination / name
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{name}-{stamp}.db"

        snapshot(source, target)
        verify(target)
        if not args.no_compress:
            target = compress(target)

        removed = prune(folder, args.keep)
        note = f", pruned {len(removed)}" if removed else ""
        print(f"{name:<9} {target}  {human(target.stat().st_size)}{note}")


if __name__ == "__main__":
    main()
