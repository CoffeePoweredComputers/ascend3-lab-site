"""All SQL. Routes call these; nothing else writes queries.

Two rules are enforced here rather than in the routes, so there is one place
to read and to test them:

- ITEM_COLUMNS never includes the source's hash or submission id, nor a
  recorded session's participant id or video path. Whatever a page renders
  about an item comes through item_by_token / items_*, so a coder cannot be
  shown which student or participant an item came from. The video route alone
  reads the path, through media_path.
- visible_annotations returns only the caller's own work while a batch is
  open, and the personal-code functions take the caller's roster id. That
  holds for leads too. Everyone's personal codes and jots are read together
  only by merge_inputs / merge_view, which refuse until open coding is closed.
"""

from __future__ import annotations

import random
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
STATUSES = ("untriaged", "pii_hold", "cleared", "excluded")

ITEM_COLUMNS = """
    i.id, i.track_id, i.token, i.kind, i.raw_path, i.shuffle_key,
    s.homework, s.project,
    st.status, st.rotation, st.crop_x, st.crop_y, st.crop_w, st.crop_h,
    st.legible, st.off_task, st.pii_visible, st.low_content, st.note, st.rev,
    sp.seq AS span_seq, sp.t_start_ms AS span_start, sp.t_end_ms AS span_end, sp.seg_first, sp.seg_last,
    se.id AS session_id, se.alias, se.duration_ms, se.media_path IS NOT NULL AS has_media,
    (SELECT COUNT(*) FROM item_span x WHERE x.session_id = se.id) AS episodes
"""
# The span and session are there only for an episode of a recorded session;
# every other item has NULL in those columns.
ITEM_FROM = """
    FROM item i
    JOIN source s ON s.id = i.source_id
    JOIN item_state st ON st.item_id = i.id
    LEFT JOIN item_span sp ON sp.item_id = i.id
    LEFT JOIN session se ON se.id = sp.session_id
"""


def _items(conn: sqlite3.Connection, rows) -> list[dict]:
    """Item rows as dicts, each with its written parts under "texts". Hidden
    parts are left out here, so no page can show one; only the export reads them."""
    items = [dict(r) for r in rows]
    by_id = {i["id"]: i for i in items}
    for i in items:
        i["texts"] = []
    if items:
        marks = ",".join("?" * len(by_id))
        for t in conn.execute(
            f"SELECT item_id, part, text, n_words FROM item_text WHERE item_id IN ({marks}) AND hidden = 0 ORDER BY ord, part",
            list(by_id),
        ):
            by_id[t["item_id"]]["texts"].append(t)
    return items


class Refused(Exception):
    """A rule said no. The message is shown to the user."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_token() -> str:
    # Tokens are a join key in the export. One that starts with "-" is read by
    # a spreadsheet as a formula and shown as #NAME?.
    while (token := secrets.token_urlsafe(9)).startswith("-"):
        pass
    return token


# ---------------------------------------------------------------- tracks, roster


def tracks_for(conn: sqlite3.Connection, email: str, admin: bool = False) -> list[dict]:
    """The studies a person can open. A site admin can open every one, as a
    lead, with roster_id 0 where they are not on the team."""
    rows = conn.execute(
        "SELECT t.*, d.title AS dataset_title, d.kind AS dataset_kind, r.role, r.coder_code, r.id AS roster_id"
        " FROM track t JOIN dataset d ON d.id = t.dataset_id"
        " LEFT JOIN roster r ON r.track_id = t.id AND r.email = ? AND r.active = 1"
        " ORDER BY d.title, t.id",
        (email,),
    ).fetchall()
    if not admin:
        return [dict(r) for r in rows if r["roster_id"]]
    return [dict(r, role="lead", coder_code=r["coder_code"] or "admin", roster_id=r["roster_id"] or 0) for r in rows]


def roster(conn: sqlite3.Connection, track_id: int, active_only: bool = False) -> list[sqlite3.Row]:
    where = " AND active = 1" if active_only else ""
    return conn.execute(
        f"SELECT * FROM roster WHERE track_id = ?{where} ORDER BY coder_code", (track_id,)
    ).fetchall()


def _keep_a_lead(conn: sqlite3.Connection, track_id: int, roster_id: int, admin: bool) -> None:
    """A lead cannot take the last lead off a study: nobody on it could run
    it any more. A site admin can, because they run every study themselves."""
    if admin:
        return
    row = conn.execute("SELECT role, active FROM roster WHERE id = ?", (roster_id,)).fetchone()
    others = conn.execute(
        "SELECT COUNT(*) FROM roster WHERE track_id = ? AND role = 'lead' AND active = 1 AND id != ?", (track_id, roster_id)
    ).fetchone()[0]
    if row and row["role"] == "lead" and row["active"] and not others:
        raise Refused("A study needs at least one active lead.")


def add_roster(conn: sqlite3.Connection, track_id: int, email: str, role: str, admin: bool = False) -> None:
    email = email.strip().lower()
    if role not in ("coder", "lead"):
        raise Refused("Role must be coder or lead.")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise Refused("That does not look like an email address.")
    if team_locked(conn, track_id):
        raise Refused("The team is locked. Nobody joins once the work has been divided.")
    existing = conn.execute(
        "SELECT id FROM roster WHERE track_id = ? AND email = ?", (track_id, email)
    ).fetchone()
    if existing:
        if role != "lead":
            _keep_a_lead(conn, track_id, existing["id"], admin)
        conn.execute("UPDATE roster SET role = ?, active = 1 WHERE id = ?", (role, existing["id"]))
        return
    n = conn.execute("SELECT COUNT(*) FROM roster WHERE track_id = ?", (track_id,)).fetchone()[0]
    conn.execute(
        "INSERT INTO roster (track_id, email, coder_code, role) VALUES (?, ?, ?, ?)",
        (track_id, email, f"C{n + 1:02d}", role),
    )


def set_roster(conn: sqlite3.Connection, track_id: int, roster_id: int, role: str, active: bool, admin: bool = False) -> None:
    if role not in ("coder", "lead"):
        raise Refused("Role must be coder or lead.")
    if role != "lead" or not active:
        _keep_a_lead(conn, track_id, roster_id, admin)
    before = conn.execute("SELECT active FROM roster WHERE id = ? AND track_id = ?", (roster_id, track_id)).fetchone()
    locked = team_locked(conn, track_id)
    if before and locked and active and not before["active"]:
        raise Refused("The team is locked. Someone taken off it stays off.")
    conn.execute(
        "UPDATE roster SET role = ?, active = ? WHERE id = ? AND track_id = ?",
        (role, int(active), roster_id, track_id),
    )
    if locked and before and before["active"] and not active:
        divide_cleaning(conn, track_id)  # their photos go to the people still on the team


def leads_whole_dataset(conn: sqlite3.Connection, dataset_id: int, email: str) -> bool:
    return not conn.execute(
        "SELECT 1 FROM track t WHERE t.dataset_id = ? AND NOT EXISTS"
        " (SELECT 1 FROM roster r WHERE r.track_id = t.id AND r.email = ? AND r.role = 'lead' AND r.active = 1)",
        (dataset_id, email),
    ).fetchone()


# ------------------------------------------------------------------------ stages


def has_started(conn: sqlite3.Connection, track: sqlite3.Row, email: str) -> bool:
    """Past the trailhead: pressed Start, or simply got on with the work."""
    return bool(conn.execute(
        "SELECT EXISTS (SELECT 1 FROM started WHERE dataset_id = :dataset AND email = :email)"
        " OR EXISTS (SELECT 1 FROM memo m JOIN roster r ON r.id = m.roster_id"
        "            WHERE m.track_id = :track AND r.email = :email)"
        " OR EXISTS (SELECT 1 FROM assignment a JOIN roster r ON r.id = a.roster_id"
        "            WHERE r.track_id = :track AND r.email = :email AND a.done_at IS NOT NULL)"
        " OR EXISTS (SELECT 1 FROM item_state st JOIN item i ON i.id = st.item_id"
        "            WHERE i.track_id = :track AND st.updated_by = :email)"
        " OR EXISTS (SELECT 1 FROM seen sn JOIN roster r ON r.id = sn.roster_id"
        "            WHERE r.track_id = :track AND r.email = :email)",
        {"dataset": track["dataset_id"], "track": track["id"], "email": email},
    ).fetchone()[0])


def start(conn: sqlite3.Connection, dataset_id: int, email: str) -> None:
    conn.execute("INSERT OR IGNORE INTO started (dataset_id, email, at) VALUES (?, ?, ?)", (dataset_id, email, now()))


def triage_counts(conn: sqlite3.Connection, track_id: int) -> dict[str, int]:
    counts = dict.fromkeys(STATUSES, 0)
    for row in conn.execute(
        "SELECT st.status, COUNT(*) AS n FROM item i JOIN item_state st ON st.item_id = i.id"
        " WHERE i.track_id = ? GROUP BY st.status",
        (track_id,),
    ):
        counts[row["status"]] = row["n"]
    return counts


def stage_marks(conn: sqlite3.Connection, track_id: int) -> set[int]:
    return {r["stage"] for r in conn.execute("SELECT stage FROM stage_done WHERE track_id = ?", (track_id,))}


# The stages the lead finishes for the team, in order: onboarding (which
# locks the team), clean and read, questions, open coding, codebook,
# calibration, production. Finishing one opens the next.
TEAM_STAGES = (0, 1, 2, 3, 4, 5, 6)
WEAK_ALPHA = 0.67  # below this a code's agreement is called weak


def team_locked(conn: sqlite3.Connection, track_id: int) -> bool:
    """The lead has finished onboarding: everyone is in, nobody else joins,
    and the cleaning has been divided among them."""
    return 0 in stage_marks(conn, track_id)


def divide_cleaning(conn: sqlite3.Connection, track_id: int) -> int:
    """Give every uncleaned photo that has no one, or has someone no longer
    on the team, to whoever on the team has the fewest. Returns how many moved."""
    people = [r["id"] for r in roster(conn, track_id, active_only=True)]
    if not people:
        return 0
    load = dict.fromkeys(people, 0)
    todo = []
    for r in conn.execute(
        "SELECT i.id, c.roster_id FROM item i JOIN item_state st ON st.item_id = i.id LEFT JOIN cleaning c ON c.item_id = i.id"
        " WHERE i.track_id = ? AND st.status = 'untriaged' ORDER BY i.shuffle_key",
        (track_id,),
    ):
        if r["roster_id"] in load:
            load[r["roster_id"]] += 1
        else:
            todo.append(r["id"])
    for item_id in todo:
        who = min(people, key=lambda p: load[p])
        load[who] += 1
        conn.execute("INSERT OR REPLACE INTO cleaning (item_id, roster_id) VALUES (?, ?)", (item_id, who))
    return len(todo)


def cleaning_left(conn: sqlite3.Connection, track_id: int) -> dict[int, int]:
    """{roster id: photos they still have to clean}. Photos that belong to
    nobody (loaded after the team was locked) are under 0: anyone can take them."""
    return {r["who"]: r["n"] for r in conn.execute(
        "SELECT COALESCE(c.roster_id, 0) AS who, COUNT(*) AS n FROM item i JOIN item_state st ON st.item_id = i.id"
        " LEFT JOIN cleaning c ON c.item_id = i.id WHERE i.track_id = ? AND st.status = 'untriaged' GROUP BY who",
        (track_id,),
    )}


def is_open(conn: sqlite3.Connection, track_id: int, stage: int) -> bool:
    """A stage is open once the lead has finished every team stage before it."""
    marks = stage_marks(conn, track_id)
    return all(n in marks for n in TEAM_STAGES if n < stage)


def require_open(conn: sqlite3.Connection, track_id: int, stage: int) -> None:
    if not is_open(conn, track_id, stage):
        raise Refused("That stage is locked until the lead opens it.")


def set_stage_done(conn: sqlite3.Connection, track_id: int, stage: int, done: bool, by: str) -> None:
    """The lead finishing a stage is what opens the next one for everyone."""
    if stage not in TEAM_STAGES:
        raise Refused("That stage is not one the lead finishes.")
    if done:
        require_open(conn, track_id, stage)
        if stage == 0:
            track = conn.execute("SELECT * FROM track WHERE id = ?", (track_id,)).fetchone()
            out = [r["email"].split("@")[0] for r in roster(conn, track_id, active_only=True) if not has_started(conn, track, r["email"])]
            if out:
                raise Refused("Not started yet: " + ", ".join(out) + ". Wait for them, or take them off the roster.")
        counts = triage_counts(conn, track_id)
        if stage == 1 and counts["pii_hold"]:
            raise Refused(f"{counts['pii_hold']} flagged card(s) are waiting for you. Keep or exclude them first.")
        if stage == 1 and counts["untriaged"]:
            raise Refused(f"{counts['untriaged']} card(s) have not been cleaned yet. Nobody has reached them.")
        if stage == 3 and not (starter(conn, track_id) or {"status": ""})["status"] == "closed":
            raise Refused("Close the open-coding deck first.")
        if stage == 4 and not latest_published(conn, track_id):
            raise Refused("Publish the codebook first.")
        if stage == 5:
            # No bar on the figures: the lead decides. But the codebook that
            # goes into the final pass must have been tried.
            version = latest_published(conn, track_id)
            if not conn.execute(
                "SELECT 1 FROM batch WHERE track_id = ? AND kind = 'calibration' AND status = 'closed' AND version_id = ?",
                (track_id, version["id"]),
            ).fetchone():
                raise Refused(f"Run a calibration round on codebook v{version['n']} first.")
        if stage == 6:
            deck = production(conn, track_id)
            if not deck or deck["status"] != "closed":
                raise Refused("Close the production deck first.")
            if left := len(final_codes(conn, track_id)["unresolved"]):
                raise Refused(f"{left} doubled card(s) still need a consensus.")
    conn.execute("DELETE FROM stage_done WHERE track_id = ? AND stage = ?", (track_id, stage))
    if done:
        conn.execute(
            "INSERT INTO stage_done (track_id, stage, done_by, done_at) VALUES (?, ?, ?, ?)",
            (track_id, stage, by, now()),
        )
        if stage == 0:
            divide_cleaning(conn, track_id)


# ------------------------------------------------------------------------- items


def item_by_token(conn: sqlite3.Connection, token: str) -> Optional[dict]:
    rows = conn.execute(f"SELECT {ITEM_COLUMNS} {ITEM_FROM} WHERE i.token = ?", (token,)).fetchall()
    return _items(conn, rows)[0] if rows else None


def items_with_status(conn: sqlite3.Connection, track_id: int, statuses: Iterable[str]) -> list[dict]:
    statuses = list(statuses)
    marks = ",".join("?" * len(statuses))
    return _items(conn, conn.execute(
        f"SELECT {ITEM_COLUMNS} {ITEM_FROM} WHERE i.track_id = ? AND st.status IN ({marks})"
        " ORDER BY i.shuffle_key",
        (track_id, *statuses),
    ).fetchall())


def segments(conn: sqlite3.Connection, session_id: int, from_ms: int, to_ms: int) -> list[sqlite3.Row]:
    """A session's transcript lines that start in [from_ms, to_ms), in order."""
    return conn.execute(
        "SELECT seq, t_start_ms, t_end_ms, speaker, text FROM segment"
        " WHERE session_id = ? AND t_start_ms >= ? AND t_start_ms < ? ORDER BY seq",
        (session_id, from_ms, to_ms),
    ).fetchall()


