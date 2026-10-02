"""Regressions for defects found in review. One test per defect."""

import csv
import io
import re
import zipfile

import pytest
from conftest import CODER1, CODER2, LEAD
from helpers import batch_tokens, new_batch, roster_ids, tokens, track_id

from annotate import db, export, repo, stats

BOTH = ("coder1@example.edu", "coder2@example.edu")


def export_files(client, track) -> dict[str, list[dict]]:
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/t/{track}/export.zip", headers=LEAD).content))
    return {n: list(csv.DictReader(io.StringIO(archive.read(n).decode()))) for n in archive.namelist()}


def test_export_holds_back_open_batches(client):
    """Blind coding applies to the lead's export too."""
    track = track_id()
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, *BOTH), 2)
    for token in batch_tokens(batch):
        client.post(f"/b/{batch}/code/{token}", headers=CODER1, data={"dim-relation": "sequence"})
    starter = new_batch(client, LEAD, track, "starter", [], 2)
    client.post(f"/t/{track}/open/generate", headers=CODER1)
    card = batch_tokens(starter)[0]
    client.post(f"/b/{starter}/code/{card}", headers=CODER1, data={"new_name": "a secret code", "new_definition": "Only mine so far."})

    out = export_files(client, track)
    assert out["codes.csv"] == []
    assert out["personal_codes.csv"] == [] and out["personal_code_cards.csv"] == []

    for b in (batch, starter):
        client.post(f"/b/{b}/close", headers=LEAD, data={"force": "1"})
    out = export_files(client, track)
    assert len(out["codes.csv"]) == 2
    assert [(r["coder"], r["name"], r["cards"], r["became"]) for r in out["personal_codes.csv"]] == [("C02", "a secret code", "1", "")]
    assert [r["token"] for r in out["personal_code_cards.csv"]] == [card]


def card(client, headers, track, token, **data):
    return client.post(f"/t/{track}/triage/{token}", headers=headers, data=data).headers["location"]


CROP = {"crop_x": "0.1", "crop_y": "0.1", "crop_w": "0.5", "crop_h": "0.5"}


def test_a_turn_never_releases_a_photo_with_a_crop_drawn_the_other_way_up(client):
    track = track_id()
    item = tokens(track, "untriaged")[0]
    # A turn saves the turn and nothing else: the box was drawn on the old orientation.
    card(client, CODER1, track, item, turn="right", **CROP)
    with db.db() as conn:
        saved = repo.item_by_token(conn, item)
    assert (saved["status"], saved["rotation"], saved["crop_w"]) == ("untriaged", 90, None)
    card(client, CODER1, track, item, **CROP)
    with db.db() as conn:
        saved = repo.item_by_token(conn, item)
    assert (saved["status"], saved["rotation"], saved["crop_w"]) == ("cleared", 90, 0.5)
    # Once it is in the data only a lead can turn it, and only by taking it back.
    card(client, CODER2, track, item, turn="right")
    with db.db() as conn:
        assert repo.item_by_token(conn, item)["rotation"] == 90


def test_a_photo_the_lead_takes_back_stays_with_the_lead(client):
    track = track_id()
    item = tokens(track, "untriaged")[0]
    card(client, CODER1, track, item, exclude="identifying")
    card(client, LEAD, track, item, action="clear", **CROP)  # the lead crops it and keeps it
    assert item in tokens(track, "cleared")
    card(client, LEAD, track, item, action="reopen")
    assert item in tokens(track, "pii_hold")  # never back to everyone uncropped
    assert client.get(f"/img/{item}?full=1", headers=CODER1).status_code == 403
    card(client, CODER1, track, tokens(track, "cleared")[0], action="reopen")  # not a coder's to do
    assert len(tokens(track, "pii_hold")) == 1
    card(client, LEAD, track, item, action="clear", **CROP)
    assert item in tokens(track, "cleared")


