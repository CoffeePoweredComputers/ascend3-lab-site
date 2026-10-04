"""Kinds of study side by side: each has its own parts, guides and
first page, and the ethics study keeps the student's lens off every page."""

import csv
import io
import re
import zipfile

from conftest import CODER1, CODER2, LEAD
from helpers import batch_tokens, new_batch, relock, roster_ids, tokens, track_id

LENS_WORDS = ("Outcomes: What is the sum", "Character: What does", "Duty: what do I owe", "Moral distance: many hands", "None, or not sure")


def test_the_dashboard_shows_every_study(client):
    home = client.get("/", headers=CODER1).text
    assert "Demo study (synthetic)" in home and "Ethics questions (synthetic)" in home and "Think-aloud sessions (synthetic)" in home
    assert home.count('class="card track"') == 3
    assert home.count("<div") == home.count("</div>")  # each card closes


def test_an_ethics_card_is_text_only(client):
    track = track_id("ethics-demo")
    card = client.get(f"/t/{track}/triage/{tokens(track, 'cleared')[0]}", headers=CODER1).text
    assert card.count('class="item-text"') == 2
    assert card.index(">topic<") < card.index(">question<")
    for absent in ("No diagram submitted", "data-crop", 'name="turn"', "unreadable", ">lens<", "Send to lead"):
        assert absent not in card, absent
    # Read, jot, next. Flagging opens this study's own reasons; there is no dropdown.
    for key in ('data-key="j"', 'data-key="Enter"', 'data-key="x"'):
        assert key in card
    assert card.count('name="exclude"') == 2 and "Blank or a test entry" in card and "Same as another" not in card and "<select" not in card
    assert card.index('<details class="why">') < card.index('name="exclude"')


def test_the_students_lens_is_on_no_page_but_is_in_the_export(client):
    track = track_id("ethics-demo")
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"), 6)
    cards = batch_tokens(batch)
    for headers in (CODER1, CODER2):
        for token in cards:
            assert client.post(f"/b/{batch}/code/{token}", headers=headers, data={"dim-topic": "other"}).status_code == 303
        client.post(f"/b/{batch}/submit", headers=headers)
    held = tokens(track, "cleared")[-1]
    pages = [
        f"/t/{track}/triage", f"/t/{track}/triage/{held}", f"/t/{track}/items", f"/t/{track}/items/{cards[0]}",
        f"/b/{batch}", f"/b/{batch}/code/{cards[0]}", f"/t/{track}/codebook",
    ]
    client.post(f"/b/{batch}/close", headers=LEAD)
    pages += [f"/b/{batch}/review?all=1", f"/b/{batch}/agreement", f"/t/{track}/memos", f"/t/{track}/history"]
    for headers in (CODER1, LEAD):
        for path in pages:
            if "/code/" in path and headers is LEAD:
                continue  # a coder's own card; the lead is not on this deck
            page = client.get(path, headers=headers)
            assert page.status_code == 200, path
            for words in LENS_WORDS:
                assert words not in page.text, (path, words)

    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/t/{track}/export.zip", headers=LEAD).content))
    texts = list(csv.DictReader(io.StringIO(archive.read("texts.csv").decode())))
    lens = [r for r in texts if r["part"] == "lens"]
    assert len(lens) == 14 and all(r["hidden"] == "1" for r in lens)
    assert any("Moral distance: many hands" in r["text"] for r in lens)
    assert {r["part"] for r in texts if r["hidden"] == "0"} == {"topic", "question"}
    codes = list(csv.DictReader(io.StringIO(archive.read("codes.csv").decode())))
    assert {r["token"] for r in codes} <= {r["token"] for r in lens}  # joinable on token
    assert {r["project"] for r in codes} == {"ethics_questions"}


def test_coding_an_ethics_card(client):
    track = track_id("ethics-demo")
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"), 3)
    card = client.get(f"/b/{batch}/code/{batch_tokens(batch)[0]}", headers=CODER1).text
    assert 'name="dim-topic"' in card and 'data-key="1"' in card and 'data-key="6"' in card
    assert 'class="eyebrow part"' not in card  # one part, so no heading for it


def test_a_dimension_must_be_about_one_of_the_studys_parts(client):
    ethics, decomp = track_id("ethics-demo"), track_id("demo")
    for track in (ethics, decomp):
        client.post(f"/t/{track}/codebook/draft/new", headers=LEAD)
    add = lambda track, part: client.post(
        f"/t/{track}/codebook/draft/dimension", headers=LEAD,
        data={"new": "1", "key": "x-" + part, "name": "X", "mode": "multi", "part": part},
    ).headers["location"]
    assert "error=" in add(ethics, "diagram")
    assert "error=" not in add(ethics, "question")
    assert "error=" in add(decomp, "question")
    assert "error=" not in add(decomp, "reflection")
    # The ethics draft form has no part picker; the diagram study's does.
    assert '<select name="part"' not in client.get(f"/t/{ethics}/codebook/draft", headers=LEAD).text
    assert '<select name="part"' in client.get(f"/t/{decomp}/codebook/draft", headers=LEAD).text


def test_each_study_has_its_own_onboarding_and_neither_mentions_irb(client):
    ethics, decomp = track_id("ethics-demo"), track_id("demo")
    relock(ethics)
    e = client.get(f"/t/{ethics}/stage/0", headers=CODER1).text
    d = client.get(f"/t/{decomp}/stage/0", headers=CODER1).text
    assert "moral distance" in e and "topic map" in e and "diagram" not in e
    assert "diagram" in d and "moral distance" not in d
    for page in (e, d, client.get(f"/t/{decomp}/roster", headers=LEAD).text):
        assert "IRB" not in page and "CITI" not in page and "protocol" not in page
    # No checklist anywhere: what the data is, how the tool works, and one button.
    for page in (e, d):
        assert 'type="checkbox"' not in page and "Checklist" not in page
        assert page.count('class="card pad"') == 3 and "The trail" in page and "Cards and keys" in page
        assert page.count("<form") == 1 and "/start" in page and ">Start <kbd>Enter</kbd>" in page
    # Starting one study does not start the other; afterwards the button carries on from where you are.
    client.post(f"/t/{ethics}/start", headers=CODER1)
    again = client.get(f"/t/{ethics}/stage/0", headers=CODER1).text
    assert "<form" not in again and "Continue: Clean and read" in again
    assert ">Start <kbd>Enter</kbd>" in client.get(f"/t/{decomp}/stage/0", headers=CODER1).text
    # Every other stage of the ethics study has a guide, shared or its own,
    # and a locked stage still shows it.
    for n in range(1, 9):
        page = client.get(f"/t/{ethics}/stage/{n}", headers=LEAD, follow_redirects=True)
        assert page.status_code == 200 and f"/guide/{n}" in page.text, n
    locked = client.get(f"/t/{ethics}/questions", headers=CODER1).text
    assert 'class="locked"' in locked and "<textarea" not in locked
    assert "topic map" in client.get(f"/t/{ethics}/guide/2", headers=CODER1).text  # readable ahead
    assert "decomposing a problem" in client.get(f"/t/{decomp}/guide/2", headers=CODER1).text
