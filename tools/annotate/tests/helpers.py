"""Small helpers shared by the route tests."""

from annotate import db


def track_id(study: str = "demo") -> int:
    """A seeded study's track: "demo" (diagrams) or "ethics-demo"."""
    with db.db() as conn:
        return conn.execute(
            "SELECT t.id FROM track t JOIN dataset d ON d.id = t.dataset_id WHERE d.slug = ?", (study,)
        ).fetchone()["id"]


def roster_ids(track: int, *emails: str) -> list[str]:
    with db.db() as conn:
        return [
            str(conn.execute("SELECT id FROM roster WHERE track_id = ? AND email = ?", (track, e)).fetchone()["id"])
            for e in emails
        ]


def tokens(track: int, status: str) -> list[str]:
    with db.db() as conn:
        rows = conn.execute(
            "SELECT i.token FROM item i JOIN item_state st ON st.item_id = i.id"
            " WHERE i.track_id = ? AND st.status = ? ORDER BY i.shuffle_key",
            (track, status),
        ).fetchall()
    return [r["token"] for r in rows]


def batch_tokens(batch: str) -> list[str]:
    with db.db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT i.token FROM assignment a JOIN item i ON i.id = a.item_id WHERE a.batch_id = ?"
            " ORDER BY i.shuffle_key",
            (batch,),
        ).fetchall()
    return [r["token"] for r in rows]


def new_batch(client, lead, track: int, kind: str, coders: list[str], n_items: int = 4) -> str:
    """Create a batch as the lead and return its id."""
    response = client.post(
        f"/t/{track}/batches", headers=lead, data={"kind": kind, "n_items": str(n_items), "coder": coders}
    )
    assert response.status_code == 303, response.text
    location = response.headers["location"]
    assert "error=" not in location, location
    if kind == "starter":  # dealt to the whole team; the lead lands on the open-coding page
        with db.db() as conn:
            return str(conn.execute("SELECT id FROM batch WHERE track_id = ? AND kind = 'starter'", (track,)).fetchone()["id"])
    return location.split("/b/")[1].split("?")[0]


def secrets() -> list[str]:
    """Every source hash and submission id in the database: the student keys a
    coder must never be shown."""
    with db.db() as conn:
        rows = conn.execute("SELECT hash, submission_id FROM source").fetchall()
    return [value for row in rows for value in (row["hash"], row["submission_id"]) if value]


def relock(track: int, done: tuple[int, ...] = ()) -> None:
    """Put a seeded study back at the first stage: the team is locked, and
    only the stages in `done` are finished besides. The seed leaves every
    stage up to calibration open."""
    with db.db() as conn:
        conn.execute("DELETE FROM stage_done WHERE track_id = ?", (track,))
        conn.executemany(
            "INSERT INTO stage_done (track_id, stage, done_by, done_at) VALUES (?, ?, 'test', '2026-01-01')",
            [(track, n) for n in {0, *done}],
        )


def stand_in_model(prompt: str) -> dict:
    """Answers the three prompts of the step pipeline (annotate/steps.py) the
    way a model would, well enough to run it end to end: two codes drafted,
    a third added in revision, and each item coded by a word in its jot."""
    import re

    if "Draft the codes" in prompt:
        return {"codes": [
            {"name": "Privacy", "definition": "About privacy.", "part": "question", "example": 1},
            {"name": "Jobs", "definition": "About jobs.", "part": "nonsense", "example": 999},
            "junk", {"name": "privacy", "definition": "The same code again."}, {"name": "", "definition": "x"},
        ]}
    if "Revise the codebook" in prompt:
        return {"codes": [
            {"name": "Privacy", "definition": "About personal privacy, not Jobs.", "part": "question", "example": 1},
            {"name": "Jobs", "definition": "About jobs.", "part": "question", "example": 2},
            {"name": "Blame", "definition": "About who is to blame.", "part": "question", "example": 3},
        ], "changes": [{"what": "Added Blame", "why": "The coders saw it in the jots."}]}
    ids = {name.lower(): cid for cid, name in re.findall(r"^(C\d\d) \| ([^|]+) \|", prompt, re.M)}
    codes = {}
    for number, jot in re.findall(r"^(\d+)\. \[.*?\] -> (.*)$", prompt, re.M):
        codes[number] = [cid for name, cid in ids.items() if name in jot.lower()]
    return {"codes": codes, "hard_to_tell_apart": [], "not_captured": ["who is to blame"]}
