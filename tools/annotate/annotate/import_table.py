"""Load a spreadsheet of responses as a study. One row is one item.

    python -m annotate.import_table responses.xlsx --dataset ethics-w6 --kind ethics \\
        --title "CS2114 ethics questions, week 6" --occasion Week06 --lead someone@vt.edu

Which column becomes which part comes from the study kind (annotate/studies.py)
and is matched on the header text, so a reordered sheet still loads. A missing
column is an error before anything is written.

Safe to run again, including on a later download of the same form: a response
that is already there is left alone with its triage and codes, and only new
ones are added.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Optional

from annotate import db, importer, repo, studies, tabular


def _find(headers: list[str], prefix: str) -> str:
    for header in headers:
        if header.casefold().startswith(prefix):
            return header
    raise ValueError(f"No column starting with '{prefix}'. The sheet has: {', '.join(headers)}")


def run(path: Path, dataset: str, title: str, kind: str, occasion: str, lead: Optional[str], dry_run: bool = False) -> dict:
    study = studies.get(kind)
    if not study.columns:
        raise ValueError(f"The '{kind}' study does not load from a spreadsheet.")
    rows = tabular.read(path)
    headers = list(rows[0]) if rows else []
    named = [(c, _find(headers, c.header)) for c in study.columns]
    main = [header for c, header in named if c.part in study.main_parts]

    items, blank = {}, 0
    for row in rows:
        if not any(row[h] for h in main):
            blank += 1
            continue
        # A response has no id of its own. Everything in the row, timestamp
        # included, tells it apart and stays the same from one download to the
        # next. Taken in header order, so moving a column changes nothing.
        key = hashlib.sha256("|".join(row[h] for h in sorted(row)).encode()).hexdigest()[:12]
        items[key] = [(c.part, row[header], c.hidden) for c, header in named if row[header]]
    report = {"rows": len(rows), "responses": len(items), "blank_rows": blank, "duplicate_rows": len(rows) - blank - len(items)}
    if dry_run:
        return report

    db.init()
    counts = {"new": 0, "kept": 0, "changed": 0}
    with db.db() as conn:
        dataset_id, track_id = importer.ensure_dataset(conn, dataset, title, kind)
        for key, parts in items.items():
            source_id = importer.ensure_source(conn, dataset_id, (key, occasion, study.task))
            counts[importer.add_item(conn, track_id, source_id, dataset, study, None, parts)] += 1
        if lead:
            repo.add_roster(conn, track_id, lead, "lead")
    return {**report, **{f"items_{k}": v for k, v in counts.items()}}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("file", type=Path, help=".xlsx or .csv")
    parser.add_argument("--dataset", required=True, help="short name, e.g. ethics-w6")
    parser.add_argument("--kind", required=True, choices=[k for k, s in studies.STUDIES.items() if s.columns])
    parser.add_argument("--title", default="", help="shown on the dashboard")
    parser.add_argument("--occasion", default="", help="when it was collected, e.g. Week06")
    parser.add_argument("--lead", help="email of the first lead")
    parser.add_argument("--dry-run", action="store_true", help="count what is there, write nothing")
    args = parser.parse_args(argv)
    report = run(args.file, args.dataset, args.title or args.dataset, args.kind, args.occasion, args.lead, args.dry_run)
    for key, value in report.items():
        print(f"{key:20} {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
