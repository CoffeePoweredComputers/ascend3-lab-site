"""The team's path from reading to a merged codebook: the lead opens each
stage, everyone reads and jots on every card, each person builds their own
codes on the same cards, and the merge turns those into one proposal that the
team settles together."""

import csv
import io
import json
import zipfile

import pytest
from conftest import CODER1, CODER2, LEAD
from helpers import batch_tokens, new_batch, relock, tokens, track_id

from annotate import assist, db, llm, merge, repo, studies

EVERYONE = (LEAD, CODER1, CODER2)


@pytest.fixture()
def study(client):
    """The ethics study with the team at the first stage."""
    track = track_id("ethics-demo")
    relock(track)
    return track


def post(client, path, headers, **data) -> str:
    response = client.post(path, headers=headers, data=data)
    assert response.status_code == 303, (path, response.status_code)
    return response.headers["location"]


def jot(client, track, headers, token, text=""):
    return post(client, f"/t/{track}/triage/{token}", headers, jot=text)


def code(client, batch, headers, token, **data):
    return post(client, f"/b/{batch}/code/{token}", headers, **data)


def my_code_ids(track, email) -> dict[str, int]:
    with db.db() as conn:
        me = conn.execute("SELECT id FROM roster WHERE track_id = ? AND email = ?", (track, email)).fetchone()["id"]
        return {c["name"]: c["id"] for c in repo.my_codes(conn, track, me)}


# ---------------------------------------------------------------- stage locks


def test_stages_stay_locked_until_the_lead_opens_them(client, study):
    questions = client.get(f"/t/{study}/questions", headers=CODER1).text
    assert 'class="locked"' in questions and "finished Clean and read" in questions
    assert "error=" in post(client, f"/t/{study}/memos", CODER1, kind="rq", body="What do they ask about?")
    # Every later stage refuses its work too.
    assert "error=" in post(client, f"/t/{study}/open/generate", CODER1)
    assert "error=" in post(client, f"/t/{study}/batches", LEAD, kind="starter", n_items="3")
    assert "error=" in post(client, f"/t/{study}/codebook/draft/new", CODER1)
    assert "error=" in post(client, f"/t/{study}/batches", LEAD, kind="calibration", n_items="3")

    # Only the lead moves the team on, and only one stage at a time.
    assert client.post(f"/t/{study}/stage/1/done", headers=CODER1, data={"done": "1"}).status_code == 403
    assert "error=" in post(client, f"/t/{study}/stage/2/done", LEAD, done="1")
    assert "Unlock Questions" in client.get(f"/t/{study}/triage", headers=LEAD).text
    assert "error=" not in post(client, f"/t/{study}/stage/1/done", LEAD, done="1")
    assert 'class="locked"' not in client.get(f"/t/{study}/questions", headers=CODER1).text
    assert "error=" not in post(client, f"/t/{study}/memos", CODER1, kind="rq", body="What do they ask about?")
    assert 'class="locked"' in client.get(f"/t/{study}/open", headers=CODER1).text

    # Open coding is finished by closing its deck, and the codebook by publishing.
    post(client, f"/t/{study}/stage/2/done", LEAD, done="1")
    assert "Close%20the%20open-coding%20deck" in post(client, f"/t/{study}/stage/3/done", LEAD, done="1")
    # The lead can lock a stage again.
    post(client, f"/t/{study}/stage/1/done", LEAD, done="0")
    assert 'class="locked"' in client.get(f"/t/{study}/questions", headers=CODER1).text


def test_the_trail_shows_where_the_team_is(client, study):
    side = client.get(f"/t/{study}/triage", headers=CODER1).text
    assert side.count(">locked<") == 6  # everything from questions to themes
    assert ">0/14<" in side
    relock(study, done=(1,))
    assert client.get(f"/t/{study}/triage", headers=CODER1).text.count(">locked<") == 5


# ---------------------------------------------------------------- reading pass


