"""The sessions importer, against a folder laid out like a real export. Every
label and name here is invented."""

import csv
import hashlib
import json

import pytest

from annotate import assist, db, import_sessions, repo, seed, stages, studies
from conftest import LEAD

RESEARCHER = "TealHarbor"
PEOPLE = {"kx101": "OrangeLantern", "kx102": "PlumAnchor", "kx103": "GreyMeadow"}


def lines(pid: str, minutes: int = 6) -> list[dict]:
    """A session as the export stores it: the participant talks, the
    researcher prompts every 40 s. Stored order is the reverse of time order."""
    rows = []
    for n in range(minutes * 60 // 20):
        prompt = n % 2 == 1
        rows.append({
            "id": f"seg-{pid}-{n}", "speaker": RESEARCHER if prompt else PEOPLE[pid],
            "t_start_ms": n * 20_000, "t_end_ms": n * 20_000 + 15_000,
            "text": "What are you thinking?" if prompt else f"I would check the rule again, step {n}.",
            "ordinal": 1000 - n,
        })
    rows[2]["text"] = "Thanks Teal, I think Harbor is the wrong word here."
    return rows


@pytest.fixture()
def export(tmp_path):
    """Three study sessions and a pilot. kx101 has a restored transcript beside
    its original; kx102 has only an original, with the unnamed second track."""
    root = tmp_path / "export"
    index, manifest = [], []
    for pid, collection in (("kx101", "study"), ("kx102", "study"), ("kx103", "study"), ("900", "pilot")):
        folder = root / "sessions" / collection / pid
        (folder / "transcripts").mkdir(parents=True)
        (folder / "video").mkdir()
        rows = lines(pid) if pid in PEOPLE else [{"id": "p", "speaker": None, "t_start_ms": 0, "t_end_ms": 1, "text": "pilot", "ordinal": 0}]
        kinds = {"original": rows}
        if pid == "kx101":
            kinds = {"original": [dict(r, text="not this one") for r in rows], "restored": rows}
        if pid == "kx102":
            kinds = {"original": rows + [dict(r, id=r["id"] + "-dup", speaker="speaker") for r in rows]}
        for kind, segments in kinds.items():
            (folder / "transcripts" / f"{pid}.{kind}.json").write_text(json.dumps(
                {"session_id": f"uuid-{pid}", "pid": pid, "version": {"id": f"ver-{pid}-{kind}", "kind": kind}, "segments": segments}
            ))
        video = folder / "video" / f"video1{pid}.mp4"
        video.write_bytes(b"not really a video " + pid.encode())
        relative = str(video.relative_to(root))
        index.append({"participant_id": pid, "collection": collection, "primary_video": relative, "video_duration_seconds": "365.5"})
        manifest.append({"path": relative, "bytes": video.stat().st_size, "sha256": hashlib.sha256(video.read_bytes()).hexdigest()})
    for name, rows in (("session-index.csv", index), ("file-manifest.csv", manifest)):
        with open(root / name, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    return root


def load(export, **kwargs):
    return import_sessions.run(export, "sessions", "Sessions", kwargs.pop("lead", None), **kwargs)


def table(name: str) -> list[dict]:
    with db.db() as conn:
        return [dict(r) for r in conn.execute(f"SELECT * FROM {name}")]


def test_dry_run_counts_and_writes_nothing(export, data_dir):
    report = load(export, dry_run=True)
    assert report["sessions"] == 3 and report["transcripts"] == "2 original, 1 restored"
    assert report["lines_kept"] == 54 and report["unnamed_lines_dropped"] == 18
    assert report["lines_without_role"] == 0
    assert not table("dataset") and not (data_dir / "raw").exists()


def test_no_name_is_stored_anywhere(export, data_dir):
    load(export, lead="lead@example.edu")
    assert {s["speaker"] for s in table("segment")} == {"R", "P"}
    with db.db() as conn:
        tables = [r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    stored = " ".join(str(v) for t in tables for row in table(t) for v in row.values()).casefold()
    for word in ("teal", "harbor", "orange", "lantern", "plum", "anchor", "grey", "meadow"):
        assert word not in stored
    assert stored.count("thanks [name], i think [name] is the wrong word here.") == 6  # 3 sessions, in the line and in its episode
    assert "not this one" not in stored  # the restored transcript was the one read


def test_only_study_sessions_are_loaded_and_the_pilot_is_not(export, data_dir):
    load(export)
    sessions = table("session")
    assert sorted(s["pid"] for s in sessions) == ["kx101", "kx102", "kx103"]
    assert sorted(s["alias"] for s in sessions) == ["S01", "S02", "S03"]
    assert {s["transcript_kind"] for s in sessions} == {"original", "restored"}


def test_episodes_tile_each_session_and_read_in_order(export, data_dir):
    load(export)
    with db.db() as conn:
        for s in conn.execute("SELECT * FROM session").fetchall():
            spans = conn.execute("SELECT * FROM item_span WHERE session_id = ? ORDER BY seq", (s["id"],)).fetchall()
            assert [sp["seq"] for sp in spans] == list(range(len(spans))) and len(spans) > 1
            assert spans[0]["t_start_ms"] == 0 and spans[-1]["t_end_ms"] == s["duration_ms"]
            assert all(a["t_end_ms"] == b["t_start_ms"] and a["seg_last"] + 1 == b["seg_first"] for a, b in zip(spans, spans[1:]))
            n = conn.execute("SELECT COUNT(*) FROM segment WHERE session_id = ?", (s["id"],)).fetchone()[0]
            assert spans[0]["seg_first"] == 0 and spans[-1]["seg_last"] == n - 1
            starts = [r["t_start_ms"] for r in conn.execute("SELECT t_start_ms FROM segment WHERE session_id = ? ORDER BY seq", (s["id"],))]
            assert starts == sorted(starts)  # time order, not the stored order
        # The reading order takes a session's episodes together, in time order.
        order = conn.execute(
            "SELECT sp.session_id, sp.seq, i.shuffle_key FROM item i JOIN item_span sp ON sp.item_id = i.id ORDER BY i.shuffle_key"
        ).fetchall()
    assert all(0 <= r["shuffle_key"] < 1 for r in order)
    runs = [r["session_id"] for r in order]
    assert len({(a, b) for a, b in zip(runs, runs[1:]) if a != b}) == 2
    assert all(b["seq"] == a["seq"] + 1 for a, b in zip(order, order[1:]) if a["session_id"] == b["session_id"])


def test_an_item_is_text_a_coder_can_read(export, data_dir):
    load(export)
    with db.db() as conn:
        track = conn.execute("SELECT id FROM track").fetchone()["id"]
        items = repo.items_with_status(conn, track, ["cleared"])
    assert items and all(i["raw_path"] is None and not i["low_content"] for i in items)
    text = items[0]["texts"][0]
    assert text["part"] == "episode" and text["text"].startswith(("Participant: ", "Researcher: "))


def test_the_cut_follows_the_researcher_then_the_cap():
    seg = lambda t, role: import_sessions.Seg(t * 1000, t * 1000, "", "x", "id", 0, role)  # noqa: E731
    # A prompt before a minute has passed does not cut; the next one does.
    talk = [seg(0, "P"), seg(30, "R"), seg(35, "P"), seg(70, "R"), seg(80, "P"), seg(100, "P")]
    assert import_sessions.cut_episodes(talk, 200_000) == [(0, 70_000, 0, 2), (70_000, 200_000, 3, 5)]
    # Nobody prompts: cut at the first line past two and a half minutes.
    alone = [seg(t, "P") for t in range(0, 400, 50)]
    assert [e[:2] for e in import_sessions.cut_episodes(alone, 400_000)] == [(0, 150_000), (150_000, 300_000), (300_000, 400_000)]
    # A last piece under twenty seconds joins the one before.
    assert import_sessions.cut_episodes(alone[:4], 160_000) == [(0, 160_000, 0, 3)]


def test_the_video_is_stored_under_its_content_not_its_name(export, data_dir):
    load(export)
    stored = sorted(p.name for p in (data_dir / "raw" / "sessions" / "video").iterdir())
    assert len(stored) == 3 and all(len(name) == 20 and name.endswith(".mp4") for name in stored)
    assert not any(pid in name for name in stored for pid in PEOPLE)
    assert {s["media_path"] for s in table("session")} == {f"sessions/video/{name}" for name in stored}


def test_a_video_that_fails_its_checksum_is_refused_before_anything_is_written(export, data_dir):
    (export / "sessions" / "study" / "kx103" / "video" / "video1kx103.mp4").write_bytes(b"something else, same name")
    with pytest.raises(ValueError, match="checksum"):
        load(export)
    assert not table("dataset") and not list((data_dir / "raw").rglob("*.part"))


def test_a_label_with_no_role_stops_the_import(export, data_dir, tmp_path):
    path = export / "sessions" / "study" / "kx102" / "transcripts" / "kx102.original.json"
    data = json.loads(path.read_text())
    data["segments"].append({"id": "extra", "speaker": "RustKettle", "t_start_ms": 5, "t_end_ms": 6, "text": "Hello.", "ordinal": 0})
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError) as refusal:
        load(export)
    assert "session kx102" in str(refusal.value) and "Kettle" not in str(refusal.value)
    assert not table("dataset") and not (data_dir / "raw").exists()
    # The names file places the label by its digest, and blanks a word no label gives away.
    names = tmp_path / "names.txt"
    names.write_text(f"{import_sessions.digest('RustKettle')},R\n{import_sessions.digest('PlumAnchor')},P\nrule\n")
    report = load(export, names=names)
    assert report["sessions_new"] == 3
    assert not any("rule" in s["text"].lower() for s in table("segment"))


def test_running_again_keeps_everything(export, data_dir):
    load(export, lead="lead@example.edu")
    before = table("item"), table("session")
    report = load(export, lead="lead@example.edu")
    assert (report["sessions_new"], report["sessions_kept"], report["sessions_changed"], report["items_new"]) == (0, 3, 0, 0)
    assert (table("item"), table("session")) == before and len(table("roster")) == 1


def test_a_changed_transcript_is_reported_and_replace_needs_untouched_items(export, data_dir):
    load(export, lead="lead@example.edu")
    path = export / "sessions" / "study" / "kx103" / "transcripts" / "kx103.original.json"
    data = json.loads(path.read_text())
    data["version"]["id"] = "ver-103-again"
    path.write_text(json.dumps(data))
    before = table("item")
    assert load(export)["sessions_changed"] == 1 and table("item") == before

    report = load(export, replace=True)
    assert report["sessions_new"] == 3 and len(table("item")) == len(before)
    assert not {i["token"] for i in table("item")} & {i["token"] for i in before}
    assert "ver-103-again" in {s["transcript_version"] for s in table("session")}

    # Once someone has read a card, the items are no longer the importer's to replace.
    with db.db() as conn:
        conn.execute("INSERT INTO seen (item_id, roster_id, at) VALUES ((SELECT MIN(id) FROM item), (SELECT id FROM roster), 'now')")
    tokens = {i["token"] for i in table("item")}
    with pytest.raises(repo.Refused, match="seen"):
        load(export, replace=True)
    assert {i["token"] for i in table("item")} == tokens


def test_the_pages_open_on_an_imported_study(export, data_dir):
    from fastapi.testclient import TestClient

    from annotate.main import app

    load(export, lead="lead@example.edu")
    client = TestClient(app, follow_redirects=True)
    track = table("track")[0]["id"]
    token = table("item")[0]["token"]
    for path in ("/", f"/t/{track}/stage/0", f"/t/{track}/triage", f"/t/{track}/triage/{token}", f"/t/{track}/items/{token}"):
        page = client.get(path, headers=LEAD)
        assert page.status_code == 200, path
        assert not any(pid in page.text for pid in PEOPLE), path


def test_a_study_whose_text_stays_here_never_reaches_a_live_model(monkeypatch):
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "https://model.example/v1")
    assert assist._mode(studies.get("ethics")) == "live"
    assert assist._mode(studies.get("sessions")) == "off"
    monkeypatch.setenv("ANNOTATE_LLM_BASE_URL", "mock")
    assert assist._mode(studies.get("sessions")) == "mock"


def test_a_guide_in_the_data_directory_wins_and_a_missing_one_is_empty(data_dir):
    assert stages.brief(0, "sessions") == ""
    assert "Calibration" in stages.brief(5, "sessions") or stages.brief(5, "sessions")  # shared guides still apply
    own = data_dir / "briefs" / "sessions"
    own.mkdir(parents=True)
    (own / "00-onboarding.md").write_text("Kept out of the repo.")
    assert stages.brief(0, "sessions") == "Kept out of the repo."
    assert stages.brief(0, "ethics") != "Kept out of the repo."


def test_reset_spares_what_is_waiting_to_be_imported(data_dir, monkeypatch):
    monkeypatch.setenv("ANNOTATE_DEV_USER", "lead@example.edu")
    (data_dir / "incoming" / "export").mkdir(parents=True)
    (data_dir / "incoming" / "export" / "video.mp4").write_bytes(b"x")
    (data_dir / "raw").mkdir()
    seed.reset()
    assert (data_dir / "incoming" / "export" / "video.mp4").exists()
    assert not (data_dir / "raw").exists() and not (data_dir / "annotate.db").exists()