def media_path(conn: sqlite3.Connection, token: str) -> Optional[str]:
    """The item's video, relative to the raw directory. For the video route
    only: no page is given the path."""
    row = conn.execute(
        "SELECT se.media_path FROM item i JOIN item_span sp ON sp.item_id = i.id JOIN session se ON se.id = sp.session_id"
        " WHERE i.token = ?",
        (token,),
    ).fetchone()
    return row["media_path"] if row else None


def can_view_item(item: dict, role: str) -> bool:
    """Held and excluded items are for leads. Everyone on the roster sees the rest."""
    return role == "lead" or item["status"] in ("untriaged", "cleared")


def save_triage(
    conn: sqlite3.Connection,
    item: sqlite3.Row,
    role: str,
    by: str,
    action: str,
    rotation: int,
    crop: Optional[tuple[float, float, float, float]],
    flags: dict[str, bool],
    note: str,
) -> str:
    """Change an item's cleaning: its turn, crop, flags and whether it is in
    the data. `action` is save (turn or crop only), clear (keep it), exclude,
    or reopen (a lead taking it back). Returns the item's new status."""
    if role != "lead" and item["status"] != "untriaged":
        raise Refused("This item has already been triaged. Ask a lead to reopen it.")
    if rotation not in (0, 90, 180, 270):
        raise Refused("Rotation must be 0, 90, 180 or 270.")
    if crop is not None:
        x, y, w, h = crop
        if not (0 <= x < 1 and 0 <= y < 1 and 0.02 < w <= 1 and 0.02 < h <= 1 and x + w <= 1.001 and y + h <= 1.001):
            raise Refused("The crop rectangle is outside the image.")
    if rotation != item["rotation"]:
        crop = None  # a rectangle drawn on the old orientation no longer fits

    if action == "save":
        status = item["status"]
    elif action == "exclude":
        status = "excluded"
    elif action == "reopen" and role == "lead":
        # Back to the lead, not to everyone: an uncleaned photo is shown
        # uncropped to whoever opens it.
        status = "pii_hold"
    elif action == "clear":
        status = "cleared"
    else:
        raise Refused("Unknown action.")

    conn.execute(
        "UPDATE item_state SET status = ?, rotation = ?, crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?,"
        " legible = ?, off_task = ?, pii_visible = ?, low_content = ?, note = ?,"
        " rev = rev + 1, updated_by = ?, updated_at = ? WHERE item_id = ?",
        (
            status,
            rotation,
            *(crop or (None, None, None, None)),
            int(flags["legible"]),
            int(flags["off_task"]),
            int(flags["pii_visible"]),
            int(flags["low_content"]),
            note.strip()[:2000],
            by,
            now(),
            item["id"],
        ),
    )
    if status != "cleared":
        _pull_from_open_batches(conn, item["id"])
    return status


def _pull_from_open_batches(conn: sqlite3.Connection, item_id: int) -> None:
    """An item that is no longer cleared leaves the batches still being coded,
    so coders are not shown it or made to code it. Closed batches are history."""
    open_batches = "SELECT id FROM batch WHERE status = 'open'"
    in_open = f"SELECT 1 FROM assignment WHERE item_id = ? AND batch_id IN ({open_batches} AND kind = 'starter')"
    if conn.execute(in_open, (item_id,)).fetchone():
        conn.execute("DELETE FROM pcode_use WHERE item_id = ?", (item_id,))
        conn.execute("UPDATE pcode SET example_item_id = NULL WHERE example_item_id = ?", (item_id,))
    conn.execute(
        f"DELETE FROM annotation WHERE assignment_id IN"
        f" (SELECT id FROM assignment WHERE item_id = ? AND batch_id IN ({open_batches}))",
        (item_id,),
    )
    conn.execute(f"DELETE FROM assignment WHERE item_id = ? AND batch_id IN ({open_batches})", (item_id,))


PASS = ("untriaged", "cleared")  # what a person's own pass goes through


def flag_item(conn: sqlite3.Connection, item: dict, by: str, reason: str, note: str) -> None:
    """Someone thinks this item should not be in the data. It leaves
    everyone's cards until a lead keeps or excludes it."""
    if item["status"] not in PASS:
        raise Refused("That card is already with the lead.")
    conn.execute(
        "UPDATE item_state SET status = 'pii_hold', note = ?, pii_visible = ?, legible = ?, off_task = ?,"
        " rev = rev + 1, updated_by = ?, updated_at = ? WHERE item_id = ?",
        (note.strip()[:2000], int(reason == "identifying"), int(reason != "unreadable"), int(reason == "off_task"), by, now(), item["id"]),
    )
    _pull_from_open_batches(conn, item["id"])


# ---------------------------------------------------------------- reading pass


def mark_seen(conn: sqlite3.Connection, item_id: int, roster_id: int) -> bool:
    """Returns False if this person had already been past the item."""
    return conn.execute(
        "INSERT OR IGNORE INTO seen (item_id, roster_id, at) VALUES (?, ?, ?)", (item_id, roster_id, now())
    ).rowcount == 1