def test_everyone_reads_every_card_and_jots_stay_private(client, study):
    cards = tokens(study, "cleared")
    assert len(cards) == 14
    for headers in (CODER1, CODER2):
        assert "14 to read" in client.get(f"/t/{study}/triage", headers=headers).text
    following = jot(client, study, CODER1, cards[0], "asks who is responsible")
    assert f"/triage/{cards[1]}" in following and "%2B15%20ft" in following
    # In this study every card gets a jot: a card cannot be passed without one.
    assert "Jot%20what%20you%20notice" in jot(client, study, CODER1, cards[1])
    assert "%2B15%20ft" in jot(client, study, CODER1, cards[1], "a question about work")
    assert '<textarea name="jot" rows="3" required>' in client.get(f"/t/{study}/triage/{cards[2]}", headers=CODER1).text

    # One person's reading does not take a card from anyone else.
    assert "12 to read" in client.get(f"/t/{study}/triage", headers=CODER1).text
    other = client.get(f"/t/{study}/triage", headers=CODER2).text
    assert "14 to read" in other and f"/triage/{cards[0]}" in other
    assert ">2/14<" in client.get(f"/t/{study}/triage", headers=CODER1).text

    # Back and Skip walk the cards in order, read or not, so a card passed by mistake is one key away.
    second = client.get(f"/t/{study}/triage/{cards[1]}", headers=CODER1).text
    assert f'/triage/{cards[0]}" data-key="ArrowLeft"' in second and f'/triage/{cards[2]}" data-key="ArrowRight">Skip' in second
    assert 'is-off" aria-disabled="true"><kbd>←</kbd> Back' in client.get(f"/t/{study}/triage/{cards[0]}", headers=CODER1).text
    # The jot is on the card for its author when they come back, and for nobody else.
    assert "asks who is responsible" in client.get(f"/t/{study}/triage/{cards[0]}", headers=CODER1).text
    assert "asks who is responsible" not in client.get(f"/t/{study}/triage/{cards[0]}", headers=CODER2).text
    # Reading a card again earns nothing more.
    assert "ft" not in jot(client, study, CODER1, cards[1], "a second look")

    # The lead sees counts, never the words.
    roster = client.get(f"/t/{study}/roster", headers=LEAD).text
    assert "2/14" in roster and "0/14" in roster and "asks who is responsible" not in roster


def test_a_flagged_card_goes_to_the_lead_who_keeps_or_excludes_it(client, study):
    first, second = tokens(study, "cleared")[:2]
    assert "Sent%20to%20the%20lead" in post(client, f"/t/{study}/triage/{first}", CODER1, exclude="empty", note="just Ai")
    post(client, f"/t/{study}/triage/{second}", CODER2, exclude="off_task")
    assert tokens(study, "pii_hold") == [first, second]
    # It is out of everyone else's cards while the lead decides.
    assert client.get(f"/t/{study}/triage/{first}", headers=CODER2).status_code == 403
    assert "12 to read" in client.get(f"/t/{study}/triage", headers=CODER2).text
    assert "2 with the lead" in client.get(f"/t/{study}/triage", headers=CODER2).text

    # The lead cannot move the team on while any are waiting.
    home = client.get(f"/t/{study}/triage", headers=LEAD).text
    assert "2 waiting for you" in home and "?status=pii_hold" in home
    assert "waiting%20for%20you" in post(client, f"/t/{study}/stage/1/done", LEAD, done="1")
    card = client.get(f"/t/{study}/triage/{first}", headers=LEAD).text
    assert "Blank or a test entry. just Ai" in card and 'data-key="k"' in card and "Send to lead" not in card

    # Excluding one leads straight to the next one waiting; keeping the last goes home.
    assert f"/triage/{second}" in post(client, f"/t/{study}/triage/{first}", LEAD, exclude="empty")
    assert f"/t/{study}/triage?" in post(client, f"/t/{study}/triage/{second}", LEAD, action="clear", legible="1")
    assert tokens(study, "excluded") == [first] and second in tokens(study, "cleared")
    assert client.get(f"/t/{study}/triage/{second}", headers=CODER1).status_code == 200
    assert "error=" not in post(client, f"/t/{study}/stage/1/done", LEAD, done="1")


# ------------------------------------------------------------------ candidates


def test_generate_runs_once_from_your_own_jots_and_closes_them(client, study, monkeypatch):
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "mock")
    cards = tokens(study, "cleared")
    for token in cards[:3]:
        jot(client, study, CODER1, token, "about responsibility for the outcome")
        jot(client, study, CODER2, token, "privacy and surveillance")
    relock(study, done=(1, 2))
    post(client, f"/t/{study}/memos", CODER2, kind="rq", body="Which topics come up?")

    before = client.get(f"/t/{study}/open", headers=CODER1).text
    assert "From your 3 jots" in before and "Once only" in before
    assert "error=" not in post(client, f"/t/{study}/open/generate", CODER1)
    page = client.get(f"/t/{study}/open", headers=CODER1).text
    assert "Waiting for the cards" in page and "Responsibility" in page and "Outcome" in page
    assert "Privacy" not in page  # nobody else's jots went in

    # Once: a second press is refused, and the jots it was made from are closed.
    assert "already%20been%20run" in post(client, f"/t/{study}/open/generate", CODER1)
    assert "error=" in jot(client, study, CODER1, cards[4], "one more thought")
    assert 'name="jot"' not in client.get(f"/t/{study}/triage/{cards[4]}", headers=CODER1).text
    assert "error=" not in jot(client, study, CODER1, cards[4])  # reading on is still fine
    # Someone who has not generated can still jot.
    assert "error=" not in jot(client, study, CODER2, cards[4], "more privacy")


