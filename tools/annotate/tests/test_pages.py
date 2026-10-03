"""Every page renders, and every link carries the prefix nginx serves the tool under."""

import re

from conftest import CODER1, CODER2, LEAD
from helpers import tokens, track_id

from annotate import config


def lead_pages() -> list[str]:
    track = track_id()
    return [
        "/",
        *(f"/t/{track}/{page}" for page in ("triage", "items", "questions", "memos", "codebook", "codebook/draft", "batches", "open", "codes", "production", "themes", "history", "roster", "export")),
        f"/t/{track}/stage/0",
        f"/t/{track}/triage?status=cleared",
        f"/t/{track}/triage/{tokens(track, 'untriaged')[0]}",
        f"/t/{track}/items/{tokens(track, 'cleared')[0]}",
        "/static/app.css",
        "/static/crop.js",
        "/static/deck.js",
        "/static/theme.js",
    ]


def test_every_page_renders(client):
    for path in lead_pages():
        assert client.get(path, headers=LEAD).status_code == 200, path


def test_links_and_redirects_carry_the_public_prefix(client, monkeypatch):
    monkeypatch.setattr(config, "ROOT_PATH", "/tools/annotate")
    for path in lead_pages()[:-4]:
        html = client.get(path, headers=LEAD).text
        local = [u for u in re.findall(r'(?:href|src|action)="([^"]+)"', html) if not u.startswith(("?", "#", "http"))]
        assert local, path
        # The only links that leave the tool go to the wiki, on the same site.
        assert all(u.startswith(("/tools/annotate/", "/wiki/")) for u in local), (path, local)
    track = track_id()
    saved = client.post(f"/t/{track}/start", headers=CODER1)
    assert saved.headers["location"] == f"/tools/annotate/t/{track}/triage"
    # A refused form goes back to the page it came from, never off-site.
    refused = client.post(
        f"/t/{track}/memos", headers=CODER1, data={"kind": "memo", "body": " "},
        follow_redirects=False, extensions={},
    )
    assert refused.headers["location"].startswith("/tools/annotate/")
    hostile = client.post(
        f"/t/{track}/memos", data={"kind": "memo", "body": " "},
        headers={**CODER1, "Referer": "https://evil.example/tools/annotate/x"},
    )
    assert hostile.headers["location"].startswith("/tools/annotate/")


def test_dev_identity_exists_only_when_asked_for(client, monkeypatch):
    monkeypatch.setenv("ANNOTATE_DEV_USER", "coder1@example.edu")
    assert "coder1@example.edu" in client.get("/").text
    client.get("/dev/as/lead@example.edu")
    assert "lead@example.edu" in client.get("/").text
    # Real gate headers always win over the developer cookie.
    assert "coder2@example.edu" in client.get("/", headers={"X-Tool-User": "coder2@example.edu"}).text
    monkeypatch.delenv("ANNOTATE_DEV_USER")
    assert client.get("/").status_code == 403


def test_starting_twice_and_backing_up_is_harmless(seeded):
    from annotate import db

    db.init()
    db.init()
    assert db.maybe_backup() is True
    assert db.maybe_backup() is False  # at most one a day
    assert len(list((seeded / "backups").glob("annotate-*.db"))) == 1


def test_an_item_shows_the_whole_submission(client):
    """The diagram and both written parts are on one panel, wherever an item appears."""
    from helpers import batch_tokens, new_batch, roster_ids

    track = track_id()
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"), 9)
    views = [f"/t/{track}/items/{tokens(track, 'cleared')[0]}", f"/t/{track}/triage/{tokens(track, 'untriaged')[0]}"]
    views.append(f"/b/{batch}/code/{batch_tokens(batch)[0]}")
    for path in views:
        html = client.get(path, headers=CODER1).text
        assert html.count('class="item-text"') == 2 and ">approach<" in html and ">challenges<" in html, path
    # The coding form keeps the two apart: diagram questions, then reflection questions.
    form = client.get(views[-1], headers=CODER1).text
    assert form.index('part">diagram') < form.index("dim-relation") < form.index('part">reflection') < form.index("dim-challenge")
    # One seeded student handed in no diagram; their reflections still show.
    pages = [client.get(f"/t/{track}/items/{t}", headers=CODER1).text for t in tokens(track, "cleared")]
    missing = [p for p in pages if "No diagram submitted." in p]
    assert len(missing) == 1 and missing[0].count('class="item-text"') == 2 and "/img/" not in missing[0]


