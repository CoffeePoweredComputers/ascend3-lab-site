"""The export: tidy tables with the join keys, no emails, and "coded as none"
distinguishable from "not coded"."""

import csv
import io
import zipfile

from conftest import CODER1, CODER2, LEAD
from helpers import batch_tokens, new_batch, roster_ids, track_id

from annotate import export


def closed_round(client):
    track = track_id()
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"), 3)
    items = batch_tokens(batch)
    for headers in (CODER1, CODER2):
        for i, token in enumerate(items):
            data = {"dim-relation": "sequence", "dim-issues": ["vague", "no-io"] if i == 0 else []}
            client.post(f"/b/{batch}/code/{token}", headers=headers, data=data)
        client.post(f"/b/{batch}/submit", headers=headers)
    client.post(f"/b/{batch}/close", headers=LEAD)
    client.post(f"/b/{batch}/consensus/{items[0]}", headers=LEAD, data={"dim-relation": "sequence", "dim-issues": ["vague"]})
    return track, batch, items


def tables(client, track) -> dict[str, list[dict]]:
    response = client.get(f"/t/{track}/export.zip", headers=LEAD)
    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert set(archive.namelist()) == set(export.FILES)
    return {name: list(csv.DictReader(io.StringIO(archive.read(name).decode()))) for name in archive.namelist()}


def test_export_is_tidy_and_joinable(client):
    track, batch, items = closed_round(client)
    client.post(f"/t/{track}/memos", headers=CODER1, data={"kind": "rq", "body": "How do arrows change?"})
    out = tables(client, track)

    assert len(out["items.csv"]) == 12
    assert sum(r["has_diagram"] == "1" for r in out["items.csv"]) == 11
    codes = out["codes.csv"]
    assert {"token", "hash", "homework", "project", "coder", "codebook_version", "part", "dimension", "code", "round_no"} <= set(codes[0])
    # 2 coders x (3 relation + 2 issues on the first item) + consensus (1 relation + 1 issue)
    assert len(codes) == 2 * 5 + 2
    assert {r["coder"] for r in codes} == {"C02", "C03", "CONSENSUS"}
    consensus = [r for r in codes if r["coder"] == "CONSENSUS"]
    assert {(r["dimension"], r["code"]) for r in consensus} == {("relation", "sequence"), ("issues", "vague")}

    # Diagram and reflection codes sit on the same item, told apart by `part`.
    assert {r["part"] for r in codes} == {"diagram"}
    assert {r["part"] for r in out["codebook.csv"]} == {"diagram", "reflection"}

    # Coded-with-nothing is visible: the assignment is done but has no issue rows.
    done = [r for r in out["assignments.csv"] if r["coder"] == "C02" and r["done_at"]]
    assert len(done) == 3
    assert len({r["token"] for r in codes if r["coder"] == "C02" and r["dimension"] == "issues"}) == 1

    agreement = {(r["dimension"], r["code"]): r for r in out["agreement.csv"]}
    assert agreement[("issues", "vague")]["alpha"] == "1.0"
    assert agreement[("relation", "")]["alpha"] == ""  # everyone chose the same option: undefined
    assert any(r["kind"] == "rq" for r in out["memos.csv"])
    assert {r["version"] for r in out["codebook.csv"]} == {"1"}


def test_export_names_nobody(client):
    track, _, _ = closed_round(client)
    response = client.get(f"/t/{track}/export.zip", headers=LEAD)
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    everything = "".join(archive.read(name).decode() for name in archive.namelist())
    assert "@" not in everything
