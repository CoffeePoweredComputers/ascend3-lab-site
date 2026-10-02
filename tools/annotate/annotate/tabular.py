"""Read a spreadsheet of form responses as a list of rows.

Takes the .xlsx a Google Form's response sheet downloads as, or a .csv. The
.xlsx reader is the standard library only: the file is a zip of XML, and a
response sheet uses nothing beyond plain cells and shared strings. Every value
comes back as text.
"""

from __future__ import annotations

import csv
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def read(path: Path) -> list[dict[str, str]]:
    """Rows of the first sheet, keyed by the header row. Blank rows are dropped."""
    grid = _xlsx(path) if path.suffix.lower() == ".xlsx" else _csv(path)
    if not grid:
        return []
    headers = [h.strip() for h in grid[0]]
    rows = []
    for cells in grid[1:]:
        row = {h: (cells[i].strip() if i < len(cells) else "") for i, h in enumerate(headers) if h}
        if any(row.values()):
            rows.append(row)
    return rows


def _csv(path: Path) -> list[list[str]]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))


def _parse(data: bytes):
    """Parse one XML part of the workbook. A real spreadsheet declares no
    DTD or entities; one that does is refused, which is what closes off entity
    expansion and external-entity tricks without another dependency."""
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("The workbook contains a document type declaration; refusing to read it.")
    return ElementTree.fromstring(data)


def _column(reference: str) -> int:
    """'C7' -> 2."""
    n = 0
    for letter in re.match(r"[A-Z]+", reference)[0]:
        n = n * 26 + ord(letter) - 64
    return n - 1


def _text(node) -> str:
    return "".join(t.text or "" for t in node.iter(NS + "t"))


def _xlsx(path: Path) -> list[list[str]]:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            shared = [_text(si) for si in _parse(archive.read("xl/sharedStrings.xml")).findall(NS + "si")]
        sheets = sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
        if not sheets:
            raise ValueError(f"{path.name} has no worksheet.")
        grid = []
        for row in _parse(archive.read(sheets[0])).iter(NS + "row"):
            cells: dict[int, str] = {}
            for c in row.findall(NS + "c"):
                value = c.find(NS + "v")
                if c.get("t") == "s" and value is not None:
                    cells[_column(c.get("r"))] = shared[int(value.text)]
                elif c.get("t") == "inlineStr":
                    cells[_column(c.get("r"))] = _text(c)
                else:
                    cells[_column(c.get("r"))] = value.text if value is not None and value.text else ""
            grid.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
    return grid
