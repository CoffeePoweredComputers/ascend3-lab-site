"""Who is asking, and whether they are on this study's roster.

The nginx gate in front of every lab tool admits any approved lab member and
sets X-Tool-User / X-Tool-Uid, overwriting whatever the client sent. That is
lab membership. A study's team is narrower, so each study keeps its own roster
and every route checks it.
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


def normalize_email(value: str) -> str:
    return value.strip().lower()


def current_user(request: Request) -> User:
    email = normalize_email(request.headers.get("X-Tool-User", ""))
    if email:
        return User(email, request.headers.get("X-Tool-Uid", ""))
    if config.dev_user():
        return User(normalize_email(request.cookies.get(DEV_COOKIE, "")) or config.dev_user(), "")
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
    if not me:
        # The same answer whether the track exists or not.
        raise HTTPException(403, "You are not on the roster for this study. Ask the project lead to add you.")
    if lead and me["role"] != "lead":
        raise HTTPException(403, "Only a lead on this track can do that.")
    if user.uid and not me["uid"]:
        conn.execute("UPDATE roster SET uid = ? WHERE id = ?", (user.uid, me["id"]))
    return user, track, me
