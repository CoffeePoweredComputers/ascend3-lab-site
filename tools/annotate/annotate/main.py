"""Routes. Every one starts by asking auth.require who is calling and whether
they are on the track's roster; the queries live in repo.py.

nginx strips /tools/annotate before proxying, so paths here start at "/" and
links are rendered with the prefix (the `root` template variable).
"""

from __future__ import annotations

import random
from contextlib import asynccontextmanager
from urllib.parse import quote, urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from markdown_it import MarkdownIt
from markupsafe import Markup

from annotate import agreement, assist, auth, config, db, export, images, import_sessions, llm, peaks, repo, stages, stats, studies


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=config.APP_DIR / "static"), name="static")
# Production gets the site's fonts from the site itself, at /fonts on the same
# origin. A developer's machine has no site in front, so serve them from the repo.
_site_fonts = config.APP_DIR.parent.parent / "public" / "fonts"
if config.dev_user() and _site_fonts.is_dir():
    app.mount("/fonts", StaticFiles(directory=_site_fonts), name="fonts")
templates = Jinja2Templates(directory=config.APP_DIR / "templates")
# Briefs are files in this repository, so their markdown is trusted. Raw HTML
# in them is still off, and nothing a user types is ever rendered as markdown.
markdown = MarkdownIt("commonmark", {"html": False}).enable("table")
# People are shown to their team by the name part of their email.
templates.env.filters["who"] = lambda email: str(email).split("@")[0]
templates.env.globals.update(passed=peaks.passed, ahead=peaks.ahead, roles=import_sessions.ROLES)