def test_with_no_model_the_work_goes_on_without_candidates(client, study):
    relock(study, done=(1, 2))
    jot(client, study, CODER1, tokens(study, "cleared")[0], "responsibility")
    assert "No model is set up" in client.get(f"/t/{study}/open", headers=CODER1).text
    post(client, f"/t/{study}/open/generate", CODER1)
    assert my_code_ids(study, "coder1@example.edu") == {}
    page = client.get(f"/t/{study}/open", headers=CODER1).text
    assert "Waiting for the cards" in page and "No model is set up" in page


def test_a_failed_run_can_be_retried_or_skipped(client, study, monkeypatch):
    relock(study, done=(1, 2))
    for headers in (CODER1, CODER2):
        jot(client, study, headers, tokens(study, "cleared")[0], "responsibility")
    monkeypatch.setattr(llm, "mode", lambda: "live")

    def down(*_, **__):
        raise RuntimeError("The model's server could not be reached.")

    monkeypatch.setattr(llm, "chat", down)
    post(client, f"/t/{study}/open/generate", CODER1)
    page = client.get(f"/t/{study}/open", headers=CODER1).text
    assert "That did not work" in page and "could not be reached" in page and "Carry on without candidates" in page

    reply = {"codes": [{"name": f"Code {n}", "definition": "When it applies.", "part": "nonsense"} for n in range(12)] + [{"name": "", "definition": "x"}, "junk"]}
    monkeypatch.setattr(llm, "chat", lambda *_, **__: "Here you go:\n```json\n" + json.dumps(reply) + "\n```")
    assert "error=" not in post(client, f"/t/{study}/open/generate", CODER1)
    mine = my_code_ids(study, "coder1@example.edu")
    assert len(mine) == assist.MAX_CANDIDATES and "Code 0" in mine  # capped, junk dropped
    with db.db() as conn:
        assert {r["part"] for r in conn.execute("SELECT part FROM pcode")} == {"question"}  # a made-up part is put right
        assert {r["status"] for r in conn.execute("SELECT status FROM pcode")} == {"candidate"}

    # Skipping is only for a run that failed.
    assert "error=" in post(client, f"/t/{study}/open/generate", CODER1, skip="1")
    monkeypatch.setattr(llm, "chat", down)
    post(client, f"/t/{study}/open/generate", CODER2)
    assert "error=" not in post(client, f"/t/{study}/open/generate", CODER2, skip="1")
    assert "Waiting for the cards" in client.get(f"/t/{study}/open", headers=CODER2).text


def test_a_job_left_working_reads_as_failed(client, study):
    with db.db() as conn:
        repo.start_job(conn, study, "merge", 0, "lead@example.edu")
        assert repo.job(conn, study, "merge")["status"] == "working"
        conn.execute("UPDATE job SET started_at = '2026-01-01T00:00:00+00:00'")
        assert repo.job(conn, study, "merge")["status"] == "failed"
        repo.start_job(conn, study, "merge", 0, "lead@example.edu")  # so it can be run again


# ------------------------------------------------------ open coding and merge


@pytest.fixture()
def coded(client, study, monkeypatch):
    """Open coding done by all three on the same four cards.

    coder1: "Who answers" on cards 0 and 1 (made as "Responsibility", renamed).
    coder2: "Who is responsible" on cards 0 and 1, and "Privacy" on card 2.
    lead:   "Who answers" on card 3 only.
    """
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "mock")
    cards = tokens(study, "cleared")
    for token in cards:
        jot(client, study, CODER2, token, "blame lands on the programmer")
    relock(study, done=(1, 2))
    for headers in (LEAD, CODER1):
        post(client, f"/t/{study}/open/generate", headers)
    batch = new_batch(client, LEAD, study, "starter", [], 4)
    return study, batch, batch_tokens(batch)


