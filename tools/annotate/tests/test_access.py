"""Who gets in: the gate's headers, the per-track roster, and the lead role."""

import pytest
from conftest import CODER1, LEAD, OUTSIDER
from helpers import tokens, track_id


def test_healthz_needs_nobody(client):
    assert client.get("/healthz").text == "ok"


def test_no_gate_headers_no_entry(client):
    response = client.get("/")
    assert response.status_code == 403
    # Dev sign-in does not exist unless ANNOTATE_DEV_USER is set.
    assert client.get("/dev/as/lead@example.edu").status_code == 404


def test_lab_member_not_on_the_roster_is_refused_everywhere(client):
    track = track_id()
    item = tokens(track, "cleared")[0]
    for path in ("/", f"/t/{track}/items", f"/t/{track}/items/{item}", f"/img/{item}", f"/t/{track}/codebook", f"/t/{track}/export.zip"):
        assert client.get(path, headers=OUTSIDER).status_code == 403, path


def test_a_missing_track_answers_like_a_closed_one(client):
    assert client.get("/t/999/items", headers=LEAD).status_code == 403


@pytest.mark.parametrize("path", ["roster", "export", "export.zip"])
def test_lead_pages_refuse_coders(client, path):
    track = track_id()
    assert client.get(f"/t/{track}/{path}", headers=CODER1).status_code == 403
    assert client.get(f"/t/{track}/{path}", headers=LEAD).status_code == 200


def test_lead_actions_refuse_coders(client):
    track = track_id()
    for path, data in (
        (f"/t/{track}/roster", {"email": "friend@example.edu", "role": "lead"}),
        (f"/t/{track}/batches", {"kind": "starter", "n_items": "2", "coder": ["1"]}),
        (f"/t/{track}/stage/2/done", {"done": "1"}),
        (f"/t/{track}/merge/run", {}),
    ):
        assert client.post(path, headers=CODER1, data=data).status_code == 403, path
    # The codebook is the whole team's: a coder can open and edit the draft.
    assert client.post(f"/t/{track}/codebook/draft/new", headers=CODER1).status_code == 303
    assert client.get(f"/t/{track}/codebook/draft", headers=CODER1).status_code == 200


def test_adding_someone_to_the_roster_lets_them_in(client):
    track = track_id()
    assert client.get(f"/t/{track}/items", headers=OUTSIDER).status_code == 403
    # Not once the team is locked.
    refused = client.post(f"/t/{track}/roster", headers=LEAD, data={"email": "outsider@example.edu", "role": "coder"})
    assert "team%20is%20locked" in refused.headers["location"]
    client.post(f"/t/{track}/stage/0/done", headers=LEAD, data={"done": "0"})
    client.post(f"/t/{track}/roster", headers=LEAD, data={"email": "Outsider@Example.edu ", "role": "coder"})
    assert client.get(f"/t/{track}/items", headers=OUTSIDER).status_code == 200


def test_deactivated_coder_loses_access_and_last_lead_cannot_step_down(client):
    from helpers import roster_ids

    track = track_id()
    coder, lead = roster_ids(track, "coder1@example.edu", "lead@example.edu")
    client.post(f"/t/{track}/roster", headers=LEAD, data={"roster_id": coder, "role": "coder"})  # active unticked
    assert client.get(f"/t/{track}/items", headers=CODER1).status_code == 403
    stuck = client.post(f"/t/{track}/roster", headers=LEAD, data={"roster_id": lead, "role": "coder", "active": "1"})
    assert "error=" in stuck.headers["location"]
    assert client.get(f"/t/{track}/roster", headers=LEAD).status_code == 200


def test_identifying_item_goes_to_a_lead_and_out_of_the_coders_reach(client):
    track = track_id()
    item = tokens(track, "untriaged")[0]
    assert client.get(f"/img/{item}?full=1", headers=CODER1).status_code == 200  # whoever reaches it first cleans it
    client.post(f"/t/{track}/triage/{item}", headers=CODER1, data={"exclude": "identifying"})
    assert item in tokens(track, "pii_hold")
    for path in (f"/img/{item}", f"/t/{track}/triage/{item}", f"/t/{track}/items/{item}"):
        assert client.get(path, headers=CODER1).status_code == 403, path
    assert item not in client.get(f"/t/{track}/triage?status=pii_hold", headers=CODER1).text

    # The lead crops it and keeps it; everyone else then gets the cropped photo only.
    data = {"action": "clear", "crop_x": "0", "crop_y": "0.3", "crop_w": "0.7", "crop_h": "0.7"}
    client.post(f"/t/{track}/triage/{item}", headers=LEAD, data=data)
    assert item in tokens(track, "cleared")
    cropped = client.get(f"/img/{item}?full=1", headers=CODER1).content
    assert cropped == client.get(f"/img/{item}", headers=CODER1).content
    assert cropped != client.get(f"/img/{item}?full=1", headers=LEAD).content
    card = client.get(f"/t/{track}/triage/{item}", headers=CODER1).text
    assert "data-crop" not in card and 'name="turn"' not in card and f"/img/{item}?rev=" in card


