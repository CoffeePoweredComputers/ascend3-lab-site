"""Student-facing submission service.

The student flow is one page: sign in with a VT Google account and pick a
project, then one or more GenAI conversations, then a completeness answer.
Everything the server stores is keyed by participant code -- the address goes no
further than app/identity.py.

Who is calling is decided in exactly one place, `current_email` below, from a
Firebase ID token. No endpoint reads an address out of a request body.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import auth, config, normalize
from app.db import identity_db, init_databases, research_db
from app import consent, repository
from app.identity import InvalidEmail, normalize_email, resolve_participant_code
from app.schemas import (
    ConsentIn,
    PreviewIn,
    RepositoryIn,
    SessionStartIn,
    ShareLinkIn,
    SubmissionIn,
)
from app.share_import import ShareImportError, import_share_link
from app.timeutil import to_utc

MAX_BODY_BYTES = 40 * 1024 * 1024  # a semester of selected conversations, not an export
MAX_PATCH_CHARS = 20_000  # matches the cap the browser parsers apply

# The annotation questions were relaxed after the first submissions existed.
# Storing distinct sentinels keeps "the student skipped it" apart from "we no
# longer ask", so a dataset spanning the change is still analysable.
PURPOSE_UNSPECIFIED = "unspecified"
CHANGE_NOT_ASKED = "not_asked"

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_databases()
    yield


app = FastAPI(
    title="GenAI Interaction Log Submission",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return JSONResponse(
            status_code=413,
            content={
                "detail": "Submission too large. Add fewer conversations at a time, "
                "or split them across two submissions."
            },
        )
    return await call_next(request)


@app.middleware("http")
async def revalidate_app_assets(request: Request, call_next):
    """Make browsers re-check the page and its scripts on every load.

    The parsers ship as static files, so a browser holding a cached copy would
    keep running last month's version after a fix -- the same stale-copy failure
    that made a student's Copilot conversations invisible. "no-cache" still
    allows 304s, so this costs a conditional request, not a re-download.
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(config.STATIC_DIR / "index.html")


@app.get("/collect_ai_logs.py")
def collector_script() -> FileResponse:
    """Serve the log collector so students always run the current version.

    A copied script goes stale silently: an older copy missed an entire tool's
    conversations during testing, and 400 copies cannot be re-synced by hand.
    """
    return FileResponse(
        config.ROOT / "scripts" / "collect_ai_logs.py",
        media_type="text/plain",
        filename="collect_ai_logs.py",
    )


@app.get("/api/config")
def get_config() -> dict:
    course = config.course_config()
    return {
        "course": course.get("course"),
        "term": course.get("term"),
        "projects": [
            {
                "id": p["id"],
                "name": p.get("name", p["id"]),
                # Hidden projects still travel: the sandbox has to be reachable
                # by the people testing, and it is a sandbox, not a secret.
                "hidden": bool(p.get("hidden")),
                "window": dict(zip(("start", "end"), config.project_window(p["id"]))),
            }
            for p in course["projects"]
        ],
        "platforms": course["platforms"],
        "primary_purposes": course["primary_purposes"],
        "reported_changes": course["reported_changes"],
        "completeness_levels": course["completeness_levels"],
        "repository_note": (course.get("repository") or {}).get("access_note", ""),
        # Public by design -- a Firebase web apiKey names a project, it does not
        # grant anything. Served rather than baked into app.js so that one
        # deployment can point at a different project without an edit, and so a
        # server with sign-in unconfigured says so instead of rendering a button
        # that fails inside Google's SDK.
        "firebase": auth.firebase_config() or None,
    }


SIGN_IN_REQUIRED = "Sign in with your VT Google account to continue."

TEAM_MISMATCH = (
    "That team does not match the roster for this project. If you joined the "
    "class late or changed teams, ask your instructor to update the roster -- "
    "the change takes effect straight away."
)

NOT_ON_ROSTER = (
    "You are not on the roster for this project. If you joined the class late "
    "or changed teams, ask your instructor to update the roster -- the change "
    "takes effect straight away."
)


