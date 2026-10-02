"""Who is asking, and whether they are on this study's roster.

The nginx gate in front of every lab tool admits any approved lab member and
sets X-Tool-User / X-Tool-Uid / X-Tool-Role, overwriting whatever the client
sent. That is lab membership. A study's team is narrower, so each study keeps
its own roster and every route checks it.

A site admin (X-Tool-Role: admin) is a lead on every study, on its roster or
not: they can open it, run it and put people on it, with no command on the
server. One who is not on the roster is not part of the team: they are dealt
no cards and cannot jot or code until they add themselves.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from fastapi import HTTPException, Request

from annotate import config

DEV_COOKIE = "annotate_dev"


@dataclass
class User:
    email: str
    uid: str
    admin: bool = False


# Stands in for a roster row when a site admin opens a study they are not on.
# Roster ids start at 1, so nothing they are shown is anyone's.
def _admin_row(track_id: int, email: str) -> dict:
    return {"id": 0, "track_id": track_id, "email": email, "uid": "", "coder_code": "admin", "role": "lead", "active": 1}


def normalize_email(value: str) -> str:
    return value.strip().lower()


def current_user(request: Request) -> User:
    email = normalize_email(request.headers.get("X-Tool-User", ""))
    if email:
        return User(email, request.headers.get("X-Tool-Uid", ""), request.headers.get("X-Tool-Role", "") == "admin")
    if config.dev_user():
        chosen = normalize_email(request.cookies.get(DEV_COOKIE, ""))
        # The developer is the admin; the people they switch to are not.
        return User(chosen or config.dev_user(), "", config.dev_admin() and chosen in ("", config.dev_user()))
    raise HTTPException(403, "No sign-in reached this tool. Open it from the Lab tools page.")


def require(conn: sqlite3.Connection, request: Request, track_id: int, lead: bool = False):
    """Return (user, track row, roster row), or refuse."""
    user = current_user(request)
    track = conn.execute(
        "SELECT t.*, d.title AS dataset_title, d.slug AS dataset_slug, d.kind AS dataset_kind"
        " FROM track t JOIN dataset d ON d.id = t.dataset_id WHERE t.id = ?",
        (track_id,),
    ).fetchone()
    me = track and conn.execute(
        "SELECT * FROM roster WHERE track_id = ? AND email = ? AND active = 1",
        (track_id, user.email),
    ).fetchone()
    if track and user.admin:
        me = dict(me, role="lead") if me else _admin_row(track_id, user.email)
    if not me:
        # The same answer whether the track exists or not.
        raise HTTPException(403, "You are not on the roster for this study. Ask the project lead to add you.")
    if lead and me["role"] != "lead":
        raise HTTPException(403, "Only a lead on this track can do that.")
    if user.uid and me["id"] and not me["uid"]:
        conn.execute("UPDATE roster SET uid = ? WHERE id = ?", (user.uid, me["id"]))
    return user, track, me


def on_team(me) -> None:
    """For the work only a member of the team does: reading, jotting, coding."""
    if not me["id"]:
        raise HTTPException(403, "You are running this study as a site admin and are not on its team. Add yourself on the Roster page to take part.")
