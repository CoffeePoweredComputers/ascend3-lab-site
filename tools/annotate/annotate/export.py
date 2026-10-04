"""Tidy CSVs for analysis outside the tool, zipped.

This is the one place the student keys (hash, homework, project, and a
session's pid) leave the database, which is why only a lead can download it. People appear as their
coder code; no file contains an email address.
"""

from __future__ import annotations

import csv
import io
import sqlite3
import zipfile

from annotate import repo

ITEM_KEYS = "i.token, s.hash, s.homework, s.project"
ITEM_JOIN = "JOIN item i ON i.id = {on} JOIN source s ON s.id = i.source_id JOIN track t ON t.id = i.track_id"

QUERIES = {
    "items.csv": f"""
        SELECT {ITEM_KEYS}, s.submission_id, i.raw_path IS NOT NULL AS has_diagram,
               (SELECT COALESCE(SUM(n_words), 0) FROM item_text x WHERE x.item_id = i.id) AS reflection_words,
               st.status, st.legible, st.off_task, st.pii_visible, st.low_content, st.rotation,
               st.crop_w IS NOT NULL AS cropped, st.note
        FROM item_state st {ITEM_JOIN.format(on="st.item_id")}
        WHERE t.dataset_id = :dataset ORDER BY s.hash, s.homework
    """,
    # Every written part of every item, including the ones no page shows.
    "texts.csv": f"""
        SELECT {ITEM_KEYS}, x.part, x.hidden, x.text
        FROM item_text x {ITEM_JOIN.format(on="x.item_id")}
        WHERE t.dataset_id = :dataset ORDER BY s.hash, s.homework, x.ord, x.part
    """,
    # One row per code applied, from closed batches only: coding in an open
    # batch is blind, to leads as well. Consensus rows carry coder = CONSENSUS.
    "codes.csv": f"""
        SELECT {ITEM_KEYS}, CASE WHEN a.is_consensus = 1 THEN 'CONSENSUS' ELSE r.coder_code END AS coder,
               v.n AS codebook_version, d.part, d.key AS dimension, d.mode, c.key AS code,
               b.id AS batch_id, b.kind AS batch_kind, b.round_no
        FROM annotation an
        JOIN assignment a ON a.id = an.assignment_id
        JOIN code c ON c.id = an.code_id
        JOIN dimension d ON d.id = c.dimension_id
        JOIN batch b ON b.id = a.batch_id
        JOIN codebook_version v ON v.id = b.version_id
        LEFT JOIN roster r ON r.id = a.roster_id
        {ITEM_JOIN.format(on="a.item_id")}
        WHERE t.dataset_id = :dataset AND b.status = 'closed'
        ORDER BY b.id, i.token, coder, d.key, c.key
    """,
    # Who coded what. A done assignment with no codes.csv rows for a
    # multi-label dimension was coded "none apply" on that dimension.
    "assignments.csv": f"""
        SELECT {ITEM_KEYS}, CASE WHEN a.is_consensus = 1 THEN 'CONSENSUS' ELSE r.coder_code END AS coder,
               b.id AS batch_id, b.kind AS batch_kind, b.round_no, b.status AS batch_status, a.done_at
        FROM assignment a
        JOIN batch b ON b.id = a.batch_id
        LEFT JOIN roster r ON r.id = a.roster_id
        {ITEM_JOIN.format(on="a.item_id")}
        WHERE t.dataset_id = :dataset ORDER BY b.id, i.token, coder
    """,
    "memos.csv": """
        SELECT m.kind, r.coder_code AS coder, i.token, s.hash, s.homework, s.project,
               m.batch_id, m.code_key, m.body, m.created_at,
               (SELECT g.t_start_ms FROM segment g WHERE g.id = m.segment_id) AS line_start_ms
        FROM memo m
        JOIN track t ON t.id = m.track_id
        JOIN roster r ON r.id = m.roster_id
        LEFT JOIN item i ON i.id = m.item_id
        LEFT JOIN source s ON s.id = i.source_id
        WHERE t.dataset_id = :dataset
        ORDER BY m.id
    """,
    # Each person's own codes from open coding and what the merge made of
    # them. Held back, like codes.csv, until open coding is closed.
    "personal_codes.csv": """
        SELECT r.coder_code AS coder, p.id AS code_id, p.part, p.name, p.definition, p.origin,
               (SELECT COUNT(*) FROM pcode_use u WHERE u.pcode_id = p.id) AS cards,
               CASE WHEN p.dropped = 1 THEN 'dropped' ELSE COALESCE(m.name, '') END AS became
        FROM pcode p
        JOIN roster r ON r.id = p.roster_id
        JOIN track t ON t.id = p.track_id
        LEFT JOIN mcode m ON m.id = p.mcode_id
        WHERE t.dataset_id = :dataset AND p.status = 'own'
          AND p.track_id IN (SELECT track_id FROM batch WHERE kind = 'starter' AND status = 'closed')
        ORDER BY p.id
    """,
    "personal_code_cards.csv": f"""
        SELECT {ITEM_KEYS}, r.coder_code AS coder, p.id AS code_id
        FROM pcode_use u
        JOIN pcode p ON p.id = u.pcode_id
        JOIN roster r ON r.id = p.roster_id
        {ITEM_JOIN.format(on="u.item_id")}
        WHERE t.dataset_id = :dataset
          AND p.track_id IN (SELECT track_id FROM batch WHERE kind = 'starter' AND status = 'closed')
        ORDER BY p.id, i.token
    """,
    "agreement.csv": """
        SELECT b.id AS batch_id, b.round_no, b.title, v.n AS codebook_version,
               g.dimension_key AS dimension, g.code_key AS code, g.n_items, g.n_coders,
               g.pct, g.kappa, g.alpha, g.ac1, g.computed_at
        FROM agreement g
        JOIN batch b ON b.id = g.batch_id
        JOIN track t ON t.id = b.track_id
        LEFT JOIN codebook_version v ON v.id = b.version_id
        WHERE t.dataset_id = :dataset ORDER BY b.id, g.id
    """,
    # The team's themes, one row per code in each. A theme with no codes has one row.
    "themes.csv": """
        SELECT th.name AS theme, th.statement, tc.dimension_key AS dimension, tc.code_key AS code
        FROM theme th
        JOIN track t ON t.id = th.track_id
        LEFT JOIN theme_code tc ON tc.theme_id = th.id
        WHERE t.dataset_id = :dataset ORDER BY th.ord, th.id, tc.dimension_key, tc.code_key
    """,
    "codebook.csv": """
        SELECT v.n AS version, v.status, v.published_at, v.note,
               d.part, d.key AS dimension, d.name AS dimension_name, d.mode,
               c.key AS code, c.label, c.definition, c.include, c.exclude, c.example
        FROM code c
        JOIN dimension d ON d.id = c.dimension_id
        JOIN codebook_version v ON v.id = d.version_id
        JOIN track t ON t.id = v.track_id
        WHERE t.dataset_id = :dataset ORDER BY v.n, d.ord, c.ord
    """,
    # Where each episode of a recorded session sits in it, and the export's
    # own ids of its first and last transcript lines. Header only for a study
    # of another kind. Text is single-spaced on import, so words are spaces + 1.
    "episodes.csv": """
        SELECT i.token, se.pid, se.alias AS session, sp.seq AS episode, sp.t_start_ms, sp.t_end_ms,
               se.transcript_kind, se.transcript_version, se.cut_rule,
               f.src_id AS first_src_id, l.src_id AS last_src_id, sp.seg_last - sp.seg_first + 1 AS lines,
               (SELECT COALESCE(SUM(CASE WHEN g.text = '' THEN 0 ELSE LENGTH(g.text) - LENGTH(REPLACE(g.text, ' ', '')) + 1 END), 0)
                FROM segment g WHERE g.session_id = se.id AND g.seq BETWEEN sp.seg_first AND sp.seg_last) AS words
        FROM item_span sp
        JOIN item i ON i.id = sp.item_id
        JOIN track t ON t.id = i.track_id
        JOIN session se ON se.id = sp.session_id
        JOIN segment f ON f.session_id = se.id AND f.seq = sp.seg_first
        JOIN segment l ON l.session_id = se.id AND l.seq = sp.seg_last
        WHERE t.dataset_id = :dataset ORDER BY se.pid, sp.seq
    """,
}


