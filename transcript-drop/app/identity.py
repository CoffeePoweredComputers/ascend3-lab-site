"""Email -> participant code mapping (section 2).

This is the only module that reads or writes a student's real identity. Codes
are assigned on first submission and reused afterwards, so a student who submits
for P1 and P3 keeps one participant code across the semester.

The identifier is the student's university email rather than their student ID.
Students know it without looking it up, and it is also the identity git records
in a commit's author field -- so the same string that opens a submission is the
one that later ties a commit to a participant, instead of the two being bridged
through a separate mapping file.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone

from app.db import identity_db

# Deliberately loose on the local part -- universities allow more punctuation
# than any short pattern predicts -- and strict on the domain, because "not on
# the roster" is a dead end for a student who typed a personal address, while
# "use your VT email" tells them exactly what to do.
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
REQUIRED_DOMAIN = "vt.edu"


class InvalidEmail(ValueError):
    pass


def normalize_email(raw: str) -> str:
    """Lower-case and validate. Case is not identity: Abc@VT.edu is abc@vt.edu."""
    cleaned = (raw or "").strip().strip("<>").lower()
    if not EMAIL_RE.match(cleaned):
        raise InvalidEmail("Enter your VT email address (for example hokie@vt.edu).")

    domain = cleaned.rsplit("@", 1)[1]
    if domain != REQUIRED_DOMAIN and not domain.endswith("." + REQUIRED_DOMAIN):
        raise InvalidEmail(
            f"Use your VT email address, ending in @{REQUIRED_DOMAIN}."
        )
    return cleaned


def _next_code(conn: sqlite3.Connection) -> str:
    row = conn.execute(
        "SELECT participant_code FROM identities "
        "ORDER BY CAST(SUBSTR(participant_code, 2) AS INTEGER) DESC LIMIT 1"
    ).fetchone()
    next_number = 1 if row is None else int(row["participant_code"][1:]) + 1
    return f"S{next_number:03d}"


def resolve_participant_code(raw_email: str) -> str:
    """Return the stable participant code for a student, creating it if new."""
    email = normalize_email(raw_email)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with identity_db() as conn:
        # IMMEDIATE takes the write lock up front so two students submitting at
        # the same moment cannot be handed the same code.
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT participant_code FROM identities WHERE email = ?", (email,)
        ).fetchone()
        if row is not None:
            conn.execute(
                "UPDATE identities SET last_seen = ? WHERE email = ?", (now, email)
            )
            return row["participant_code"]

        code = _next_code(conn)
        conn.execute(
            "INSERT INTO identities (email, participant_code, first_seen, last_seen) "
            "VALUES (?, ?, ?, ?)",
            (email, code, now, now),
        )
        return code


def participant_code_for(email: str) -> str | None:
    """Look up an existing code without creating one. Used by researcher scripts."""
    try:
        cleaned = normalize_email(email)
    except InvalidEmail:
        return None
    with identity_db() as conn:
        row = conn.execute(
            "SELECT participant_code FROM identities WHERE email = ?", (cleaned,)
        ).fetchone()
    return row["participant_code"] if row else None