def clock(ms: int) -> str:
    """A time in a recording: 23:10, or 1:02:05 past the hour."""
    minutes, seconds = divmod(int(ms) // 1000, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"


templates.env.filters["clock"] = clock
CONTEXT_MS = 30_000  # transcript shown either side of an episode, muted


def page(request: Request, name: str, status_code: int = 200, **context) -> Response:
    """Render a template. On a track's pages this also builds the sidebar (the
    stages, with progress) and, for the stage named by `at`, its guide."""
    context.update(root=config.ROOT_PATH, dev=config.dev_user(), band=stats.band)
    track, user = context.get("track"), context.get("user")
    if track and user:
        context["study"] = studies.get(track["dataset_kind"])
        with db.db() as conn:
            context["nav"] = stage_rows(conn, track, user)
            mates = team_positions(conn, track, user.email)
            if context.get("me"):
                context["climb"] = repo.trail_stats(conn, track["id"], context["me"])
        context["trail"] = trail(context["nav"], f"trail-{track['id']}", mates)
        stage = next((s for s in context["nav"] if s["key"] == context.get("at")), None)
        context["stage"] = stage
        if stage:
            context["guide"] = Markup(markdown.render(stages.brief(stage["n"], track["dataset_kind"])))
            # The waypoints either side, skipping ones this person cannot open.
            lead = context.get("me") and context["me"]["role"] == "lead"
            walk = [s for s in context["nav"] if s is stage or s["key"] != "export" or lead]
            here = walk.index(stage)
            context["stage_prev"] = walk[here - 1] if here else None
            context["stage_next"] = walk[here + 1] if here + 1 < len(walk) else None
    return templates.TemplateResponse(request, name, context, status_code=status_code)


def go(path: str, error: str = "", ok: str = "") -> RedirectResponse:
    path, _, fragment = path.partition("#")
    url = config.ROOT_PATH + path
    if error or ok:
        url += ("&" if "?" in url else "?") + ("error=" + quote(error) if error else "ok=" + quote(ok))
    return RedirectResponse(url + ("#" + fragment if fragment else ""), status_code=303)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    # The gate's cookie is SameSite=Lax, and every *.vt.edu host counts as the
    # same site. Browsers say where a request came from; a form posted from
    # any other origin is refused.
    if request.method not in ("GET", "HEAD") and request.headers.get("sec-fetch-site", "same-origin") not in ("same-origin", "none"):
        return PlainTextResponse("Cross-site request refused.", status_code=403)
    response = await call_next(request)
    # The tool shares an origin with the wiki and every other lab tool, so a
    # script injected here would run with the member's session. No inline
    # script or style is allowed at all.
    response.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    # Pages are never stored. Scripts and styles are checked with the server
    # each time, so a new version of the tool is not mixed with old ones.
    response.headers["Cache-Control"] = "no-cache" if request.url.path.startswith("/static/") else "no-store"
    return response


@app.exception_handler(HTTPException)
async def refused_page(request: Request, exc: HTTPException):
    return page(request, "refused.html", status_code=exc.status_code, message=exc.detail)


@app.exception_handler(repo.Refused)
async def refused_action(request: Request, exc: repo.Refused):
    """A rule said no to a form. Send them back where they were, with the reason.
    The transaction has already rolled back."""
    back = urlsplit(request.headers.get("referer", "")).path
    prefix = config.ROOT_PATH + "/"
    path = back[len(config.ROOT_PATH):] if back.startswith(prefix) and not back.startswith("//") else "/"
    return go(path, error=str(exc))


TRAIL_WIDTH, TRAIL_ROW = 240, 62


def _cubic(p0, c0, c1, p1, t):
    u = 1 - t
    return tuple(u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d for a, b, c, d in zip(p0, c0, c1, p1))


def passing(conn, track_id: int, me, before: int) -> str:
    """" · past Mount Fuji" when the work just saved climbed past a landmark."""
    peak = peaks.crossed(before, repo.feet(conn, track_id, me["id"], me["email"]))
    if not peak:
        return ""
    return f" · past {peak.name}" + (f" on {peak.where}" if peak.where else "")


def gain(rows: list[dict]) -> float:
    """How far along the trail a person is: every finished stage, plus how
    far into the one the team is on."""
    here = next((s for s in rows if not s["done"]), rows[-1])
    return min(here["n"] + here["part"], len(rows) - 1)


def team_positions(conn, track, me_email: str) -> list[dict]:
    """Where everyone else on the team is, for the trail. A number each, no
    more: what they have done, never what they wrote."""
    out = []
    for n, r in enumerate(repo.roster(conn, track["id"], active_only=True)):
        if r["email"] == me_email:
            continue
        out.append({"who": r["email"].split("@")[0], "n": n % 6, "gain": gain(stage_rows(conn, track, auth.User(r["email"], "")))})
    return out


def trail(rows: list[dict], seed: str, mates: list[dict] = ()) -> dict:
    """The sidebar's trail, drawn the way the main site draws its own
    (Navigation.astro): waypoints alternate sides at a random distance from the
    edge, and the path between them wanders through two drift points instead
    of running straight. Seeded by the study, so it has its own shape and
    keeps it from one page to the next. Trailhead at the bottom, summit on top.
    """
    rng = random.Random(seed)
    height = TRAIL_ROW * len(rows) + 12
    for s in rows:
        s["x"] = rng.randint(24, 86) if s["n"] % 2 == 0 else rng.randint(154, 216)
        s["y"] = height - 34 - s["n"] * TRAIL_ROW

    path = f"M {rows[0]['x']} {rows[0]['y']}"
    reach = [0.0]  # path length from the trailhead to each waypoint
    for a, b in zip(rows, rows[1:]):
        stops = [(a["x"], a["y"])]
        for k in (1, 2):
            x = a["x"] + (b["x"] - a["x"]) * k / 3 + rng.uniform(-38, 38)
            stops.append((min(max(x, 14), TRAIL_WIDTH - 14), a["y"] + (b["y"] - a["y"]) * k / 3))
        stops.append((b["x"], b["y"]))
        length = 0.0
        for p0, p1 in zip(stops, stops[1:]):
            # Control points share their end's x, so the line always leaves and
            # arrives vertically: it bends, it never kinks.
            mid = (p0[1] + p1[1]) / 2
            jitter = rng.uniform(-0.12, 0.12) * (p1[1] - p0[1])
            c0, c1 = (p0[0], mid + jitter), (p1[0], mid - jitter)
            path += f" C {c0[0]:.1f} {c0[1]:.1f}, {c1[0]:.1f} {c1[1]:.1f}, {p1[0]:.1f} {p1[1]:.1f}"
            samples = [_cubic(p0, c0, c1, p1, i / 24) for i in range(25)]
            length += sum(((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 for (x0, y0), (x1, y1) in zip(samples, samples[1:]))
        reach.append(reach[-1] + length)

    def along(how_far: float) -> float:
        whole, part = int(how_far), how_far - int(how_far)
        return reach[whole] + part * (reach[min(whole + 1, len(reach) - 1)] - reach[whole])

    here = next((s for s in rows if not s["done"]), rows[-1])
    mine = gain(rows)
    return {
        "height": height, "path": path, "here": here["n"], "gain": round(mine, 3),
        "length": round(reach[-1], 1), "climbed": round(along(mine), 1),
        # Teammates, as a share of the path each, so the script can place them.
        "mates": [{**m, "at": round(along(m["gain"]) / reach[-1], 4)} for m in mates],
    }


def own_item(conn, track_id: int, token: str, role: str):
    item = repo.item_by_token(conn, token)
    if not item or item["track_id"] != track_id:
        raise HTTPException(404, "No such item on this track.")
    if not repo.can_view_item(item, role):
        raise HTTPException(403, "This item is held for a lead.")
    return item


def transcript(conn, item) -> list:
    """An episode's lines, with half a minute of the session either side."""
    if item["session_id"] is None:
        return []
    return repo.segments(conn, item["session_id"], item["span_start"] - CONTEXT_MS, item["span_end"] + CONTEXT_MS)


def batch_context(conn, request: Request, batch_id: int, lead: bool = False):
    """(user, track, roster row, batch, submitted) where submitted is None for
    someone who is not a coder on the batch. Coders reach only their own batches."""
    batch = repo.batch(conn, batch_id)
    if not batch:
        raise HTTPException(404, "No such batch.")
    user, track, me = auth.require(conn, request, batch["track_id"], lead=lead)
    submitted = repo.has_submitted(conn, batch_id, me["id"])
    if submitted is None and me["role"] != "lead":
        raise HTTPException(403, "You are not a coder on this batch.")
    return user, track, me, batch, submitted


def stage_rows(conn, track, user) -> list[dict]:
    """The trail for one person: each stage with whether the team has finished
    it, whether it is still locked, and how far through it this person is."""
    tid = track["id"]
    me = conn.execute("SELECT id FROM roster WHERE track_id = ? AND email = ?", (tid, user.email)).fetchone()
    counts = repo.triage_counts(conn, tid)
    started = repo.has_started(conn, track, user.email)
    marks = repo.stage_marks(conn, tid)
    published = repo.latest_published(conn, tid)
    rounds = [b for b in repo.batches(conn, tid) if b["kind"] == "calibration"]
    deck = repo.starter(conn, tid)
    final = repo.production(conn, tid)
    photos = studies.get(track["dataset_kind"]).has_image
    video = studies.get(track["dataset_kind"]).has_video
    rows = []
    for n, _, title, key, path in stages.STAGES:
        # `part` is how far through the stage this person is, 0 to 1. The
        # trail fills by it, so the path moves as the work is done.
        part, progress = 0.0, ""
        if key == "onboarding":
            part = 1.0 if started else 0.0
        elif key == "triage":
            # Photos are cleaned first, once each, by the team. Then everyone reads every card.
            cards = counts["cleared"] + counts["untriaged"]
            read = len(repo.seen_ids(conn, tid, me["id"])) if me else 0
            if counts["untriaged"]:
                part, progress = 0.5 * counts["cleared"] / cards, f"{counts['cleared']}/{cards} clean"
            else:
                share = read / cards if cards else 0
                part, progress = (0.5 + 0.5 * share if photos else share), f"{read} read" if video else f"{read}/{cards}"
        elif key == "questions":
            asked = {r["roster_id"] for r in conn.execute("SELECT DISTINCT roster_id FROM memo WHERE track_id = ? AND kind = 'rq'", (tid,))}
            part = 1.0 if me and me["id"] in asked else 0.0
            progress = f"{len(asked)}/{len(repo.roster(conn, tid, active_only=True))}"
        elif key == "starter" and deck and me:
            mine = repo.my_assignments(conn, deck["id"], me["id"])
            coded = sum(1 for m in mine if m["done_at"])
            part = 1.0 if deck["status"] == "closed" else coded / len(mine) if mine else 0.0
            progress = f"{coded}/{len(mine)}" if mine else ""
        elif key == "codebook":
            merged = repo.job(conn, tid, "merge")
            part = 1.0 if published else 0.6 if repo.draft(conn, tid) else 0.3 if merged and merged["status"] == "ready" else 0.0
            progress = f"v{published['n']}" if published else ""
        elif key == "calibration":
            part = 0.5 if any(b["status"] == "closed" for b in rounds) else 0.25 if rounds else 0.0
            progress = str(len(rounds) or "")
        elif key == "production" and final and me:
            mine = repo.my_assignments(conn, final["id"], me["id"])
            coded = sum(1 for m in mine if m["done_at"])
            part = 1.0 if final["status"] == "closed" else coded / len(mine) if mine else 0.0
            progress = f"{coded}/{len(mine)}" if mine else ""
        elif key == "themes":
            n_themes = len(repo.themes(conn, tid))
            part = 1.0 if n_themes else 0.0
            progress = str(n_themes or "")
        team = n in repo.TEAM_STAGES
        # Past the trailhead once you have started and the lead has locked the team.
        done = n in marks and (started or key != "onboarding")
        locked = 1 <= n <= 7 and not all(m in marks for m in repo.TEAM_STAGES if m < n)
        rows.append({
            "n": n, "title": title, "key": key, "path": path, "done": done, "locked": locked,
            "progress": "locked" if locked else progress,
            "part": 1.0 if done else 0.0 if locked else part,
            # "auto" stages have nothing for the lead to finish.
            "auto": not team or key == "onboarding",
        })
    return rows


async def form_of(request: Request):
    return await request.form()


def chosen_codes(form, tree) -> dict[str, list[str]]:
    return {d["key"]: [str(v) for v in form.getlist("dim-" + d["key"])] for d in tree}


# ------------------------------------------------------------------- dashboard


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"


@app.get("/")
def dashboard(request: Request):
    user = auth.current_user(request)
    db.maybe_backup()
    with db.db() as conn:
        tracks = repo.tracks_for(conn, user.email, user.admin)
        if not tracks:
            # An admin sees every study, so for them an empty list means none has been loaded.
            raise HTTPException(
                403,
                "No study has been loaded yet. Import a dataset on the server; the commands are in the tool's README."
                if user.admin else "You are not on the roster for any study here. Ask the project lead to add you.",
            )
        cards = [
            {
                "track": t,
                "stages": stage_rows(conn, t, user),
                "climb": repo.trail_stats(conn, t["id"], {"id": t["roster_id"], "email": user.email}),
            }
            for t in tracks
        ]
    return page(request, "dashboard.html", user=user, cards=cards)


@app.get("/dev/as/{email}")
def dev_switch(email: str):
    """Developer machines only: pick who you are. Absent unless ANNOTATE_DEV_USER is set."""
    if not config.dev_user():
        raise HTTPException(404, "Not found.")
    response = go("/")
    response.set_cookie(auth.DEV_COOKIE, auth.normalize_email(email), httponly=True, samesite="lax")
    return response


# ---------------------------------------------------------------------- stages


@app.get("/t/{tid}/stage/{n}")
def stage(request: Request, tid: int, n: int):
    if n not in range(len(stages.STAGES)):
        raise HTTPException(404, "No such stage.")
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
    _, _, _, key, path = stages.STAGES[n]
    if key != "onboarding":
        return go(f"/t/{tid}/{path}")
    intro, cards = stages.sections(stages.brief(n, track["dataset_kind"]))
    with db.db() as conn:
        people = repo.team_progress(conn, tid) if me["role"] == "lead" else []
        team_locked, started = repo.team_locked(conn, tid), repo.has_started(conn, track, user.email)
    return page(
        request, "onboarding.html", user=user, track=track, me=me, at=key, people=people, team_locked=team_locked, started=started,
        intro=Markup(markdown.render(intro)), cards=[(title, Markup(markdown.render(body))) for title, body in cards],
    )


@app.get("/t/{tid}/guide/{n}")
def guide(request: Request, tid: int, n: int):
    """A stage's guide, on a page of its own. Readable while the stage is locked."""
    if n not in range(1, len(stages.STAGES)):
        raise HTTPException(404, "No such stage.")
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
    return page(request, "stage.html", user=user, track=track, me=me, at=stages.STAGES[n][3], guide_page=True)


@app.post("/t/{tid}/stage/{n}/done")
async def stage_done(request: Request, tid: int, n: int):
    if n not in range(len(stages.STAGES)):
        raise HTTPException(404, "No such stage.")
    form = await form_of(request)
    with db.db() as conn:
        user, _, _ = auth.require(conn, request, tid, lead=True)
        repo.set_stage_done(conn, tid, n, form.get("done") == "1", user.email)
    return go(f"/t/{tid}/{stages.STAGES[n][4]}")


@app.post("/t/{tid}/start")
def start(request: Request, tid: int):
    """The one button on the onboarding page: off the trailhead, on to the first stage."""
    with db.db() as conn:
        user, track, _ = auth.require(conn, request, tid)
        repo.start(conn, track["dataset_id"], user.email)
        ready = repo.team_locked(conn, tid)
    return go(f"/t/{tid}/{stages.STAGES[1][4] if ready else 'stage/0'}")


# ---------------------------------------------------------------------- triage


@app.get("/t/{tid}/triage")
def triage_list(request: Request, tid: int, status: str = ""):
    """Your own pass through every card. A lead also has what was flagged and
    what is out."""
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        if me["role"] != "lead" or status not in ("pii_hold", "excluded"):
            status = ""
        items = repo.items_with_status(conn, tid, [status] if status else repo.PASS)
        counts = repo.triage_counts(conn, tid)
        # While any photo is uncleaned, that is the work. Reading comes after.
        to_clean = repo.next_uncleaned(conn, tid, me["id"])
        first = to_clean or repo.next_unseen(conn, tid, me["id"])
        seen = repo.seen_ids(conn, tid, me["id"])
        left = repo.cleaning_left(conn, tid)
        waiting = [(r["email"], left[r["id"]]) for r in repo.roster(conn, tid) if left.get(r["id"])]
        # Recorded sessions are read a session at a time, so they are listed that way.
        sessions = repo.reading_sessions(conn, tid, me["id"])
    return page(
        request, "triage_list.html", user=user, track=track, me=me, at="triage",
        items=items, counts=counts, status=status, first=first, seen=seen, sessions=sessions,
        mine=left.get(me["id"], 0) + left.get(0, 0), to_clean=to_clean, waiting=waiting,
    )


@app.get("/t/{tid}/triage/{token}")
def triage_item(request: Request, tid: int, token: str):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        item = own_item(conn, tid, token, me["role"])
        if studies.get(track["dataset_kind"]).has_video and item["status"] == "cleared":
            # A recorded session is read whole, on its own page, from this episode on.
            return go(f"/t/{tid}/session/{quote(item['alias'])}?at={item['span_start']}")
        counts = repo.triage_counts(conn, tid)
        jot = repo.my_jot(conn, me["id"], item["id"])
        frozen = repo.jots_frozen(conn, tid, me["id"])
        read = len(repo.seen_ids(conn, tid, me["id"]))
        back, forward = repo.neighbours(conn, tid, me["id"], item)
        lines = transcript(conn, item)
        session = next((s for s in repo.reading_sessions(conn, tid, me["id"]) if s["id"] == item["session_id"]), None)
    # clean: a photo nobody has turned and cropped yet. read: a card in the
    # data. resolve: a lead deciding on one that was flagged or excluded.
    mode = {"untriaged": "clean", "cleared": "read"}.get(item["status"], "resolve")
    cards = counts["cleared"] + counts["untriaged"]
    deck = {"back": f"/t/{tid}/triage", "title": "Read", "value": read, "max": cards}
    if mode == "clean":
        deck.update(title="Clean", value=counts["cleared"])
    elif session:
        deck.update(title=f"Read · {session['alias']}", value=session["read"], max=session["n"])
    return page(
        request, "triage_item.html", user=user, track=track, me=me, item=item, at="triage", deck=deck,
        mode=mode, jot=jot, frozen=frozen, lines=lines,
        back=f"/t/{tid}/triage/{back}" if back else None, forward=f"/t/{tid}/triage/{forward}" if forward else None,
    )


@app.post("/t/{tid}/triage/{token}")
async def triage_save(request: Request, tid: int, token: str):
    form = await form_of(request)
    action = str(form.get("action") or "")
    try:
        crop = tuple(float(str(form.get(k) or "")) for k in ("crop_x", "crop_y", "crop_w", "crop_h"))
    except ValueError:
        crop = None  # no rectangle drawn
    reason = str(form.get("exclude") or "")
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        repo.require_open(conn, tid, 1)
        study = studies.get(track["dataset_kind"])
        item = own_item(conn, tid, token, me["role"])
        before = repo.feet(conn, tid, me["id"], me["email"])
        label = dict(study.exclude_reasons).get(reason)
        if reason and not label:
            raise repo.Refused("Pick one of the reasons.")
        note = str(form.get("note") or "").strip()
        clean = {"legible": True, "off_task": False, "pii_visible": False, "low_content": bool(item["low_content"])}
        cleaning = item["status"] == "untriaged" or me["role"] == "lead"

        if form.get("turn") in ("left", "right") and cleaning and item["status"] != "cleared":
            # Turning saves at once and stays on the card; the crop is drawn after.
            rotation = (item["rotation"] + (90 if form.get("turn") == "right" else 270)) % 360
            kept = {k: bool(item[k]) for k in clean}
            repo.save_triage(conn, item, me["role"], user.email, "save", rotation, None, kept, item["note"])
            return go(f"/t/{tid}/triage/{token}")

        if item["status"] not in repo.PASS:
            # A lead settling a card that was flagged or excluded.
            flags = dict(clean, legible=reason != "unreadable", off_task=reason == "off_task", pii_visible=reason == "identifying")
            if label and label not in note:
                note = f"{label}. {note}".strip()  # the reason travels with the item, into the export
            status = repo.save_triage(conn, item, "lead", user.email, "exclude" if reason else "clear", item["rotation"], crop, flags, note)
            following = repo.next_held(conn, tid)
            said = "Excluded" if status == "excluded" else "Kept"
            if following:
                return go(f"/t/{tid}/triage/{following['token']}", ok=said)
            return go(f"/t/{tid}/triage", ok=said + " · nothing left waiting for you")

        if form.get("mode") == "clean" or item["status"] == "untriaged":
            # Cleaning: one photo, done once for everyone. No jot here; reading
            # comes after. The form says it was a cleaning card in case
            # someone else cleaned the photo while this person had it open.
            if item["status"] != "untriaged":
                said = "Someone had already cleaned that one"
            elif me["role"] != "lead" and repo.cleaner(conn, item["id"]) not in (None, me["id"]):
                raise repo.Refused("That photo is someone else's to clean.")
            elif reason:
                repo.flag_item(conn, item, user.email, reason, f"{label}. {note}".strip())
                said = f"Sent to the lead · +{repo.FEET['triaged']} ft"
            else:
                repo.save_triage(conn, item, me["role"], user.email, "clear", item["rotation"], crop, clean, item["note"])
                said = f"+{repo.FEET['triaged']} ft"
            said += passing(conn, tid, me, before)
            following = repo.next_uncleaned(conn, tid, me["id"], after=item["shuffle_key"])
            if following:
                return go(f"/t/{tid}/triage/{following['token']}", ok=said)
            return go(f"/t/{tid}/triage", ok="Every photo cleaned")

        if action == "reopen" and me["role"] == "lead":
            # Back to the lead to turn or crop again. It stays out of everyone
            # else's reach meanwhile: without its crop the photo may show
            # what the crop was hiding.
            repo.save_triage(conn, item, "lead", user.email, "reopen", item["rotation"], None, dict(clean, pii_visible=True), item["note"])
            return go(f"/t/{tid}/triage/{token}", ok="Reopened")

        # One card of a person's own pass: jot, and move on or flag it.
        auth.on_team(me)
        jot = str(form.get("jot") or "").strip()
        if jot and repo.jots_frozen(conn, tid, me["id"]):
            raise repo.Refused("You have generated your candidate codes, so your jots are closed.")
        fresh = bool(jot) and repo.set_jotting(conn, tid, me["id"], item["id"], jot)
        if not jot and study.jot_required and not reason and not repo.jots_frozen(conn, tid, me["id"]):
            raise repo.Refused("Jot what you notice before moving on.")
        said = ""
        if reason:
            repo.flag_item(conn, item, user.email, reason, f"{label}. {note}".strip())
            said = "Sent to the lead"
        if repo.mark_seen(conn, item["id"], me["id"]):
            said = (said + " · " if said else "") + f"+{repo.FEET['triaged'] + (repo.FEET['jotting'] if fresh else 0)} ft"
        elif fresh:
            said = (said + " · " if said else "") + f"+{repo.FEET['jotting']} ft"
        said += passing(conn, tid, me, before)
        following = repo.next_unseen(conn, tid, me["id"], after=item["shuffle_key"])
    if following:
        return go(f"/t/{tid}/triage/{following['token']}", ok=said or "Saved")
    return go(f"/t/{tid}/triage", ok="Every card read")


# -------------------------------------------------------------------- sessions


def session_of(conn, request: Request, tid: int, alias: str):
    """(user, track, roster row, session) for a recorded session, by its alias."""
    user, track, me = auth.require(conn, request, tid)
    session = studies.get(track["dataset_kind"]).has_video and repo.session_by_alias(conn, tid, alias)
    if not session:
        raise HTTPException(404, "No such session.")
    return user, track, me, session


@app.get("/t/{tid}/session/{alias}")
def session_page(request: Request, tid: int, alias: str):
    """A whole recorded session, read and jotted on line by line. Its episodes
    are still what is marked read and compared, so each line carries its
    own; one held or excluded takes no jot and, for a coder, shows nothing."""
    with db.db() as conn:
        user, track, me, session = session_of(conn, request, tid, alias)
        lines = repo.session_lines(conn, tid, session["id"])
        jots = repo.line_jots(conn, me["id"], session["id"])
        can_jot = bool(me["id"]) and repo.is_open(conn, tid, 1) and not repo.jots_frozen(conn, tid, me["id"])
        mine = next((s for s in repo.reading_sessions(conn, tid, me["id"]) if s["id"] == session["id"]), None)
    rows, hidden = [], None
    for g in lines:
        if not repo.can_view_item(g, me["role"]):
            if g["item_id"] != hidden:
                rows.append({"gap": True, "t_start_ms": g["t_start_ms"]})  # one row for the episode, none of its words
            hidden = g["item_id"]
            continue
        rows.append({
            "seq": g["seq"], "t_start_ms": g["t_start_ms"], "speaker": g["speaker"], "text": g["text"],
            "open": g["status"] == "cleared", "jot": jots.get(g["seq"], ""),
        })
    # The whole recording, reached through an episode this person may see.
    video = next((g["token"] for g in lines if repo.can_view_item(g, me["role"])), None) if session["has_media"] else None
    deck = {"back": f"/t/{tid}/triage", "title": f"Read · {session['alias']}", "value": mine["read"] if mine else 0, "max": mine["n"] if mine else 0}
    return page(
        request, "session.html", user=user, track=track, me=me, at="triage", deck=deck, session=session,
        rows=rows, video=video, can_jot=can_jot, done=bool(mine and mine["done"]),
    )


@app.post("/t/{tid}/session/{alias}/line/{seq}")
async def line_jot(request: Request, tid: int, alias: str, seq: int):
    """Save one line's jot from the session page's script. Empty text deletes it."""
    form = await form_of(request)
    try:
        with db.db() as conn:
            _, _, me, session = session_of(conn, request, tid, alias)
            auth.on_team(me)
            repo.require_open(conn, tid, 1)
            if repo.jots_frozen(conn, tid, me["id"]):
                raise repo.Refused("You have generated your candidate codes, so your jots are closed.")
            repo.set_line_jot(conn, tid, me["id"], session["id"], seq, str(form.get("body") or ""))
            body = repo.line_jots(conn, me["id"], session["id"]).get(seq, "")
    except repo.Refused as refusal:  # rolled back; the script shows the reason
        return JSONResponse({"error": str(refusal)}, status_code=409)
    return JSONResponse({"body": body})


@app.post("/t/{tid}/session/{alias}/read")
async def session_read(request: Request, tid: int, alias: str):
    """Mark a whole session read, and go on to the next. read=0 takes it back."""
    form = await form_of(request)
    with db.db() as conn:
        _, _, me, session = session_of(conn, request, tid, alias)
        auth.on_team(me)
        repo.require_open(conn, tid, 1)
        if form.get("read") == "0":
            repo.mark_session_read(conn, tid, session["id"], me["id"], read=False)
            return go(f"/t/{tid}/session/{quote(session['alias'])}", ok="Marked unread")
        before = repo.feet(conn, tid, me["id"], me["email"])
        fresh = repo.mark_session_read(conn, tid, session["id"], me["id"])
        said = f"{session['alias']} read" + (f" · +{fresh * repo.FEET['triaged']} ft" if fresh else "") + passing(conn, tid, me, before)
        following = repo.next_session(conn, tid, me["id"], session["id"])
    if following:
        return go(f"/t/{tid}/session/{quote(following)}", ok=said)
    return go(f"/t/{tid}/triage", ok=said + " · every session read")


@app.get("/img/{token}")
def image(request: Request, token: str, full: int = 0):
    with db.db() as conn:
        item = repo.item_by_token(conn, token)
        if not item:
            raise HTTPException(404, "No such image.")
        _, _, me = auth.require(conn, request, item["track_id"])
    if not item["raw_path"]:
        raise HTTPException(404, "This submission has no diagram.")
    if not repo.can_view_item(item, me["role"]):
        raise HTTPException(403, "This item is held for a lead.")
    # The uncropped photo is for whoever is drawing the crop: anyone while the
    # item is still untriaged, a lead afterwards.
    uncropped = bool(full) and (me["role"] == "lead" or item["status"] == "untriaged")
    return Response(images.served(item, uncropped=uncropped), media_type="image/jpeg")


@app.get("/video/{token}")
def video(request: Request, token: str):
    """An episode's whole recording; the page's player starts it at the
    episode. Starlette answers Range requests, so the browser fetches only
    the part it plays."""
    with db.db() as conn:
        item = repo.item_by_token(conn, token)
        if not item:
            raise HTTPException(404, "No such video.")
        _, track, me = auth.require(conn, request, item["track_id"])
        media = repo.media_path(conn, token)
    if not studies.get(track["dataset_kind"]).has_video or not media:
        raise HTTPException(404, "This item has no video.")
    if not repo.can_view_item(item, me["role"]):
        raise HTTPException(403, "This item is held for a lead.")
    raw = config.raw_dir().resolve()
    path = (raw / media).resolve()
    if not path.is_relative_to(raw) or not path.is_file():
        raise HTTPException(404, "This item has no video.")
    # No filename, so no Content-Disposition: it plays, it is not offered as a download.
    return FileResponse(path, media_type="video/mp4", headers={"Cross-Origin-Resource-Policy": "same-origin"})


# ------------------------------------------------------------- items and memos


@app.get("/t/{tid}/items")
def items(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        rows = repo.items_with_status(conn, tid, ["cleared"])
        jotted = {j["item_id"] for j in repo.my_jottings(conn, me["id"])}
    return page(request, "items.html", user=user, track=track, me=me, items=rows, jotted=jotted, at="items")


@app.get("/t/{tid}/items/{token}")
def item_view(request: Request, tid: int, token: str):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        item = own_item(conn, tid, token, me["role"])
        if item["status"] != "cleared" and me["role"] != "lead":
            raise HTTPException(403, "This item has not been cleared for reading yet.")
        cleared = repo.items_with_status(conn, tid, ["cleared"])
        jot = repo.my_jot(conn, me["id"], item["id"])
        frozen = repo.jots_frozen(conn, tid, me["id"])
        lines = transcript(conn, item)
    tokens = [i["token"] for i in cleared]
    at = tokens.index(token) if token in tokens else -1
    deck = {"back": f"/t/{tid}/items", "title": "Items", "value": at + 1, "max": len(tokens)}
    return page(
        request, "item.html", user=user, track=track, me=me, item=item, jot=jot, frozen=frozen, at="items", deck=deck, lines=lines,
        previous=tokens[at - 1] if at > 0 else None,
        following=tokens[at + 1] if 0 <= at < len(tokens) - 1 else None,
    )


@app.post("/t/{tid}/items/{token}/jot")
async def jot(request: Request, tid: int, token: str):
    form = await form_of(request)
    with db.db() as conn:
        _, _, me = auth.require(conn, request, tid)
        item = own_item(conn, tid, token, me["role"])
        auth.on_team(me)
        if repo.jots_frozen(conn, tid, me["id"]):
            raise repo.Refused("You have generated your candidate codes, so your jots are closed.")
        before = repo.feet(conn, tid, me["id"], me["email"])
        fresh = repo.set_jotting(conn, tid, me["id"], item["id"], str(form.get("body") or ""))
        said = f"Jotted · +{repo.FEET['jotting']} ft" + passing(conn, tid, me, before) if fresh else "Jot saved"
    return go(f"/t/{tid}/items/{token}", ok=said)


@app.get("/t/{tid}/memos")
def memos(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        context = dict(
            shared=repo.shared_memos(conn, tid, "memo"),
            jottings=repo.my_jottings(conn, me["id"]),
        )
    return page(request, "memos.html", user=user, track=track, me=me, at="memos", **context)


@app.get("/t/{tid}/questions")
def questions(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        rows = repo.shared_memos(conn, tid, "rq")
    return page(request, "questions.html", user=user, track=track, me=me, at="questions", questions=rows)


@app.post("/t/{tid}/memos")
async def memo_add(request: Request, tid: int):
    form = await form_of(request)
    kind = str(form.get("kind"))
    if kind not in ("memo", "rq"):
        raise HTTPException(400, "Unknown kind of memo.")
    with db.db() as conn:
        _, _, me = auth.require(conn, request, tid)
        auth.on_team(me)
        if kind == "rq":
            repo.require_open(conn, tid, 2)
        before = repo.feet(conn, tid, me["id"], me["email"])
        repo.add_memo(conn, tid, me["id"], kind, str(form.get("body") or ""), code_key=str(form.get("code_key") or "").strip())
        said = f"Shared with the team · +{repo.FEET['memo']} ft" + passing(conn, tid, me, before)
    return go(f"/t/{tid}/{'questions' if kind == 'rq' else 'memos'}", ok=said)


# -------------------------------------------------------------------- codebook


@app.get("/t/{tid}/codebook")
def codebook(request: Request, tid: int, v: int = 0):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        all_versions = [x for x in repo.versions(conn, tid) if x["status"] == "published"]
        shown = next((x for x in all_versions if x["n"] == v), all_versions[0] if all_versions else None)
        tree = repo.version_tree(conn, shown["id"]) if shown else []
        has_draft = bool(repo.draft(conn, tid))
        deck = repo.starter(conn, tid)
        merged = repo.job(conn, tid, "merge")
    # Once a version has been published since the merge, the merge is history.
    settled = bool(merged and merged["status"] == "ready" and all_versions and all_versions[0]["published_at"] > merged["finished_at"])
    return page(
        request, "codebook.html", user=user, track=track, me=me, at="codebook",
        versions=all_versions, shown=shown, tree=tree, has_draft=has_draft,
        merged=merged, can_merge=bool(deck and deck["status"] == "closed"), settled=settled, model=llm.mode(),
    )


@app.get("/t/{tid}/codebook/draft")
def codebook_draft(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        version = repo.draft(conn, tid)
        tree = repo.version_tree(conn, version["id"]) if version else []
    return page(request, "codebook_draft.html", user=user, track=track, me=me, version=version, tree=tree, at="codebook")


@app.post("/t/{tid}/codebook/draft/{action}")
async def codebook_edit(request: Request, tid: int, action: str):
    """The codebook is the whole team's: anyone on the roster edits the draft
    and publishes it, once the lead has opened the stage."""
    form = await form_of(request)
    get = lambda name: str(form.get(name) or "")  # noqa: E731
    with db.db() as conn:
        user, track, _ = auth.require(conn, request, tid)
        repo.require_open(conn, tid, 4)
        parts = studies.get(track["dataset_kind"]).parts
        if action == "new":
            repo.new_draft(conn, tid, user.email)
        elif action == "discard":
            repo.discard_draft(conn, tid)
            return go(f"/t/{tid}/codebook", ok="Draft discarded.")
        elif action == "dimension":
            repo.save_dimension(conn, tid, get("key"), get("name"), get("mode"), get("part") or parts[0], parts, new=get("new") == "1")
        elif action == "dimension-delete":
            repo.delete_dimension(conn, tid, get("key"))
        elif action == "code":
            fields = {f: get(f) for f in ("label", "definition", "include", "exclude", "example")}
            repo.save_code(conn, tid, get("dimension"), get("key"), fields, new=get("new") == "1")
            if get("move_to") and get("move_to") != get("dimension"):
                repo.move_code(conn, tid, get("dimension"), get("key"), get("move_to"))
        elif action == "code-delete":
            repo.delete_code(conn, tid, get("dimension"), get("key"))
        elif action == "publish":
            repo.publish(conn, tid, get("note"))
            return go(f"/t/{tid}/codebook", ok="Published.")
        else:
            raise HTTPException(404, "Unknown codebook action.")
    return go(f"/t/{tid}/codebook/draft")


# ----------------------------------------------------------------- open coding


@app.get("/t/{tid}/open")
def open_coding(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        deck = repo.starter(conn, tid)
        context = dict(
            deck=None,  # `deck` is the card-deck layout's variable; this page is not one
            cards=deck,
            mine=repo.my_assignments(conn, deck["id"], me["id"]) if deck else [],
            run=repo.job(conn, tid, "candidates", me["id"]),
            codes=repo.my_codes(conn, tid, me["id"]),
            jots=len(repo.candidate_inputs(conn, tid, me["id"])["jots"]),
            unused=len(repo.unused_cleared(conn, tid)),
            members=len(repo.roster(conn, tid, active_only=True)),
            model=llm.mode(),
        )
    return page(request, "open.html", user=user, track=track, me=me, at="starter", **context)


@app.post("/t/{tid}/open/generate")
async def generate(request: Request, tid: int):
    """One person's candidate codes, from their own jots. Once."""
    form = await form_of(request)
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        auth.on_team(me)
        repo.require_open(conn, tid, 3)
        study = studies.get(track["dataset_kind"])
        existing = repo.job(conn, tid, "candidates", me["id"])
        if form.get("skip") == "1":
            if not existing or existing["status"] != "failed":
                raise repo.Refused("There is nothing to skip.")
            repo.finish_job(conn, tid, "candidates", me["id"], "ready", "Carried on without candidates.")
            return go(f"/t/{tid}/open")
        repo.start_job(conn, tid, "candidates", me["id"], user.email)
        given = repo.candidate_inputs(conn, tid, me["id"])
    assist.run(tid, "candidates", me["id"], lambda: assist.candidates(study, given), assist.store_candidates(tid, me["id"]))
    return go(f"/t/{tid}/open")


@app.get("/t/{tid}/codes")
def codes_view(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        deck = repo.starter(conn, tid)
        codes = repo.my_codes(conn, tid, me["id"])
    return page(
        request, "codes.html", user=user, track=track, me=me, at="starter",
        codes=[c for c in codes if c["status"] == "own"], cards=deck, closed=bool(deck and deck["status"] == "closed"),
    )


@app.post("/t/{tid}/codes/{pid}")
async def code_edit(request: Request, tid: int, pid: int):
    form = await form_of(request)
    with db.db() as conn:
        _, track, me = auth.require(conn, request, tid)
        parts = studies.get(track["dataset_kind"]).parts
        repo.edit_pcode(conn, tid, me["id"], pid, str(form.get("name") or ""), str(form.get("definition") or ""), str(form.get("part") or parts[0]), parts)
    return go(f"/t/{tid}/codes", ok="Saved. The change is on every card the code is on.")


# ----------------------------------------------------------------------- merge


@app.post("/t/{tid}/merge/run")
async def merge_run(request: Request, tid: int):
    """The lead's one-time step after open coding closes: propose one codebook
    from everyone's."""
    form = await form_of(request)
    with db.db() as conn:
        user, track, _ = auth.require(conn, request, tid, lead=True)
        repo.require_open(conn, tid, 4)
        study = studies.get(track["dataset_kind"])
        given = repo.merge_inputs(conn, tid)
        if not given["codes"]:
            raise repo.Refused("Nobody made any codes in open coding, so there is nothing to merge.")
        repo.start_job(conn, tid, "merge", 0, user.email)
    plain = form.get("plain") == "1"
    assist.run(tid, "merge", 0, lambda: assist.proposal(study, given, plain), assist.store_proposal(tid, len(given["codes"])))
    return go(f"/t/{tid}/codebook")


@app.get("/t/{tid}/merge")
def merge_view(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        view = repo.merge_view(conn, tid)
        merged = repo.job(conn, tid, "merge")
        has_draft = bool(repo.draft(conn, tid))
    if not merged or merged["status"] != "ready":
        return go(f"/t/{tid}/codebook")
    return page(request, "merge.html", user=user, track=track, me=me, at="codebook", view=view, merged=merged, has_draft=has_draft)


@app.get("/t/{tid}/merge/cards/{pid}")
def merge_cards(request: Request, tid: int, pid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        code, cards = repo.code_cards(conn, tid, pid)
    return page(request, "merge_cards.html", user=user, track=track, me=me, at="codebook", code=code, cards=cards)


@app.post("/t/{tid}/merge/{action}")
async def merge_edit(request: Request, tid: int, action: str):
    """The meeting. Anyone on the roster can do any of it."""
    form = await form_of(request)
    get = lambda name: str(form.get(name) or "")  # noqa: E731
    with db.db() as conn:
        user, track, _ = auth.require(conn, request, tid)
        repo.require_open(conn, tid, 4)
        if action == "move" and get("pcode").isdigit():
            repo.move_pcode(conn, tid, int(get("pcode")), get("to"))
        elif action == "code" and get("mcode").isdigit():
            repo.save_mcode(conn, tid, int(get("mcode")), get("name"), get("definition"))
        elif action == "write":
            repo.merge_to_draft(conn, tid, user.email, studies.get(track["dataset_kind"]).parts)
            return go(f"/t/{tid}/codebook/draft", ok="Written to the draft. Edit it here, then publish.")
        else:
            raise HTTPException(404, "Unknown merge action.")
    return go(f"/t/{tid}/merge" + (f"#m{get('mcode')}" if action == "code" else ""))


# --------------------------------------------------------------------- batches


@app.get("/t/{tid}/batches")
def batch_list(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        rows = [b for b in repo.batches(conn, tid) if b["kind"] == "calibration"]  # open coding has its own page
        if me["role"] != "lead":
            rows = [b for b in rows if repo.has_submitted(conn, b["id"], me["id"]) is not None]
        context = dict(
            batches=rows,
            people=repo.roster(conn, tid, active_only=True),
            published=repo.latest_published(conn, tid),
            unused=len(repo.unused_cleared(conn, tid)),
            weak=repo.weak_codes(conn, tid),
        )
    return page(request, "batches.html", user=user, track=track, me=me, at="calibration", **context)


@app.post("/t/{tid}/batches")
async def batch_create(request: Request, tid: int):
    form = await form_of(request)
    try:
        n_items = int(form.get("n_items") or 0)
        coders = [int(v) for v in form.getlist("coder")]
        int(form.get("overlap") or 20)
    except ValueError:
        raise repo.Refused("The number of items must be a whole number.")
    with db.db() as conn:
        user, _, _ = auth.require(conn, request, tid, lead=True)
        kind = str(form.get("kind"))
        repo.require_open(conn, tid, {"starter": 3, "production": 6}.get(kind, 5))
        overlap = int(form.get("overlap") or 20)
        batch_id = repo.create_batch(conn, tid, kind, str(form.get("title") or ""), n_items, coders, user.email, overlap)
    home = {"starter": f"/t/{tid}/open", "production": f"/t/{tid}/production"}.get(kind, f"/b/{batch_id}")
    return go(home, ok="Cards dealt.")


@app.get("/b/{bid}")
def batch_view(request: Request, bid: int):
    with db.db() as conn:
        user, track, me, batch, submitted = batch_context(conn, request, bid)
        context = dict(
            coders=repo.batch_coders(conn, bid),
            mine=repo.my_assignments(conn, bid, me["id"]) if submitted is not None else [],
        )
    return page(request, "batch.html", user=user, track=track, me=me, batch=batch, submitted=submitted, at=batch["kind"], **context)


def my_assignment(conn, batch, me, token: str):
    for row in repo.my_assignments(conn, batch["id"], me["id"]):
        if row["token"] == token:
            return row
    raise HTTPException(404, "That item is not in your part of this batch.")


@app.get("/b/{bid}/code/{token}")
def code_form(request: Request, bid: int, token: str):
    with db.db() as conn:
        user, track, me, batch, submitted = batch_context(conn, request, bid)
        item = my_assignment(conn, batch, me, token)
        mine = repo.my_assignments(conn, bid, me["id"])
        tree = repo.version_tree(conn, batch["version_id"]) if batch["version_id"] else []
        own = repo.visible_annotations(conn, batch, me).get((item["id"], me["coder_code"]), set())
        jot = repo.my_jot(conn, me["id"], item["id"])
        lines = transcript(conn, item)
        codes, on_card, run = [], set(), None
        if batch["kind"] == "starter":
            codes = repo.my_codes(conn, track["id"], me["id"])
            on_card = repo.codes_on(conn, me["id"], item["id"])
            run = repo.job(conn, track["id"], "candidates", me["id"])
    if batch["kind"] == "starter" and batch["status"] == "open" and (not run or run["status"] != "ready"):
        return go(f"/t/{track['id']}/open", error="Generate your candidate codes first.")
    position = [m["token"] for m in mine].index(token)
    deck = {"back": f"/b/{bid}", "title": batch["title"], "value": sum(1 for m in mine if m["done_at"]), "max": len(mine)}
    return page(
        request, "code.html", user=user, track=track, me=me, batch=batch, item=item, tree=tree, at=batch["kind"], deck=deck,
        previous=mine[position - 1]["token"] if position else None,
        following=mine[position + 1]["token"] if position + 1 < len(mine) else None,
        own=own, jot=jot, position=position + 1, total=len(mine), lines=lines,
        codes=[c for c in codes if c["status"] == "own"], candidates=[c for c in codes if c["status"] == "candidate"], on_card=on_card,
        locked=bool(submitted) or batch["status"] == "closed",
    )


@app.post("/b/{bid}/code/{token}")
async def code_save(request: Request, bid: int, token: str):
    form = await form_of(request)
    with db.db() as conn:
        _, track, me, batch, submitted = batch_context(conn, request, bid)
        item = my_assignment(conn, batch, me, token)
        before = repo.feet(conn, track["id"], me["id"], me["email"])
        if batch["status"] == "closed":
            raise repo.Refused("The lead closed this deck. This card was not saved.")
        if submitted:
            raise repo.Refused("You have submitted this batch, so your codes are locked.")
        if batch["kind"] == "starter":
            parts = studies.get(track["dataset_kind"]).parts
            name = str(form.get("new_name") or "").strip()
            new = (name, str(form.get("new_definition") or ""), str(form.get("new_part") or parts[0])) if name else None
            chosen = {int(v) for v in form.getlist("code") if str(v).isdigit()}
            repo.save_card_codes(conn, track["id"], me["id"], item["id"], chosen, new, parts)
            repo.mark_done(conn, item["assignment_id"])
            if form.get("action") == "add":
                return go(f"/b/{bid}/code/{token}", ok="Code added")
        else:
            tree = repo.version_tree(conn, batch["version_id"])
            repo.save_codes(conn, batch, item["assignment_id"], chosen_codes(form, tree))
        note = str(form.get("note") or "").strip()
        if note:
            repo.set_jotting(conn, track["id"], me["id"], item["id"], note)
        following = next((m["token"] for m in repo.my_assignments(conn, bid, me["id"]) if not m["done_at"]), None)
        said = f"+{repo.FEET['coded']} ft" + passing(conn, track["id"], me, before)
    if following:
        return go(f"/b/{bid}/code/{following}", ok=said)
    return go(f"/b/{bid}", ok="Deck finished." if batch["kind"] == "starter" else "Deck finished. Submit when ready.")


@app.post("/b/{bid}/submit")
def batch_submit(request: Request, bid: int):
    with db.db() as conn:
        _, _, me, _, submitted = batch_context(conn, request, bid)
        if submitted is None:
            raise repo.Refused("You are not a coder on this batch.")
        repo.submit(conn, bid, me["id"])
    return go(f"/b/{bid}", ok="Submitted.")


@app.post("/b/{bid}/close")
async def batch_close(request: Request, bid: int):
    form = await form_of(request)
    with db.db() as conn:
        user, _, _, batch, _ = batch_context(conn, request, bid, lead=True)
        repo.close_batch(conn, batch, force=form.get("force") == "1")
        # Only on the close itself: a repeated POST must not rewrite frozen figures.
        if batch["kind"] in ("calibration", "production") and batch["status"] != "closed":
            agreement.snapshot(conn, batch)
        if batch["kind"] == "starter" and batch["status"] != "closed":
            # Closing open coding is the lead finishing that stage: it opens the codebook.
            repo.set_stage_done(conn, batch["track_id"], 3, True, user.email)
    if batch["kind"] == "starter":
        return go(f"/t/{batch['track_id']}/codebook", ok="Open coding closed.")
    return go(f"/b/{bid}/review", ok="Batch closed.")


def closed_batch(conn, request: Request, bid: int):
    user, track, me, batch, _ = batch_context(conn, request, bid)
    if batch["status"] != "closed":
        raise HTTPException(403, "This opens when the lead closes the batch.")
    return user, track, me, batch


@app.get("/b/{bid}/agreement")
def batch_agreement(request: Request, bid: int):
    with db.db() as conn:
        user, track, me, batch = closed_batch(conn, request, bid)
        rows = agreement.for_batch(conn, bid)
    return page(request, "agreement.html", user=user, track=track, me=me, batch=batch, rows=rows, at="calibration")


@app.get("/b/{bid}/review")
def batch_review(request: Request, bid: int, all: int = 0):
    with db.db() as conn:
        user, track, me, batch = closed_batch(conn, request, bid)
        if batch["kind"] == "starter":
            return go(f"/t/{track['id']}/codebook")  # open coding is reviewed at the merge
        batch_items = repo.batch_items(conn, bid)
        coders = [c["coder_code"] for c in repo.batch_coders(conn, bid)]
        tree = repo.version_tree(conn, batch["version_id"]) if batch["version_id"] else []
        codes = repo.visible_annotations(conn, batch, me)
    rows = []
    for item in batch_items:
        by_coder = {c: codes[(item["id"], c)] for c in coders if (item["id"], c) in codes}
        split = len({frozenset(v) for v in by_coder.values()}) > 1
        if split or all:
            rows.append({
                "item": item, "by_coder": by_coder, "split": split,
                "consensus": codes.get((item["id"], "CONSENSUS")),
            })
    return page(
        request, "review.html", user=user, track=track, me=me, batch=batch, at=batch["kind"],
        rows=rows, tree=tree, coders=coders, show_all=bool(all), n_items=len(batch_items),
    )


@app.post("/b/{bid}/consensus/{token}")
async def consensus(request: Request, bid: int, token: str):
    form = await form_of(request)
    with db.db() as conn:
        # The team settles a disagreement together; whoever is driving records it.
        _, track, me, batch, _ = batch_context(conn, request, bid)
        if batch["kind"] == "starter":
            raise HTTPException(404, "Open coding has no consensus.")
        item = own_item(conn, track["id"], token, me["role"])
        if item["id"] not in {i["id"] for i in repo.batch_items(conn, bid)}:
            raise HTTPException(404, "That item is not in this batch.")
        tree = repo.version_tree(conn, batch["version_id"])
        repo.save_consensus(conn, batch, item["id"], chosen_codes(form, tree))
    view = "?all=1" if form.get("all") == "1" else ""
    return go(f"/b/{bid}/review{view}#item-{token}", ok="Consensus saved.")


@app.get("/t/{tid}/history")
def history(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        rows = agreement.history(conn, tid)
        # A coder can open only the rounds they were on.
        mine = {b["id"] for b in repo.batches(conn, tid) if me["role"] == "lead" or repo.has_submitted(conn, b["id"], me["id"]) is not None}
    # One line per dimension: mean alpha by round, drawn on a 0..1 scale.
    # The chart is the calibration rounds; the final pass is in the table below it.
    charted = [r for r in rows if r["kind"] == "calibration"]
    rounds = sorted({r["round_no"] for r in charted})
    lines = []
    for i, dim in enumerate(sorted({r["dimension_key"] for r in charted})):
        points = [
            (40 + 420 * (rounds.index(r["round_no"]) / max(len(rounds) - 1, 1)), 170 - 150 * max(r["alpha"], 0))
            for r in charted if r["dimension_key"] == dim and r["alpha"] is not None
        ]
        lines.append({"dim": dim, "n": i % 4, "points": points, "path": " ".join(f"{x:.0f},{y:.0f}" for x, y in points)})
    return page(request, "history.html", user=user, track=track, me=me, at="history", rows=rows, lines=lines, rounds=rounds, mine=mine)


# ----------------------------------------------------- production and themes


@app.get("/t/{tid}/production")
def production(request: Request, tid: int):
    """The final pass: every kept item, most by one person, a share by two."""
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        cards = repo.production(conn, tid)
        context = dict(
            deck=None, cards=cards,
            mine=repo.my_assignments(conn, cards["id"], me["id"]) if cards else [],
            submitted=repo.has_submitted(conn, cards["id"], me["id"]) if cards else None,
            final=repo.final_codes(conn, tid) if cards and cards["status"] == "closed" else None,
            kept=repo.triage_counts(conn, tid)["cleared"],
            members=len(repo.roster(conn, tid, active_only=True)),
            published=repo.latest_published(conn, tid),
        )
    return page(request, "production.html", user=user, track=track, me=me, at="production", **context)


@app.get("/t/{tid}/themes")
def themes_view(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        ready = repo.is_open(conn, tid, 7)
        context = dict(
            topics=repo.topic_map(conn, tid) if ready else None,
            themes=repo.themes(conn, tid),
            run=repo.job(conn, tid, "themes"),
            model=llm.mode(),
        )
    return page(request, "themes.html", user=user, track=track, me=me, at="themes", **context)


@app.get("/t/{tid}/themes/code/{dimension}/{key}")
def theme_code_items(request: Request, tid: int, dimension: str, key: str):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        repo.require_open(conn, tid, 7)
        code, cards = repo.code_items(conn, tid, dimension, key)
    return page(request, "code_items.html", user=user, track=track, me=me, at="themes", code=code, cards=cards)


@app.post("/t/{tid}/themes/{action}")
async def themes_edit(request: Request, tid: int, action: str):
    """Themes are the team's. Anyone on the roster edits them; the lead can
    ask the model for a first proposal, once."""
    form = await form_of(request)
    get = lambda name: str(form.get(name) or "")  # noqa: E731
    theme_id = int(get("theme")) if get("theme").isdigit() else None
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid)
        repo.require_open(conn, tid, 7)
        if action == "save":
            repo.save_theme(conn, tid, theme_id, get("name"), get("statement"))
        elif action == "delete" and theme_id:
            repo.delete_theme(conn, tid, theme_id)
        elif action == "move":
            repo.set_code_theme(conn, tid, get("dimension"), get("code"), theme_id)
        elif action == "propose":
            if me["role"] != "lead":
                raise HTTPException(403, "Only a lead on this track can do that.")
            study = studies.get(track["dataset_kind"])
            given = repo.topic_map(conn, tid)
            repo.start_job(conn, tid, "themes", 0, user.email)
        else:
            raise HTTPException(404, "Unknown themes action.")
    if action == "propose":
        assist.run(tid, "themes", 0, lambda: assist.themes(study, given), assist.store_themes(tid))
    return go(f"/t/{tid}/themes")


# ----------------------------------------------------------- roster and export


@app.get("/t/{tid}/roster")
def roster_view(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid, lead=True)
        people = repo.team_progress(conn, tid)
        counts = repo.triage_counts(conn, tid)
        team_locked = repo.team_locked(conn, tid)
    return page(request, "roster.html", team_locked=team_locked, outside=not me["id"], kept=counts["cleared"] + counts["untriaged"], user=user, track=track, me=me, people=people, at="roster")


@app.post("/t/{tid}/roster")
async def roster_edit(request: Request, tid: int):
    form = await form_of(request)
    with db.db() as conn:
        user, _, _ = auth.require(conn, request, tid, lead=True)
        if form.get("roster_id"):
            if not str(form.get("roster_id")).isdigit():
                raise repo.Refused("Unknown roster entry.")
            repo.set_roster(conn, tid, int(str(form.get("roster_id"))), str(form.get("role")), form.get("active") == "1", user.admin)
        else:
            repo.add_roster(conn, tid, str(form.get("email") or ""), str(form.get("role")), user.admin)
    return go(f"/t/{tid}/roster", ok="Roster updated.")


@app.get("/t/{tid}/export")
def export_view(request: Request, tid: int):
    with db.db() as conn:
        user, track, me = auth.require(conn, request, tid, lead=True)
    return page(request, "export.html", user=user, track=track, me=me, files=export.FILES, at="export")


@app.get("/t/{tid}/export.zip")
def export_zip(request: Request, tid: int):
    with db.db() as conn:
        user, track, _ = auth.require(conn, request, tid, lead=True)
        # The bundle covers the whole study, so it takes a lead on every track of it.
        if not user.admin and not repo.leads_whole_dataset(conn, track["dataset_id"], user.email):
            raise HTTPException(403, "The export covers every track in the study, so it needs a lead on all of them.")
        data = export.bundle(conn, track["dataset_id"])
    name = f"{track['dataset_slug']}-export.zip"
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})