def seen_ids(conn: sqlite3.Connection, track_id: int, roster_id: int) -> set[int]:
    """The items in the data that this person has read."""
    return {r["item_id"] for r in conn.execute(
        "SELECT sn.item_id FROM seen sn JOIN item i ON i.id = sn.item_id JOIN item_state st ON st.item_id = i.id"
        " WHERE i.track_id = ? AND sn.roster_id = ? AND st.status = 'cleared'",
        (track_id, roster_id),
    )}


def _next(conn: sqlite3.Connection, track_id: int, where: str, args: tuple, after: float) -> Optional[dict]:
    """The next item after a point in the order, going round to the start
    when the end is reached."""
    for start in (after, -1.0):
        rows = conn.execute(
            f"SELECT {ITEM_COLUMNS} {ITEM_FROM} WHERE i.track_id = ? AND i.shuffle_key > ? AND {where}"
            " ORDER BY i.shuffle_key LIMIT 1",
            (track_id, start, *args),
        ).fetchall()
        if rows:
            return _items(conn, rows)[0]
    return None


def _start(roster_id: int) -> float:
    """Each person starts at a different point in the order, so two people
    working at once are rarely on the same card."""
    return (roster_id * 0.6180339887) % 1


def _reading_start(conn: sqlite3.Connection, track_id: int, roster_id: int) -> float:
    """Where this person's reading pass begins. Recorded sessions are read a
    whole session at a time, so there it is just before the first episode of
    a session, a different one for each person."""
    firsts = [r[0] for r in conn.execute(
        "SELECT MIN(i.shuffle_key) AS k FROM item i JOIN item_span sp ON sp.item_id = i.id"
        " WHERE i.track_id = ? GROUP BY sp.session_id ORDER BY k",
        (track_id,),
    )]
    if not firsts:
        return _start(roster_id)
    first = firsts[int(_start(roster_id) * len(firsts))]
    before = conn.execute("SELECT MAX(shuffle_key) FROM item WHERE track_id = ? AND shuffle_key < ?", (track_id, first)).fetchone()[0]
    return -1.0 if before is None else before


def next_unseen(conn: sqlite3.Connection, track_id: int, roster_id: int, after: Optional[float] = None) -> Optional[dict]:
    """The next card of this person's reading pass: in the data, not yet read by them."""
    where = "st.status = 'cleared' AND i.id NOT IN (SELECT item_id FROM seen WHERE roster_id = ?)"
    return _next(conn, track_id, where, (roster_id,), _reading_start(conn, track_id, roster_id) if after is None else after)


def reading_sessions(conn: sqlite3.Connection, track_id: int, roster_id: int) -> list[dict]:
    """Recorded sessions, one row each, for one person's reading: how many of
    its episodes in the data they have read, and the token to go on from (the
    first unread, or the first once all are read). Empty for other studies."""
    out: dict[int, dict] = {}
    for r in conn.execute(
        "SELECT se.id, se.alias, i.token, i.id IN (SELECT item_id FROM seen WHERE roster_id = ?) AS read"
        " FROM item i JOIN item_state st ON st.item_id = i.id"
        " JOIN item_span sp ON sp.item_id = i.id JOIN session se ON se.id = sp.session_id"
        " WHERE i.track_id = ? AND st.status = 'cleared' ORDER BY se.alias, sp.seq",
        (roster_id, track_id),
    ):
        s = out.setdefault(r["id"], {"id": r["id"], "alias": r["alias"], "n": 0, "read": 0, "next": None, "first": r["token"]})
        s["n"] += 1
        s["read"] += r["read"]
        if not r["read"] and not s["next"]:
            s["next"] = r["token"]
    for s in out.values():
        s["done"] = s["read"] == s["n"]
        s["next"] = s["next"] or s["first"]
    return list(out.values())


MINE_TO_CLEAN = "COALESCE((SELECT roster_id FROM cleaning WHERE item_id = i.id), ?) = ?"


def next_uncleaned(conn: sqlite3.Connection, track_id: int, roster_id: int, after: Optional[float] = None) -> Optional[dict]:
    """The next photo this person is to turn and crop: one of theirs, or one
    that belongs to nobody."""
    where = f"st.status = 'untriaged' AND {MINE_TO_CLEAN}"
    return _next(conn, track_id, where, (roster_id, roster_id), _start(roster_id) if after is None else after)


def neighbours(conn: sqlite3.Connection, track_id: int, roster_id: int, item: dict) -> tuple[Optional[str], Optional[str]]:
    """The cards either side of this one in the person's order, read or not,
    so a card passed by mistake is one key away. While cleaning, that is the
    photos that are theirs to clean; while reading, every card in the data."""
    if item["status"] == "untriaged":
        where = "st.status = 'untriaged' AND COALESCE((SELECT roster_id FROM cleaning WHERE item_id = i.id), :r) = :r"
    else:
        where = "st.status = 'cleared'"
    def one(op: str, order: str) -> str:
        return f"SELECT i.token FROM item i JOIN item_state st ON st.item_id = i.id WHERE i.track_id = :t AND {where} AND i.shuffle_key {op} :k ORDER BY i.shuffle_key {order} LIMIT 1"

    row = conn.execute(
        f"SELECT ({one('<', 'DESC')}) AS back, ({one('>', 'ASC')}) AS forward",
        {"t": track_id, "k": item["shuffle_key"], "r": roster_id},
    ).fetchone()
    return row["back"], row["forward"]


def cleaner(conn: sqlite3.Connection, item_id: int) -> Optional[int]:
    row = conn.execute("SELECT roster_id FROM cleaning WHERE item_id = ?", (item_id,)).fetchone()
    return row["roster_id"] if row else None


def next_held(conn: sqlite3.Connection, track_id: int) -> Optional[dict]:
    held = items_with_status(conn, track_id, ["pii_hold"])
    return held[0] if held else None


# ------------------------------------------------------------------- elevation

FEET = {"triaged": 10, "coded": 25, "memo": 50, "rq": 50, "jotting": 5}


def feet(conn: sqlite3.Connection, track_id: int, roster_id: Optional[int] = None, email: Optional[str] = None) -> int:
    """Elevation gained on a track: one person's, or with neither id nor email
    given, the whole team's."""
    mine = " AND a.roster_id = ?" if roster_id else ""
    coded = conn.execute(
        "SELECT COUNT(*) FROM assignment a JOIN batch b ON b.id = a.batch_id"
        f" WHERE b.track_id = ? AND a.done_at IS NOT NULL AND a.is_consensus = 0{mine}",
        (track_id, roster_id) if roster_id else (track_id,),
    ).fetchone()[0]
    read = conn.execute(
        "SELECT COUNT(*) FROM seen sn JOIN item i ON i.id = sn.item_id"
        f" WHERE i.track_id = ?{' AND sn.roster_id = ?' if roster_id else ''}",
        (track_id, roster_id) if roster_id else (track_id,),
    ).fetchone()[0]
    # A photo cleaned: turned, cropped and kept, flagged or settled.
    cleaned = conn.execute(
        "SELECT COUNT(*) FROM item i JOIN item_state st ON st.item_id = i.id"
        " WHERE i.track_id = ? AND i.raw_path IS NOT NULL AND st.status != 'untriaged'"
        + (" AND st.updated_by = ?" if email else " AND st.updated_by IS NOT NULL AND st.updated_by != 'seed'"),
        (track_id, email) if email else (track_id,),
    ).fetchone()[0]
    total = FEET["triaged"] * (read + cleaned) + FEET["coded"] * coded
    mine = " AND roster_id = ?" if roster_id else ""
    for row in conn.execute(
        f"SELECT kind, COUNT(*) AS n FROM memo WHERE track_id = ?{mine} GROUP BY kind",
        (track_id, roster_id) if roster_id else (track_id,),
    ):
        total += FEET.get(row["kind"], 0) * row["n"]
    return total


def trail_stats(conn: sqlite3.Connection, track_id: int, me: sqlite3.Row) -> dict:
    """Elevation gained: feet for work done, never for speed or for agreeing
    with anyone. A coder sees their own figure and the team's total only."""
    days = {
        r[0] for r in conn.execute(
            "SELECT substr(a.done_at, 1, 10) FROM assignment a WHERE a.roster_id = ? AND a.done_at IS NOT NULL"
            " UNION SELECT substr(created_at, 1, 10) FROM memo WHERE roster_id = ?"
            " UNION SELECT substr(at, 1, 10) FROM seen WHERE roster_id = ?"
            " UNION SELECT substr(st.updated_at, 1, 10) FROM item_state st JOIN item i ON i.id = st.item_id"
            "       WHERE i.track_id = ? AND st.updated_by = ?",
            (me["id"], me["id"], me["id"], track_id, me["email"]),
        )
    }
    day = datetime.now(timezone.utc).date()
    if day.isoformat() not in days:
        day -= timedelta(days=1)  # today's work may not have started yet
    streak = 0
    while day.isoformat() in days:
        streak, day = streak + 1, day - timedelta(days=1)
    return {"feet": feet(conn, track_id, me["id"], me["email"]), "team_feet": feet(conn, track_id), "streak": streak}


# ------------------------------------------------------------------------- memos


def add_memo(
    conn: sqlite3.Connection,
    track_id: int,
    roster_id: int,
    kind: str,
    body: str,
    item_id: Optional[int] = None,
    batch_id: Optional[int] = None,
    code_key: Optional[str] = None,
) -> None:
    body = body.strip()
    if not body:
        raise Refused("Nothing to save: the text is empty.")
    conn.execute(
        "INSERT INTO memo (track_id, roster_id, kind, item_id, batch_id, code_key, body, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (track_id, roster_id, kind, item_id, batch_id, code_key or None, body[:10000], now()),
    )


def set_jotting(conn: sqlite3.Connection, track_id: int, roster_id: int, item_id: int, body: str) -> bool:
    """One jot per person per card, written in place. Returns True when this
    is the card's first jot by them. Earlier separate jots on the card fold
    into the one being written."""
    body = body.strip()
    if not body:
        raise Refused("Nothing to save: the text is empty.")
    rows = conn.execute(
        "SELECT id FROM memo WHERE roster_id = ? AND item_id = ? AND kind = 'jotting' ORDER BY id", (roster_id, item_id)
    ).fetchall()
    if not rows:
        add_memo(conn, track_id, roster_id, "jotting", body, item_id=item_id)
        return True
    conn.execute("UPDATE memo SET body = ? WHERE id = ?", (body[:10000], rows[0]["id"]))
    conn.executemany("DELETE FROM memo WHERE id = ?", [(r["id"],) for r in rows[1:]])
    return False