def test_open_coding_builds_a_personal_codebook(client, coded):
    track, batch, cards = coded
    # One deck, the same cards for the whole team, the lead included.
    assert "already%20has%20its%20cards" in post(client, f"/t/{track}/batches", LEAD, kind="starter", n_items="2")
    for headers in EVERYONE:
        assert client.get(f"/b/{batch}", headers=headers).status_code == 200
    # Generate comes first.
    assert "Generate%20your%20candidate%20codes%20first" in client.get(f"/b/{batch}/code/{cards[0]}", headers=CODER2).headers["location"]
    post(client, f"/t/{track}/open/generate", CODER2)
    card = client.get(f"/b/{batch}/code/{cards[0]}", headers=CODER2).text
    assert "Candidates" in card and "Blame" in card and 'data-key="q"' in card and 'data-key="n"' in card

    # A new code needs a definition; the card it was made on is its example.
    assert "Write%20a%20definition" in code(client, batch, CODER1, cards[0], new_name="Responsibility")
    assert f"/code/{cards[1]}" in code(client, batch, CODER1, cards[0], new_name="Responsibility", new_definition="Asks who answers for harm.")
    mine = my_code_ids(track, "coder1@example.edu")
    code(client, batch, CODER1, cards[1], code=str(mine["Responsibility"]))
    second = client.get(f"/b/{batch}/code/{cards[1]}", headers=CODER1).text
    assert f'value="{mine["Responsibility"]}" checked' in second and 'data-key="1"' in second
    with db.db() as conn:
        example = conn.execute("SELECT i.token FROM pcode p JOIN item i ON i.id = p.example_item_id WHERE p.id = ?", (mine["Responsibility"],)).fetchone()
    assert example["token"] == cards[0]

    # "Add and stay" keeps you on the card. Typing a name you already have uses that code.
    assert f"/code/{cards[0]}" in code(client, batch, CODER1, cards[0], code=str(mine["Responsibility"]), new_name="Scratch", new_definition="To be folded.", action="add")
    code(client, batch, CODER1, cards[2], new_name="  responsibility ")
    assert set(my_code_ids(track, "coder1@example.edu")) == {"Responsibility", "Scratch"}

    # Renaming changes it on every card. Renaming to a name you have folds the two.
    post(client, f"/t/{track}/codes/{mine['Responsibility']}", CODER1, name="Who answers", definition="Asks who answers for harm.")
    assert "Who answers" in client.get(f"/b/{batch}/code/{cards[1]}", headers=CODER1).text
    scratch = my_code_ids(track, "coder1@example.edu")["Scratch"]
    post(client, f"/t/{track}/codes/{scratch}", CODER1, name="who answers", definition="The definition typed while folding.")
    codes = client.get(f"/t/{track}/codes", headers=CODER1).text
    assert "Scratch" not in codes and "3 cards" in codes and "The definition typed while folding." in codes
    # Open coding has no submit, so nothing can lock a person's codes before the close.
    assert "error=" in post(client, f"/b/{batch}/submit", CODER1)

    # A candidate becomes yours when you tick it; unticking a code takes it off the card.
    blame = my_code_ids(track, "coder2@example.edu")["Blame"]
    code(client, batch, CODER2, cards[0], code=str(blame))
    with db.db() as conn:
        assert conn.execute("SELECT status, origin FROM pcode WHERE id = ?", (blame,)).fetchone()[:] == ("own", "model")
    code(client, batch, CODER2, cards[0])
    assert f'value="{blame}" checked' not in client.get(f"/b/{batch}/code/{cards[0]}", headers=CODER2).text

    # Nobody sees anyone else's codes, by any page, and nobody can use them.
    for path in (f"/b/{batch}/code/{cards[0]}", f"/t/{track}/codes", f"/t/{track}/open", f"/b/{batch}"):
        assert "Who answers" not in client.get(path, headers=CODER2).text, path
        assert "Who answers" not in client.get(path, headers=LEAD).text, path
    assert "error=" in code(client, batch, CODER2, cards[1], code=str(mine["Responsibility"]))
    assert "error=" in post(client, f"/t/{track}/codes/{mine['Responsibility']}", CODER2, name="Mine now", definition="x")
    for path in (f"/t/{track}/merge", f"/t/{track}/merge/cards/{blame}"):
        assert "error=" in client.get(path, headers=LEAD).headers["location"]


def finish_open_coding(client, coded):
    track, batch, cards = coded
    post(client, f"/t/{track}/open/generate", CODER2)
    code(client, batch, CODER1, cards[0], new_name="Responsibility", new_definition="Asks who answers for harm.")
    one = my_code_ids(track, "coder1@example.edu")["Responsibility"]
    code(client, batch, CODER1, cards[1], code=str(one))
    post(client, f"/t/{track}/codes/{one}", CODER1, name="Who answers", definition="Asks who answers for harm.")
    code(client, batch, CODER2, cards[0], new_name="Who is responsible", new_definition="Blame or duty is the question.")
    two = my_code_ids(track, "coder2@example.edu")["Who is responsible"]
    code(client, batch, CODER2, cards[1], code=str(two))
    code(client, batch, CODER2, cards[2], new_name="Privacy", new_definition="About being watched.")
    code(client, batch, LEAD, cards[3], new_name="Who answers", new_definition="Someone must answer.")
    for headers, left in ((CODER1, cards[2:]), (LEAD, cards[:3])):
        for token in left:
            code(client, batch, headers, token)  # read it, nothing applies
    return track, batch, cards


