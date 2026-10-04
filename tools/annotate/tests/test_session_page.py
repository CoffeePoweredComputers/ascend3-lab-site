"""A recorded session read whole: one page with the video and every line of
the transcript, jots written on lines, and a session marked read at once."""

import csv
import io
import re
import zipfile

from conftest import CODER1, CODER2, LEAD, OUTSIDER
from test_import_sessions import export  # noqa: F401  (the fixture)
from test_sessions_pages import EVERYONE, clean, client, finish, post, study  # noqa: F401  (client and study are fixtures)

from annotate import db, importer, repo, studies

ADMIN = {"X-Tool-User": "admin@example.edu", "X-Tool-Uid": "uid-admin", "X-Tool-Role": "admin"}


def session(alias: str = "S01") -> dict:
    with db.db() as conn:
        return dict(conn.execute("SELECT id, duration_ms FROM session WHERE alias = ?", (alias,)).fetchone())


def episodes(alias: str = "S01") -> list[dict]:
    with db.db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT i.id, i.token, sp.seq, sp.t_start_ms, sp.seg_first, sp.seg_last FROM item_span sp JOIN item i ON i.id = sp.item_id"
            " JOIN session se ON se.id = sp.session_id WHERE se.alias = ? ORDER BY sp.seq",
            (alias,),
        )]


def set_status(item_id: int, status: str) -> None:
    with db.db() as conn:
        conn.execute("UPDATE item_state SET status = ? WHERE item_id = ?", (status, item_id))


def jot(client, headers, seq: int, body: str, alias: str = "S01"):
    with db.db() as conn:
        track = conn.execute("SELECT id FROM track").fetchone()["id"]
    return client.post(f"/t/{track}/session/{alias}/line/{seq}", headers=headers, data={"body": body})


def line_jots(email: str) -> list[dict]:
    with db.db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT m.item_id, m.segment_id, m.body FROM memo m JOIN roster r ON r.id = m.roster_id"
            " WHERE r.email = ? AND m.kind = 'jotting' AND m.segment_id IS NOT NULL ORDER BY m.id",
            (email,),
        )]


def test_the_page_is_the_whole_session_in_time_order(client, study):
    finish(study, 0)
    page = client.get(f"/t/{study}/session/S01", headers=CODER1).text
    sid = session()["id"]
    with db.db() as conn:
        n = len(repo.segments(conn, sid, 0, 10**9))
    assert page.count("<video") == 1 and 'controlslist="nodownload"' in page and 'preload="metadata"' in page
    assert "autoplay" not in page and re.search(r'src="/video/[\w-]+"', page)  # the whole recording, no #t=
    starts = [int(t) for t in re.findall(r'<li class="line[^"]*" data-t="(\d+)"', page)]
    assert len(starts) == n and starts == sorted(starts)
    assert [int(s) for s in re.findall(r'data-seq="(\d+)"', page)] == list(range(n))
    assert "static/session.js" in page and "static/player.js" in page and 'data-key="j"' in page
    for headers in EVERYONE.values():
        clean(client.get(f"/t/{study}/session/S01", headers=headers).text, "session page")
    assert "transcripts" not in page and ".json" not in page and ".mp4" not in page


def test_who_reaches_it(client, study):
    assert client.get(f"/t/{study}/session/S01", headers=OUTSIDER).status_code == 403
    assert client.get(f"/t/{study}/session/S09", headers=LEAD).status_code == 404
    assert client.get(f"/t/{study}/session/kx101", headers=LEAD).status_code == 404  # a pid is not an address
    with db.db() as conn:
        dataset_id, other = importer.ensure_dataset(conn, "eth", "Ethics", "ethics")
        source = importer.ensure_source(conn, dataset_id, ("h", "w", "p"))
        importer.add_item(conn, other, source, "eth", studies.get("ethics"), None, [("question", "Is it fair?", False)])
        repo.add_roster(conn, other, "lead@example.edu", "lead")
    assert client.get(f"/t/{other}/session/S01", headers=LEAD).status_code == 404


