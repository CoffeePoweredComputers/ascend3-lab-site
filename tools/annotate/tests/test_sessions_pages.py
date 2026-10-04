"""The pages of a study of recorded sessions: the episode card, the reading
list by session, and every other page an episode turns up on. None of them
may carry who the participant is or where their video came from."""

import re

import pytest
from conftest import CODER1, CODER2, LEAD
from fastapi.testclient import TestClient
from helpers import batch_tokens, new_batch, roster_ids
from test_import_sessions import PEOPLE, export  # noqa: F401  (export is the fixture)

from annotate import db, import_sessions, repo, studies

EVERYONE = {"lead@example.edu": LEAD, "coder1@example.edu": CODER1, "coder2@example.edu": CODER2}


@pytest.fixture()
def study(export, data_dir):  # noqa: F811
    """The synthetic export imported, with a team and a published codebook."""
    import_sessions.run(export, "sessions", "Sessions", "lead@example.edu")
    with db.db() as conn:
        track = conn.execute("SELECT id FROM track").fetchone()["id"]
        for email in ("coder1@example.edu", "coder2@example.edu"):
            repo.add_roster(conn, track, email, "coder")
        repo.new_draft(conn, track, "test")
        repo.save_dimension(conn, track, "move", "Move", "single", "episode", studies.get("sessions").parts)
        for key, label in (("plan", "Plans"), ("check", "Checks")):
            repo.save_code(conn, track, "move", key, {"label": label, "definition": label})
        repo.publish(conn, track, "v1")
    return track


@pytest.fixture()
def client(study):
    from annotate.main import app

    return TestClient(app, follow_redirects=False)


def finish(track, *stages):
    with db.db() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO stage_done (track_id, stage, done_by, done_at) VALUES (?, ?, 'test', '2026-01-01')",
            [(track, n) for n in stages],
        )


def post(client, path, headers, **data) -> str:
    response = client.post(path, headers=headers, data=data)
    assert response.status_code == 303, (path, response.status_code)
    assert "error=" not in response.headers["location"], response.headers["location"]
    return response.headers["location"]


def secrets() -> list[str]:
    """What no page may show: participant ids, the export's own ids and file
    names, and where the videos are kept."""
    with db.db() as conn:
        out = [r["pid"] for r in conn.execute("SELECT pid FROM session")]
        out += [r["media_path"].rsplit("/", 1)[1] for r in conn.execute("SELECT media_path FROM session")]
        out += [r["src_id"] for r in conn.execute("SELECT src_id FROM segment")]
    return out + ["video1", "uuid-"]


def clean(page: str, where: str) -> None:
    for secret in secrets():
        assert secret not in page, (where, secret)


def span(token: str) -> dict:
    with db.db() as conn:
        return dict(conn.execute(
            "SELECT sp.*, se.alias FROM item_span sp JOIN item i ON i.id = sp.item_id JOIN session se ON se.id = sp.session_id WHERE i.token = ?",
            (token,),
        ).fetchone())


def a_line(token: str) -> str:
    """A line of the participant's inside the episode, as it would appear on the page."""
    sp = span(token)
    with db.db() as conn:
        return conn.execute(
            "SELECT text FROM segment WHERE session_id = ? AND seq BETWEEN ? AND ? AND text LIKE 'I would%' ORDER BY seq LIMIT 1",
            (sp["session_id"], sp["seg_first"], sp["seg_last"]),
        ).fetchone()["text"]


def all_tokens(track) -> list[str]:
    with db.db() as conn:
        return [r["token"] for r in conn.execute("SELECT token FROM item WHERE track_id = ? ORDER BY shuffle_key", (track,))]


def test_the_card_is_the_video_with_the_transcript_once(client, study):
    token = all_tokens(study)[1]
    sp = span(token)
    for path in (f"/t/{study}/items/{token}",):
        page = client.get(path, headers=CODER1).text
        assert "<video" in page and f"/video/{token}#t=" in page and "/img/" not in page
        assert 'controlslist="nodownload"' in page and "autoplay" not in page
        assert "static/player.js" in page
        assert page.count(a_line(token)) == 1, path
        assert f"{sp['alias']} · " in page and f" · {sp['seq'] + 1} of " in page
        assert "study · " not in page and "t000" not in page  # the source's homework and project are not a task line here
        assert re.search(r'data-seek="\d+"', page) and "line--context" in page
        assert 'data-key=" "' in page and 'data-key=";"' in page


def test_a_session_without_its_video_is_read_as_text(client, study):
    with db.db() as conn:
        conn.execute("UPDATE session SET media_path = NULL")
    token = all_tokens(study)[0]
    page = client.get(f"/t/{study}/items/{token}", headers=CODER1).text
    assert "No video." in page and "<video" not in page and "data-seek" not in page
    assert page.count(a_line(token)) == 1


