"""Load a Decomp_Anon-style folder into the tool's data directory.

Run it where the data is, inside the container on the server:

    docker exec ascend-tool-annotate python -m annotate.importer /data/incoming/decomp \\
        --dataset decomp --title "Decomposition diagrams" --lead someone@vt.edu

One item is one student's whole submission for one homework: the diagram photo
and the written approach and challenges. It reads three things and nothing
else: manifest.csv (the list of submissions), comments.jsonl (the written
parts) and by_project/**/*_diagram.jpeg.

Safe to run again: an item that already exists keeps its triage state, its
codes and its token.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import re
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Optional

from annotate import config, db, repo, studies

PROJECT_DIR = re.compile(r"^(Homework\d+)_(.+)$")
DIAGRAM = re.compile(r"^vt_.+_(\d+)_diagram\.jpe?g$", re.IGNORECASE)
LOW_CONTENT_WORDS = 5
TRACK = "main"

Key = tuple[str, str, str]  # hash, homework, project


def ensure_dataset(conn: sqlite3.Connection, slug: str, title: str, kind: str = "decomp") -> tuple[int, int]:
    """The dataset and its track. Returns (dataset id, track id)."""
    study = studies.get(kind)
    row = conn.execute("SELECT id FROM dataset WHERE slug = ?", (slug,)).fetchone()
    dataset_id = row["id"] if row else conn.execute(
        "INSERT INTO dataset (slug, title, kind) VALUES (?, ?, ?)", (slug, title, kind)
    ).lastrowid
    row = conn.execute("SELECT id FROM track WHERE dataset_id = ? AND slug = ?", (dataset_id, TRACK)).fetchone()
    track_id = row["id"] if row else conn.execute(
        "INSERT INTO track (dataset_id, slug, title, item_kind) VALUES (?, ?, ?, ?)",
        (dataset_id, TRACK, study.track_title, kind),
    ).lastrowid
    return dataset_id, track_id


def ensure_source(conn: sqlite3.Connection, dataset_id: int, key: Key, submission_id: str = "") -> int:
    row = conn.execute(
        "SELECT id FROM source WHERE dataset_id = ? AND hash = ? AND homework = ? AND project = ?",
        (dataset_id, *key),
    ).fetchone()
    if row:
        if submission_id:
            conn.execute("UPDATE source SET submission_id = ? WHERE id = ?", (submission_id, row["id"]))
        return row["id"]
    return conn.execute(
        "INSERT INTO source (dataset_id, hash, homework, project, submission_id) VALUES (?, ?, ?, ?, ?)",
        (dataset_id, *key, submission_id),
    ).lastrowid


Part = tuple[str, str, bool]  # name, text, hidden


def add_item(
    conn: sqlite3.Connection,
    track_id: int,
    source_id: int,
    dataset_slug: str,
    study: studies.Study,
    photo: Optional[Path],
    parts: list[Part],
) -> str:
    """One item, with its written parts in the order given. Returns 'new',
    'kept' or 'changed' (same item, different photo or text: reported, never
    overwritten)."""
    digest = hashlib.sha256(photo.read_bytes()).hexdigest() if photo else None
    texts = {name: text for name, text, _ in parts}
    existing = conn.execute("SELECT * FROM item WHERE track_id = ? AND source_id = ?", (track_id, source_id)).fetchone()
    if existing:
        stored = {r["part"]: r["text"] for r in conn.execute("SELECT part, text FROM item_text WHERE item_id = ?", (existing["id"],))}
        return "kept" if existing["sha256"] == digest and stored == texts else "changed"

    token = repo.new_token()
    relative = None
    if photo:
        # Renamed to the token: the submission id in the original file name is a student key.
        relative = f"{dataset_slug}/{token}.jpg"
        target = config.raw_dir() / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(photo, target)
        target.chmod(0o600)
    item_id = conn.execute(
        "INSERT INTO item (track_id, source_id, token, kind, raw_path, sha256, shuffle_key)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (track_id, source_id, token, study.kind, relative, digest, random.random()),
    ).lastrowid
    conn.executemany(
        "INSERT INTO item_text (item_id, part, text, n_words, ord, hidden) VALUES (?, ?, ?, ?, ?, ?)",
        [(item_id, name, text, len(text.split()), n, int(hidden)) for n, (name, text, hidden) in enumerate(parts)],
    )
    # Judged on the parts that carry the content: a one-word topic beside a
    # full question is not low content.
    main = [text for name, text, hidden in parts if not hidden and (not study.main_parts or name in study.main_parts)]
    low = all(len(text.split()) < LOW_CONTENT_WORDS for text in main)
    # A photo has to be turned and cropped by the first person who opens it
    # before it is in the data. Text is in from the start.
    status = "untriaged" if study.has_image else "cleared"
    conn.execute("INSERT INTO item_state (item_id, status, low_content) VALUES (?, ?, ?)", (item_id, status, int(low)))
    return "new"


def scan(folder: Path) -> tuple[dict[Key, tuple[str, Path]], dict[Key, dict[str, str]], list[dict], int]:
    """(diagrams, written parts, manifest rows, duplicate written parts), keyed by submission."""
    diagrams: dict[Key, tuple[str, Path]] = {}
    for project_dir in sorted((folder / "by_project").iterdir()):
        match = PROJECT_DIR.match(project_dir.name)
        if not match or not project_dir.is_dir():
            continue
        for photo in sorted(project_dir.glob("*/*")):
            found = DIAGRAM.match(photo.name)
            if found:
                diagrams[(photo.parent.name, match[1], match[2])] = (found[1], photo)
    with open(folder / "comments.jsonl", encoding="utf-8") as f:
        reflections = [json.loads(line) for line in f if line.strip()]
    with open(folder / "manifest.csv", encoding="utf-8", newline="") as f:
        manifest = list(csv.DictReader(f))
    # Checked here, before anything is copied: a bad row found halfway through
    # an import would roll the database back but leave photos behind in /data.
    for name, rows, needed in (
        ("comments.jsonl", reflections, ("hash", "homework", "project", "type", "text")),
        ("manifest.csv", manifest, ("hash", "homework", "project", "submission_id")),
    ):
        for n, row in enumerate(rows, start=1):
            missing = [k for k in needed if not isinstance(row.get(k), str) or not row[k]]
            if missing:
                raise ValueError(f"{name}, record {n}: missing {', '.join(missing)}")
    texts: dict[Key, dict[str, str]] = {}
    duplicates = 0
    for r in reflections:
        parts = texts.setdefault((r["hash"], r["homework"], r["project"]), {})
        if r["type"] in parts:
            duplicates += 1  # the first one is kept
        else:
            parts[r["type"]] = r["text"]
    return diagrams, texts, manifest, duplicates


def run(folder: Path, dataset: str, title: str, lead: Optional[str], dry_run: bool = False) -> dict:
    diagrams, texts, manifest, duplicates = scan(folder)
    ids = {(r["hash"], r["homework"], r["project"]): r["submission_id"] for r in manifest}
    keys = sorted(set(ids) | set(diagrams) | set(texts))
    report = {
        "manifest_rows": len(manifest),
        "submissions": len(keys),
        "diagrams_found": len(diagrams),
        "written_parts_found": sum(len(parts) for parts in texts.values()),
        "submissions_without_diagram": len(keys) - len(diagrams),
        "duplicate_written_parts": duplicates,
    }
    if dry_run:
        return report
    db.init()
    counts = {"new": 0, "kept": 0, "changed": 0}
    with db.db() as conn:
        dataset_id, track_id = ensure_dataset(conn, dataset, title, "decomp")
        study = studies.get("decomp")
        for key in keys:
            submission_id, photo = diagrams.get(key, ("", None))
            source_id = ensure_source(conn, dataset_id, key, ids.get(key) or submission_id)
            parts = [(name, text, False) for name, text in sorted(texts.get(key, {}).items())]
            counts[add_item(conn, track_id, source_id, dataset, study, photo, parts)] += 1
        if lead:
            repo.add_roster(conn, track_id, lead, "lead")
    return {**report, **{f"items_{k}": v for k, v in counts.items()}}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("folder", type=Path)
    parser.add_argument("--dataset", required=True, help="short name, e.g. decomp")
    parser.add_argument("--title", default="", help="shown on the dashboard")
    parser.add_argument("--lead", help="email of the first lead")
    parser.add_argument("--dry-run", action="store_true", help="count what is there, write nothing")
    args = parser.parse_args(argv)
    report = run(args.folder, args.dataset, args.title or args.dataset, args.lead, args.dry_run)
    for key, value in report.items():
        print(f"{key:30} {value}")
    if report.get("items_changed") or report.get("duplicate_written_parts"):
        print("Some photos or texts differ from what was already imported, or appear twice. The first copy was kept.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
