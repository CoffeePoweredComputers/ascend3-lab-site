"""The importer, against a folder laid out like the real dataset."""

import json

import pytest
from PIL import Image

from annotate import db, importer, repo


@pytest.fixture()
def folder(tmp_path):
    """Three submissions by two students; one has no diagram. Plus the
    by_student/ tree and notes file that the importer must leave alone."""
    root = tmp_path / "incoming"
    rows = [
        ("aaa111", "Homework05", "text_stats", "501", True),
        ("aaa111", "Homework06", "grade_report", "601", True),
        ("bbb222", "Homework05", "text_stats", "502", False),
    ]
    comments = []
    for hash_, homework, project, submission, has_diagram in rows:
        directory = root / "by_project" / f"{homework}_{project}" / hash_
        directory.mkdir(parents=True)
        (directory / f"vt_{project}_{submission}_approach.html").write_text("<p>ignored</p>")
        if has_diagram:
            Image.new("RGB", (60, 40), (10, 20, int(submission) % 255)).save(directory / f"vt_{project}_{submission}_diagram.jpeg")
        comments.append({"hash": hash_, "homework": homework, "project": project, "type": "approach", "text": "I split it into steps and then ordered them."})
        comments.append({"hash": hash_, "homework": homework, "project": project, "type": "challenges", "text": "Fine."})
    (root / "comments.jsonl").write_text("\n".join(json.dumps(c) for c in comments))
    (root / "manifest.csv").write_text(
        "hash,homework,project,submission_id,approach,challenges,diagram,n_present\n"
        + "\n".join(f"{h},{hw},{p},{s},1,1,{int(d)},3" for h, hw, p, s, d in rows)
    )
    by_student = root / "by_student" / "aaa111" / "Homework05_text_stats"
    by_student.mkdir(parents=True)
    Image.new("RGB", (60, 40)).save(by_student / "vt_text_stats_501_diagram.jpeg")
    (root / "growth_arcs.md").write_text("notes")
    return root


def counts():
    with db.db() as conn:
        return {
            table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("dataset", "track", "source", "item", "item_text", "item_state", "roster")
        }


def test_dry_run_counts_and_writes_nothing(folder, data_dir):
    report = importer.run(folder, "decomp", "Decomposition", None, dry_run=True)
    assert report == {
        "manifest_rows": 3, "submissions": 3, "diagrams_found": 2, "written_parts_found": 6,
        "submissions_without_diagram": 1, "duplicate_written_parts": 0,
    }
    assert counts()["dataset"] == 0 and not (data_dir / "raw").exists()


def test_one_item_is_a_whole_submission(folder, data_dir):
    report = importer.run(folder, "decomp", "Decomposition", "Lead@VT.edu")
    assert report["items_new"] == 3
    assert counts() == {"dataset": 1, "track": 1, "source": 3, "item": 3, "item_text": 6, "item_state": 3, "roster": 1}
    with db.db() as conn:
        assert {r["email"] for r in conn.execute("SELECT email FROM roster")} == {"lead@vt.edu"}
        track = conn.execute("SELECT id FROM track").fetchone()["id"]
        items = repo.items_with_status(conn, track, ["untriaged"])
        assert len(items) == 3
        assert all([t["part"] for t in i["texts"]] == ["approach", "challenges"] for i in items)
        assert sorted(bool(i["raw_path"]) for i in items) == [False, True, True]
        # "Fine." alone would be low content; with a real approach beside it, it is not.
        assert not any(i["low_content"] for i in items)
        # The submission with no diagram still has its id, from the manifest.
        assert conn.execute("SELECT submission_id FROM source WHERE hash = 'bbb222'").fetchone()[0] == "502"


def test_photos_are_stored_under_tokens_not_submission_ids(folder, data_dir):
    importer.run(folder, "decomp", "Decomposition", None)
    stored = sorted(p.name for p in (data_dir / "raw" / "decomp").iterdir())
    with db.db() as conn:
        tokens = sorted(r["token"] + ".jpg" for r in conn.execute("SELECT token FROM item WHERE raw_path IS NOT NULL"))
    assert stored == tokens and len(stored) == 2
    assert not any("501" in name or "601" in name or "aaa111" in name for name in stored)


def test_running_again_changes_nothing_and_keeps_triage(folder, data_dir):
    importer.run(folder, "decomp", "Decomposition", "lead@vt.edu")
    with db.db() as conn:
        conn.execute("UPDATE item_state SET status = 'cleared', rotation = 90")
        before = [tuple(r) for r in conn.execute("SELECT id, token, shuffle_key FROM item ORDER BY id")]
    report = importer.run(folder, "decomp", "Decomposition", "lead@vt.edu")
    assert report["items_new"] == 0 and report["items_kept"] == 3 and report["items_changed"] == 0
    with db.db() as conn:
        assert [tuple(r) for r in conn.execute("SELECT id, token, shuffle_key FROM item ORDER BY id")] == before
        assert {tuple(r) for r in conn.execute("SELECT status, rotation FROM item_state")} == {("cleared", 90)}
    assert counts()["roster"] == 1


def test_a_changed_photo_or_text_is_reported_not_overwritten(folder, data_dir):
    importer.run(folder, "decomp", "Decomposition", None)
    stored = next((data_dir / "raw" / "decomp").iterdir())
    original = stored.read_bytes()
    for photo in (folder / "by_project").glob("*/*/*_diagram.jpeg"):
        Image.new("RGB", (60, 40), (200, 0, 0)).save(photo)
    assert importer.run(folder, "decomp", "Decomposition", None)["items_changed"] == 2
    assert stored.read_bytes() == original


def test_a_bad_file_is_rejected_before_anything_is_copied(folder, data_dir):
    with open(folder / "comments.jsonl", "a") as f:
        f.write('\n{"hash": "aaa111", "homework": "Homework05", "project": "text_stats"}\n')
    with pytest.raises(ValueError, match="comments.jsonl, record 7"):
        importer.run(folder, "decomp", "Decomposition", None)
    assert not (data_dir / "raw").exists()


def test_a_written_part_that_appears_twice_is_counted(folder, data_dir):
    with open(folder / "comments.jsonl", "a") as f:
        f.write('\n' + json.dumps({"hash": "aaa111", "homework": "Homework05", "project": "text_stats", "type": "approach", "text": "Another."}))
    report = importer.run(folder, "decomp", "Decomposition", None)
    assert report["duplicate_written_parts"] == 1 and report["items_new"] == 3
    with db.db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM item_text WHERE text = 'Another.'").fetchone()[0] == 0