def test_closing_open_coding_fixes_the_codes_and_opens_the_codebook(client, coded):
    track, batch, cards = finish_open_coding(client, coded)
    # coder2 has one card left: the close waits, and says for whom.
    assert "Still%20waiting%20on%20coder2" in post(client, f"/b/{batch}/close", LEAD)
    assert client.post(f"/t/{track}/merge/run", headers=LEAD).headers["location"].count("error=") == 1  # still locked
    code(client, batch, CODER2, cards[3])
    assert "All cards coded" in client.get(f"/t/{track}/open", headers=CODER2).text
    assert client.post(f"/b/{batch}/close", headers=CODER1).status_code == 403
    assert f"/t/{track}/codebook" in post(client, f"/b/{batch}/close", LEAD)

    # Closing is the lead finishing the stage. Codes can no longer change.
    assert 'class="locked"' not in client.get(f"/t/{track}/codebook", headers=CODER1).text
    assert "not%20saved" in code(client, batch, CODER1, cards[0])
    one = my_code_ids(track, "coder1@example.edu")["Who answers"]
    assert "error=" in post(client, f"/t/{track}/codes/{one}", CODER1, name="Later", definition="x")
    assert "Waiting for the lead to run the merge" in client.get(f"/t/{track}/codebook", headers=CODER1).text


@pytest.fixture()
def merged(client, coded):
    track, batch, cards = finish_open_coding(client, coded)
    code(client, batch, CODER2, cards[3])
    post(client, f"/b/{batch}/close", LEAD)
    assert client.post(f"/t/{track}/merge/run", headers=CODER1).status_code == 403
    assert "error=" not in post(client, f"/t/{track}/merge/run", LEAD)
    return track, cards


def test_the_merge_proposes_one_codebook_from_everyones(client, merged):
    track, cards = merged
    assert "already%20been%20run" in post(client, f"/t/{track}/merge/run", LEAD)
    home = client.get(f"/t/{track}/codebook", headers=CODER1).text
    assert "Proposal ready" in home and "1 proposed code(s) from 3 of 4 personal codes. 1 undecided." in home

    # Everyone on the team can open it. It shows whose each code was, why they
    # were put together, an example and the jots behind them.
    page = client.get(f"/t/{track}/merge", headers=CODER1).text
    assert "1 proposed · 1 undecided · 0 dropped" in page
    proposed = page[page.index("<h2>Proposed codes</h2>"):]
    for text in ("Who answers", "Who is responsible", "2 of 2 cards shared", "same name", ">coder1<", ">coder2<", ">lead<", "blame lands on the programmer"):
        assert text in proposed, text
    undecided = page[page.index("<h2>Undecided</h2>"):page.index("<h2>Proposed codes</h2>")]
    assert 'code__name">Privacy' in undecided and 'code__name">Who answers' not in undecided

    with db.db() as conn:
        ids = {(r["email"].split("@")[0], r["name"]): r["id"] for r in conn.execute("SELECT p.id, p.name, r.email FROM pcode p JOIN roster r ON r.id = p.roster_id WHERE p.status = 'own'")}
        mcode = conn.execute("SELECT id FROM mcode").fetchone()["id"]
    cards_page = client.get(f"/t/{track}/merge/cards/{ids[('coder2', 'Who is responsible')]}", headers=CODER1).text
    assert cards_page.count("<h2>Item ") == 2 and "blame lands on the programmer" in cards_page
    # A candidate nobody took up is not a code, and cannot be looked up by its number.
    with db.db() as conn:
        unused = conn.execute("SELECT id FROM pcode WHERE status = 'candidate'").fetchone()["id"]
    assert "No%20such%20code" in client.get(f"/t/{track}/merge/cards/{unused}", headers=CODER1).headers["location"]

    # Nothing is written while a code is undecided.
    move = lambda who, name, to, headers=CODER1: post(client, f"/t/{track}/merge/move", headers, pcode=str(ids[(who, name)]), to=to)  # noqa: E731
    assert "still%20undecided" in post(client, f"/t/{track}/merge/write", CODER1)
    # The one action: where a personal code goes. Anyone can take it.
    move("coder2", "Privacy", "own", CODER2)
    move("lead", "Who answers", "drop")
    assert "2 proposed · 0 undecided · 1 dropped" in client.get(f"/t/{track}/merge", headers=LEAD).text
    move("lead", "Who answers", "undecided")
    move("lead", "Who answers", str(mcode))
    assert "error=" in move("lead", "Who answers", "999")
    post(client, f"/t/{track}/merge/code", CODER2, mcode=str(mcode), name="Responsibility", definition="The question is who answers for a harm.")

    # Writing it makes a draft with one tick-all-that-apply question; anyone publishes.
    assert f"/t/{track}/codebook/draft" in post(client, f"/t/{track}/merge/write", CODER1)
    assert "already%20open" in post(client, f"/t/{track}/merge/write", CODER1)
    with db.db() as conn:
        tree = repo.version_tree(conn, repo.draft(conn, track)["id"])
    codes = next(d for d in tree if d["key"] == "codes")
    assert codes["mode"] == "multi" and codes["part"] == "question"
    assert [(c["key"], c["label"]) for c in codes["codes"]] == [("responsibility", "Responsibility"), ("privacy", "Privacy")]
    assert all(c["example"] for c in codes["codes"])
    assert "error=" not in post(client, f"/t/{track}/codebook/draft/publish", CODER2, note="Merged at the meeting.")
    assert "Responsibility" in client.get(f"/t/{track}/codebook", headers=CODER1).text
    assert "error=" not in post(client, f"/t/{track}/stage/4/done", LEAD, done="1")

    # Each person can see what became of their own codes, and so can the export.
    assert "Became: Responsibility" in client.get(f"/t/{track}/codes", headers=CODER1).text
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/t/{track}/export.zip", headers=LEAD).content))
    rows = list(csv.DictReader(io.StringIO(archive.read("personal_codes.csv").decode())))
    assert {(r["coder"], r["name"], r["became"]) for r in rows} == {
        ("C01", "Who answers", "Responsibility"), ("C02", "Who answers", "Responsibility"),
        ("C03", "Who is responsible", "Responsibility"), ("C03", "Privacy", "Privacy"),
    }
    assert len(list(csv.DictReader(io.StringIO(archive.read("personal_code_cards.csv").decode())))) == 6