def current_email(authorization: str = Header(default="")) -> str:
    """The signed-in student, from their Firebase ID token.

    This is the identity boundary. Every endpoint that touches a student's data
    depends on it instead of reading an address out of the body, so there is one
    place -- and only one -- where "who is calling?" is answered.

    Tests replace this through app.dependency_overrides rather than minting real
    tokens. Nothing in the production path is relaxed to make that possible:
    there is no bypass env var to forget to unset, because an override that only
    exists in a test process cannot be left switched on in this one.
    """
    scheme, _, raw = (authorization or "").strip().partition(" ")
    token = raw.strip()
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail=SIGN_IN_REQUIRED)
    try:
        return normalize_email(auth.verify_id_token(token))
    except auth.InvalidToken as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except auth.AuthUnavailable as exc:
        # Ours, not theirs: sign-in is unconfigured or Google is unreachable.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except InvalidEmail as exc:  # a verified address our own rules still refuse
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _require_roster_match(email: str, project_id: str, typed_team, when: datetime) -> str:
    """The team instance this student was on, or a refusal.

    Identity is proven by the ID token before this runs, so this is
    authorization rather than a check on the address: is the signed-in student
    on this project's roster at all? A typed team is still honoured when a
    client sends one, and still has to agree -- but it is no longer asked for.
    Its whole purpose was to make a mistyped or borrowed address visible, and an
    address that has to be signed for cannot be either.

    "Not on the roster" can now be said plainly. It used to be folded into one
    message with "wrong team" so that typing addresses could not be used to
    discover who was enrolled; a caller who has already proved they own the
    address learns nothing about anyone else.
    """
    if typed_team and str(typed_team).strip():
        instance = config.verify_team(email, project_id, typed_team, when)
        if instance is None:
            raise HTTPException(status_code=400, detail=TEAM_MISMATCH)
        return instance

    instance, _how = config.lookup_team_instance(email, project_id, when)
    if instance is None:
        raise HTTPException(status_code=403, detail=NOT_ON_ROSTER)
    return instance


CONSENT_UNAVAILABLE = (
    "The consent form for this study is not ready yet. Please tell your "
    "instructor -- nothing can be submitted until it is in place."
)

CONSENT_REQUIRED = (
    "You have not agreed to take part in this study, so there is nothing to "
    "submit."
)


def _consent_form_or_503() -> dict:
    """The approved text, or a refusal. Never a draft."""
    form = consent.form()
    if not form["available"]:
        raise HTTPException(status_code=503, detail=CONSENT_UNAVAILABLE)
    return form



@app.get("/healthz")
def healthz() -> dict:
    """Liveness for whatever watches the service. Public, and says nothing.

    Deliberately unauthenticated: a health check exists to be called by systemd,
    a load balancer or an uptime monitor, none of which carry credentials, and a
    check that needs a secret is a check that stops being run. It is safe to
    leave open because there is nothing in the answer -- "ok" or "degraded" and
    the reason it is degraded. Anything worth protecting lives in
    /api/admin/status.

    It touches both databases rather than only returning a constant: a service
    that answers "ok" while its database is unreadable has told the monitor the
    one thing it must never say.
    """
    problems = []
    for name, connect in (("identity", identity_db), ("research", research_db)):
        try:
            with connect() as conn:
                conn.execute("SELECT 1").fetchone()
        except Exception as exc:  # noqa: BLE001 -- report, never raise, from a health check
            problems.append(f"{name} database: {type(exc).__name__}")

    if problems:
        return JSONResponse(
            status_code=503, content={"status": "degraded", "problems": problems}
        )
    return {"status": "ok"}


ADMIN_TOKEN_HEADER = "X-Admin-Token"


def _require_admin(token: str | None) -> None:
    """Guard the status page with a shared secret, not a list of addresses.

    An email address is not a secret -- the admins' own addresses are printed on
    the consent form -- so a list of them controls nothing. GENAI_ADMIN_TOKEN is
    set on the server and known to the three people who run the study. Absent
    from the environment, the page is closed rather than open: a status page
    that falls back to public when someone forgets to set a variable is the
    worst of both.
    """
    expected = os.environ.get("GENAI_ADMIN_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="No admin token is configured on this server.",
        )
    if not token or not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=404, detail="Not found.")