def test_a_session_without_its_video_still_reads(client, study):
    with db.db() as conn:
        conn.execute("UPDATE session SET media_path = NULL")
    page = client.get(f"/t/{study}/session/S01", headers=CODER1).text
    assert "No video." in page and "<video" not in page and "data-seek" not in page and 'data-seq="0"' in page


def test_a_jot_on_a_line_is_its_writers_alone(client, study):
    finish(study, 0)
    ep = episodes()[1]
    seq = ep["seg_first"] + 1
    response = jot(client, CODER1, seq, "  rereads the rule  ")
    assert response.status_code == 200 and response.json() == {"body": "rereads the rule"}
    sid = session()["id"]
    with db.db() as conn:
        segment = conn.execute("SELECT id FROM segment WHERE session_id = ? AND seq = ?", (sid, seq)).fetchone()["id"]
    assert line_jots("coder1@example.edu") == [{"item_id": ep["id"], "segment_id": segment, "body": "rereads the rule"}]
    assert "rereads the rule</p>" in client.get(f"/t/{study}/session/S01", headers=CODER1).text
    for headers in (CODER2, LEAD):
        assert "rereads the rule" not in client.get(f"/t/{study}/session/S01", headers=headers).text

    # Writing again edits it; empty text deletes it.
    assert jot(client, CODER1, seq, "rereads it twice").json() == {"body": "rereads it twice"}
    assert [j["body"] for j in line_jots("coder1@example.edu")] == ["rereads it twice"]
    assert jot(client, CODER1, seq, "   ").json() == {"body": ""}
    assert line_jots("coder1@example.edu") == []


def test_a_jot_is_refused_when_it_may_not_be_written(client, study):
    response = jot(client, CODER1, 0, "too early")
    assert response.status_code == 409 and "locked" in response.json()["error"]
    finish(study, 0)
    assert jot(client, ADMIN, 0, "not on the team").status_code == 403
    assert jot(client, OUTSIDER, 0, "not on the roster").status_code == 403
    assert jot(client, CODER1, 10_000, "no such line").status_code == 409
    with db.db() as conn:
        me = conn.execute("SELECT id FROM roster WHERE email = 'coder1@example.edu'").fetchone()["id"]
        repo.start_job(conn, study, "candidates", me, "coder1@example.edu")
    response = jot(client, CODER1, 0, "after generating")
    assert response.status_code == 409 and "closed" in response.json()["error"]
    assert line_jots("coder1@example.edu") == [] and line_jots("admin@example.edu") == []
    assert 'data-jot-form' not in client.get(f"/t/{study}/session/S01", headers=CODER1).text


def test_line_jots_survive_every_other_way_of_jotting(client, study):
    finish(study, 0)
    ep = episodes()[0]
    with db.db() as conn:
        me = conn.execute("SELECT id, email FROM roster WHERE email = 'coder1@example.edu'").fetchone()
        before = repo.feet(conn, study, me["id"], me["email"])
    for seq, body in ((ep["seg_first"], "line one"), (ep["seg_first"] + 1, "line two")):
        assert jot(client, CODER1, seq, body).status_code == 200
    with db.db() as conn:
        assert repo.feet(conn, study, me["id"], me["email"]) == before + repo.FEET["jotting"]  # one episode, however many lines

    # The episode's own jot box, on Items, the reading card's form, and the
    # coding card's note (which goes through set_jotting).
    card = client.get(f"/t/{study}/items/{ep['token']}", headers=CODER1).text
    assert "line one" not in card
    post(client, f"/t/{study}/items/{ep['token']}/jot", CODER1, body="the whole card")
    post(client, f"/t/{study}/triage/{ep['token']}", CODER1, jot="from the old card")
    with db.db() as conn:
        repo.set_jotting(conn, study, me["id"], ep["id"], "from a coding card")
        item_level = [r["body"] for r in conn.execute(
            "SELECT body FROM memo WHERE roster_id = ? AND item_id = ? AND segment_id IS NULL", (me["id"], ep["id"])
        )]
        assert repo.my_jot(conn, me["id"], ep["id"]) == "from a coding card"
        assert len(repo.candidate_inputs(conn, study, me["id"])["jots"]) == 3
    assert item_level == ["from a coding card"]
    assert [j["body"] for j in line_jots("coder1@example.edu")] == ["line one", "line two"]