def test_reading_goes_a_session_at_a_time(client, study):
    finish(study, 0)
    firsts = {}
    for email, headers in EVERYONE.items():
        page = client.get(f"/t/{study}/triage", headers=headers).text
        assert "0 sessions read" in page and "to read" not in page
        assert all(f"S0{n} <small>0 of " in page for n in (1, 2, 3))
        firsts[email] = re.search(r'session/(S\d+)" data-key="Enter">Start', page)[1]
    assert len(set(firsts.values())) == 3  # each person at a different one

    # Reading a session whole counts as one, on the reading list and the roster.
    finish(study, 1)
    first = firsts["coder1@example.edu"]
    post(client, f"/t/{study}/session/{first}/read", CODER1)
    page = client.get(f"/t/{study}/triage", headers=CODER1).text
    assert "1 session read" in page and "Continue" in page
    assert f'session/{first}">{first} <small>' in page
    roster = client.get(f"/t/{study}/roster", headers=LEAD).text
    assert "1 session · " in roster and "0 sessions · 0 episodes" in roster


def test_no_page_shows_who_or_where_from(client, study):
    """Every page of the study, for the lead and for a coder, through open
    coding, the merge, a calibration round and the final pass."""
    tokens = all_tokens(study)
    pages = ["/", f"/t/{study}/stage/0", f"/t/{study}/triage", f"/t/{study}/items", f"/t/{study}/memos",
             f"/t/{study}/questions", f"/t/{study}/codebook", f"/t/{study}/open", f"/t/{study}/codes",
             f"/t/{study}/batches", f"/t/{study}/history", f"/t/{study}/guide/1", f"/t/{study}/production"]
    pages += [f"/t/{study}/session/S0{n}" for n in (1, 2, 3)] + [f"/t/{study}/items/{t}" for t in tokens[:3]]

    def check(paths, people=EVERYONE.values()):
        for headers in people:
            for path in paths:
                response = client.get(path, headers=headers)
                assert response.status_code == 200, (path, response.status_code)
                clean(response.text, path)

    check(pages)
    check([f"/t/{study}/roster"], [LEAD])

    # Open coding: a code made on a card, then the merge's page of its cards.
    finish(study, 0, 1, 2)
    for headers in EVERYONE.values():
        post(client, f"/t/{study}/open/generate", headers)
    batch = new_batch(client, LEAD, study, "starter", [], 3)
    cards = batch_tokens(batch)
    card = client.get(f"/b/{batch}/code/{cards[0]}", headers=CODER1).text
    assert "<video" in card and f"/video/{cards[0]}#t=" in card and card.count(a_line(cards[0])) == 1
    check([f"/b/{batch}/code/{t}" for t in cards])
    post(client, f"/b/{batch}/code/{cards[0]}", CODER1, new_name="Rechecks", new_definition="Goes back over a rule.", action="add")
    for headers in EVERYONE.values():
        for token in cards[1 if headers is CODER1 else 0:]:  # coder1's first card is done, with the code on it
            post(client, f"/b/{batch}/code/{token}", headers)
    post(client, f"/b/{batch}/close", LEAD)
    with db.db() as conn:
        pcode = conn.execute("SELECT id FROM pcode WHERE name = 'Rechecks'").fetchone()["id"]
    merged = client.get(f"/t/{study}/merge/cards/{pcode}", headers=CODER2).text
    assert f"/t/{study}/items/{cards[0]}" in merged and "<video" not in merged and a_line(cards[0]) in merged
    post(client, f"/t/{study}/merge/run", LEAD)
    check([f"/t/{study}/merge/cards/{pcode}", f"/t/{study}/merge"])

    # A calibration round the two coders split on, and its review.
    finish(study, 4)
    batch = new_batch(client, LEAD, study, "calibration", roster_ids(study, "coder1@example.edu", "coder2@example.edu"), 2)
    for headers, choice in ((CODER1, "plan"), (CODER2, "check")):
        for token in batch_tokens(batch):
            post(client, f"/b/{batch}/code/{token}", headers, **{"dim-move": choice})
        post(client, f"/b/{batch}/submit", headers)
    check([f"/b/{batch}/code/{t}" for t in batch_tokens(batch)], [CODER1, CODER2])
    post(client, f"/b/{batch}/close", LEAD)
    review = client.get(f"/b/{batch}/review", headers=CODER1).text
    assert "<video" not in review and "Card</a>" in review
    check([f"/b/{batch}/review?all=1", f"/b/{batch}/agreement", f"/t/{study}/history"])

    # The final pass, all agreed, and a code's page on the topic map.
    finish(study, 5)
    post(client, f"/t/{study}/batches", LEAD, kind="production", overlap="0")
    with db.db() as conn:
        final = repo.production(conn, study)["id"]
        dealt = conn.execute(
            "SELECT i.token, r.email FROM assignment a JOIN item i ON i.id = a.item_id JOIN roster r ON r.id = a.roster_id WHERE a.batch_id = ?",
            (final,),
        ).fetchall()
    for row in dealt:
        post(client, f"/b/{final}/code/{row['token']}", EVERYONE[row["email"]], **{"dim-move": "plan"})
    for headers in EVERYONE.values():
        post(client, f"/b/{final}/submit", headers)
    post(client, f"/b/{final}/close", LEAD)
    finish(study, 6)
    topic = client.get(f"/t/{study}/themes/code/move/plan", headers=CODER1).text
    assert "<video" not in topic and "Card</a>" in topic
    check([f"/t/{study}/themes", f"/t/{study}/themes/code/move/plan", f"/t/{study}/production", f"/b/{final}/review?all=1"])
