"""The video route: an episode's recording, to the people who may see the
item, as a file the browser can seek in and never as a download."""

import pytest
from conftest import CODER1, LEAD, OUTSIDER
from fastapi.testclient import TestClient
from test_import_sessions import export  # noqa: F401  (the fixture)

from annotate import config, db, import_sessions, importer, repo, studies


@pytest.fixture()
def client(export, data_dir):  # noqa: F811
    import_sessions.run(export, "sessions", "Sessions", "lead@example.edu")
    with db.db() as conn:
        track = conn.execute("SELECT id FROM track").fetchone()["id"]
        repo.add_roster(conn, track, "coder1@example.edu", "coder")
    from annotate.main import app

    return TestClient(app, follow_redirects=False)


def first_token() -> str:
    with db.db() as conn:
        return conn.execute("SELECT token FROM item ORDER BY id LIMIT 1").fetchone()["token"]


def stored_video(token: str) -> bytes:
    with db.db() as conn:
        return (config.raw_dir() / repo.media_path(conn, token)).read_bytes()


def set_media(value) -> None:
    with db.db() as conn:
        conn.execute("UPDATE session SET media_path = ?", (value,))


def test_only_the_team_gets_the_video(client):
    token = first_token()
    assert client.get(f"/video/{token}").status_code == 403
    assert client.get(f"/video/{token}", headers=OUTSIDER).status_code == 403
    assert client.get("/video/nosuchtoken", headers=LEAD).status_code == 404
    assert client.get(f"/video/{token}", headers=CODER1).status_code == 200


def test_an_excluded_item_is_for_the_lead(client):
    token = first_token()
    with db.db() as conn:
        conn.execute("UPDATE item_state SET status = 'excluded' WHERE item_id = (SELECT id FROM item WHERE token = ?)", (token,))
    assert client.get(f"/video/{token}", headers=CODER1).status_code == 403
    assert client.get(f"/video/{token}", headers=LEAD).status_code == 200


def test_an_item_of_another_kind_has_no_video(client):
    with db.db() as conn:
        dataset_id, track = importer.ensure_dataset(conn, "eth", "Ethics", "ethics")
        source = importer.ensure_source(conn, dataset_id, ("h", "w", "p"))
        importer.add_item(conn, track, source, "eth", studies.get("ethics"), None, [("question", "Is it fair?", False)])
        repo.add_roster(conn, track, "lead@example.edu", "lead")
        token = conn.execute("SELECT token FROM item WHERE track_id = ?", (track,)).fetchone()["token"]
    assert client.get(f"/video/{token}", headers=LEAD).status_code == 404


def test_a_path_outside_the_raw_directory_is_refused(client):
    token = first_token()
    for path in ("../annotate.db", str(config.db_path().resolve()), "sessions/video/../../../annotate.db"):
        set_media(path)
        assert client.get(f"/video/{token}", headers=LEAD).status_code == 404, path
    set_media(None)
    assert client.get(f"/video/{token}", headers=LEAD).status_code == 404


def test_the_browser_can_seek_and_nothing_is_kept_or_offered_as_a_download(client):
    token = first_token()
    whole = stored_video(token)
    response = client.get(f"/video/{token}", headers={**LEAD, "Range": "bytes=0-"})
    assert response.status_code == 206 and response.headers["content-range"] == f"bytes 0-{len(whole) - 1}/{len(whole)}"
    assert response.content == whole
    response = client.get(f"/video/{token}", headers={**LEAD, "Range": "bytes=5-9"})
    assert response.status_code == 206 and response.content == whole[5:10]
    assert client.get(f"/video/{token}", headers={**LEAD, "Range": f"bytes={len(whole) + 10}-"}).status_code == 416
    response = client.get(f"/video/{token}", headers=LEAD)
    assert response.headers["content-type"] == "video/mp4"
    assert "content-disposition" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["cross-origin-resource-policy"] == "same-origin"
    # default-src covers media-src: the player may load only from this origin.
    assert response.headers["content-security-policy"].startswith("default-src 'self'")