def test_a_photo_nobody_has_cleaned_has_the_tools_to_clean_it(client):
    """The first person to reach a photo turns and crops it; turning is one press."""
    from annotate import db, repo

    track = track_id()
    first, second, third = tokens(track, "untriaged")[:3]
    card = client.get(f"/t/{track}/triage/{first}", headers=CODER1).text
    for key in ('data-key="Enter"', 'data-key="x"', 'data-key="["', 'data-key="]"'):
        assert key in card
    assert "Keep and next" in card and "needs cleaning" in card and "data-crop" in card
    assert 'name="jot"' not in card  # cleaning first; jotting is the next pass
    # The photo is on the left; what the student wrote is in the right column, above the buttons.
    assert 'class="deck deck--photo"' in card and card.index('class="deck__play"') < card.index('class="item-text"') < card.index("Keep and next")
    assert 'class="deckbar"' in card and 'class="side' not in card  # a card fills the screen
    assert card.count('name="exclude"') == 3 and "<select" not in card  # reasons are buttons under Flag

    post = lambda token, **data: client.post(f"/t/{track}/triage/{token}", headers=CODER1, data=data)
    assert "%2B10%20ft" in post(first, exclude="identifying").headers["location"]
    post(second, exclude="unreadable")
    post(third, turn="right")
    post(third, turn="right")
    post(third, turn="left")
    with db.db() as conn:
        a, b, c = (repo.item_by_token(conn, t) for t in (first, second, third))
    assert (a["status"], a["pii_visible"]) == ("pii_hold", 1)
    assert (b["status"], b["legible"]) == ("pii_hold", 0)
    assert (c["status"], c["rotation"]) == ("untriaged", 90)
    # Keeping it puts it in the data for everyone, cropped.
    post(third, crop_x="0.1", crop_y="0.1", crop_w="0.5", crop_h="0.5")
    with db.db() as conn:
        c = repo.item_by_token(conn, third)
    assert (c["status"], c["crop_w"]) == ("cleared", 0.5)
    read = client.get(f"/t/{track}/triage/{third}", headers=CODER2).text
    assert "data-crop" not in read and "Next card" in read and 'name="turn"' not in read and 'name="jot"' in read
    assert read.index('class="item-image"') < read.index('class="deck__play"') < read.index('class="item-text"')


def test_coding_card_has_a_key_for_every_choice(client):
    from helpers import batch_tokens, new_batch, roster_ids

    track = track_id()
    batch = new_batch(client, LEAD, track, "calibration", roster_ids(track, "coder1@example.edu", "coder2@example.edu"), 3)
    card = client.get(f"/b/{batch}/code/{batch_tokens(batch)[0]}", headers=CODER1).text
    # Number row for the first question, then the letter rows; Enter moves on.
    for key in ("1", "2", "3", "q", "w", "e", "a", "s", "d", "Enter"):
        assert f'data-key="{key}"' in card, key
    assert card.count("data-key=") == len(set(re.findall(r'data-key="([^"]+)"', card)))  # no key used twice
    # The review page has many forms on it, so no keys there.
    for headers in (CODER1, CODER2):
        for token in batch_tokens(batch):
            client.post(f"/b/{batch}/code/{token}", headers=headers, data={"dim-relation": "sequence"})
        client.post(f"/b/{batch}/submit", headers=headers)
    client.post(f"/b/{batch}/close", headers=LEAD)
    assert 'data-key="1"' not in client.get(f"/b/{batch}/review?all=1", headers=LEAD).text