def my_jot(conn: sqlite3.Connection, roster_id: int, item_id: int) -> str:
    """What this person has jotted on a card, as the text of one box."""
    return "\n\n".join(r["body"] for r in reversed(my_jottings(conn, roster_id, item_id)))


def shared_memos(conn: sqlite3.Connection, track_id: int, kind: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT m.*, r.coder_code FROM memo m JOIN roster r ON r.id = m.roster_id"
        " WHERE m.track_id = ? AND m.kind = ? ORDER BY m.id DESC",
        (track_id, kind),
    ).fetchall()


def my_jottings(conn: sqlite3.Connection, roster_id: int, item_id: Optional[int] = None) -> list[sqlite3.Row]:
    sql = (
        "SELECT m.*, i.token FROM memo m JOIN item i ON i.id = m.item_id"
        " WHERE m.roster_id = ? AND m.kind = 'jotting'"
    )
    args: list = [roster_id]
    if item_id is not None:
        sql += " AND m.item_id = ?"
        args.append(item_id)
    return conn.execute(sql + " ORDER BY m.id DESC", args).fetchall()


def jots_frozen(conn: sqlite3.Connection, track_id: int, roster_id: int) -> bool:
    """Generating candidate codes closes a person's jotting: the candidates
    were made from the jots as they stood."""
    row = job(conn, track_id, "candidates", roster_id)
    return bool(row) and row["status"] != "failed"


# ---------------------------------------------------------------- personal codes
#
# During open coding each person builds their own codebook. Every function
# here takes the owner's roster id, so one person's codes cannot be read
# through another's page.


def _norm(name: str) -> str:
    return " ".join(name.lower().split())


def starter(conn: sqlite3.Connection, track_id: int) -> Optional[sqlite3.Row]:
    """The open-coding deck. A study has one, dealt to everyone."""
    return conn.execute(
        "SELECT * FROM batch WHERE track_id = ? AND kind = 'starter' ORDER BY id LIMIT 1", (track_id,)
    ).fetchone()


def _codes_frozen(conn: sqlite3.Connection, track_id: int) -> None:
    deck = starter(conn, track_id)
    if deck and deck["status"] == "closed":
        raise Refused("Open coding is closed, so your codes are fixed as they were merged.")


def my_codes(conn: sqlite3.Connection, track_id: int, roster_id: int) -> list[dict]:
    """This person's codes and unused candidates, oldest first, with how many
    cards each is on, its example card and what the merge made of it."""
    return [dict(r) for r in conn.execute(
        "SELECT p.*, (SELECT COUNT(*) FROM pcode_use u WHERE u.pcode_id = p.id) AS uses,"
        " COALESCE(i.token, (SELECT i2.token FROM pcode_use u JOIN item i2 ON i2.id = u.item_id"
        "                    WHERE u.pcode_id = p.id ORDER BY i2.shuffle_key LIMIT 1)) AS example_token,"
        " m.name AS became"
        " FROM pcode p LEFT JOIN item i ON i.id = p.example_item_id LEFT JOIN mcode m ON m.id = p.mcode_id"
        " WHERE p.track_id = ? AND p.roster_id = ? ORDER BY p.id",
        (track_id, roster_id),
    )]


def codes_on(conn: sqlite3.Connection, roster_id: int, item_id: int) -> set[int]:
    return {r["pcode_id"] for r in conn.execute(
        "SELECT u.pcode_id FROM pcode_use u JOIN pcode p ON p.id = u.pcode_id WHERE p.roster_id = ? AND u.item_id = ?",
        (roster_id, item_id),
    )}


def add_candidates(conn: sqlite3.Connection, track_id: int, roster_id: int, candidates: list[dict]) -> int:
    """Store the model's proposals for one person. They are not codes until
    that person clicks one."""
    have = {(_norm(c["name"]), c["part"]) for c in my_codes(conn, track_id, roster_id)}
    added = 0
    for c in candidates:
        key = (_norm(c["name"]), c["part"])
        if not key[0] or key in have:
            continue
        have.add(key)
        conn.execute(
            "INSERT INTO pcode (track_id, roster_id, name, definition, part, status, origin, created_at)"
            " VALUES (?, ?, ?, ?, ?, 'candidate', 'model', ?)",
            (track_id, roster_id, c["name"].strip()[:80], c["definition"].strip()[:1000], c["part"], now()),
        )
        added += 1
    return added


def save_card_codes(
    conn: sqlite3.Connection,
    track_id: int,
    roster_id: int,
    item_id: int,
    chosen: set[int],
    new: Optional[tuple[str, str, str]],
    parts: tuple[str, ...],
) -> None:
    """Set which of this person's codes are on one card. `chosen` may include
    candidates, which become the person's own on first use. `new` is
    (name, definition, part) for a code made on this card."""
    _codes_frozen(conn, track_id)
    mine = {c["id"]: c for c in my_codes(conn, track_id, roster_id)}
    if not chosen <= set(mine):
        raise Refused("That is not one of your codes.")
    chosen = set(chosen)
    if new:
        name, definition, part = (v.strip() for v in new)
        if part not in parts:
            raise Refused("A code is about: " + ", ".join(parts) + ".")
        same = next((c for c in mine.values() if _norm(c["name"]) == _norm(name) and c["part"] == part), None)
        if same:
            chosen.add(same["id"])  # they already have it; use that one
        else:
            if not definition:
                raise Refused("Write a definition for the new code.")
            chosen.add(conn.execute(
                "INSERT INTO pcode (track_id, roster_id, name, definition, part, example_item_id, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (track_id, roster_id, name[:80], definition[:1000], part, item_id, now()),
            ).lastrowid)
    conn.execute(
        "DELETE FROM pcode_use WHERE item_id = ? AND pcode_id IN (SELECT id FROM pcode WHERE roster_id = ?)",
        (item_id, roster_id),
    )
    conn.executemany("INSERT INTO pcode_use (pcode_id, item_id) VALUES (?, ?)", [(c, item_id) for c in chosen])
    marks = ",".join("?" * len(chosen))
    # A candidate becomes the person's own code on the first card it is used
    # on, and that card is its example.
    conn.execute(
        f"UPDATE pcode SET status = 'own', example_item_id = COALESCE(example_item_id, ?) WHERE id IN ({marks})",
        (item_id, *chosen),
    )


def edit_pcode(
    conn: sqlite3.Connection, track_id: int, roster_id: int, pcode_id: int, name: str, definition: str, part: str, parts: tuple[str, ...]
) -> None:
    """Rename or redefine one of your codes. It is one code, so the change
    shows on every card it is on. Renaming it to a name you already have
    folds the two together."""
    _codes_frozen(conn, track_id)
    mine = {c["id"]: c for c in my_codes(conn, track_id, roster_id) if c["status"] == "own"}
    if pcode_id not in mine:
        raise Refused("That is not one of your codes.")
    name, definition = name.strip(), definition.strip()
    if not name or not definition:
        raise Refused("A code needs a name and a definition.")
    if part not in parts:
        raise Refused("A code is about: " + ", ".join(parts) + ".")
    twin = next((c for c in mine.values() if c["id"] != pcode_id and _norm(c["name"]) == _norm(name) and c["part"] == part), None)
    if twin:
        conn.execute("INSERT OR IGNORE INTO pcode_use (pcode_id, item_id) SELECT ?, item_id FROM pcode_use WHERE pcode_id = ?", (twin["id"], pcode_id))
        conn.execute("DELETE FROM pcode_use WHERE pcode_id = ?", (pcode_id,))
        conn.execute("DELETE FROM pcode WHERE id = ?", (pcode_id,))
        # The definition just typed is the one they mean for the folded code.
        conn.execute("UPDATE pcode SET definition = ? WHERE id = ?", (definition[:1000], twin["id"]))
        return
    conn.execute("UPDATE pcode SET name = ?, definition = ?, part = ? WHERE id = ?", (name[:80], definition[:1000], part, pcode_id))


# ------------------------------------------------------------------------- jobs


JOB_DEADLINE = timedelta(minutes=10)


def job(conn: sqlite3.Connection, track_id: int, kind: str, roster_id: int = 0) -> Optional[dict]:
    """A model run, or None if it was never started. One left 'working' past
    the deadline (the process was restarted under it) reads as failed."""
    row = conn.execute(
        "SELECT * FROM job WHERE track_id = ? AND kind = ? AND roster_id = ?", (track_id, kind, roster_id)
    ).fetchone()
    if not row:
        return None
    row = dict(row)
    if row["status"] == "working" and datetime.fromisoformat(row["started_at"]) + JOB_DEADLINE < datetime.now(timezone.utc):
        row.update(status="failed", detail="It stopped before finishing.")
    return row


def start_job(conn: sqlite3.Connection, track_id: int, kind: str, roster_id: int, by: str) -> None:
    """Each job runs once. Only one that failed can be started again."""
    existing = job(conn, track_id, kind, roster_id)
    if existing and existing["status"] != "failed":
        raise Refused("That has already been run." if existing["status"] == "ready" else "That is already running.")
    conn.execute(
        "INSERT OR REPLACE INTO job (track_id, kind, roster_id, status, started_by, started_at) VALUES (?, ?, ?, 'working', ?, ?)",
        (track_id, kind, roster_id, by, now()),
    )


def finish_job(conn: sqlite3.Connection, track_id: int, kind: str, roster_id: int, status: str, detail: str) -> None:
    conn.execute(
        "UPDATE job SET status = ?, detail = ?, finished_at = ? WHERE track_id = ? AND kind = ? AND roster_id = ?",
        (status, detail[:500], now(), track_id, kind, roster_id),
    )


def candidate_inputs(conn: sqlite3.Connection, track_id: int, roster_id: int) -> dict:
    """What the model is given for one person: their own jots, each with the
    item it is about, and the questions the team has shared. Nobody else's work."""
    jots = conn.execute(
        "SELECT m.body, m.item_id FROM memo m JOIN item_state st ON st.item_id = m.item_id"
        " WHERE m.track_id = ? AND m.roster_id = ? AND m.kind = 'jotting' AND st.status = 'cleared'"
        " ORDER BY m.id DESC LIMIT 200",
        (track_id, roster_id),
    ).fetchall()
    texts = _texts(conn, {j["item_id"] for j in jots})
    return {
        "jots": [{"item": texts.get(j["item_id"], ""), "jot": j["body"][:500]} for j in jots],
        "questions": [m["body"][:500] for m in shared_memos(conn, track_id, "rq")],
    }