def test_a_model_grouping_is_checked_before_it_is_stored(client, coded, monkeypatch):
    track, batch, cards = finish_open_coding(client, coded)
    code(client, batch, CODER2, cards[3])
    post(client, f"/b/{batch}/close", LEAD)
    with db.db() as conn:
        given = repo.merge_inputs(conn, track)
    ids = {(c["roster_id"], c["name"]): c["id"] for c in given["codes"]}
    one, two, privacy, three = (ids[k] for k in sorted(ids, key=lambda k: ids[k]))
    seen = {}

    def chat(system, user, max_tokens=0):
        seen["prompt"] = user
        return json.dumps({"groups": [
            {"name": "Responsibility", "definition": "Who answers.", "reason": "Same idea.", "ids": [one, two, 999, "x", one]},
            {"name": "Again", "definition": "Reuses a code.", "ids": [two, privacy]},  # two is taken: one code left, no group
            {"name": "", "definition": "No name.", "ids": [privacy, three]},
        ]})

    monkeypatch.setattr(llm, "mode", lambda: "live")
    monkeypatch.setattr(llm, "chat", chat)
    groups = assist.proposal(studies.get("ethics"), given)
    assert [(g["name"], g["ids"]) for g in groups] == [("Responsibility", [one, two])]
    assert groups[0]["reason"] == "Same idea. (2 of 2 cards shared)"
    # The model was shown the codes, whose they were by letter, the counts and a jot; no names.
    prompt = seen["prompt"]
    assert "Who is responsible" in prompt and "on the same 2 of 2 cards" in prompt and "blame lands on the programmer" in prompt
    assert "coder1" not in prompt and "@" not in prompt
    # The lead can fall back to the plain merge after a failure.
    assert [sorted(g["ids"]) for g in assist.proposal(studies.get("ethics"), given, plain=True)] == [[one, two, three]]


def test_codes_are_grouped_by_shared_cards_only_across_people_and_parts():
    done = {1: {1, 2, 3, 4}, 2: {1, 2, 3}}
    code = lambda i, who, name, items, part="question": {"id": i, "roster_id": who, "name": name, "definition": "", "part": part, "items": set(items)}  # noqa: E731
    codes = [
        code(1, 1, "Harm", {1, 2}), code(2, 2, "Damage", {1, 2}),       # same cards
        code(3, 1, "Jobs", {3}), code(4, 2, "jobs ", {1}),              # same name
        code(5, 1, "Also harm", {1, 2, 4}),                             # same person as 1: never linked to it directly
        code(6, 2, "Diagram thing", {1, 2}, part="diagram"),            # another part
        code(7, 2, "Once", {3}), code(8, 1, "Once too", {3}),           # one shared card is not enough
    ]
    shared = merge.overlaps(codes, done)
    assert shared[(1, 2)] == (2, 2) and shared[(2, 5)] == (2, 2)  # card 4 is not counted: person 2 never reached it
    assert (1, 5) not in shared and (1, 6) not in shared
    groups = {tuple(sorted(g["ids"])): g for g in merge.by_cards(codes, done)}
    assert set(groups) == {(1, 2, 5), (3, 4)}
    assert groups[(3, 4)]["reason"] == "same name"
    assert merge.clean("not a list", codes, "question", shared) == []


# -------------------------------------------------------------- codebook draft