@app.get("/api/admin/status")
def admin_status(x_admin_token: str = Header(default="")) -> dict:
    """What the people running the study need to see, without opening a shell.

    Answers 404 rather than 401 when the token is wrong: there is no reason to
    confirm the page exists to someone who cannot open it.
    """
    _require_admin(x_admin_token)

    with research_db() as conn:
        counts = {
            table: conn.execute(f"SELECT count(*) c FROM {table}").fetchone()["c"]
            for table in (
                "submissions",
                "conversations",
                "turns",
                "team_repositories",
                "commits",
            )
        }
        latest = conn.execute(
            "SELECT submitted_at FROM submissions ORDER BY submitted_at DESC LIMIT 1"
        ).fetchone()
        by_project = {
            row["project_id"]: row["c"]
            for row in conn.execute(
                "SELECT project_id, count(*) c FROM submissions GROUP BY project_id"
            )
        }

    with identity_db() as conn:
        participants = conn.execute("SELECT count(*) c FROM identities").fetchone()["c"]
        consented = conn.execute(
            "SELECT count(*) c FROM consent_records WHERE decision = 'agree'"
        ).fetchone()["c"]
        declined = conn.execute(
            "SELECT count(*) c FROM consent_records WHERE decision = 'decline'"
        ).fetchone()["c"]

    form = consent.form()
    usage = shutil.disk_usage(config.DATA_DIR)

    return {
        "status": "ok",
        "counts": counts,
        "submissions_by_project": by_project,
        "last_submission_at": latest["submitted_at"] if latest else None,
        "participants": participants,
        "consent": {"agreed": consented, "declined": declined},
        "consent_form": {
            "available": form["available"],
            "version": form["version"],
            "problem": form.get("problem"),
        },
        "roster_rows": len(config.roster()),
        "disk_free_gb": round(usage.free / 1024**3, 1),
        "database_mb": {
            "identity": round(_file_mb(config.IDENTITY_DB), 2),
            "research": round(_file_mb(config.RESEARCH_DB), 2),
        },
    }


def _file_mb(path) -> float:
    try:
        return path.stat().st_size / 1024**2
    except OSError:
        return 0.0

@app.post("/api/session/start")
def start_session(
    payload: SessionStartIn, email: str = Depends(current_email)
) -> dict:
    """Check the signed-in student against the roster, then the consent record.

    No participant code is minted here: signing in to look at the page should
    not leave an identity row behind for someone who never submits anything.
    """
    if payload.project_id not in config.project_ids():
        raise HTTPException(status_code=400, detail="Unknown project.")

    instance = _require_roster_match(
        email, payload.project_id, payload.team_id, datetime.now(timezone.utc)
    )

    answer = consent.decision_for(email)
    # Asked again after a decline, deliberately: a student who said no and later
    # changes their mind would otherwise have no way back in. Consent recorded
    # outside the portal counts, which is why this asks has_consented rather
    # than reading the row directly -- otherwise a student who signed on paper
    # would be asked a second time, and the submission endpoint, which does
    # accept it, would disagree with the screen in front of them.
    needs_consent = not consent.has_consented(email)
    response = {
        "project_id": payload.project_id,
        "team_id": config.team_label_of(instance, payload.project_id),
        "team_instance_id": instance,
        # Usually one entry, and then the portal never asks. More than one means
        # the student changed teams during this project and genuinely has to say
        # which one a submission belongs to.
        "teams": config.team_labels(email, payload.project_id),
        "consent_required": needs_consent,
        "previously_declined": bool(answer and answer["decision"] == consent.DECLINE),
    }
    if needs_consent:
        form = _consent_form_or_503()
        response["consent_form"] = {"text": form["text"], "version": form["version"]}
    else:
        response["repository"] = repository.for_team(
            payload.project_id, response["team_id"]
        )
    return response


@app.post("/api/consent")
def record_consent(payload: ConsentIn, email: str = Depends(current_email)) -> dict:
    """Store what a student answered on the consent form.

    Filed against the signed-in account, so a consent decision cannot be
    recorded -- or withdrawn -- on someone else's behalf.
    """
    if payload.decision not in (consent.AGREE, consent.DECLINE):
        raise HTTPException(status_code=400, detail="Unknown consent decision.")

    form = _consent_form_or_503()
    # The answer is recorded against the wording that was actually on screen. If
    # the form was revised while the student was reading it, the stale version
    # they saw is not what we want on file.
    if payload.form_version != form["version"]:
        raise HTTPException(
            status_code=409,
            detail="The consent form was updated while you were reading it. "
            "Please reload the page and read it again.",
        )

    if payload.decision == consent.AGREE and not payload.is_adult:
        raise HTTPException(
            status_code=400,
            detail="This study is open to students aged 18 or older.",
        )

    answer = consent.record(email, payload.decision, form["version"], payload.is_adult)
    return {"decision": answer["decision"], "recorded_at": answer["recorded_at"]}