def _texts(conn: sqlite3.Connection, item_ids: Iterable[int]) -> dict[int, str]:
    """Each item's visible written parts as one string, for the model and for
    examples. Hidden parts are left out, as on every page."""
    ids = list(item_ids)
    out: dict[int, list[str]] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for t in conn.execute(
            f"SELECT item_id, part, text FROM item_text WHERE hidden = 0 AND item_id IN ({','.join('?' * len(chunk))}) ORDER BY ord, part",
            chunk,
        ):
            out.setdefault(t["item_id"], []).append(f"{t['part']}: {t['text'][:600]}")
    return {k: " | ".join(v) for k, v in out.items()}


# ------------------------------------------------------------------------- merge


def _closed_starter(conn: sqlite3.Connection, track_id: int) -> sqlite3.Row:
    """The gate on reading everyone's personal codes and jots together."""
    deck = starter(conn, track_id)
    if not deck or deck["status"] != "closed":
        raise Refused("The merge opens when the lead closes open coding.")
    return deck


def merge_inputs(conn: sqlite3.Connection, track_id: int) -> dict:
    """Everyone's own codes with the cards each is on, and which cards each
    person finished. Unused candidates are left out: nobody chose them."""
    deck = _closed_starter(conn, track_id)
    codes = [dict(r) for r in conn.execute(
        "SELECT p.id, p.roster_id, p.name, p.definition, p.part FROM pcode p"
        " WHERE p.track_id = ? AND p.status = 'own' ORDER BY p.id",
        (track_id,),
    )]
    for c in codes:
        c["items"] = set()
    by_id = {c["id"]: c for c in codes}
    for u in conn.execute("SELECT u.pcode_id, u.item_id FROM pcode_use u JOIN pcode p ON p.id = u.pcode_id WHERE p.track_id = ?", (track_id,)):
        if u["pcode_id"] in by_id:
            by_id[u["pcode_id"]]["items"].add(u["item_id"])
    done: dict[int, set[int]] = {}
    for a in conn.execute("SELECT roster_id, item_id FROM assignment WHERE batch_id = ? AND done_at IS NOT NULL", (deck["id"],)):
        done.setdefault(a["roster_id"], set()).add(a["item_id"])
    texts = _texts(conn, {i for c in codes for i in c["items"]})
    jots: dict[tuple[int, int], list[str]] = {}
    for j in conn.execute("SELECT roster_id, item_id, body FROM memo WHERE track_id = ? AND kind = 'jotting' AND item_id IS NOT NULL", (track_id,)):
        jots.setdefault((j["roster_id"], j["item_id"]), []).append(j["body"])
    return {"codes": codes, "done": done, "texts": texts, "jots": jots}


def store_merge(conn: sqlite3.Connection, track_id: int, groups: list[dict]) -> None:
    """Save the proposed codes. Each group is {part, name, definition, reason,
    ids}; a personal code in no group stays undecided."""
    for n, g in enumerate(groups):
        mcode_id = conn.execute(
            "INSERT INTO mcode (track_id, part, name, definition, reason, ord) VALUES (?, ?, ?, ?, ?, ?)",
            (track_id, g["part"], g["name"][:80], g["definition"][:1000], g["reason"][:300], n),
        ).lastrowid
        conn.executemany("UPDATE pcode SET mcode_id = ? WHERE id = ? AND track_id = ?", [(mcode_id, i, track_id) for i in g["ids"]])


def merge_view(conn: sqlite3.Connection, track_id: int) -> dict:
    """The meeting's page: proposed codes with the personal codes in each,
    then the undecided and the dropped. Each personal code carries its owner,
    how many cards it is on, an example and its owner's jots on those cards."""
    _closed_starter(conn, track_id)
    sources = [dict(r) for r in conn.execute(
        "SELECT p.*, r.email, (SELECT COUNT(*) FROM pcode_use u WHERE u.pcode_id = p.id) AS uses"
        " FROM pcode p JOIN roster r ON r.id = p.roster_id WHERE p.track_id = ? AND p.status = 'own' ORDER BY p.part, p.id",
        (track_id,),
    )]
    used: dict[int, list[int]] = {}
    for u in conn.execute(
        "SELECT u.pcode_id, u.item_id FROM pcode_use u JOIN pcode p ON p.id = u.pcode_id JOIN item i ON i.id = u.item_id"
        " WHERE p.track_id = ? ORDER BY i.shuffle_key",
        (track_id,),
    ):
        used.setdefault(u["pcode_id"], []).append(u["item_id"])
    examples = {s["id"]: s["example_item_id"] or (used.get(s["id"]) or [None])[0] for s in sources}
    texts = _texts(conn, set(examples.values()) - {None})
    # The example's photo, where there is one that is still in the data.
    photos = {r["id"]: r["token"] for r in conn.execute(
        "SELECT i.id, i.token FROM item i JOIN item_state st ON st.item_id = i.id"
        " WHERE i.track_id = ? AND i.raw_path IS NOT NULL AND st.status = 'cleared'", (track_id,)
    )}
    jots: dict[tuple[int, int], list[str]] = {}
    for j in conn.execute("SELECT roster_id, item_id, body FROM memo WHERE track_id = ? AND kind = 'jotting' AND item_id IS NOT NULL", (track_id,)):
        jots.setdefault((j["roster_id"], j["item_id"]), []).append(j["body"])
    for s in sources:
        s["who"] = s["email"].split("@")[0]
        s["example"] = texts.get(examples[s["id"]], "")
        s["photo"] = photos.get(examples[s["id"]])
        s["jots"] = [body for item_id in used.get(s["id"], []) for body in jots.get((s["roster_id"], item_id), [])][:6]
    proposed = [dict(m) for m in conn.execute("SELECT * FROM mcode WHERE track_id = ? ORDER BY part, ord, id", (track_id,))]
    for m in proposed:
        m["sources"] = [s for s in sources if s["mcode_id"] == m["id"] and not s["dropped"]]
    return {
        "proposed": [m for m in proposed if m["sources"]],
        "empty": [m for m in proposed if not m["sources"]],
        "undecided": [s for s in sources if not s["mcode_id"] and not s["dropped"]],
        "dropped": [s for s in sources if s["dropped"]],
    }


def code_cards(conn: sqlite3.Connection, track_id: int, pcode_id: int) -> tuple[dict, list[dict]]:
    """One personal code and every card it is on, each with its owner's jots."""
    _closed_starter(conn, track_id)
    code = conn.execute(
        # An unused candidate is nobody's code: it came from one person's jots and they did not take it.
        "SELECT p.*, r.email FROM pcode p JOIN roster r ON r.id = p.roster_id WHERE p.id = ? AND p.track_id = ? AND p.status = 'own'",
        (pcode_id, track_id),
    ).fetchone()
    if not code:
        raise Refused("No such code.")
    cards = _items(conn, conn.execute(
        f"SELECT {ITEM_COLUMNS} {ITEM_FROM} JOIN pcode_use u ON u.item_id = i.id WHERE u.pcode_id = ? ORDER BY i.shuffle_key",
        (pcode_id,),
    ).fetchall())
    for card in cards:
        card["jots"] = [r["body"] for r in conn.execute(
            "SELECT body FROM memo WHERE kind = 'jotting' AND roster_id = ? AND item_id = ? ORDER BY id",
            (code["roster_id"], card["id"]),
        )]
    return dict(code), cards


def move_pcode(conn: sqlite3.Connection, track_id: int, pcode_id: int, to: str) -> None:
    """The one action of the merge meeting, on one personal code: put it in a
    proposed code ("123"), make it a code of its own ("own"), drop it ("drop")
    or set it aside again ("undecided"). Splitting a proposed code is moving
    some of its personal codes out."""
    _closed_starter(conn, track_id)
    code = conn.execute("SELECT * FROM pcode WHERE id = ? AND track_id = ? AND status = 'own'", (pcode_id, track_id)).fetchone()
    if not code:
        raise Refused("No such code.")
    if to == "drop":
        target, dropped = None, 1
    elif to == "undecided":
        target, dropped = None, 0
    elif to == "own":
        ord_ = conn.execute("SELECT COUNT(*) FROM mcode WHERE track_id = ?", (track_id,)).fetchone()[0]
        target, dropped = conn.execute(
            "INSERT INTO mcode (track_id, part, name, definition, reason, ord) VALUES (?, ?, ?, ?, ?, ?)",
            (track_id, code["part"], code["name"], code["definition"], "Kept as its own code.", ord_),
        ).lastrowid, 0
    else:
        row = conn.execute("SELECT * FROM mcode WHERE id = ? AND track_id = ?", (to if to.isdigit() else -1, track_id)).fetchone()
        if not row:
            raise Refused("No such proposed code.")
        if row["part"] != code["part"]:
            raise Refused(f"That proposed code is about the {row['part']}; this one is about the {code['part']}.")
        target, dropped = row["id"], 0
    conn.execute("UPDATE pcode SET mcode_id = ?, dropped = ? WHERE id = ?", (target, dropped, pcode_id))


def save_mcode(conn: sqlite3.Connection, track_id: int, mcode_id: int, name: str, definition: str) -> None:
    _closed_starter(conn, track_id)
    if not name.strip() or not definition.strip():
        raise Refused("A proposed code needs a name and a definition.")
    conn.execute(
        "UPDATE mcode SET name = ?, definition = ? WHERE id = ? AND track_id = ?",
        (name.strip()[:80], definition.strip()[:1000], mcode_id, track_id),
    )