def test_excluding_an_item_takes_it_out_of_open_batches_only(client):
    track = track_id()
    closed = new_batch(client, LEAD, track, "calibration", roster_ids(track, *BOTH), 2)
    kept = batch_tokens(closed)
    client.post(f"/b/{closed}/close", headers=LEAD, data={"force": "1"})
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, *BOTH), 3)
    gone = batch_tokens(batch)[0]
    client.post(f"/b/{batch}/code/{gone}", headers=CODER1, data={"dim-relation": "unclear"})

    # Flagged, it leaves the open deck at once; the lead then excludes both.
    for token in (gone, kept[0]):
        card(client, CODER2, track, token, exclude="off_task")
        card(client, LEAD, track, token, exclude="off_task")
    assert {gone, kept[0]} == set(tokens(track, "excluded"))

    assert gone not in batch_tokens(batch) and len(batch_tokens(batch)) == 2
    assert client.get(f"/b/{batch}/code/{gone}", headers=CODER1).status_code == 404
    assert batch_tokens(closed) == kept  # history is left alone


def test_two_people_reaching_the_same_photo_the_first_cleans_it(client):
    track = track_id()
    item = tokens(track, "untriaged")[0]
    card(client, CODER1, track, item, mode="clean", **CROP)
    # The second person had the uncropped card open. The first crop stands, they are told, and
    # the card is not counted as read by them.
    location = card(client, CODER2, track, item, mode="clean", crop_x="0", crop_y="0", crop_w="1", crop_h="1")
    assert "already%20cleaned" in location
    with db.db() as conn:
        assert repo.item_by_token(conn, item)["crop_w"] == 0.5
        assert conn.execute("SELECT COUNT(*) FROM seen").fetchone()[0] == 0


def test_people_start_their_pass_at_different_cards(client):
    track = track_id("ethics-demo")
    starts = {re.search(r'/triage/([\w-]+)" data-key="Enter"', client.get(f"/t/{track}/triage", headers=h).text)[1] for h in (LEAD, CODER1, CODER2)}
    assert len(starts) == 3


def test_bad_form_values_are_refused_not_crashes(client):
    track = track_id()
    item = tokens(track, "untriaged")[0]
    assert "error=" in card(client, LEAD, track, item, exclude="sideways")
    assert "error=" in card(client, LEAD, track, item, crop_x="2", crop_y="0", crop_w="1", crop_h="1")
    assert "error=" not in card(client, LEAD, track, item, crop_x="wide")  # an unreadable box is no box
    assert "error=" in client.post(f"/t/{track}/roster", headers=LEAD, data={"roster_id": "x", "role": "coder"}).headers["location"]
    assert client.post(f"/t/{track}/stage/99/done", headers=LEAD, data={"done": "1"}).status_code == 404


def test_readding_the_only_lead_as_a_coder_is_refused(client):
    track = track_id()
    response = client.post(f"/t/{track}/roster", headers=LEAD, data={"email": "lead@example.edu", "role": "coder"})
    assert "error=" in response.headers["location"]
    assert client.get(f"/t/{track}/roster", headers=LEAD).status_code == 200


def test_batch_size_is_never_quietly_shrunk(client):
    track = track_id()
    coders = roster_ids(track, *BOTH)
    available = len(tokens(track, "cleared"))
    assert f"{available} unused cleared items" in client.get(f"/t/{track}/batches", headers=LEAD).text
    too_many = client.post(f"/t/{track}/batches", headers=LEAD, data={"kind": "calibration", "n_items": str(available + 1), "coder": coders})
    assert f"Only%20{available}" in too_many.headers["location"]
    new_batch(client, LEAD, track, "calibration", coders, available)
    assert "0 unused cleared items" in client.get(f"/t/{track}/batches", headers=LEAD).text
    none = client.post(f"/t/{track}/batches", headers=LEAD, data={"kind": "calibration", "n_items": "1"})
    assert "at%20least%20two%20coders" in none.headers["location"]


def test_adding_a_code_with_a_taken_key_does_not_overwrite(client):
    track = track_id()
    base = f"/t/{track}/codebook/draft"
    client.post(f"{base}/new", headers=LEAD)
    clash = client.post(f"{base}/code", headers=LEAD, data={"new": "1", "dimension": "relation", "key": "sequence", "label": "Oops"})
    assert "error=" in clash.headers["location"]
    assert "error=" in client.post(f"{base}/dimension", headers=LEAD, data={"new": "1", "key": "relation", "name": "X", "mode": "multi"}).headers["location"]
    with db.db() as conn:
        tree = repo.version_tree(conn, repo.draft(conn, track)["id"])
    code = next(c for d in tree if d["key"] == "relation" for c in d["codes"] if c["key"] == "sequence")
    assert code["label"] == "Sequencing" and code["definition"] and tree[0]["mode"] == "single"