def test_anyone_can_restructure_the_draft(client):
    track = track_id()
    base = f"/t/{track}/codebook/draft"
    post(client, f"{base}/new", CODER1)
    # Move a code to another question, keeping what it says.
    post(client, f"{base}/code", CODER1, dimension="relation", key="unclear", label="Unclear", definition="Cannot be told.", move_to="issues")
    # Change a question's name and kind.
    post(client, f"{base}/dimension", CODER2, key="issues", name="Problems", mode="multi", part="diagram")
    with db.db() as conn:
        tree = {d["key"]: d for d in repo.version_tree(conn, repo.draft(conn, track)["id"])}
    assert [c["key"] for c in tree["issues"]["codes"]][-1] == "unclear" and tree["issues"]["name"] == "Problems"
    assert "unclear" not in [c["key"] for c in tree["relation"]["codes"]]
    assert "error=" in post(client, f"{base}/code", CODER1, dimension="relation", key="sequence", label="Sequencing", move_to="nowhere")
    # A question with codes in it cannot be removed in one press.
    assert "Move%20or%20remove%20its%20codes" in post(client, f"{base}/dimension-delete", CODER1, key="issues")
    # A draft can be thrown away; what is published is untouched.
    assert "Draft%20discarded" in post(client, f"{base}/discard", CODER1)
    with db.db() as conn:
        assert repo.draft(conn, track) is None and repo.latest_published(conn, track)["n"] == 1


# ------------------------------------------------------------ the diagram study


def test_the_diagram_study_runs_the_same_way_with_two_parts(client):
    """Photos are cleaned on the way through, and a code is about the diagram
    or the reflection: the two are never merged into one."""
    track = track_id()
    relock(track)
    # The team cannot move on while a photo is still uncleaned.
    assert "have%20not%20been%20cleaned" in post(client, f"/t/{track}/stage/1/done", LEAD, done="1")
    home = client.get(f"/t/{track}/triage", headers=CODER1).text
    assert "3 photos for you to clean" in home
    for token in tokens(track, "untriaged"):
        post(client, f"/t/{track}/triage/{token}", CODER1, mode="clean")
    assert "error=" not in post(client, f"/t/{track}/stage/1/done", LEAD, done="1")
    post(client, f"/t/{track}/stage/2/done", LEAD, done="1")
    for headers in EVERYONE:
        post(client, f"/t/{track}/open/generate", headers)
    batch = new_batch(client, LEAD, track, "starter", [], 4)
    cards = batch_tokens(batch)

    card = client.get(f"/b/{batch}/code/{cards[0]}", headers=CODER1).text
    assert '<select name="new_part">' in card and "The diagram" in card and "The reflection" in card
    code(client, batch, CODER1, cards[0], new_name="Boxes are steps", new_definition="Each box is one step.", new_part="diagram", action="add")
    code(client, batch, CODER1, cards[0], code=str(my_code_ids(track, "coder1@example.edu")["Boxes are steps"]),
         new_name="Says it was hard", new_definition="Names a difficulty.", new_part="reflection")
    code(client, batch, CODER2, cards[0], new_name="boxes are steps", new_definition="A box per step.", new_part="diagram", action="add")
    code(client, batch, CODER2, cards[0], code=str(my_code_ids(track, "coder2@example.edu")["boxes are steps"]),
         new_name="Says it was hard", new_definition="Same words, about the drawing.", new_part="diagram")
    assert "error=" in code(client, batch, CODER1, cards[1], new_name="Nowhere", new_definition="x", new_part="margin")
    for headers in EVERYONE:
        for token in cards[0 if headers is LEAD else 1:]:
            code(client, batch, headers, token)
    post(client, f"/b/{batch}/close", LEAD)
    post(client, f"/t/{track}/merge/run", LEAD)

    page = client.get(f"/t/{track}/merge", headers=CODER1).text
    assert "1 proposed · 2 undecided · 0 dropped" in page  # the same name about different parts is two codes
    with db.db() as conn:
        ids = {(r["email"].split("@")[0], r["name"]): r["id"] for r in conn.execute("SELECT p.id, p.name, r.email FROM pcode p JOIN roster r ON r.id = p.roster_id")}
        mcode = conn.execute("SELECT id FROM mcode").fetchone()["id"]
        has_photo = bool(repo.item_by_token(conn, cards[0])["raw_path"])
    assert ('class="thumb"' in page) == has_photo  # the example diagram is shown beside the code
    # A reflection code cannot be put into a diagram code.
    assert "about%20the%20diagram" in post(client, f"/t/{track}/merge/move", CODER1, pcode=str(ids[("coder1", "Says it was hard")]), to=str(mcode))
    for who in ("coder1", "coder2"):
        post(client, f"/t/{track}/merge/move", CODER1, pcode=str(ids[(who, "Says it was hard")]), to="own")
    post(client, f"/t/{track}/merge/write", CODER2)
    with db.db() as conn:
        tree = {d["key"]: d for d in repo.version_tree(conn, repo.draft(conn, track)["id"])}
    assert [c["label"] for c in tree["diagram-codes"]["codes"]] == ["Boxes are steps", "Says it was hard"]
    assert [c["label"] for c in tree["reflection-codes"]["codes"]] == ["Says it was hard"]
    assert tree["diagram-codes"]["part"] == "diagram" and tree["reflection-codes"]["part"] == "reflection"


