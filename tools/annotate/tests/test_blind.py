"""Blind coding: while a batch is open, nobody reaches anyone else's work, by
any route, and that includes the lead. After close, the batch's people do."""

import pytest
from conftest import CODER1, CODER2, LEAD
from helpers import batch_tokens, new_batch, roster_ids, secrets, tokens, track_id


@pytest.fixture()
def round_one(client):
    """A calibration round where the two coders disagree on the first item.
    coder1 has submitted; coder2 has coded but not submitted."""
    track = track_id()
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"))
    items = batch_tokens(batch)
    for headers, first in ((CODER1, "sequence"), (CODER2, "dataflow")):
        for i, token in enumerate(items):
            data = {"dim-relation": first if i == 0 else "unclear", "dim-issues": ["vague"] if i == 1 else []}
            assert client.post(f"/b/{batch}/code/{token}", headers=headers, data=data).status_code == 303
    assert "ok=" in client.post(f"/b/{batch}/submit", headers=CODER1).headers["location"]
    return batch, items


def test_open_batch_hides_review_and_agreement_from_everyone(client, round_one):
    batch, _ = round_one
    for headers in (CODER1, CODER2, LEAD):
        assert client.get(f"/b/{batch}/review", headers=headers).status_code == 403
        assert client.get(f"/b/{batch}/agreement", headers=headers).status_code == 403


def test_open_batch_query_returns_only_the_callers_codes(client, round_one):
    from annotate import db, repo

    batch_id, _ = round_one
    with db.db() as conn:
        batch = repo.batch(conn, int(batch_id))
        for email, own in (("coder1@example.edu", "C02"), ("coder2@example.edu", "C03")):
            me = conn.execute("SELECT * FROM roster WHERE track_id = ? AND email = ?", (batch["track_id"], email)).fetchone()
            assert {who for _, who in repo.visible_annotations(conn, batch, me)} == {own}
        lead = conn.execute("SELECT * FROM roster WHERE track_id = ? AND role = 'lead'", (batch["track_id"],)).fetchone()
        assert repo.visible_annotations(conn, batch, lead) == {}


def test_coding_form_shows_own_choice_not_the_other_coders(client, round_one):
    batch, items = round_one
    page = client.get(f"/b/{batch}/code/{items[0]}", headers=CODER1).text
    assert 'value="sequence"\n                   checked' in page
    assert 'value="dataflow"\n                   checked' not in page


def test_lead_sees_progress_counts_only(client, round_one):
    batch, _ = round_one
    page = client.get(f"/b/{batch}", headers=LEAD).text
    assert "4/4" in page
    assert "Sequencing" not in page and "Data flow" not in page


def test_lead_cannot_open_a_coders_form(client, round_one):
    batch, items = round_one
    assert client.get(f"/b/{batch}/code/{items[0]}", headers=LEAD).status_code == 404


def test_submitted_coding_is_locked(client, round_one):
    batch, items = round_one
    response = client.post(f"/b/{batch}/code/{items[0]}", headers=CODER1, data={"dim-relation": "dataflow"})
    assert "error=" in response.headers["location"]
    assert 'value="sequence"\n                   checked' in client.get(f"/b/{batch}/code/{items[0]}", headers=CODER1).text


def test_cannot_submit_with_items_left(client):
    track = track_id()
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"))
    assert "error=" in client.post(f"/b/{batch}/submit", headers=CODER1).headers["location"]


def test_close_waits_for_everyone_unless_forced(client, round_one):
    batch, _ = round_one
    assert "error=" in client.post(f"/b/{batch}/close", headers=LEAD).headers["location"]
    assert "error=" not in client.post(f"/b/{batch}/close", headers=LEAD, data={"force": "1"}).headers["location"]


def test_only_a_lead_closes(client, round_one):
    batch, _ = round_one
    assert client.post(f"/b/{batch}/close", headers=CODER1).status_code == 403


def test_after_close_the_batch_sees_everything_and_agreement_is_frozen(client, round_one):
    batch, items = round_one
    client.post(f"/b/{batch}/submit", headers=CODER2)
    client.post(f"/b/{batch}/close", headers=LEAD)

    review = client.get(f"/b/{batch}/review", headers=CODER1)
    assert review.status_code == 200
    assert "Sequencing" in review.text and "Data flow" in review.text
    assert "1 of 4 items" in review.text  # only the item they split on

    table = client.get(f"/b/{batch}/agreement", headers=CODER2).text
    assert "75%" in table  # relation: three of four items the same
    assert "undefined" in table  # codes nobody applied

    # Anyone on the round records the consensus the team reached.
    done = client.post(f"/b/{batch}/consensus/{items[0]}", headers=CODER1, data={"dim-relation": "sequence"})
    assert "ok=" in done.headers["location"]
    assert "Save consensus" in client.get(f"/b/{batch}/review", headers=CODER2).text
    assert client.get(f"/t/{track_id()}/history", headers=CODER1).status_code == 200


def test_a_coder_not_on_the_batch_is_kept_out(client):
    track = track_id()
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "lead@example.edu"))
    assert client.get(f"/b/{batch}", headers=CODER2).status_code == 403
    assert f"/b/{batch}\"" not in client.get(f"/t/{track}/batches", headers=CODER2).text
    assert client.post(f"/b/{batch}/consensus/{batch_tokens(batch)[0]}", headers=CODER2, data={"dim-relation": "sequence"}).status_code == 403


def test_calibration_needs_two_coders_and_fresh_items(client):
    track = track_id()
    one = client.post(f"/t/{track}/batches", headers=LEAD, data={"kind": "calibration", "n_items": "3", "coder": roster_ids(track, "coder1@example.edu")})
    assert "error=" in one.headers["location"]
    both = roster_ids(track, "coder1@example.edu", "coder2@example.edu")
    first = set(batch_tokens(new_batch(client, LEAD, track, "calibration", both, 4)))
    second = set(batch_tokens(new_batch(client, LEAD, track, "calibration", both, 4)))
    assert first and second and not first & second
    assert first | second <= set(tokens(track, "cleared"))  # never an untriaged or held item


def test_pages_never_show_who_the_student_is(client, round_one):
    """The hash and submission id say which student and which hand-in. No page
    a coder can open carries them."""
    batch, items = round_one
    track = track_id()
    pages = [
        "/", f"/t/{track}/items", f"/t/{track}/items/{items[0]}", f"/t/{track}/triage",
        f"/t/{track}/triage/{tokens(track, 'untriaged')[0]}", f"/t/{track}/memos", f"/b/{batch}",
        f"/b/{batch}/code/{items[0]}", f"/t/{track}/questions",
    ]
    for path in pages:
        response = client.get(path, headers=CODER1)
        assert response.status_code == 200, path
        for secret in secrets():
            assert secret not in response.text, (path, secret)
