"""Reading a form-responses spreadsheet, and loading it as a study."""

import zipfile

import pytest

from annotate import db, import_table, repo, tabular

HEADERS = ["Timestamp", "Topic", "Your question", "Which lens did you use, if any?"]
ROWS = [
    ["46293.45", "Face recognition", "Can a person consent to being scanned in public?", "Duty: what do I owe the users?"],
    ["46293.51", "AI", "Who answers for bugs a model wrote, and should it be the model's maker or me?", "Outcomes: What is the sum of my actions?, Moral distance: many hands"],
    ["46294.02", "ai", "Hm", "None, or not sure"],
]
SHEET = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def write_xlsx(path, grid):
    """A workbook the way a spreadsheet app writes one: text in a shared-strings
    table, numbers inline, cells addressed A1-style."""
    strings, cells = [], []
    for r, row in enumerate(grid, start=1):
        out = ""
        for c, value in enumerate(row):
            ref = f"{chr(65 + c)}{r}"
            if value == "":
                continue
            try:
                float(value)
                out += f'<c r="{ref}"><v>{value}</v></c>'
            except ValueError:
                strings.append(value)
                out += f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>'
        cells.append(f'<row r="{r}">{out}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    escape = lambda s: s.replace("&", "&amp;").replace("<", "&lt;")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml", f"<worksheet {ns}><sheetData>{''.join(cells)}</sheetData></worksheet>")
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}>{''.join(f'<si><t>{escape(s)}</t></si>' for s in strings)}</sst>")
    return path


def write_csv(path, grid):
    import csv

    with open(path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(grid)
    return path


def test_xlsx_and_csv_read_the_same_rows(tmp_path):
    grid = [HEADERS, *ROWS, ["", "", "", ""]]  # a trailing blank row, as sheets often have
    from_xlsx = tabular.read(write_xlsx(tmp_path / "r.xlsx", grid))
    from_csv = tabular.read(write_csv(tmp_path / "r.csv", grid))
    assert from_xlsx == from_csv
    assert len(from_xlsx) == 3 and from_xlsx[1]["Topic"] == "AI"
    assert "Moral distance: many hands" in from_xlsx[1]["Which lens did you use, if any?"]


def test_a_workbook_with_a_doctype_is_refused(tmp_path):
    path = tmp_path / "bad.xlsx"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml", '<!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet/>')
    with pytest.raises(ValueError, match="document type"):
        tabular.read(path)


def load(path, **kwargs):
    return import_table.run(path, "ethics-w6", "Ethics, week 6", "ethics", "Week06", "lead@vt.edu", **kwargs)


def test_dry_run_counts_and_writes_nothing(tmp_path, data_dir):
    report = load(write_xlsx(tmp_path / "r.xlsx", [HEADERS, *ROWS]), dry_run=True)
    assert report == {"rows": 3, "responses": 3, "blank_rows": 0, "duplicate_rows": 0}
    with db.db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM dataset").fetchone()[0] == 0


def test_one_row_is_one_item_with_the_lens_hidden(tmp_path, data_dir):
    report = load(write_xlsx(tmp_path / "r.xlsx", [HEADERS, *ROWS]))
    assert report["items_new"] == 3
    with db.db() as conn:
        assert conn.execute("SELECT kind FROM dataset").fetchone()[0] == "ethics"
        track = conn.execute("SELECT id FROM track").fetchone()["id"]
        # Everyone reads every response, so they start in the data, not in a queue.
        items = repo.items_with_status(conn, track, ["cleared"])
        # Shown in sheet order, topic then question; the lens is not loaded at all.
        assert all([t["part"] for t in i["texts"]] == ["topic", "question"] for i in items)
        assert conn.execute("SELECT COUNT(*) FROM item_text WHERE part = 'lens' AND hidden = 1").fetchone()[0] == 3
        # Low content is judged on the question, not the one-word topic.
        low = {i["texts"][1]["text"] for i in items if i["low_content"]}
        assert low == {"Hm"}
        assert not any(i["raw_path"] for i in items)


def test_a_later_download_adds_only_the_new_responses(tmp_path, data_dir):
    load(write_xlsx(tmp_path / "first.xlsx", [HEADERS, *ROWS]))
    with db.db() as conn:
        conn.execute("UPDATE item_state SET status = 'excluded' WHERE item_id = (SELECT MIN(id) FROM item)")
        before = {r["token"] for r in conn.execute("SELECT token FROM item")}
    more = [*reversed(ROWS), ["46295.10", "Jobs", "Do I owe anything to people my software replaces?", "Duty: what do I owe the users?"]]
    # Columns in another order, rows in another order.
    reordered = [[HEADERS[2], HEADERS[0], HEADERS[3], HEADERS[1]], *[[r[2], r[0], r[3], r[1]] for r in more]]
    report = load(write_xlsx(tmp_path / "second.xlsx", reordered))
    assert (report["items_new"], report["items_kept"], report["items_changed"]) == (1, 3, 0)
    with db.db() as conn:
        assert before < {r["token"] for r in conn.execute("SELECT token FROM item")}
        # What was already there keeps its state; the new one starts in the data.
        assert [r[0] for r in conn.execute("SELECT status FROM item_state ORDER BY item_id")] == ["excluded", "cleared", "cleared", "cleared"]
        assert conn.execute("SELECT COUNT(*) FROM roster").fetchone()[0] == 1


def test_a_missing_column_is_an_error_before_anything_is_written(tmp_path, data_dir):
    grid = [["Timestamp", "Topic", "Question text"], *[r[:3] for r in ROWS]]
    with pytest.raises(ValueError, match="your question"):
        load(write_csv(tmp_path / "r.csv", grid))
    with db.db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM dataset").fetchone()[0] == 0