FINAL = "final_codes.csv"
FILES = [*QUERIES, FINAL]


def table(conn: sqlite3.Connection, name: str, dataset_id: int) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    if name == FINAL:
        header, rows = final_codes(conn, dataset_id)
    else:
        cursor = conn.execute(QUERIES[name], {"dataset": dataset_id})
        header, rows = [column[0] for column in cursor.description], cursor
    writer.writerow(header)
    writer.writerows([_inert(cell) for cell in row] for row in rows)
    return out.getvalue()


def final_codes(conn: sqlite3.Connection, dataset_id: int) -> tuple[list[str], list[tuple]]:
    """What each item was finally coded as: one row per code on it, or one row
    with no code where nothing applied. `source` says how it was settled
    (see repo.final_codes). Held back until the final pass is closed."""
    header = ["token", "hash", "homework", "project", "codebook_version", "dimension", "code", "source"]
    rows = []
    for track in conn.execute("SELECT id FROM track WHERE dataset_id = ?", (dataset_id,)):
        deck = repo.production(conn, track["id"])
        if not deck or deck["status"] != "closed":
            continue
        version = conn.execute("SELECT n FROM codebook_version WHERE id = ?", (deck["version_id"],)).fetchone()["n"]
        keys = {c["id"]: (d["key"], c["key"]) for d in repo.version_tree(conn, deck["version_id"]) for c in d["codes"]}
        items = {r["id"]: tuple(r)[1:] for r in conn.execute(
            f"SELECT i.id, {ITEM_KEYS} FROM item i JOIN source s ON s.id = i.source_id WHERE i.track_id = ?", (track["id"],)
        )}
        for item_id, (codes, source) in repo.final_codes(conn, track["id"])["items"].items():
            for dimension, code in sorted(keys[c] for c in codes) or [("", "")]:
                rows.append((*items[item_id], version, dimension, code, source))
    return header, sorted(rows)


def _inert(cell):
    """Coders write some of these cells. A spreadsheet would run one that
    starts like a formula, so it gets a leading apostrophe."""
    if isinstance(cell, str) and cell[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + cell
    return cell


def bundle(conn: sqlite3.Connection, dataset_id: int) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.writestr(name, table(conn, name, dataset_id))
    return out.getvalue()
