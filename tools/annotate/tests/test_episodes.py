"""The seeded sessions study: built by the importer's own steps, its pages
open, no speaker label is stored, and episodes.csv places every episode."""

import csv
import io
import zipfile

from conftest import CODER1, LEAD
from helpers import track_id

from annotate import db, export, seed


def tables(client, track) -> dict[str, list[dict]]:
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/t/{track}/export.zip", headers=LEAD).content))
    return {name: list(csv.DictReader(io.StringIO(archive.read(name).decode()))) for name in archive.namelist()}


def everything() -> dict[str, list[dict]]:
    with db.db() as conn:
        names = [r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        return {name: [dict(r) for r in conn.execute(f"SELECT * FROM {name} ORDER BY rowid")] for name in names}


def test_the_seed_runs_twice_without_change(seeded):
    before = everything()
    assert seed.run() is False
    assert everything() == before


def test_no_speaker_label_is_stored(seeded):
    stored = " ".join(str(v) for rows in everything().values() for row in rows for v in row.values()).casefold()
    for label in (seed.RESEARCHER, *seed.PARTICIPANTS):
        assert label.casefold() not in stored
    for word in ("quartz", "heron", "pebble", "finch", "marble", "otter", "cobalt", "moth"):
        assert word not in stored, word
    assert "hi, i am [name]." in stored


def test_the_demo_sessions_pages_open(client):
    track = track_id("sessions-demo")
    for headers in (LEAD, CODER1):
        assert "Think-aloud sessions (synthetic)" in client.get("/", headers=headers).text
        for path in (f"/t/{track}/stage/0", f"/t/{track}/triage"):
            page = client.get(path, headers=headers, follow_redirects=True)
            assert page.status_code == 200, path
            assert "sess000" not in page.text, path  # the participant id stays in the export


def test_episodes_csv_places_every_episode_and_joins_on_token(client):
    track = track_id("sessions-demo")
    out = tables(client, track)
    episodes = out["episodes.csv"]
    with db.db() as conn:
        spans = conn.execute("SELECT COUNT(*) FROM item_span").fetchone()[0]
        lines = {(r["session_id"], r["seq"]): r for r in conn.execute("SELECT * FROM segment")}
    assert len(episodes) == spans == len(out["items.csv"]) and spans > 3
    assert {r["token"] for r in episodes} == {r["token"] for r in out["items.csv"]} == {r["token"] for r in out["texts.csv"]}
    assert {r["pid"] for r in episodes} == {"sess0000", "sess0001", "sess0002"}
    assert {r["session"] for r in episodes} == {"S01", "S02", "S03"}
    assert {(r["transcript_kind"], r["cut_rule"]) for r in episodes} == {("restored", "ep-v1")}
    # Ordered by session and time, each session's episodes tile it with no gap.
    for pid in ("sess0000", "sess0001", "sess0002"):
        mine = [r for r in episodes if r["pid"] == pid]
        assert [int(r["episode"]) for r in mine] == list(range(len(mine)))
        assert mine[0]["t_start_ms"] == "0" and mine[0]["first_src_id"] == f"{pid}-0"
        assert all(a["t_end_ms"] == b["t_start_ms"] for a, b in zip(mine, mine[1:]))
        assert sum(int(r["lines"]) for r in mine) == sum(1 for key in lines if lines[key]["src_id"].startswith(pid + "-"))
    # Words count the transcript lines, not the role labels in the stored text.
    first = episodes[0]
    with db.db() as conn:
        texts = [r["text"] for r in conn.execute(
            "SELECT g.text FROM segment g JOIN session se ON se.id = g.session_id JOIN item_span sp ON sp.session_id = se.id"
            " JOIN item i ON i.id = sp.item_id WHERE i.token = ? AND g.seq BETWEEN sp.seg_first AND sp.seg_last", (first["token"],)
        )]
    assert int(first["words"]) == sum(len(t.split()) for t in texts) and int(first["lines"]) == len(texts)


def test_episodes_csv_is_header_only_elsewhere_and_the_export_is_lead_only(client):
    assert "episodes.csv" in export.FILES
    out = tables(client, track_id("demo"))
    assert out["episodes.csv"] == []
    track = track_id("sessions-demo")
    assert client.get(f"/t/{track}/export.zip", headers=CODER1).status_code == 403
    assert "episodes.csv" in client.get(f"/t/{track}/export", headers=LEAD).text