@app.post("/api/repository")
def submit_repository(
    payload: RepositoryIn, email: str = Depends(current_email)
) -> dict:
    """Record the team's repository for one project.

    Team-level, so any member can hand it in and a later submission replaces the
    earlier one. Gated exactly like a conversation submission: the roster has to
    place the signed-in student on this project and they have to have consented,
    because this is research data being contributed like any other.
    """
    if payload.project_id not in config.project_ids():
        raise HTTPException(status_code=400, detail="Unknown project.")

    now = datetime.now(timezone.utc)
    instance = _require_roster_match(email, payload.project_id, payload.team_id, now)
    if not consent.has_consented(email):
        raise HTTPException(status_code=403, detail=CONSENT_REQUIRED)

    try:
        stored = repository.record(
            project_id=payload.project_id,
            team_id=config.team_label_of(instance, payload.project_id),
            repo_url=payload.repo_url,
            participant_code=resolve_participant_code(email),
            team_instance_id=instance,
        )
    except repository.InvalidRepositoryURL as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return stored

@app.post("/api/preview", dependencies=[Depends(current_email)])
def preview(payload: PreviewIn) -> dict:
    """Segment pasted text server-side so the preview matches what gets stored.

    Nothing here is stored or attributed, so the caller's address is not needed
    -- but the sign-in is. Without it this is an anonymous endpoint that will
    segment 40 MB of anyone's text, on a service whose page never calls it
    before the student has signed in anyway.
    """
    turns, quality = normalize.segment_text(payload.text)
    if not turns:
        raise HTTPException(status_code=400, detail="Nothing to read in that text.")
    return {
        "turns": turns,
        "turn_count": len(turns),
        "parse_quality": quality,
        "char_count": sum(len(turn["content"]) for turn in turns),
        # Storage caps a single turn, so tell the student now rather than
        # silently keeping a fraction of what they pasted.
        "truncated": any(len(turn["content"]) > normalize.MAX_TURN_CHARS for turn in turns),
    }


@app.post("/api/import-link", dependencies=[Depends(current_email)])
def import_link(payload: ShareLinkIn) -> dict:
    """Read a ChatGPT share link server-side.

    The browser cannot do this itself -- chatgpt.com does not allow a
    cross-origin read -- so the fetch happens here, restricted to share URLs on
    known hosts. Failures are returned as a message telling the student to paste
    instead, because this depends on the shape of someone else's page.

    Sign-in is required even though the result is not stored: this endpoint
    makes an outbound request on the server's behalf, and an anonymous caller
    could use it as a relay with nothing to trace a request back to.
    """
    try:
        return import_share_link(payload.url)
    except ShareImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _resolve_team(email: str, project_id: str, conversation_start, submitted_at):
    """Attribute a conversation to whoever the team was when it happened.

    Team membership is a temporal relation, so the answer depends on *when*. A
    conversation with its own timestamp is placed by that; a pasted one with no
    timestamp falls back to the submission time. Which of the two was used is
    recorded, because a fallback across a mid-project team change is a guess and
    should not read like a fact.
    """
    when = to_utc(conversation_start)
    basis = "conversation_time" if when else "submission_time"
    instance, how = config.lookup_team_instance(
        email, project_id, when or to_utc(submitted_at)
    )
    if instance is None:
        return None, "unknown"
    if how == "ambiguous":
        return instance, "ambiguous"
    return instance, basis


def _validate_choice(value: str, key: str, label: str) -> str:
    if value not in config.allowed_ids(key):
        raise HTTPException(status_code=400, detail=f"Unknown {label}: {value}")
    return value