def merge_to_draft(conn: sqlite3.Connection, track_id: int, by: str, parts: tuple[str, ...]) -> None:
    """Write the proposed codes into the codebook draft: one tick-all-that-
    apply question per part. From there it is edited and published like any
    other draft."""
    view = merge_view(conn, track_id)
    if view["undecided"]:
        raise Refused(f"{len(view['undecided'])} code(s) are still undecided. Put each in a proposed code, keep it as its own, or drop it.")
    if not view["proposed"]:
        raise Refused("There are no proposed codes to write.")
    existing = draft(conn, track_id)
    if existing and version_tree(conn, existing["id"]):
        raise Refused("A draft is already open. Publish or discard it first.")
    new_draft(conn, track_id, by)
    version = draft(conn, track_id)
    taken = {d["key"] for d in version_tree(conn, version["id"])}
    for part in parts:
        codes = [m for m in view["proposed"] if m["part"] == part]
        if not codes:
            continue
        dim_key = _free_key("codes" if len(parts) == 1 else f"{part}-codes", taken)
        save_dimension(conn, track_id, dim_key, "Codes" if len(parts) == 1 else f"{part.capitalize()} codes", "multi", part, parts, new=True)
        keys: set[str] = set()
        for m in codes:
            example = next((s["example"] for s in m["sources"] if s["example"]), "")
            save_code(conn, track_id, dim_key, _free_key(m["name"], keys), {"label": m["name"], "definition": m["definition"], "example": example[:600]}, new=True)


def _free_key(name: str, taken: set[str]) -> str:
    """A codebook key made from a name, with -2, -3 ... if it is taken."""
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:34] or "code"
    key, n = base, 1
    while key in taken:
        n += 1
        key = f"{base}-{n}"
    taken.add(key)
    return key


# ---------------------------------------------------------------------- codebook


def versions(conn: sqlite3.Connection, track_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM codebook_version WHERE track_id = ? ORDER BY n DESC", (track_id,)
    ).fetchall()


def latest_published(conn: sqlite3.Connection, track_id: int) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM codebook_version WHERE track_id = ? AND status = 'published' ORDER BY n DESC LIMIT 1",
        (track_id,),
    ).fetchone()


def draft(conn: sqlite3.Connection, track_id: int) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM codebook_version WHERE track_id = ? AND status = 'draft'", (track_id,)
    ).fetchone()


def version_tree(conn: sqlite3.Connection, version_id: int) -> list[dict]:
    """Dimensions in order, each with its codes."""
    dims = [
        dict(d)
        for d in conn.execute("SELECT * FROM dimension WHERE version_id = ? ORDER BY part, ord, id", (version_id,))
    ]
    for d in dims:
        d["codes"] = conn.execute(
            "SELECT * FROM code WHERE dimension_id = ? ORDER BY ord, id", (d["id"],)
        ).fetchall()
    return dims


def new_draft(conn: sqlite3.Connection, track_id: int, by: str) -> sqlite3.Row:
    """Start the next version as a copy of the latest published one."""
    existing = draft(conn, track_id)
    if existing:
        return existing
    base = latest_published(conn, track_id)
    n = conn.execute(
        "SELECT COALESCE(MAX(n), 0) + 1 FROM codebook_version WHERE track_id = ?", (track_id,)
    ).fetchone()[0]
    version_id = conn.execute(
        "INSERT INTO codebook_version (track_id, n, created_by) VALUES (?, ?, ?)", (track_id, n, by)
    ).lastrowid
    for d in version_tree(conn, base["id"]) if base else []:
        dim_id = conn.execute(
            "INSERT INTO dimension (version_id, key, name, mode, part, ord) VALUES (?, ?, ?, ?, ?, ?)",
            (version_id, d["key"], d["name"], d["mode"], d["part"], d["ord"]),
        ).lastrowid
        conn.executemany(
            "INSERT INTO code (dimension_id, key, label, definition, include, exclude, example, ord)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (dim_id, c["key"], c["label"], c["definition"], c["include"], c["exclude"], c["example"], c["ord"])
                for c in d["codes"]
            ],
        )
    return draft(conn, track_id)


def _draft_dimension(conn: sqlite3.Connection, track_id: int, dim_key: str) -> tuple[sqlite3.Row, Optional[sqlite3.Row]]:
    """The track's draft and one of its dimensions. Published versions are
    never reachable from here, which is what keeps them immutable."""
    version = draft(conn, track_id)
    if not version:
        raise Refused("There is no draft to edit. Published versions cannot be changed; start a new draft.")
    dim = conn.execute(
        "SELECT * FROM dimension WHERE version_id = ? AND key = ?", (version["id"], dim_key)
    ).fetchone()
    return version, dim


def _check_key(key: str) -> str:
    key = key.strip().lower()
    if not KEY_RE.match(key):
        raise Refused("Keys are lowercase letters, digits, hyphens and underscores, up to 40 characters.")
    return key


def save_dimension(
    conn: sqlite3.Connection, track_id: int, key: str, name: str, mode: str, part: str, parts: tuple[str, ...], new: bool = False
) -> None:
    """`parts` is what this study's dimensions can be about."""
    key = _check_key(key)
    if part not in parts:
        raise Refused("In this study a dimension is about: " + ", ".join(parts) + ".")
    if mode not in ("single", "multi"):
        raise Refused("A dimension is either single-choice or multi-label.")
    if not name.strip():
        raise Refused("A dimension needs a name.")
    version, dim = _draft_dimension(conn, track_id, key)
    if dim and new:
        raise Refused(f"A dimension with the key '{key}' is already in the draft.")
    if dim:
        conn.execute("UPDATE dimension SET name = ?, mode = ?, part = ? WHERE id = ?", (name.strip(), mode, part, dim["id"]))
    else:
        ord_ = conn.execute("SELECT COUNT(*) FROM dimension WHERE version_id = ?", (version["id"],)).fetchone()[0]
        conn.execute(
            "INSERT INTO dimension (version_id, key, name, mode, part, ord) VALUES (?, ?, ?, ?, ?, ?)",
            (version["id"], key, name.strip(), mode, part, ord_),
        )


def delete_dimension(conn: sqlite3.Connection, track_id: int, key: str) -> None:
    _, dim = _draft_dimension(conn, track_id, key)
    if dim:
        if conn.execute("SELECT 1 FROM code WHERE dimension_id = ?", (dim["id"],)).fetchone():
            raise Refused("Move or remove its codes first.")
        conn.execute("DELETE FROM dimension WHERE id = ?", (dim["id"],))


def move_code(conn: sqlite3.Connection, track_id: int, dim_key: str, key: str, to_key: str) -> None:
    """Put one of the draft's codes under another of its dimensions."""
    version, dim = _draft_dimension(conn, track_id, dim_key)
    target = conn.execute("SELECT * FROM dimension WHERE version_id = ? AND key = ?", (version["id"], to_key)).fetchone()
    if not dim or not target:
        raise Refused("That dimension is not in the draft.")
    if conn.execute("SELECT 1 FROM code WHERE dimension_id = ? AND key = ?", (target["id"], key)).fetchone():
        raise Refused(f"'{target['name']}' already has a code with the key '{key}'.")
    ord_ = conn.execute("SELECT COUNT(*) FROM code WHERE dimension_id = ?", (target["id"],)).fetchone()[0]
    conn.execute("UPDATE code SET dimension_id = ?, ord = ? WHERE dimension_id = ? AND key = ?", (target["id"], ord_, dim["id"], key))


def discard_draft(conn: sqlite3.Connection, track_id: int) -> None:
    """Throw the draft away. Published versions are untouched."""
    version = draft(conn, track_id)
    if version:
        conn.execute("DELETE FROM code WHERE dimension_id IN (SELECT id FROM dimension WHERE version_id = ?)", (version["id"],))
        conn.execute("DELETE FROM dimension WHERE version_id = ?", (version["id"],))
        conn.execute("DELETE FROM codebook_version WHERE id = ?", (version["id"],))


def save_code(conn: sqlite3.Connection, track_id: int, dim_key: str, key: str, fields: dict[str, str], new: bool = False) -> None:
    key = _check_key(key)
    _, dim = _draft_dimension(conn, track_id, dim_key)
    if not dim:
        raise Refused("That dimension is not in the draft.")
    label = fields.get("label", "").strip()
    if not label:
        raise Refused("A code needs a label.")
    values = [fields.get(f, "").strip()[:4000] for f in ("definition", "include", "exclude", "example")]
    existing = conn.execute("SELECT id FROM code WHERE dimension_id = ? AND key = ?", (dim["id"], key)).fetchone()
    if existing and new:
        raise Refused(f"A code with the key '{key}' is already in this dimension. Edit it above.")
    if existing:
        conn.execute(
            "UPDATE code SET label = ?, definition = ?, include = ?, exclude = ?, example = ? WHERE id = ?",
            (label, *values, existing["id"]),
        )
    else:
        ord_ = conn.execute("SELECT COUNT(*) FROM code WHERE dimension_id = ?", (dim["id"],)).fetchone()[0]
        conn.execute(
            "INSERT INTO code (dimension_id, key, label, definition, include, exclude, example, ord)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (dim["id"], key, label, *values, ord_),
        )


def delete_code(conn: sqlite3.Connection, track_id: int, dim_key: str, key: str) -> None:
    _, dim = _draft_dimension(conn, track_id, dim_key)
    if dim:
        conn.execute("DELETE FROM code WHERE dimension_id = ? AND key = ?", (dim["id"], key))


def publish(conn: sqlite3.Connection, track_id: int, note: str) -> None:
    version = draft(conn, track_id)
    if not version:
        raise Refused("There is no draft to publish.")
    if not note.strip():
        raise Refused("Say what changed and why. The note is the codebook's change log.")
    deck = production(conn, track_id)
    if deck and deck["status"] == "open":
        raise Refused("The final pass is under way with the current version. Close it before publishing another.")
    tree = version_tree(conn, version["id"])
    if not tree:
        raise Refused("The draft has no dimensions.")
    for d in tree:
        if len(d["codes"]) < (2 if d["mode"] == "single" else 1):
            raise Refused(f"Dimension '{d['name']}' needs more codes before it can be used.")
    conn.execute(
        "UPDATE codebook_version SET status = 'published', note = ?, published_at = ? WHERE id = ?",
        (note.strip(), now(), version["id"]),
    )


# ----------------------------------------------------------------------- batches


def batches(conn: sqlite3.Connection, track_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT b.*, v.n AS version_n,"
        " (SELECT COUNT(DISTINCT item_id) FROM assignment a WHERE a.batch_id = b.id) AS n_items"
        " FROM batch b LEFT JOIN codebook_version v ON v.id = b.version_id"
        " WHERE b.track_id = ? ORDER BY b.id DESC",
        (track_id,),
    ).fetchall()


def batch(conn: sqlite3.Connection, batch_id: int) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT b.*, v.n AS version_n FROM batch b LEFT JOIN codebook_version v ON v.id = b.version_id"
        " WHERE b.id = ?",
        (batch_id,),
    ).fetchone()