def test_the_trail_and_elevation(client):
    from helpers import relock

    track = track_id()
    relock(track)  # the team is at the first stage
    page = client.get(f"/t/{track}/triage", headers=CODER1).text
    assert page.count('class="wp ') == 9 and "▲ 0 ft" in page
    def trail(headers):
        """(stages climbed, share of the path filled in) as the sidebar draws them."""
        html = client.get(f"/t/{track}/triage", headers=headers).text
        m = re.search(r'data-gain="([\d.]+)"\s+pathLength="([\d.]+)" stroke-dasharray="([\d.]+) ', html)
        return float(m[1]), float(m[3]) / float(m[2])

    assert trail(CODER1) == (0, 0)  # at the trailhead

    # Start leaves the trailhead. Cleaning is the first half of the stage: 9 of 12 photos are clean.
    client.post(f"/t/{track}/start", headers=CODER1)
    gain, filled = trail(CODER1)
    assert gain == 1.375 and 0.1 < filled < 0.35
    assert ">9/12 clean<" in client.get(f"/t/{track}/triage", headers=CODER1).text
    for token in tokens(track, "untriaged"):
        client.post(f"/t/{track}/triage/{token}", headers=CODER1)
    assert trail(CODER1)[0] == 1.5
    # Then each card you read moves it on.
    client.post(f"/t/{track}/triage/{tokens(track, 'cleared')[0]}", headers=CODER1)
    further, more = trail(CODER1)
    assert further == 1.542 and more > filled
    assert trail(CODER2)[0] == 0  # someone else has not started
    # Doing the work counts as starting, with or without the button. Their pass is their own.
    client.post(f"/t/{track}/triage/{tokens(track, 'cleared')[0]}", headers=CODER2)
    assert trail(CODER2)[0] == 1.542
    item = tokens(track, "cleared")[0]
    client.post(f"/t/{track}/items/{item}/jot", headers=CODER1, data={"body": "arrows mean order here"})
    relock(track, done=(1,))  # the lead has opened Questions
    client.post(f"/t/{track}/memos", headers=CODER1, data={"kind": "rq", "body": "How do arrows change?"})
    page = client.get(f"/t/{track}/triage", headers=CODER1).text
    assert "▲ 95 ft" in page  # 30 for three photos cleaned, 10 for the card read, 5 for the jotting, 50 for the question
    # The rest of the team stand on the trail too, by name, each a share of the way along.
    mates = re.findall(r'<g class="mate mate--\d is-unplaced" data-at="([\d.]+)"[^>]*>\s*<circle[^>]*><title>([^<]+)</title>', page)
    assert sorted(who for _, who in mates) == ["coder2", "lead"] and all(0 <= float(at) <= 1 for at, _ in mates)
    # Another coder sees the team's total, never this coder's figure.
    other = client.get(f"/t/{track}/triage", headers=CODER2).text
    assert "<b>▲ 10 ft</b>" in other and "team ▲ 105 ft" in other


def test_back_and_next_stay_put_and_lead_on_to_the_next_stage(client):
    track = track_id()
    cards = tokens(track, "cleared")
    first = client.get(f"/t/{track}/items/{cards[0]}", headers=CODER1).text
    last = client.get(f"/t/{track}/items/{cards[-1]}", headers=CODER1).text
    for page in (first, last):
        nav = page[page.index('class="deck__nav"'):page.index("</nav>", page.index('class="deck__nav"'))]
        assert nav.count('class="button') == 2  # Back and Next, always both
        assert nav.index("Back") < nav.index("→")
    # No card before the first: Back is there but greyed out, not gone.
    assert 'is-off" aria-disabled="true"><kbd>←</kbd> Back' in first
    assert f'/items/{cards[1]}" data-key="ArrowRight">Next' in first
    # Nothing after the last card: Next is greyed out too, still in its place.
    assert 'is-off" aria-disabled="true">Next' in last

    # Every stage page has the same two slots at the bottom.
    triage = client.get(f"/t/{track}/triage", headers=CODER1).text
    assert 'class="stagenav"' in triage and "← Onboarding" in triage and "Questions →" in triage
    # The lead's button at the top says what finishing the stage does.
    assert "Lock Calibration again" in client.get(f"/t/{track}/codebook", headers=LEAD).text
    assert "Lock Calibration again" not in client.get(f"/t/{track}/codebook", headers=CODER1).text
    # The first page has its own single button instead.
    assert 'class="stagenav"' not in client.get(f"/t/{track}/stage/0", headers=CODER1).text
    # A coder's trail ends at themes; a lead's goes on to export.
    assert "Production →" in client.get(f"/t/{track}/batches", headers=CODER1).text
    assert 'is-off" aria-disabled="true">Next →' in client.get(f"/t/{track}/themes", headers=CODER1).text
    assert "Export →" in client.get(f"/t/{track}/themes", headers=LEAD).text