# ------------------------------------------------- locking the team, cleaning


def unlocked(track):
    with db.db() as conn:
        conn.execute("DELETE FROM stage_done WHERE track_id = ?", (track,))
        conn.execute("DELETE FROM started")


def test_the_lead_locks_the_team_once_everyone_is_in(client):
    track = track_id()
    unlocked(track)
    # Before the lock nothing is open, and the lead sees who is in.
    assert 'class="locked"' in client.get(f"/t/{track}/triage", headers=CODER1).text
    assert "error=" in post(client, f"/t/{track}/triage/{tokens(track, 'untriaged')[0]}", CODER1)
    assert f"/t/{track}/stage/0" in post(client, f"/t/{track}/start", CODER1)
    waiting = client.get(f"/t/{track}/stage/0", headers=CODER1).text
    assert "You are in" in waiting and "Lock the team" not in waiting
    page = client.get(f"/t/{track}/stage/0", headers=LEAD).text
    assert "Lock the team" in page and page.count(">not started<") == 2 and page.count(">in<") == 1
    assert "Not%20started%20yet%3A%20lead%2C%20coder2" in post(client, f"/t/{track}/stage/0/done", LEAD, done="1")
    assert client.post(f"/t/{track}/stage/0/done", headers=CODER1, data={"done": "1"}).status_code == 403
    for headers in (LEAD, CODER2):
        post(client, f"/t/{track}/start", headers)
    assert "error=" not in post(client, f"/t/{track}/stage/0/done", LEAD, done="1")

    # Locked: the first stage is open, nobody can be added, and the photos are divided.
    assert "team%20is%20locked" in post(client, f"/t/{track}/roster", LEAD, email="late@example.edu", role="coder")
    assert "Add someone" not in client.get(f"/t/{track}/roster", headers=LEAD).text
    for headers in EVERYONE:
        assert "1 photo for you to clean" in client.get(f"/t/{track}/triage", headers=headers).text
    with db.db() as conn:
        owner = {r["token"]: r["email"] for r in conn.execute("SELECT i.token, r.email FROM cleaning c JOIN item i ON i.id = c.item_id JOIN roster r ON r.id = c.roster_id")}
    assert sorted(owner.values()) == ["coder1@example.edu", "coder2@example.edu", "lead@example.edu"]

    # A photo is its owner's to clean. The lead can step in on any.
    theirs = next(t for t, email in owner.items() if email == "coder2@example.edu")
    mine = next(t for t, email in owner.items() if email == "coder1@example.edu")
    assert "someone%20else" in post(client, f"/t/{track}/triage/{theirs}", CODER1, mode="clean")
    post(client, f"/t/{track}/triage/{mine}", CODER1, mode="clean")
    home = client.get(f"/t/{track}/triage", headers=CODER1).text
    assert "Your photos are clean" in home and "coder2 has 1" in home and "lead has 1" in home


def test_taking_someone_off_the_team_passes_their_photos_on(client):
    from helpers import roster_ids

    track = track_id()
    unlocked(track)
    for headers in EVERYONE:
        post(client, f"/t/{track}/start", headers)
    post(client, f"/t/{track}/stage/0/done", LEAD, done="1")
    (gone,) = roster_ids(track, "coder2@example.edu")
    post(client, f"/t/{track}/roster", LEAD, roster_id=gone, role="coder")  # active unticked
    with db.db() as conn:
        left = repo.cleaning_left(conn, track)
    assert int(gone) not in left and sum(left.values()) == 3 and sorted(left.values()) == [1, 2]
    assert client.get(f"/t/{track}/triage", headers=CODER2).status_code == 403
    # Off the team stays off while it is locked.
    assert "stays%20off" in post(client, f"/t/{track}/roster", LEAD, roster_id=gone, role="coder", active="1")
    roster = client.get(f"/t/{track}/roster", headers=LEAD).text
    assert "To clean" in roster and "their photos to clean go to the others" in roster
    # Unlocking lets the lead add someone; locking again deals only what has no one.
    post(client, f"/t/{track}/stage/0/done", LEAD, done="0")
    assert "error=" not in post(client, f"/t/{track}/roster", LEAD, roster_id=gone, role="coder", active="1")
    post(client, f"/t/{track}/stage/0/done", LEAD, done="1")
    with db.db() as conn:
        assert sorted(repo.cleaning_left(conn, track).values()) == [1, 2]  # nobody's photos were taken away