def batch_coders(conn: sqlite3.Connection, batch_id: int) -> list[sqlite3.Row]:
    """Coders with their progress. Counts only: never what anyone chose."""
    return conn.execute(
        "SELECT r.id, r.coder_code, r.email, r.active, bc.submitted_at,"
        " COUNT(a.id) AS total, COUNT(a.done_at) AS done"
        " FROM batch_coder bc JOIN roster r ON r.id = bc.roster_id"
        " LEFT JOIN assignment a ON a.batch_id = bc.batch_id AND a.roster_id = r.id"
        " WHERE bc.batch_id = ? GROUP BY r.id ORDER BY r.coder_code",
        (batch_id,),
    ).fetchall()


def unused_cleared(conn: sqlite3.Connection, track_id: int) -> list[int]:
    """Cleared items no batch has used: what a new batch can draw from."""
    return [
        r["id"]
        for r in conn.execute(
            "SELECT i.id FROM item i JOIN item_state st ON st.item_id = i.id"
            " WHERE i.track_id = ? AND st.status = 'cleared'"
            " AND i.id NOT IN (SELECT a.item_id FROM assignment a JOIN batch b ON b.id = a.batch_id"
            "                  WHERE b.track_id = ?)",
            (track_id, track_id),
        )
    ]


def production(conn: sqlite3.Connection, track_id: int) -> Optional[sqlite3.Row]:
    """The final deck. A study has one."""
    return conn.execute(
        "SELECT * FROM batch WHERE track_id = ? AND kind = 'production' ORDER BY id LIMIT 1", (track_id,)
    ).fetchone()


def create_batch(
    conn: sqlite3.Connection, track_id: int, kind: str, title: str, n_items: int, roster_ids: list[int], by: str, overlap: int = 20
) -> int:
    """Deal a deck. Open coding and the final pass go to the whole team; a
    calibration round goes to the coders ticked. `overlap` is the share of the
    final pass, in percent, that two people code."""
    if kind not in ("starter", "calibration", "production"):
        raise Refused("A deck is for open coding, a calibration round or the final pass.")
    version = latest_published(conn, track_id) if kind != "starter" else None
    if kind != "starter" and not version:
        raise Refused("Publish a codebook version first.")
    valid = {r["id"] for r in roster(conn, track_id, active_only=True)}
    if kind == "starter":
        # Open coding is one deck, the same cards for everyone on the team:
        # codes landing on the same cards is what the merge compares.
        if starter(conn, track_id):
            raise Refused("Open coding already has its cards.")
        roster_ids = list(valid)
    if kind == "production":
        if production(conn, track_id):
            raise Refused("The final deck has already been dealt.")
        roster_ids = list(valid)
    coders = sorted(set(roster_ids) & valid)
    if kind == "calibration" and len(coders) < 2:
        raise Refused("A calibration round needs at least two coders, so agreement can be measured.")
    if kind == "production":
        # Every kept item, whatever deck it has been in: earlier decks used
        # personal codes or older versions, so they are coded again.
        chosen = [r["id"] for r in conn.execute(
            "SELECT i.id FROM item i JOIN item_state st ON st.item_id = i.id WHERE i.track_id = ? AND st.status = 'cleared'",
            (track_id,),
        )]
        if not chosen:
            raise Refused("There are no kept items to code.")
        if not 0 <= overlap <= 100:
            raise Refused("The share coded twice is between 0 and 100.")
        doubled = round(len(chosen) * overlap / 100)
        if doubled and len(coders) < 2:
            raise Refused("Coding cards twice needs at least two people.")
        random.shuffle(chosen)
        random.shuffle(coders)
    else:
        if not 1 <= n_items <= 200:
            raise Refused("A batch holds between 1 and 200 items.")
        # Fresh items each round: recoding ones the team has already discussed
        # would flatter the agreement figures.
        pool = unused_cleared(conn, track_id)
        if n_items > len(pool):
            raise Refused(f"Only {len(pool)} cleared item(s) are left that have not already been in a batch.")
        chosen = random.sample(pool, n_items)
    round_no = conn.execute(
        "SELECT COUNT(*) + 1 FROM batch WHERE track_id = ? AND kind = ?", (track_id, kind)
    ).fetchone()[0]
    default = "Production" if kind == "production" else f"{kind.title()} {round_no}"
    batch_id = conn.execute(
        "INSERT INTO batch (track_id, version_id, kind, round_no, title, created_by, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (track_id, version and version["id"], kind, round_no, title.strip() or default, by, now()),
    ).lastrowid
    conn.executemany("INSERT INTO batch_coder (batch_id, roster_id) VALUES (?, ?)", [(batch_id, c) for c in coders])
    if kind == "production":
        # The first `doubled` cards go to two people, the rest to one, taking
        # people in turn so the loads are even and the pairs change. Cards are
        # shown in their usual order, so nobody can tell which are doubled.
        rows, turn = [], 0
        for n, item_id in enumerate(chosen):
            take = 2 if n < doubled else 1
            rows += [(batch_id, item_id, coders[(turn + j) % len(coders)]) for j in range(take)]
            turn += take
    else:
        rows = [(batch_id, item_id, c) for item_id in chosen for c in coders]
    conn.executemany("INSERT INTO assignment (batch_id, item_id, roster_id) VALUES (?, ?, ?)", rows)
    return batch_id


def my_assignments(conn: sqlite3.Connection, batch_id: int, roster_id: int) -> list[dict]:
    return _items(conn, conn.execute(
        f"SELECT a.id AS assignment_id, a.done_at, {ITEM_COLUMNS} {ITEM_FROM}"
        " JOIN assignment a ON a.item_id = i.id"
        " WHERE a.batch_id = ? AND a.roster_id = ? ORDER BY i.shuffle_key",
        (batch_id, roster_id),
    ).fetchall())


def batch_items(conn: sqlite3.Connection, batch_id: int) -> list[dict]:
    return _items(conn, conn.execute(
        f"SELECT {ITEM_COLUMNS} {ITEM_FROM}"
        " WHERE i.id IN (SELECT item_id FROM assignment WHERE batch_id = ?) ORDER BY i.shuffle_key",
        (batch_id,),
    ).fetchall())


def has_submitted(conn: sqlite3.Connection, batch_id: int, roster_id: int) -> Optional[bool]:
    """None if this person is not a coder on the batch."""
    row = conn.execute(
        "SELECT submitted_at FROM batch_coder WHERE batch_id = ? AND roster_id = ?", (batch_id, roster_id)
    ).fetchone()
    return None if row is None else row["submitted_at"] is not None


def save_codes(conn: sqlite3.Connection, batch: sqlite3.Row, assignment_id: int, chosen: dict[str, list[str]]) -> None:
    """Replace one assignment's codes. `chosen` maps dimension key to code keys."""
    code_ids = []
    for d in version_tree(conn, batch["version_id"]):
        keys = list(dict.fromkeys(chosen.get(d["key"], [])))  # a form can repeat a value
        by_key = {c["key"]: c["id"] for c in d["codes"]}
        if any(k not in by_key for k in keys):
            raise Refused("That code is not in this batch's codebook version.")
        if d["mode"] == "single" and len(keys) != 1:
            raise Refused(f"Choose exactly one option for '{d['name']}'.")
        code_ids += [by_key[k] for k in keys]
    conn.execute("DELETE FROM annotation WHERE assignment_id = ?", (assignment_id,))
    conn.executemany(
        "INSERT INTO annotation (assignment_id, code_id) VALUES (?, ?)", [(assignment_id, c) for c in code_ids]
    )
    conn.execute("UPDATE assignment SET done_at = ? WHERE id = ?", (now(), assignment_id))


def mark_done(conn: sqlite3.Connection, assignment_id: int) -> None:
    conn.execute("UPDATE assignment SET done_at = ? WHERE id = ?", (now(), assignment_id))


def submit(conn: sqlite3.Connection, batch_id: int, roster_id: int) -> None:
    if conn.execute("SELECT kind FROM batch WHERE id = ?", (batch_id,)).fetchone()["kind"] == "starter":
        raise Refused("Open coding has no submit: your codes stay open until the lead closes.")
    left = conn.execute(
        "SELECT COUNT(*) FROM assignment WHERE batch_id = ? AND roster_id = ? AND done_at IS NULL",
        (batch_id, roster_id),
    ).fetchone()[0]
    if left:
        raise Refused(f"{left} item(s) in this batch are not coded yet.")
    conn.execute(
        "UPDATE batch_coder SET submitted_at = ? WHERE batch_id = ? AND roster_id = ?",
        (now(), batch_id, roster_id),
    )


def close_batch(conn: sqlite3.Connection, batch: sqlite3.Row, force: bool) -> None:
    if batch["status"] == "closed":
        return
    # Open coding has no submit: codes stay editable until the close, so it
    # waits on unfinished cards. Someone taken off the roster is not waited for.
    starter_deck = batch["kind"] == "starter"
    waiting = [
        c["email"].split("@")[0] for c in batch_coders(conn, batch["id"])
        if c["active"] and (c["done"] < c["total"] if starter_deck else not c["submitted_at"])
    ]
    if waiting and not force:
        raise Refused("Still waiting on " + ", ".join(waiting) + ". Tick 'close anyway' to treat their unfinished cards as missing.")
    conn.execute("UPDATE batch SET status = 'closed', closed_at = ? WHERE id = ?", (now(), batch["id"]))


def visible_annotations(conn: sqlite3.Connection, batch: sqlite3.Row, me: sqlite3.Row) -> dict[tuple[int, str], set[str]]:
    """{(item_id, coder_code or 'CONSENSUS'): {'dimension/code', ...}}.

    The blind-coding rule, in one place: while the batch is open this returns
    the caller's own codes and nothing else, whatever their role. Assignments
    that are done but carry no codes still appear, with an empty set.
    """
    sql = (
        "SELECT a.item_id, a.is_consensus, r.coder_code, d.key AS dim, c.key AS code"
        " FROM assignment a"
        " LEFT JOIN roster r ON r.id = a.roster_id"
        " LEFT JOIN annotation an ON an.assignment_id = a.id"
        " LEFT JOIN code c ON c.id = an.code_id"
        " LEFT JOIN dimension d ON d.id = c.dimension_id"
        " WHERE a.batch_id = ? AND a.done_at IS NOT NULL"
    )
    args: list = [batch["id"]]
    if batch["status"] != "closed":
        sql += " AND a.roster_id = ?"
        args.append(me["id"])
    out: dict[tuple[int, str], set[str]] = {}
    for row in conn.execute(sql, args):
        who = "CONSENSUS" if row["is_consensus"] else row["coder_code"]
        codes = out.setdefault((row["item_id"], who), set())
        if row["code"]:
            codes.add(f"{row['dim']}/{row['code']}")
    return out


