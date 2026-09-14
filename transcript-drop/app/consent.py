"""Electronic consent: the text students are shown, and what they answered.

The protocol (HRP-503a) says the portal presents the consent information before
any research data are collected, and that only students who affirmatively
consent are enrolled. This module is that gate.

Two things are deliberately kept apart. The *text* lives in a file the
researcher owns (config/consent_form.md), because it is IRB-approved language
and nothing in this code should be able to alter it. The *answer* lives in
identity.db beside the email it belongs to, never in the research database --
a consent decision is about a named person, which is exactly what research.db
must not contain.

Each answer records a fingerprint of the text that was on screen when it was
given. A consent form is revised more often than anyone expects, and "they
consented" is a much weaker record than "they consented to this wording".
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path

from app import config
from app.db import identity_db

CONSENT_FORM_MD = config.CONFIG_DIR / "consent_form.md"

AGREE = "agree"
DECLINE = "decline"


def _fingerprint(text: str) -> str:
    """Identify a wording, ignoring whitespace-only edits."""
    normalised = re.sub(r"\s+", " ", text).strip()
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:12]


# The draft ships with these markers in it. Refusing to serve a form that still
# contains one is the guard that matters most in this module: an unapproved
# consent document shown to a student is not a cosmetic bug, and "we forgot to
# fill in the PI's phone number" is exactly the mistake that survives review.
UNFILLED_MARKER = "[PI TO COMPLETE:"


def _load(path: Path) -> dict:
    if not path.exists():
        return {"text": "", "version": "", "available": False, "problem": "missing"}
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return {"text": "", "version": "", "available": False, "problem": "empty"}
    if UNFILLED_MARKER in text:
        return {"text": text, "version": _fingerprint(text), "available": False,
                "problem": "unfilled"}
    return {"text": text, "version": _fingerprint(text), "available": True, "problem": None}


# Reloaded when the file changes, like the roster: an approved revision has to
# reach a running server without waiting for a restart.
form = config._cached_file(lambda: CONSENT_FORM_MD, _load)


def decision_for(email: str) -> dict | None:
    """What this student answered, or None if they have not been asked yet."""
    key = (email or "").strip().lower()
    if not key:
        return None
    with identity_db() as conn:
        row = conn.execute(
            "SELECT decision, form_version, recorded_at, updated_at, is_adult "
            "FROM consent_records WHERE email = ?",
            (key,),
        ).fetchone()
    return dict(row) if row else None


def record(email: str, decision: str, form_version: str, is_adult: bool) -> dict:
    """Store an answer, replacing any earlier one from the same student.

    Declining is stored rather than left blank. Absence and refusal look the
    same to the repository gate either way, but they are not the same fact, and
    a student who declined and later changes their mind needs a row to change.

    The age confirmation is stored beside the answer because the protocol
    requires eligibility to be confirmed in the portal before consent -- so what
    the participant confirmed has to be on record, not merely enforced once.
    """
    if decision not in (AGREE, DECLINE):
        raise ValueError(f"Unknown consent decision: {decision}")
    if decision == AGREE and not is_adult:
        raise ValueError("Cannot record consent without confirming eligibility.")

    key = (email or "").strip().lower()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with identity_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO consent_records (email, decision, form_version, recorded_at, "
            "updated_at, is_adult) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(email) DO UPDATE SET decision = excluded.decision, "
            "form_version = excluded.form_version, updated_at = excluded.updated_at, "
            "is_adult = excluded.is_adult",
            (key, decision, form_version, now, now, 1 if is_adult else 0),
        )
    return decision_for(key)


def has_consented(email: str) -> bool:
    """Whether a student has agreed, by either route.

    The portal is the normal path. config/consent.csv stays as the researcher's
    record of consent collected outside it -- on paper, or before the portal
    existed -- and either one counts. Absence in both is not consent, which is
    the only safe default: a teammate who never answered still blocks their
    team's repository from collection.
    """
    answer = decision_for(email)
    if answer is not None:
        return answer["decision"] == AGREE and bool(answer["is_adult"])
    return config.has_consented(email)
