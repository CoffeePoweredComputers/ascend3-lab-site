"""Finishing a study: the lead ends calibration, the final pass codes every
kept card (most once, a share twice), splits are settled, and the team reads
the topic map and writes themes."""

import csv
import io
import json
import zipfile

from conftest import CODER1, CODER2, LEAD
from helpers import batch_tokens, new_batch, roster_ids, track_id

from annotate import assist, db, llm, merge, repo, studies

PEOPLE = {"lead@example.edu": LEAD, "coder1@example.edu": CODER1, "coder2@example.edu": CODER2}


def post(client, path, headers, **data) -> str:
    response = client.post(path, headers=headers, data=data)
    assert response.status_code == 303, (path, response.status_code)
    return response.headers["location"]


def calibrate(client, track, split=True) -> str:
    """One closed round on the current codebook, the two coders differing on the first card."""
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"), 4)
    for headers, first in ((CODER1, "faces"), (CODER2, "work" if split else "faces")):
        for n, token in enumerate(batch_tokens(batch)):
            post(client, f"/b/{batch}/code/{token}", headers, **{"dim-topic": first if n == 0 else "other"})
        post(client, f"/b/{batch}/submit", headers)
    post(client, f"/b/{batch}/close", LEAD)
    return batch


def dealt(batch) -> dict[str, list[str]]:
    """{card token: [emails it was dealt to]} for a deck."""
    with db.db() as conn:
        out: dict[str, list[str]] = {}
        for r in conn.execute(
            "SELECT i.token, r.email FROM assignment a JOIN item i ON i.id = a.item_id JOIN roster r ON r.id = a.roster_id"
            " WHERE a.batch_id = ? ORDER BY i.shuffle_key, r.email", (batch,)
        ):
            out.setdefault(r["token"], []).append(r["email"])
    return out


def final_pass(client, track, overlap="50"):
    """Deal the final pass and code it: everything "other", except that the
    two people on one doubled card differ. Returns (batch, that card)."""
    calibrate(client, track)
    post(client, f"/t/{track}/stage/5/done", LEAD, done="1")
    assert "error=" not in post(client, f"/t/{track}/batches", LEAD, kind="production", overlap=overlap)
    with db.db() as conn:
        batch = str(repo.production(conn, track)["id"])
    cards = dealt(batch)
    split = next(t for t, who in cards.items() if len(who) == 2)
    for token, who in cards.items():
        for n, email in enumerate(who):
            choice = "faces" if token == split and n == 0 else "other"
            post(client, f"/b/{batch}/code/{token}", PEOPLE[email], **{"dim-topic": choice})
    return batch, split


def test_the_lead_ends_calibration_once_the_codebook_has_been_tried(client):
    track = track_id("ethics-demo")
    assert "Run%20a%20calibration%20round%20on%20codebook%20v1" in post(client, f"/t/{track}/stage/5/done", LEAD, done="1")
    assert "error=" in post(client, f"/t/{track}/batches", LEAD, kind="production")  # still locked
    calibrate(client, track)

    # The page says which codes are still shaky. It blocks nothing.
    page = client.get(f"/t/{track}/batches", headers=CODER1).text
    assert "After Calibration 1" in page and "Weak or unmeasured agreement" in page and "Topic area" in page
    assert "Unlock Production" in client.get(f"/t/{track}/batches", headers=LEAD).text

    # A newer version that no round has used cannot go into the final pass.
    post(client, f"/t/{track}/codebook/draft/new", CODER1)
    post(client, f"/t/{track}/codebook/draft/publish", CODER1, note="Tightened a definition.")
    assert "codebook%20v2" in post(client, f"/t/{track}/stage/5/done", LEAD, done="1")
    calibrate(client, track, split=False)
    assert client.post(f"/t/{track}/stage/5/done", headers=CODER1, data={"done": "1"}).status_code == 403
    assert "error=" not in post(client, f"/t/{track}/stage/5/done", LEAD, done="1")
    assert 'class="locked"' not in client.get(f"/t/{track}/production", headers=CODER1).text


def test_a_round_with_no_weak_codes_says_so(client):
    track = track_id("ethics-demo")
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"), 4)
    for headers in (CODER1, CODER2):
        for n, token in enumerate(batch_tokens(batch)):
            post(client, f"/b/{batch}/code/{token}", headers, **{"dim-topic": "faces" if n % 2 else "other"})
        post(client, f"/b/{batch}/submit", headers)
    post(client, f"/b/{batch}/close", LEAD)
    assert "Every code reached" in client.get(f"/t/{track}/batches", headers=CODER1).text