def save_consensus(conn: sqlite3.Connection, batch: sqlite3.Row, item_id: int, chosen: dict[str, list[str]]) -> None:
    if batch["status"] != "closed":
        raise Refused("Consensus is recorded after the batch is closed.")
    row = conn.execute(
        "SELECT id FROM assignment WHERE batch_id = ? AND item_id = ? AND is_consensus = 1",
        (batch["id"], item_id),
    ).fetchone()
    assignment_id = (
        row["id"]
        if row
        else conn.execute(
            "INSERT INTO assignment (batch_id, item_id, is_consensus) VALUES (?, ?, 1)", (batch["id"], item_id)
        ).lastrowid
    )
    save_codes(conn, batch, assignment_id, chosen)


# ------------------------------------------------------------------- the team


def team_progress(conn: sqlite3.Connection, track_id: int) -> list[dict]:
    """Where each person is, for the lead. Counts only: never what anyone
    wrote or chose."""
    deck = starter(conn, track_id)
    left = cleaning_left(conn, track_id)
    track = conn.execute("SELECT * FROM track WHERE id = ?", (track_id,)).fetchone()
    rows = []
    for r in roster(conn, track_id):
        count = lambda sql, *args: conn.execute(sql, args).fetchone()[0]  # noqa: E731
        candidates = job(conn, track_id, "candidates", r["id"])
        rows.append({
            **dict(r),
            "read": len(seen_ids(conn, track_id, r["id"])),
            "sessions": sum(s["done"] for s in reading_sessions(conn, track_id, r["id"])),
            "jots": count("SELECT COUNT(*) FROM memo WHERE roster_id = ? AND kind = 'jotting'", r["id"]),
            "asked": count("SELECT COUNT(*) FROM memo WHERE roster_id = ? AND kind = 'rq'", r["id"]),
            "candidates": candidates["status"] if candidates else "",
            "to_clean": left.get(r["id"], 0),
            "started": has_started(conn, track, r["email"]),
            "coded": count("SELECT COUNT(*) FROM assignment WHERE batch_id = ? AND roster_id = ? AND done_at IS NOT NULL", deck["id"], r["id"]) if deck else 0,
            "to_code": count("SELECT COUNT(*) FROM assignment WHERE batch_id = ? AND roster_id = ?", deck["id"], r["id"]) if deck else 0,
        })
    return rows


# ------------------------------------------------------------- finishing a study


def weak_codes(conn: sqlite3.Connection, track_id: int) -> Optional[dict]:
    """From the last closed calibration round: the codes whose agreement was
    weak or could not be measured. What the team looks at before the lead
    decides calibration is over."""
    last = conn.execute(
        "SELECT b.*, v.n AS version_n FROM batch b JOIN codebook_version v ON v.id = b.version_id"
        " WHERE b.track_id = ? AND b.kind = 'calibration' AND b.status = 'closed' ORDER BY b.id DESC LIMIT 1",
        (track_id,),
    ).fetchone()
    if not last:
        return None
    names = {(d["key"], c["key"]): c["label"] for d in version_tree(conn, last["version_id"]) for c in d["codes"]}
    names.update({(d["key"], None): d["name"] for d in version_tree(conn, last["version_id"])})
    rows = [
        {**dict(r), "label": names.get((r["dimension_key"], r["code_key"]), r["code_key"] or r["dimension_key"])}
        for r in conn.execute("SELECT * FROM agreement WHERE batch_id = ? ORDER BY id", (last["id"],))
        if r["alpha"] is None or r["alpha"] < WEAK_ALPHA
    ]
    return {"batch": last, "rows": rows}


def final_codes(conn: sqlite3.Connection, track_id: int) -> dict:
    """What each item was coded as in the final pass.

    {"items": {item_id: (set of code ids, source)}, "unresolved": [item ids], "uncoded": [item ids]}

    source is "consensus" where the team recorded one, "single" where one
    person coded the item, "agreed" where two did and matched. Two who differ
    with no consensus yet leave the item unresolved."""
    out: dict = {"items": {}, "unresolved": [], "uncoded": []}
    deck = production(conn, track_id)
    if not deck:
        return out
    consensus: dict[int, set[int]] = {}
    coded: dict[int, dict[int, set[int]]] = {}
    dealt: set[int] = set()
    for r in conn.execute(
        "SELECT a.id, a.item_id, a.is_consensus, a.roster_id, a.done_at, an.code_id"
        " FROM assignment a LEFT JOIN annotation an ON an.assignment_id = a.id WHERE a.batch_id = ?",
        (deck["id"],),
    ):
        dealt.add(r["item_id"])
        if not r["done_at"]:
            continue
        codes = consensus.setdefault(r["item_id"], set()) if r["is_consensus"] else coded.setdefault(r["item_id"], {}).setdefault(r["roster_id"], set())
        if r["code_id"]:
            codes.add(r["code_id"])
    for item_id in sorted(dealt):
        by = list(coded.get(item_id, {}).values())
        if item_id in consensus:
            out["items"][item_id] = (consensus[item_id], "consensus")
        elif not by:
            out["uncoded"].append(item_id)
        elif len(by) == 1:
            out["items"][item_id] = (by[0], "single")
        elif all(codes == by[0] for codes in by):
            out["items"][item_id] = (by[0], "agreed")
        else:
            out["unresolved"].append(item_id)
    return out


def _closed_production(conn: sqlite3.Connection, track_id: int) -> sqlite3.Row:
    deck = production(conn, track_id)
    if not deck or deck["status"] != "closed":
        raise Refused("This opens when the lead closes the final pass.")
    return deck


def topic_map(conn: sqlite3.Connection, track_id: int) -> dict:
    """Every code of the final codebook with how many items it is on, two of
    them as examples, and the theme it has been put in."""
    deck = _closed_production(conn, track_id)
    final = final_codes(conn, track_id)
    on: dict[int, list[int]] = {}
    for item_id, (codes, _) in final["items"].items():
        for code_id in codes:
            on.setdefault(code_id, []).append(item_id)
    in_theme = {(r["dimension_key"], r["code_key"]): r["theme_id"] for r in conn.execute("SELECT * FROM theme_code WHERE track_id = ?", (track_id,))}
    texts = _texts(conn, {i for ids in on.values() for i in ids[:2]})
    codes = [
        {
            "dimension": d["key"], "dimension_name": d["name"], "part": d["part"], "key": c["key"], "label": c["label"], "definition": c["definition"],
            "n": len(on.get(c["id"], [])), "examples": [texts.get(i, "") for i in on.get(c["id"], [])[:2]],
            "items": on.get(c["id"], []), "theme_id": in_theme.get((d["key"], c["key"])),
        }
        for d in version_tree(conn, deck["version_id"]) for c in d["codes"]
    ]
    return {"codes": sorted(codes, key=lambda c: -c["n"]), "total": len(final["items"]), **{k: len(final[k]) for k in ("unresolved", "uncoded")}}


def code_items(conn: sqlite3.Connection, track_id: int, dimension: str, key: str) -> tuple[dict, list[dict]]:
    """One final code and every item it is on."""
    code = next((c for c in topic_map(conn, track_id)["codes"] if (c["dimension"], c["key"]) == (dimension, key)), None)
    if not code:
        raise Refused("No such code.")
    marks = ",".join("?" * len(code["items"]))
    return code, _items(conn, conn.execute(
        f"SELECT {ITEM_COLUMNS} {ITEM_FROM} WHERE i.id IN ({marks}) ORDER BY i.shuffle_key", code["items"]
    ).fetchall())


def themes(conn: sqlite3.Connection, track_id: int) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM theme WHERE track_id = ? ORDER BY ord, id", (track_id,)).fetchall()


def save_theme(conn: sqlite3.Connection, track_id: int, theme_id: Optional[int], name: str, statement: str) -> int:
    """Add a theme, or change one's name and statement."""
    _closed_production(conn, track_id)
    if not name.strip():
        raise Refused("A theme needs a name.")
    if theme_id is None:
        ord_ = conn.execute("SELECT COUNT(*) FROM theme WHERE track_id = ?", (track_id,)).fetchone()[0]
        return conn.execute(
            "INSERT INTO theme (track_id, name, statement, ord) VALUES (?, ?, ?, ?)", (track_id, name.strip()[:80], statement.strip()[:4000], ord_)
        ).lastrowid
    conn.execute(
        "UPDATE theme SET name = ?, statement = ? WHERE id = ? AND track_id = ?", (name.strip()[:80], statement.strip()[:4000], theme_id, track_id)
    )
    return theme_id


def delete_theme(conn: sqlite3.Connection, track_id: int, theme_id: int) -> None:
    """Remove a theme. Its codes go back to having none."""
    conn.execute("DELETE FROM theme_code WHERE track_id = ? AND theme_id = ?", (track_id, theme_id))
    conn.execute("DELETE FROM theme WHERE id = ? AND track_id = ?", (theme_id, track_id))


def set_code_theme(conn: sqlite3.Connection, track_id: int, dimension: str, key: str, theme_id: Optional[int]) -> None:
    """Put a code in a theme, or in none. A code is in one theme at most."""
    if not any((c["dimension"], c["key"]) == (dimension, key) for c in topic_map(conn, track_id)["codes"]):
        raise Refused("No such code.")
    conn.execute("DELETE FROM theme_code WHERE track_id = ? AND dimension_key = ? AND code_key = ?", (track_id, dimension, key))
    if theme_id is not None:
        if not conn.execute("SELECT 1 FROM theme WHERE id = ? AND track_id = ?", (theme_id, track_id)).fetchone():
            raise Refused("No such theme.")
        conn.execute(
            "INSERT INTO theme_code (track_id, dimension_key, code_key, theme_id) VALUES (?, ?, ?, ?)", (track_id, dimension, key, theme_id)
        )