@app.post("/api/submissions")
def create_submission(
    payload: SubmissionIn, email: str = Depends(current_email)
) -> dict:
    if payload.project_id not in config.project_ids():
        raise HTTPException(status_code=400, detail="Unknown project.")
    _validate_choice(payload.completeness, "completeness_levels", "completeness level")

    now = datetime.now(timezone.utc)
    # Checked again here rather than trusted from the first screen: the form is
    # a convenience, this endpoint is the boundary.
    submission_instance = _require_roster_match(
        email, payload.project_id, payload.team_id, now
    )
    if not consent.has_consented(email):
        raise HTTPException(status_code=403, detail=CONSENT_REQUIRED)
    team_id = config.team_label_of(submission_instance, payload.project_id)

    prepared = []
    for item in payload.conversations:
        _validate_choice(item.platform, "platforms", "platform")
        purpose = (item.primary_purpose or "").strip()
        if purpose:
            _validate_choice(purpose, "primary_purposes", "purpose")
        reported = (item.reported_change or "").strip()
        if reported:
            _validate_choice(reported, "reported_changes", "reported change")

        turns = [turn.model_dump() for turn in item.turns]
        quality = item.parse_quality or "structured"
        if not turns and item.raw_text:
            turns, quality = normalize.segment_text(item.raw_text)
        if not turns:
            raise HTTPException(
                status_code=400,
                detail=f"Conversation '{item.title or item.platform}' has no content.",
            )

        conversation = normalize.build_conversation(
            platform=item.platform,
            title=item.title,
            source_format=item.source_format,
            turns=turns,
            parse_quality=quality,
            conversation_start=item.conversation_start,
            conversation_end=item.conversation_end,
        )
        conversation["platform_other"] = (item.platform_other or "").strip() or None
        conversation["primary_purpose"] = purpose or PURPOSE_UNSPECIFIED
        conversation["reported_change"] = reported or CHANGE_NOT_ASKED

        workspace = item.workspace.model_dump() if item.workspace else {}
        conversation["workspace_cwd"] = workspace.get("cwd")
        conversation["workspace_repo_url"] = workspace.get("repo_url")
        conversation["workspace_branch"] = workspace.get("branch")
        conversation["workspace_commit"] = workspace.get("commit_hash")
        conversation["tool_origin"] = workspace.get("tool_origin")
        conversation["models"] = ",".join(dict.fromkeys(m for m in item.models if m)) or None
        conversation["tool_version"] = item.tool_version
        conversation["source_session_id"] = (item.source_session_id or "").strip() or None
        conversation["source_url"] = (item.source_url or "").strip() or None
        conversation["metadata_json"] = json.dumps(item.metadata, ensure_ascii=False) if item.metadata else None
        instance, assignment = _resolve_team(
            email, payload.project_id, conversation["conversation_start"], now
        )
        conversation["team_instance_id"] = instance
        conversation["team_assignment"] = assignment
        conversation["ai_edits"] = [
            {
                "path": edit.path,
                "change_type": edit.change_type or "edit",
                "occurred_at": normalize.normalize_timestamp(edit.ts),
                "patch": (edit.patch or "")[:MAX_PATCH_CHARS] or None,
            }
            for edit in item.ai_edits
        ]
        prepared.append(conversation)

    participant_code = resolve_participant_code(email)
    submission_id = f"SUB-{uuid.uuid4().hex[:12].upper()}"
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    stored, updated, duplicates = 0, 0, 0
    with research_db() as conn:
        conn.execute(
            "INSERT INTO submissions (submission_id, participant_code, project_id, "
            "team_id, completeness, submitted_at, client_note, team_instance_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                submission_id,
                participant_code,
                payload.project_id,
                team_id,
                payload.completeness,
                now,
                None,
                submission_instance,
            ),
        )

        for conversation in prepared:
            # Identity is the tool's own session id where one exists. A session
            # keeps growing after a mid-project submission, so hashing its text
            # would file the same session twice -- the second copy containing the
            # first -- and double every turn count and edit derived from it.
            session_id = conversation["source_session_id"]
            existing = None
            if session_id:
                existing = conn.execute(
                    "SELECT conversation_id, turn_count, content_hash FROM conversations "
                    "WHERE participant_code = ? AND project_id = ? AND source_session_id = ?",
                    (participant_code, payload.project_id, session_id),
                ).fetchone()
                if existing and (
                    existing["content_hash"] == conversation["content_hash"]
                    or conversation["turn_count"] < existing["turn_count"]
                ):
                    # Unchanged since last time, or an older bundle arriving late
                    # that would shrink what is already stored. Either way, the
                    # student is told "already on file" rather than "updated".
                    duplicates += 1
                    continue
            elif conn.execute(
                "SELECT 1 FROM conversations WHERE participant_code = ? "
                "AND project_id = ? AND content_hash = ?",
                (participant_code, payload.project_id, conversation["content_hash"]),
            ).fetchone():
                # Pasted text carries no session id; fall back to its content.
                duplicates += 1
                continue

            if existing:
                conversation_id = existing["conversation_id"]
                conn.execute(
                    "DELETE FROM conversation_edits WHERE conversation_id = ?", (conversation_id,)
                )
                conn.execute("DELETE FROM turns WHERE conversation_id = ?", (conversation_id,))
                conn.execute(
                    "UPDATE conversations SET submission_id = ?, team_id = ?, platform = ?, "
                    "platform_other = ?, title = ?, source_format = ?, parse_quality = ?, "
                    "primary_purpose = ?, reported_change = ?, conversation_start = ?, "
                    "conversation_end = ?, turn_count = ?, char_count = ?, content_hash = ?, "
                    "workspace_cwd = ?, workspace_repo_url = ?, workspace_branch = ?, "
                    "workspace_commit = ?, tool_origin = ?, models = ?, tool_version = ?, "
                    "metadata_json = ?, team_instance_id = ?, team_assignment = ? "
                    "WHERE conversation_id = ?",
                    (
                        submission_id,
                        team_id,
                        conversation["platform"],
                        conversation["platform_other"],
                        conversation["title"],
                        conversation["source_format"],
                        conversation["parse_quality"],
                        conversation["primary_purpose"],
                        conversation["reported_change"],
                        conversation["conversation_start"],
                        conversation["conversation_end"],
                        conversation["turn_count"],
                        conversation["char_count"],
                        conversation["content_hash"],
                        conversation["workspace_cwd"],
                        conversation["workspace_repo_url"],
                        conversation["workspace_branch"],
                        conversation["workspace_commit"],
                        conversation["tool_origin"],
                        conversation["models"],
                        conversation["tool_version"],
                        conversation["metadata_json"],
                        conversation["team_instance_id"],
                        conversation["team_assignment"],
                        conversation_id,
                    ),
                )
                updated += 1
            else:
                conversation_id = f"C-{uuid.uuid4().hex[:12].upper()}"
                conn.execute(
                "INSERT INTO conversations (conversation_id, submission_id, "
                "participant_code, project_id, team_id, platform, platform_other, title, "
                "source_format, parse_quality, primary_purpose, reported_change, "
                "conversation_start, conversation_end, turn_count, char_count, content_hash, "
                "workspace_cwd, workspace_repo_url, workspace_branch, workspace_commit, "
                "tool_origin, models, tool_version, metadata_json, team_instance_id, "
                "team_assignment, source_session_id, source_url) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    submission_id,
                    participant_code,
                    payload.project_id,
                    team_id,
                    conversation["platform"],
                    conversation["platform_other"],
                    conversation["title"],
                    conversation["source_format"],
                    conversation["parse_quality"],
                    conversation["primary_purpose"],
                    conversation["reported_change"],
                    conversation["conversation_start"],
                    conversation["conversation_end"],
                    conversation["turn_count"],
                    conversation["char_count"],
                    conversation["content_hash"],
                    conversation["workspace_cwd"],
                    conversation["workspace_repo_url"],
                    conversation["workspace_branch"],
                    conversation["workspace_commit"],
                    conversation["tool_origin"],
                    conversation["models"],
                    conversation["tool_version"],
                    conversation["metadata_json"],
                    conversation["team_instance_id"],
                    conversation["team_assignment"],
                    conversation["source_session_id"],
                    conversation["source_url"],
                ),
            )
                stored += 1

            conn.executemany(
                "INSERT INTO turns (conversation_id, turn_id, role, timestamp, "
                "content, char_count, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        conversation_id,
                        turn["turn_id"],
                        turn["role"],
                        turn["timestamp"],
                        turn["content"],
                        len(turn["content"]),
                        turn.get("model"),
                    )
                    for turn in conversation["turns"]
                ],
            )
            conn.executemany(
                "INSERT INTO conversation_edits (conversation_id, path, change_type, "
                "occurred_at, patch) VALUES (?, ?, ?, ?, ?)",
                [
                    (
                        conversation_id,
                        edit["path"],
                        edit["change_type"],
                        edit["occurred_at"],
                        edit["patch"],
                    )
                    for edit in conversation["ai_edits"]
                ],
            )

    return {
        "submission_id": submission_id,
        "project_id": payload.project_id,
        "team_id": team_id,
        "team_instance_id": submission_instance,
        "conversations_stored": stored,
        "conversations_updated": updated,
        "duplicates_skipped": duplicates,
        "submitted_at": now,
    }


app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
