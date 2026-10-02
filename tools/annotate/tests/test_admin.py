"""A site admin is a lead on every study without being put on its roster, and
can hand the lead to anyone. They are not part of a team until they join it."""

from conftest import CODER1, LEAD, as_user
from helpers import batch_tokens, new_batch, relock, roster_ids, tokens, track_id

from annotate import db, repo

ADMIN = {**as_user("boss@example.edu"), "X-Tool-Role": "admin"}
NOT_ADMIN = as_user("boss@example.edu")


def post(client, path, headers, **data):
    return client.post(path, headers=headers, data=data)


def test_an_admin_opens_and_runs_every_study_with_no_roster_entry(client):
    assert client.get("/", headers=NOT_ADMIN).status_code == 403
    home = client.get("/", headers=ADMIN).text
    assert home.count('class="card track"') == 2 and "lead" in home
    for study in ("demo", "ethics-demo"):
        track = track_id(study)
        for page in ("triage", "roster", "export", "codebook", "batches", "open", "production", "stage/0"):
            assert client.get(f"/t/{track}/{page}", headers=ADMIN).status_code == 200, page
        assert client.get(f"/t/{track}/roster", headers=NOT_ADMIN).status_code == 403
        assert client.get(f"/t/{track}/export.zip", headers=ADMIN).status_code == 200
    # They do everything a lead does: lock and open stages, deal, settle flags.
    track = track_id("ethics-demo")
    relock(track)
    assert "error=" not in post(client, f"/t/{track}/stage/1/done", ADMIN, done="1").headers["location"]
    card = tokens(track, "cleared")[0]
    post(client, f"/t/{track}/triage/{card}", CODER1, exclude="empty")
    assert "error=" not in post(client, f"/t/{track}/triage/{card}", ADMIN, action="clear").headers["location"]
    assert card in tokens(track, "cleared")


def test_an_admin_outside_the_team_is_dealt_nothing_and_does_none_of_its_work(client):
    track = track_id("ethics-demo")
    relock(track, done=(1, 2))
    assert "not on its team" in client.get(f"/t/{track}/roster", headers=ADMIN).text
    card = tokens(track, "cleared")[0]
    for path, data in (
        (f"/t/{track}/triage/{card}", {"jot": "mine"}),
        (f"/t/{track}/memos", {"kind": "rq", "body": "A question"}),
        (f"/t/{track}/open/generate", {}),
    ):
        assert post(client, path, ADMIN, **data).status_code == 403, path
    # A deck dealt by the admin goes to the team, not to them, and stays blind to them.
    assert "error=" not in post(client, f"/t/{track}/batches", ADMIN, kind="starter", n_items="3").headers["location"]
    team = set(map(int, roster_ids(track, "lead@example.edu", "coder1@example.edu", "coder2@example.edu")))
    with db.db() as conn:
        deck = repo.starter(conn, track)
        assert {r["roster_id"] for r in conn.execute("SELECT roster_id FROM assignment WHERE batch_id = ?", (deck["id"],))} == team
    assert "You are not on this team" in client.get(f"/t/{track}/open", headers=ADMIN).text
    assert client.get(f"/b/{deck['id']}/code/{batch_tokens(deck['id'])[0]}", headers=ADMIN).status_code == 404
    # Locking the team does not wait on them.
    relock(track)
    with db.db() as conn:
        conn.execute("DELETE FROM stage_done WHERE track_id = ?", (track,))
    for headers in (LEAD, CODER1, as_user("coder2@example.edu")):
        post(client, f"/t/{track}/start", headers)
    assert "error=" not in post(client, f"/t/{track}/stage/0/done", ADMIN, done="1").headers["location"]


def test_an_admin_hands_the_lead_to_someone_else(client):
    track = track_id()
    lead, coder = roster_ids(track, "lead@example.edu", "coder1@example.edu")
    # A lead cannot leave a study with no lead; an admin can change who it is.
    assert "error=" in post(client, f"/t/{track}/roster", LEAD, roster_id=lead, role="coder", active="1").headers["location"]
    assert "error=" not in post(client, f"/t/{track}/roster", ADMIN, roster_id=coder, role="lead", active="1").headers["location"]
    assert "error=" not in post(client, f"/t/{track}/roster", ADMIN, roster_id=lead, role="coder", active="1").headers["location"]
    assert client.get(f"/t/{track}/roster", headers=CODER1).status_code == 200
    assert client.get(f"/t/{track}/roster", headers=LEAD).status_code == 403
    # Even a study left with no lead on its roster stays runnable, by the admin.
    assert "error=" not in post(client, f"/t/{track}/roster", ADMIN, roster_id=coder, role="coder", active="1").headers["location"]
    assert client.get(f"/t/{track}/roster", headers=ADMIN).status_code == 200


def test_an_admin_who_joins_a_team_is_a_member_like_any_other(client):
    track = track_id("ethics-demo")
    relock(track)
    with db.db() as conn:
        conn.execute("DELETE FROM stage_done WHERE track_id = ?", (track,))  # the team is not locked yet
    post(client, f"/t/{track}/roster", ADMIN, email="boss@example.edu", role="coder")
    # On the roster as a coder, they are still a lead: the site role wins.
    assert client.get(f"/t/{track}/roster", headers=ADMIN).status_code == 200
    assert "not on its team" not in client.get(f"/t/{track}/roster", headers=ADMIN).text
    relock(track)
    card = tokens(track, "cleared")[0]
    assert "ft" in post(client, f"/t/{track}/triage/{card}", ADMIN, jot="now I can").headers["location"]
    # Without the admin role the same person is the coder the roster says.
    assert client.get(f"/t/{track}/roster", headers=NOT_ADMIN).status_code == 403
    assert client.get(f"/t/{track}/triage", headers=NOT_ADMIN).status_code == 200


def test_the_role_cannot_be_claimed_without_the_gate(client, monkeypatch):
    # With no gate header there is no identity at all, whatever role is claimed.
    assert client.get("/", headers={"X-Tool-Role": "admin"}).status_code == 403
    # On a developer's machine the developer is an admin only when asked for; whoever they switch to is not.
    monkeypatch.setenv("ANNOTATE_DEV_USER", "boss@example.edu")
    assert client.get("/").status_code == 403
    monkeypatch.setenv("ANNOTATE_DEV_ADMIN", "1")
    assert client.get("/").status_code == 200
    client.get("/dev/as/outsider@example.edu")
    assert client.get("/").status_code == 403