def test_the_final_pass_deals_every_kept_card_most_once_a_share_twice(client):
    track = track_id("ethics-demo")
    calibrate(client, track)
    post(client, f"/t/{track}/stage/5/done", LEAD, done="1")
    assert "Waiting for the lead" in client.get(f"/t/{track}/production", headers=CODER1).text
    assert client.post(f"/t/{track}/batches", headers=CODER1, data={"kind": "production"}).status_code == 403
    assert "error=" in post(client, f"/t/{track}/batches", LEAD, kind="production", overlap="150")
    assert f"/t/{track}/production" in post(client, f"/t/{track}/batches", LEAD, kind="production", overlap="50")
    assert "already%20been%20dealt" in post(client, f"/t/{track}/batches", LEAD, kind="production")

    with db.db() as conn:
        batch = repo.production(conn, track)["id"]
        kept = conn.execute("SELECT COUNT(*) FROM item i JOIN item_state st ON st.item_id = i.id WHERE i.track_id = ? AND st.status = 'cleared'", (track,)).fetchone()[0]
    cards = dealt(batch)
    # Every kept card, including the four the calibration round used; half of them to two people.
    assert len(cards) == kept == 14
    assert sorted(len(who) for who in cards.values()) == [1] * 7 + [2] * 7
    assert all(len(set(who)) == len(who) for who in cards.values())
    loads = [sum(email in who for who in cards.values()) for email in PEOPLE]
    assert sum(loads) == 21 and max(loads) - min(loads) <= 1

    # It is coded like a round: blind until the lead closes, and the codebook holds still.
    mine = client.get(f"/t/{track}/production", headers=CODER1).text
    assert "0 of 7 cards" in mine and "Start" in mine
    assert client.get(f"/b/{batch}/review", headers=LEAD).status_code == 403
    post(client, f"/t/{track}/codebook/draft/new", CODER1)
    assert "final%20pass%20is%20under%20way" in post(client, f"/t/{track}/codebook/draft/publish", CODER1, note="Mid-pass change.")


def test_splits_are_settled_before_the_lead_opens_themes(client):
    track = track_id("ethics-demo")
    batch, split = final_pass(client, track)
    for headers in PEOPLE.values():
        assert "All your cards coded" in client.get(f"/t/{track}/production", headers=headers).text
        post(client, f"/b/{batch}/submit", headers)
    assert "Close%20the%20production%20deck" in post(client, f"/t/{track}/stage/6/done", LEAD, done="1")
    assert f"/b/{batch}/review" in post(client, f"/b/{batch}/close", LEAD)

    # Agreement over the doubled cards is frozen at the close, before any consensus.
    assert client.get(f"/b/{batch}/agreement", headers=CODER1).status_code == 200
    assert "final pass" in client.get(f"/t/{track}/history", headers=CODER1).text
    with db.db() as conn:
        assert conn.execute("SELECT MAX(n_items) FROM agreement WHERE batch_id = ?", (batch,)).fetchone()[0] == 7

    # One card was coded differently by its two coders. Nothing moves until it is settled.
    home = client.get(f"/t/{track}/production", headers=CODER1).text
    assert "13 coded" in home and "Settle 1 that two people coded differently" in home
    review = client.get(f"/b/{batch}/review", headers=CODER1).text
    assert "1 of 14 items differ" in review and f'id="item-{split}"' in review
    assert "1%20doubled%20card" in post(client, f"/t/{track}/stage/6/done", LEAD, done="1")
    assert 'class="locked"' in client.get(f"/t/{track}/themes", headers=CODER1).text
    assert "ok=" in post(client, f"/b/{batch}/consensus/{split}", CODER1, **{"dim-topic": "faces"})
    assert "14 coded" in client.get(f"/t/{track}/production", headers=CODER1).text
    assert "error=" not in post(client, f"/t/{track}/stage/6/done", LEAD, done="1")

    with db.db() as conn:
        final = repo.final_codes(conn, track)
    assert sorted(source for _, source in final["items"].values()) == ["agreed"] * 6 + ["consensus"] + ["single"] * 7
    assert final["unresolved"] == [] and final["uncoded"] == []


def finished(client, track):
    batch, split = final_pass(client, track)
    for headers in PEOPLE.values():
        post(client, f"/b/{batch}/submit", headers)
    post(client, f"/b/{batch}/close", LEAD)
    post(client, f"/b/{batch}/consensus/{split}", CODER1, **{"dim-topic": "faces"})
    post(client, f"/t/{track}/stage/6/done", LEAD, done="1")
    return batch, split


