"""In the diagram study a card takes a jot on each source the student handed
in: the diagram, the approach and the challenges, each under its source."""

from conftest import CODER1, CODER2
from helpers import tokens, track_id

from annotate import db, repo

ALL = {"jot_diagram": "boxes in a line", "jot_approach": "works backwards", "jot_challenges": "naming the steps"}


def card(track, with_photo=True):
    cards = tokens(track, "cleared")
    with db.db() as conn:
        for token in cards:
            if bool(repo.item_by_token(conn, token)["raw_path"]) == with_photo:
                return token
    raise AssertionError("no such card in the demo data")


def jots(token, roster_email):
    with db.db() as conn:
        item = repo.item_by_token(conn, token)
        rid = conn.execute("SELECT id FROM roster WHERE email = ? AND track_id = ?", (roster_email, item["track_id"])).fetchone()[0]
        return repo.my_part_jots(conn, rid, item["id"]), repo.seen_ids(conn, item["track_id"], rid)


def test_a_card_cannot_be_passed_until_every_source_has_a_jot(client):
    track = track_id()
    token = card(track)
    where = client.post(f"/t/{track}/triage/{token}", headers=CODER1, data={"jot_diagram": "boxes in a line"}).headers["location"]
    # Back to the same card, told what is missing, with what was typed kept.
    assert f"/triage/{token}?error=" in where and "approach" in where and "challenges" in where
    saved, seen = jots(token, "coder1@example.edu")
    assert saved == {"diagram": "boxes in a line"} and not seen
    page = client.get(f"/t/{track}/triage/{token}", headers=CODER1).text
    assert '<textarea name="jot_diagram" rows="3"  required>boxes in a line</textarea>' in page

    where = client.post(f"/t/{track}/triage/{token}", headers=CODER1, data=ALL).headers["location"]
    assert "error=" not in where and "%2B15%20ft" in where  # one card read, jotted once
    saved, seen = jots(token, "coder1@example.edu")
    assert saved == {"diagram": "boxes in a line", "approach": "works backwards", "challenges": "naming the steps"} and seen


def test_a_card_with_no_diagram_needs_only_the_written_parts(client):
    track = track_id()
    token = card(track, with_photo=False)
    page = client.get(f"/t/{track}/triage/{token}", headers=CODER1).text
    assert 'name="jot_diagram"' not in page and 'name="jot_approach"' in page and 'name="jot_challenges"' in page
    where = client.post(f"/t/{track}/triage/{token}", headers=CODER1,
                        data={"jot_approach": "a list of steps", "jot_challenges": "loops"}).headers["location"]
    assert "error=" not in where


def test_flagging_a_card_needs_no_jots(client):
    track = track_id()
    token = card(track)
    where = client.post(f"/t/{track}/triage/{token}", headers=CODER1, data={"exclude": "unreadable"}).headers["location"]
    assert "error=" not in where


def test_each_jot_says_its_source_to_the_model_and_the_items_list(client):
    track = track_id()
    token = card(track)
    client.post(f"/t/{track}/triage/{token}", headers=CODER1, data={"jot_diagram": "boxes in a line"})
    # Half done does not count as jotted.
    assert "0 of" in client.get(f"/t/{track}/items", headers=CODER1).text
    client.post(f"/t/{track}/triage/{token}", headers=CODER1, data=ALL)
    assert "1 of" in client.get(f"/t/{track}/items", headers=CODER1).text
    with db.db() as conn:
        rid = conn.execute("SELECT id FROM roster WHERE email = 'coder1@example.edu' AND track_id = ?", (track,)).fetchone()[0]
        given = [j["jot"] for j in repo.candidate_inputs(conn, track, rid)["jots"]]
    assert sorted(given) == ["On the approach: works backwards", "On the challenges: naming the steps", "On the diagram: boxes in a line"]
    # Nobody else sees them.
    assert "works backwards" not in client.get(f"/t/{track}/items/{token}", headers=CODER2).text