def test_every_kind_of_page_has_the_light_dark_switch(client):
    track = track_id()
    for path in ("/", f"/t/{track}/triage", f"/t/{track}/items/{tokens(track, 'cleared')[0]}"):
        assert client.get(path, headers=CODER1).text.count("data-theme-toggle") == 1, path
    assert client.get("/", headers={"X-Tool-User": "nobody@example.edu"}).text.count("data-theme-toggle") == 1


def test_photos_are_cleaned_first_then_everyone_reads_and_jots(client):
    track = track_id()
    home = client.get(f"/t/{track}/triage", headers=CODER1).text
    assert "3 photos for you to clean" in home and "to read" not in home
    # Start leads to a photo that needs cleaning, not to a card to read.
    start = re.search(r'/triage/([\w-]+)" data-key="Enter"', home)[1]
    assert start in tokens(track, "untriaged")
    for token in tokens(track, "untriaged"):
        kept = client.post(f"/t/{track}/triage/{token}", headers=CODER1, data={"mode": "clean"})
    assert "Every%20photo%20cleaned" in kept.headers["location"]
    # Cleaning is shared: it is done for everyone. Reading is each person's own.
    for headers in (CODER1, CODER2):
        assert "12 to read" in client.get(f"/t/{track}/triage", headers=headers).text
    first = tokens(track, "cleared")[0]
    read = client.post(f"/t/{track}/triage/{first}", headers=CODER1, data={"jot": "arrows loop back here"})
    assert "%2B15%20ft" in read.headers["location"]  # 10 for the card, 5 for the jotting
    # The jotting is on the item afterwards, for its author only.
    assert "arrows loop back here" in client.get(f"/t/{track}/items/{first}", headers=CODER1).text
    assert "arrows loop back here" not in client.get(f"/t/{track}/items/{first}", headers=CODER2).text
    side = client.get(f"/t/{track}/triage", headers=CODER1).text
    assert [t for t in re.findall(r'class="wp__title"[^>]*>([^<]+)', side)] == [
        "Onboarding", "Clean and read", "Questions", "Open coding", "Codebook", "Calibration", "Production", "Themes", "Export"]


def test_the_trail_wanders_like_the_main_sites(client):
    """Waypoints sit at uneven distances from the edge and the path drifts
    between them; the shape belongs to the study and does not change between pages."""
    track, other = track_id(), track_id("ethics-demo")
    shape = lambda t, page: re.search(r'class="trail__path" d="([^"]+)"', client.get(f"/t/{t}/{page}", headers=CODER1).text)[1]
    path = shape(track, "triage")
    assert path == shape(track, "memos") == shape(track, "codebook")
    assert path != shape(other, "triage")
    side = client.get(f"/t/{track}/triage", headers=CODER1).text
    xs = [int(x) for x in re.findall(r'class="wp__dot" cx="(\d+)"', side)]
    assert len(xs) == 9 and len(set(xs)) > 4  # not two fixed columns
    assert all((x < 120) == (i % 2 == 0) for i, x in enumerate(xs))  # still switching sides
    assert path.count(" C ") == 8 * 3  # two drift points between each pair of waypoints