def closed_round(client, track):
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, *BOTH), 2)
    for headers in (CODER1, CODER2):
        for token in batch_tokens(batch):
            client.post(f"/b/{batch}/code/{token}", headers=headers, data={"dim-relation": "sequence"})
        client.post(f"/b/{batch}/submit", headers=headers)
    client.post(f"/b/{batch}/close", headers=LEAD)
    return batch


def test_consensus_redirect_keeps_the_message_the_view_and_the_anchor(client):
    track = track_id()
    batch = closed_round(client, track)
    item = batch_tokens(batch)[0]
    done = client.post(f"/b/{batch}/consensus/{item}", headers=LEAD, data={"dim-relation": "sequence", "all": "1"})
    assert done.headers["location"] == f"/b/{batch}/review?all=1&ok=Consensus%20saved.#item-{item}"
    page = client.get(f"/b/{batch}/review?all=1", headers=LEAD).text
    assert f"Item {item[:6]}" in page  # the short id people use to talk about an item


def test_closing_twice_does_not_rewrite_the_frozen_figures(client):
    track = track_id()
    batch = closed_round(client, track)
    with db.db() as conn:
        before = [tuple(r) for r in conn.execute("SELECT id, computed_at FROM agreement WHERE batch_id = ?", (batch,))]
    client.post(f"/b/{batch}/close", headers=LEAD)
    with db.db() as conn:
        assert [tuple(r) for r in conn.execute("SELECT id, computed_at FROM agreement WHERE batch_id = ?", (batch,))] == before


def test_cross_site_posts_are_refused(client):
    track = track_id()
    data = {"email": "attacker@example.edu", "role": "lead"}
    for site in ("cross-site", "same-site"):
        assert client.post(f"/t/{track}/roster", headers={**LEAD, "Sec-Fetch-Site": site}, data=data).status_code == 403
    assert client.post(f"/t/{track}/roster", headers={**LEAD, "Sec-Fetch-Site": "same-origin"}, data=data).status_code == 303
    assert client.get("/", headers={**LEAD, "Sec-Fetch-Site": "cross-site"}).status_code == 200


def test_coders_are_not_offered_pages_that_refuse_them(client):
    track = track_id()
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder2@example.edu", "lead@example.edu"), 2)
    for headers in (CODER2, LEAD):
        for token in batch_tokens(batch):
            client.post(f"/b/{batch}/code/{token}", headers=headers, data={"dim-relation": "sequence"})
        client.post(f"/b/{batch}/submit", headers=headers)
    client.post(f"/b/{batch}/close", headers=LEAD)
    assert f"/b/{batch}/agreement" not in client.get(f"/t/{track}/history", headers=CODER1).text
    assert f"/b/{batch}/agreement" in client.get(f"/t/{track}/history", headers=CODER2).text
    # Only the lead is offered the button that moves the team on.
    assert "Lock Open coding again" in client.get(f"/t/{track}/questions", headers=LEAD).text
    assert "Lock Open coding again" not in client.get(f"/t/{track}/questions", headers=CODER1).text


def test_export_cells_cannot_run_as_formulas(client):
    track = track_id()
    client.post(f"/t/{track}/memos", headers=CODER1, data={"kind": "memo", "body": "=HYPERLINK(\"http://x\")"})
    with db.db() as conn:
        memos = export.table(conn, "memos.csv", conn.execute("SELECT dataset_id FROM track WHERE id = ?", (track,)).fetchone()[0])
    assert "'=HYPERLINK" in memos and "\n=HYPERLINK" not in memos and ",=HYPERLINK" not in memos
    assert not any(repo.new_token().startswith("-") for _ in range(2000))


def test_ac1_category_shares_count_items_only_one_coder_reached():
    # Gwet (2014): agreement over items rated twice, shares over every rated item.
    full = [(1, 1), (0, 0), (1, 0)]
    assert stats.gwet_ac1(full + [(1, None)] * 5, 2) != pytest.approx(stats.gwet_ac1(full, 2))
    # pa = 2/3; shares over 8 items: pi_1 = 6.5/8, so pe = 2 * 0.8125 * 0.1875.
    pe = 2 * 0.8125 * 0.1875
    assert stats.gwet_ac1(full + [(1, None)] * 5, 2) == pytest.approx((2 / 3 - pe) / (1 - pe))