def test_the_topic_map_and_themes(client):
    track = track_id("ethics-demo")
    _, split = finished(client, track)
    page = client.get(f"/t/{track}/themes", headers=CODER1).text
    assert "14 coded" in page
    # Largest first: thirteen "other", one "faces", the rest on nothing.
    assert page.index(">Other</a>") < page.index(">Faces and surveillance</a>") < page.index(">Jobs</a>")
    others = client.get(f"/t/{track}/themes/code/topic/other", headers=CODER2).text
    assert others.count("<h2>Item ") == 13 and f"Item {split[:6]}" not in others
    assert f"Item {split[:6]}" in client.get(f"/t/{track}/themes/code/topic/faces", headers=CODER2).text

    # Anyone writes a theme and puts codes in it. A code is in one theme at most.
    themes = f"/t/{track}/themes"
    assert "error=" in post(client, f"{themes}/save", CODER1, name=" ", statement="No name.")
    post(client, f"{themes}/save", CODER1, name="Being watched", statement="Students ask who may identify them.")
    post(client, f"{themes}/save", CODER2, name="Everything else", statement="")
    with db.db() as conn:
        watched, rest = [t["id"] for t in repo.themes(conn, track)]
    post(client, f"{themes}/move", CODER2, dimension="topic", code="faces", theme=str(watched))
    post(client, f"{themes}/move", CODER2, dimension="topic", code="faces", theme=str(rest))
    assert "error=" in post(client, f"{themes}/move", CODER2, dimension="topic", code="made-up", theme=str(rest))
    post(client, f"{themes}/save", LEAD, theme=str(rest), name="The rest", statement="Renamed.")
    page = client.get(themes, headers=LEAD).text
    assert "Faces and surveillance (1)" in page and 'value="The rest"' in page and "No codes yet" in page

    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/t/{track}/export.zip", headers=LEAD).content))
    read = lambda name: list(csv.DictReader(io.StringIO(archive.read(name).decode())))  # noqa: E731
    final = read("final_codes.csv")
    assert len(final) == 14 and {r["source"] for r in final} == {"single", "agreed", "consensus"}
    assert sum(r["code"] == "other" for r in final) == 13 and {r["codebook_version"] for r in final} == {"1"}
    assert [r for r in final if r["source"] == "consensus"][0]["code"] == "faces"
    assert [(r["theme"], r["code"]) for r in read("themes.csv")] == [("Being watched", ""), ("The rest", "faces")]

    # Removing a theme frees its codes.
    post(client, f"{themes}/delete", CODER1, theme=str(rest))
    assert "Faces and surveillance (1)" not in client.get(themes, headers=LEAD).text


def test_final_codes_stay_out_of_the_export_until_the_pass_is_closed(client):
    track = track_id("ethics-demo")
    final_pass(client, track)
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/t/{track}/export.zip", headers=LEAD).content))
    assert archive.read("final_codes.csv").decode().strip().count("\n") == 0


def test_a_theme_proposal_is_the_leads_once_and_is_checked(client, monkeypatch):
    track = track_id("ethics-demo")
    finished(client, track)
    themes = f"/t/{track}/themes"
    assert "Propose themes" not in client.get(themes, headers=LEAD).text  # no model, nothing to offer
    assert client.post(f"{themes}/propose", headers=CODER1).status_code == 403

    reply = {"themes": [
        {"name": "Watching", "statement": "Students ask who may watch them.", "codes": ["topic/faces", "topic/faces", "topic/nope"]},
        {"name": "Again", "statement": "Reuses a code.", "codes": ["topic/faces"]},
        {"name": "", "statement": "No name.", "codes": ["topic/work"]},
        {"name": "Work", "statement": "", "codes": ["topic/work", "topic/attention"]},
        "junk",
    ]}
    monkeypatch.setattr(llm, "mode", lambda: "live")
    monkeypatch.setattr(llm, "chat", lambda *_, **__: json.dumps(reply))
    assert "Propose themes" in client.get(themes, headers=LEAD).text
    assert "error=" not in post(client, f"{themes}/propose", LEAD)
    page = client.get(themes, headers=CODER1).text
    assert 'value="Watching"' in page and 'value="Work"' in page and "Again" not in page and "2 theme(s) proposed" in page
    assert "already%20been%20run" in post(client, f"{themes}/propose", LEAD)
    assert merge.clean_themes("nonsense", {"a/b"}) == []


def test_the_dashboard_card_is_one_line_of_status_and_a_button(client):
    assert "Not started · coder" in client.get("/", headers=CODER1).text
    for study in ("demo", "ethics-demo"):
        client.post(f"/t/{track_id(study)}/start", headers=CODER1)
    home = client.get("/", headers=CODER1).text
    assert home.count("Stage 5 of 8 · Calibration · coder") == 2
    assert 'class="badge' not in home and home.count('data-key="Enter"') == 1