def test_a_coder_can_flag_a_card_but_never_exclude_it(client):
    track = track_id()
    item = tokens(track, "cleared")[0]
    assert "error=" in client.post(f"/t/{track}/triage/{item}", headers=CODER1, data={"exclude": "made-up"}).headers["location"]
    client.post(f"/t/{track}/triage/{item}", headers=CODER1, data={"exclude": "off_task", "note": "a shopping list"})
    assert item in tokens(track, "pii_hold") and tokens(track, "excluded") == []
    # It is the lead's now: the coder cannot act on it again.
    assert client.post(f"/t/{track}/triage/{item}", headers=CODER1, data={"action": "clear"}).status_code == 403
    assert "Not an attempt at the task. a shopping list" in client.get(f"/t/{track}/triage/{item}", headers=LEAD).text
    client.post(f"/t/{track}/triage/{item}", headers=LEAD, data={"exclude": "off_task"})
    assert tokens(track, "excluded") == [item]


def test_published_codebook_cannot_be_edited(client):
    from annotate import db, repo

    track = track_id()
    with db.db() as conn:
        before = [dict(c) for d in repo.version_tree(conn, repo.latest_published(conn, track)["id"]) for c in d["codes"]]
    # With no draft open there is nothing these can touch.
    for action, data in (
        ("code", {"dimension": "relation", "key": "sequence", "label": "Changed"}),
        ("code-delete", {"dimension": "relation", "key": "sequence"}),
        ("dimension-delete", {"key": "relation"}),
    ):
        client.post(f"/t/{track}/codebook/draft/{action}", headers=LEAD, data=data)
    # Editing a new draft leaves the published version as it was.
    client.post(f"/t/{track}/codebook/draft/new", headers=LEAD)
    client.post(f"/t/{track}/codebook/draft/code", headers=LEAD, data={"dimension": "relation", "key": "sequence", "label": "Changed"})
    with db.db() as conn:
        published = repo.latest_published(conn, track)
        after = [dict(c) for d in repo.version_tree(conn, published["id"]) for c in d["codes"]]
        assert published["n"] == 1 and after == before
    assert "error=" in client.post(f"/t/{track}/codebook/draft/publish", headers=LEAD, data={"note": " "}).headers["location"]
    client.post(f"/t/{track}/codebook/draft/publish", headers=LEAD, data={"note": "Renamed sequencing."})
    page = client.get(f"/t/{track}/codebook", headers=CODER1).text
    assert "Codebook v2" in page and "Changed" in page and "Renamed sequencing." in page


def test_user_text_is_escaped_and_pages_forbid_inline_script(client):
    track = track_id()
    client.post(f"/t/{track}/memos", headers=CODER1, data={"kind": "memo", "body": "<script>alert(1)</script>"})
    response = client.get(f"/t/{track}/memos", headers=LEAD)
    assert "<script>alert(1)</script>" not in response.text
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in response.text
    assert response.headers["content-security-policy"].startswith("default-src 'self'")
    flash = client.get("/?error=<b>x</b>", headers=LEAD).text
    assert "<b>x</b>" not in flash


def test_every_stage_has_a_page_with_its_guide(client):
    """A stage's link goes to where the work is. The guide is one key away on
    a page of its own, not a dropdown in the way."""
    track = track_id()
    for n in range(1, 9):
        response = client.get(f"/t/{track}/stage/{n}", headers=LEAD, follow_redirects=True)
        assert response.status_code == 200, n
        assert f"Stage {n}</p>" in response.text and "<details class=\"guide\"" not in response.text, n
        # The link sits in the sidebar, out of the page's way.
        assert f'/t/{track}/guide/{n}" data-key="?"' in response.text and response.text.count("/guide/") == 1, n
        guide = client.get(f"/t/{track}/guide/{n}", headers=CODER1)
        assert guide.status_code == 200 and 'class="prose"' in guide.text, n
    card = client.get(f"/t/{track}/triage/{tokens(track, 'untriaged')[0]}", headers=CODER1).text
    assert f'/t/{track}/guide/1" target="_blank"' in card and "<summary>Guide</summary>" not in card
    # Coders have no export stage: not in the sidebar, and refused if they go there.
    assert f"/t/{track}/export" not in client.get(f"/t/{track}/triage", headers=CODER1).text
    assert client.get(f"/t/{track}/stage/8", headers=CODER1, follow_redirects=True).status_code == 403
