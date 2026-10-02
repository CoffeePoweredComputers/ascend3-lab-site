"""Agreement for one batch: build the item x coder tables, run the statistics.

A single-choice dimension is one nominal variable per item. A multi-label
dimension is one present/absent variable per code. An item a coder did not
finish is missing for that coder, not "absent".
"""

from __future__ import annotations

import sqlite3

from annotate import repo, stats


def compute(conn: sqlite3.Connection, batch: sqlite3.Row) -> list[dict]:
    coders = [c["coder_code"] for c in repo.batch_coders(conn, batch["id"])]
    done = conn.execute(
        "SELECT a.item_id, r.coder_code, d.key AS dim, c.key AS code"
        " FROM assignment a JOIN roster r ON r.id = a.roster_id"
        " LEFT JOIN annotation an ON an.assignment_id = a.id"
        " LEFT JOIN code c ON c.id = an.code_id"
        " LEFT JOIN dimension d ON d.id = c.dimension_id"
        " WHERE a.batch_id = ? AND a.is_consensus = 0 AND a.done_at IS NOT NULL",
        (batch["id"],),
    ).fetchall()
    # {(item, coder): {(dimension, code)}}; a key with an empty set is "coded, nothing applies".
    coded: dict[tuple[int, str], set[tuple[str, str]]] = {}
    for row in done:
        entry = coded.setdefault((row["item_id"], row["coder_code"]), set())
        if row["code"]:
            entry.add((row["dim"], row["code"]))
    items = sorted({item for item, _ in coded})

    def units(value_of):
        return [
            [value_of(coded[(item, c)]) if (item, c) in coded else None for c in coders]
            for item in items
        ]

    rows = []
    for d in repo.version_tree(conn, batch["version_id"]):
        if d["mode"] == "single":
            table = units(lambda codes, key=d["key"]: next((c for dim, c in codes if dim == key), None))
            rows.append(_row(d["key"], None, table, len(coders), len(d["codes"])))
        else:
            for c in d["codes"]:
                pair = (d["key"], c["key"])
                table = units(lambda codes, pair=pair: int(pair in codes))
                rows.append(_row(d["key"], c["key"], table, len(coders), 2))
    return rows


def _row(dim: str, code, table, n_coders: int, n_categories: int) -> dict:
    return {
        "dimension_key": dim,
        "code_key": code,
        "n_items": sum(1 for u in table if sum(v is not None for v in u) >= 2),
        "n_coders": n_coders,
        "pct": stats.percent_agreement(table),
        "kappa": stats.cohen_kappa(table) if n_coders == 2 else None,
        "alpha": stats.krippendorff_alpha(table),
        "ac1": stats.gwet_ac1(table, n_categories),
    }


def snapshot(conn: sqlite3.Connection, batch: sqlite3.Row) -> None:
    """Freeze the figures at close. Later codebook edits do not move them."""
    conn.execute("DELETE FROM agreement WHERE batch_id = ?", (batch["id"],))
    stamp = repo.now()
    conn.executemany(
        "INSERT INTO agreement (batch_id, dimension_key, code_key, n_items, n_coders, pct, kappa, alpha, ac1, computed_at)"
        " VALUES (:batch_id, :dimension_key, :code_key, :n_items, :n_coders, :pct, :kappa, :alpha, :ac1, :at)",
        [{**row, "batch_id": batch["id"], "at": stamp} for row in compute(conn, batch)],
    )


def for_batch(conn: sqlite3.Connection, batch_id: int) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM agreement WHERE batch_id = ? ORDER BY id", (batch_id,)).fetchall()


def history(conn: sqlite3.Connection, track_id: int) -> list[dict]:
    """One row per calibration round, and for the final pass, and dimension,
    averaged over the dimension's codes where the statistic is defined."""
    rows = conn.execute(
        "SELECT b.round_no, b.kind, b.title, b.id AS batch_id, v.n AS version_n, g.dimension_key,"
        " MAX(g.n_items) AS n_items, MAX(g.n_coders) AS n_coders,"
        " AVG(g.pct) AS pct, AVG(g.alpha) AS alpha, AVG(g.ac1) AS ac1"
        " FROM agreement g JOIN batch b ON b.id = g.batch_id"
        " LEFT JOIN codebook_version v ON v.id = b.version_id"
        " WHERE b.track_id = ? GROUP BY b.id, g.dimension_key ORDER BY b.id, g.dimension_key",
        (track_id,),
    ).fetchall()
    return [dict(r) for r in rows]