def test_marking_a_session_read_marks_its_kept_episodes_and_moves_on(client, study):
    finish(study, 0)
    eps = episodes()
    set_status(eps[-1]["id"], "excluded")
    location = post(client, f"/t/{study}/session/S01/read", CODER1)
    assert re.search(r"/t/\d+/session/S0[23]\?ok=S01%20read", location)
    with db.db() as conn:
        me = conn.execute("SELECT id FROM roster WHERE email = 'coder1@example.edu'").fetchone()["id"]
        seen = {r["item_id"] for r in conn.execute("SELECT item_id FROM seen WHERE roster_id = ?", (me,))}
    assert seen == {e["id"] for e in eps[:-1]}
    page = client.get(f"/t/{study}/session/S01", headers=CODER1).text
    assert "Mark unread" in page and "Mark session read" not in page

    post(client, f"/t/{study}/session/S01/read", CODER1, read="0")
    with db.db() as conn:
        assert not conn.execute("SELECT 1 FROM seen WHERE roster_id = ?", (me,)).fetchone()

    for alias in ("S01", "S02"):
        post(client, f"/t/{study}/session/{alias}/read", CODER1)
    assert "/triage?ok=" in post(client, f"/t/{study}/session/S03/read", CODER1)
    assert client.post(f"/t/{study}/session/S01/read", headers=ADMIN).status_code == 403


def test_an_excluded_episode_takes_no_jot_and_shows_a_coder_nothing(client, study):
    finish(study, 0)
    ep = episodes()[1]
    set_status(ep["id"], "excluded")
    inside = range(ep["seg_first"], ep["seg_last"] + 1)
    said = [f"step {n}." for n in inside if n % 2 == 0 and n != 2]  # line 2 is the one with the names in it
    page = client.get(f"/t/{study}/session/S01", headers=CODER1).text
    assert "Not in the data." in page and said and not any(s in page for s in said)
    assert not any(f'data-seq="{n}"' in page or f'data-seek="{n * 20_000}"' in page for n in inside)
    lead = client.get(f"/t/{study}/session/S01", headers=LEAD).text
    assert all(s in lead for s in said) and not any(f'data-seq="{n}"' in lead for n in inside)
    response = jot(client, CODER1, ep["seg_first"], "on an excluded line")
    assert response.status_code == 409 and line_jots("coder1@example.edu") == []


def test_the_reading_card_sends_the_reader_to_the_session(client, study):
    ep = episodes()[2]
    response = client.get(f"/t/{study}/triage/{ep['token']}", headers=CODER1)
    assert response.status_code == 303 and response.headers["location"] == f"/t/{study}/session/S01?at={ep['t_start_ms']}"
    # A lead settling a flagged or excluded one still has the card.
    set_status(ep["id"], "pii_hold")
    assert client.get(f"/t/{study}/triage/{ep['token']}", headers=LEAD).status_code == 200
    assert client.get(f"/t/{study}/triage/{ep['token']}", headers=CODER1).status_code == 403


def test_the_export_says_when_a_line_jot_was_spoken(client, study):
    finish(study, 0)
    ep = episodes()[0]
    jot(client, CODER1, ep["seg_first"] + 2, "a line")
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/t/{study}/export.zip", headers=LEAD).content))
    rows = list(csv.DictReader(io.StringIO(archive.read("memos.csv").decode())))
    assert [(r["body"], r["line_start_ms"], r["token"]) for r in rows] == [("a line", str((ep["seg_first"] + 2) * 20_000), ep["token"])]
