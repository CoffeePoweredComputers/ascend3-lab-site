import pytest
from fastapi.testclient import TestClient

from app import auth
from app.db import identity_db, research_db
from app.main import app


# ---------------------------------------------------------------- sign-in ----
#
# Identity left the request body and became a Firebase ID token. The tests still
# have to say *which* student is acting, and around forty of them already say it
# with an "email" key in the body. Rather than rewrite them all, the client below
# lifts that address out and presents it the way a browser now would -- as a
# bearer token -- so the code under test sees exactly what production sees.

TEST_TOKEN_PREFIX = "test:"


def fake_verify_id_token(token: str) -> str:
    """Stand in for Google's signature check, and for nothing else.

    This replaces precisely the step that needs Google's public keys. Header
    parsing, the VT-domain rule in normalize_email, and every refusal path in
    the endpoints remain the real ones, so these tests still exercise the
    identity boundary rather than stepping around it. The verification itself is
    covered against real RSA signatures in tests/test_auth.py.
    """
    if not token.startswith(TEST_TOKEN_PREFIX):
        raise auth.InvalidToken("That sign-in could not be verified.")
    return token[len(TEST_TOKEN_PREFIX) :]


class SignedInClient(TestClient):
    """A client that reads a body's "email" as "who is signed in"."""

    def request(self, method, url, **kwargs):
        body = kwargs.get("json")
        if isinstance(body, dict) and "email" in body:
            body = dict(body)
            email = body.pop("email")
            kwargs["json"] = body
            headers = dict(kwargs.get("headers") or {})
            headers.setdefault("Authorization", f"Bearer {TEST_TOKEN_PREFIX}{email}")
            kwargs["headers"] = headers
        return super().request(method, url, **kwargs)


client = SignedInClient(app)


@pytest.fixture(autouse=True)
def stub_token_verification(monkeypatch):
    monkeypatch.setattr(auth, "verify_id_token", fake_verify_id_token)


def submission_body(email="s905123456@vt.edu", **overrides):
    body = {
        "email": email,
        "project_id": "P2",
        "team_id": "T12",
        "completeness": "pct_61_80",
        "conversations": [
            {
                "platform": "claude",
                "title": "Designing Bag<T>",
                "source_format": "claude_export",
                "parse_quality": "structured",
                "primary_purpose": "design",
                "reported_change": "implementation",
                "turns": [
                    {"role": "human", "content": "How should Bag<T> store items?",
                     "timestamp": "2026-10-13T14:22:00"},
                    {"role": "assistant", "content": "Use a resizable array.",
                     "timestamp": "2026-10-13T14:57:00"},
                ],
            }
        ],
    }
    body.update(overrides)
    return body



# Every request in this file depends on a roster: submission is gated on the
# (email, team) pair agreeing with it. Reading the machine's real
# config/roster.csv would make these tests pass or fail depending on who happens
# to be enrolled locally -- which has already broken one of them once -- so the
# tests own their roster instead.
# Add the address here as well when a new test invents one, or its request will
# be turned away by the roster check with a confusing KeyError downstream.
ROSTER_EMAILS = [
    "s905010203@vt.edu",
    "s905040506@vt.edu",
    "s905070809@vt.edu",
    "s905101112@vt.edu",
    "s905111222@vt.edu",
    "s905121212@vt.edu",
    "s905123456@vt.edu",
    "s905131313@vt.edu",
    "s905141414@vt.edu",
    "s905151515@vt.edu",
    "s905161616@vt.edu",
    "s905171717@vt.edu",
    "s905181818@vt.edu",
    "s905191919@vt.edu",
    "s905202020@vt.edu",
    "s905222333@vt.edu",
    "s905333444@vt.edu",
    "s905444555@vt.edu",
    "s905666777@vt.edu",
    "s905888999@vt.edu",
]


# Stands in for the IRB-approved wording. The real config/consent_form.md ships
# as a draft and the server refuses to serve it, which is the point of that
# guard -- so the tests supply their own approved-looking text.
TEST_CONSENT_FORM = "# Consent\n\nThis is the wording used by the tests.\n"


@pytest.fixture(autouse=True)
def isolated_roster(tmp_path, monkeypatch):
    from app import config, consent
    from app.db import identity_db

    rows = ["email,project_id,team_instance_id,joined_at,left_at"]
    for email in ROSTER_EMAILS:
        for project_id in ("P1", "P2", "P3"):
            rows.append(f"{email},{project_id},{project_id}_T12,2026-08-01,")

    roster = tmp_path / "roster.csv"
    roster.write_text("\n".join(rows) + "\n", encoding="utf-8")
    monkeypatch.setattr(config, "ROSTER_CSV", roster)
    config.roster.cache_clear()

    form = tmp_path / "consent_form.md"
    form.write_text(TEST_CONSENT_FORM, encoding="utf-8")
    monkeypatch.setattr(consent, "CONSENT_FORM_MD", form)
    consent.form.cache_clear()

    # Most tests are about something other than consent, so they start from a
    # class that has already agreed. One transaction, not one per student.
    now = "2026-08-01T00:00:00+00:00"
    version = consent.form()["version"]
    with identity_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            "INSERT INTO consent_records (email, decision, form_version, recorded_at, "
            "updated_at, is_adult) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(email) DO UPDATE SET "
            "decision = excluded.decision, form_version = excluded.form_version, "
            "is_adult = excluded.is_adult",
            [(email, consent.AGREE, version, now, now) for email in ROSTER_EMAILS],
        )

    yield
    config.roster.cache_clear()
    consent.form.cache_clear()


def test_config_lists_every_form_option():
    payload = client.get("/api/config").json()
    assert {"P1", "P2", "P3"} <= {project["id"] for project in payload["projects"]}
    assert "claude_code" in {platform["id"] for platform in payload["platforms"]}
    assert len(payload["completeness_levels"]) == 5


@pytest.mark.parametrize(
    "bad_email",
    [
        "",
        "not an email",
        "hokie@",
        "@vt.edu",
        "hokie@gmail.com",
        "hokie@notvt.edu",
    ],
)
def test_a_token_whose_address_we_refuse_is_not_a_session(bad_email):
    """401, not 400: the address is no longer something a student can type.

    app/auth.py rejects these against Google's own claims first. This covers the
    layer behind it -- current_email runs the same VT-domain rule over whatever
    a token asserts, so a project that ever loosened the Firebase side would
    still not let a personal address through.
    """
    response = client.post("/api/session/start", json={"email": bad_email, "project_id": "P2"})
    assert response.status_code == 401


@pytest.mark.parametrize(
    "path,body",
    [
        ("/api/session/start", {"project_id": "P2"}),
        ("/api/consent", {"decision": "agree", "form_version": "x", "is_adult": True}),
        ("/api/repository", {"project_id": "P2", "repo_url": "https://github.com/a/b"}),
        ("/api/submissions", {"project_id": "P2", "completeness": "pct_61_80",
                              "conversations": [{"platform": "claude"}]}),
        # These two store nothing, which is how they came to be left off the
        # list: one segments up to 40 MB of text, the other fetches a URL on
        # the server's behalf. Neither is anything to hand an anonymous caller.
        ("/api/preview", {"text": "You: hi\nClaude: hello"}),
        ("/api/import-link", {"url": "https://chatgpt.com/share/0000"}),
    ],
)
def test_every_student_endpoint_refuses_an_anonymous_caller(path, body):
    """No token, no session -- checked one endpoint at a time.

    The dependency is shared, so this is really asking whether anyone forgot to
    depend on it. That is exactly the mistake worth a test: the endpoint would
    work perfectly in a browser and be wide open to curl.
    """
    assert client.post(path, json=body).status_code == 401


@pytest.mark.parametrize(
    "header",
    ["", "Bearer", "Bearer    ", "test:s905123456@vt.edu", "Basic dGVzdA==",
     "Bearerest:s905123456@vt.edu"],
)
def test_a_malformed_authorization_header_is_not_a_session(header):
    response = client.post(
        "/api/session/start",
        json={"project_id": "P2"},
        headers={"Authorization": header},
    )
    assert response.status_code == 401


def test_a_signed_in_student_who_is_not_on_the_roster_is_refused():
    """403, and told so plainly.

    The old message folded this together with "wrong team" so that typing
    addresses could not be used to discover who was enrolled. A caller who has
    signed in has already proved they own the address, so naming their own
    absence tells them nothing about anybody else.
    """
    response = client.post(
        "/api/session/start", json={"email": "stranger@vt.edu", "project_id": "P2"}
    )

    assert response.status_code == 403
    assert "roster" in response.json()["detail"]


def test_session_start_accepts_formatting_students_type():
    response = client.post(
        "/api/session/start",
        json={"email": " S905123456@VT.edu ", "project_id": "P2", "team_id": "t12"},
    )

    assert response.status_code == 200
    # Surrounding space and capitals are forgiven on both fields; the pair still
    # has to be one the roster holds.
    assert response.json()["team_id"] == "T12"


def test_a_vt_subdomain_address_is_accepted(tmp_path, monkeypatch):
    """Departments hand out cs.vt.edu addresses; those are still VT."""
    write_roster(tmp_path, monkeypatch, ["grad@cs.vt.edu,P2,P2_T12,2026-08-01,\n"])

    response = client.post(
        "/api/session/start",
        json={"email": "grad@cs.vt.edu", "project_id": "P2", "team_id": "T12"},
    )

    assert response.status_code == 200

    from app import config

    config.roster.cache_clear()


def test_preview_segments_pasted_text():
    payload = client.post(
        "/api/preview",
        json={
            "email": "s905123456@vt.edu",
            "text": "You: why does remove() fail?\nClaude: the index is off by one.",
        },
    ).json()
    assert payload["turn_count"] == 2
    assert payload["parse_quality"] == "heuristic"


def test_submission_stores_conversation_under_a_participant_code():
    response = client.post("/api/submissions", json=submission_body())
    assert response.status_code == 200
    result = response.json()
    assert result["conversations_stored"] == 1
    assert result["submission_id"].startswith("SUB-")

    with research_db() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE submission_id = ?", (result["submission_id"],)
        ).fetchone()
    assert row["participant_code"].startswith("S")
    assert row["turn_count"] == 2
    assert row["conversation_start"] == "2026-10-13T14:22:00"


def test_the_students_identity_never_reaches_the_research_database():
    """The property the two-database split exists for, asserted directly."""
    email = "s905222333@vt.edu"
    client.post("/api/submissions", json=submission_body(email=email))

    with research_db() as conn:
        tables = [
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        ]
        for table in tables:
            dumped = str(conn.execute(f"SELECT * FROM {table}").fetchall())
            assert email not in dumped
            assert "905222333" not in dumped, "nor the identifying part of it"

    with identity_db() as conn:
        assert conn.execute(
            "SELECT 1 FROM identities WHERE email = ?", (email,)
        ).fetchone()


def test_participant_code_is_stable_across_submissions():
    client.post("/api/submissions", json=submission_body(email="s905444555@vt.edu"))
    client.post("/api/submissions", json=submission_body(email="s905444555@vt.edu", project_id="P3"))

    with research_db() as conn:
        codes = {
            row["participant_code"]
            for row in conn.execute(
                "SELECT participant_code FROM submissions WHERE project_id IN ('P2','P3')"
            ).fetchall()
        }
    with identity_db() as conn:
        code = conn.execute(
            "SELECT participant_code FROM identities WHERE email = ?", ("s905444555@vt.edu",)
        ).fetchone()["participant_code"]
    assert code in codes


def test_resubmitting_the_same_conversation_is_deduplicated():
    client.post("/api/submissions", json=submission_body(email="s905666777@vt.edu"))
    second = client.post("/api/submissions", json=submission_body(email="s905666777@vt.edu")).json()

    assert second["conversations_stored"] == 0
    assert second["duplicates_skipped"] == 1


def test_raw_text_conversations_are_segmented_server_side():
    body = submission_body(email="s905888999@vt.edu")
    body["conversations"] = [
        {
            "platform": "cursor",
            "source_format": "paste",
            "primary_purpose": "debugging",
            "reported_change": "testing",
            "turns": [],
            "raw_text": "You: JUnit edge cases?\nCursor: test the empty bag first.",
        }
    ]
    result = client.post("/api/submissions", json=body).json()
    assert result["conversations_stored"] == 1

    with research_db() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE submission_id = ?", (result["submission_id"],)
        ).fetchone()
    assert row["turn_count"] == 2
    assert row["parse_quality"] == "heuristic"


def agentic_body(email="s905010203@vt.edu"):
    """What the browser sends after parsing a Claude Code / Codex session."""
    body = submission_body(email=email)
    body["conversations"] = [
        {
            "platform": "codex",
            "title": "move validation out of Main",
            "source_format": "codex",
            "parse_quality": "structured",
            "primary_purpose": "implementation",
            "reported_change": "implementation",
            "turns": [
                {"role": "user", "content": "move validation out of Main",
                 "timestamp": "2026-10-13T14:02:00Z"},
                {"role": "assistant", "content": "Added InputValidator.",
                 "timestamp": "2026-10-13T14:04:00Z", "model": "gpt-5.1-codex-max"},
            ],
            "workspace": {
                "cwd": "/Users/s/team12-p2",
                "repo_url": "https://github.com/vt/team12-p2.git",
                "branch": "main",
                "commit_hash": "ad30778",
                "tool_origin": "codex_vscode",
            },
            "ai_edits": [
                {"path": "src/InputValidator.java", "change_type": "A",
                 "patch": "+public class InputValidator {}", "ts": "2026-10-13T14:03:00Z"},
                {"path": "src/Main.java", "change_type": "M", "patch": "-old\n+new",
                 "ts": "2026-10-13T14:03:00Z"},
            ],
            "models": ["gpt-5.1-codex-max"],
            "tool_version": "0.61.1",
            "metadata": {"effort_levels": ["medium"], "model_provider": "openai"},
        }
    ]
    return body


def test_workspace_context_is_stored():
    result = client.post("/api/submissions", json=agentic_body()).json()

    with research_db() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE submission_id = ?", (result["submission_id"],)
        ).fetchone()

    assert row["workspace_repo_url"] == "https://github.com/vt/team12-p2.git"
    assert row["workspace_branch"] == "main"
    assert row["workspace_commit"] == "ad30778"
    assert row["tool_origin"] == "codex_vscode"
    assert row["models"] == "gpt-5.1-codex-max"
    assert row["tool_version"] == "0.61.1"
    assert "model_provider" in row["metadata_json"]


def test_ai_edits_round_trip_with_their_patches():
    result = client.post("/api/submissions", json=agentic_body(email="s905040506@vt.edu")).json()

    with research_db() as conn:
        conversation_id = conn.execute(
            "SELECT conversation_id FROM conversations WHERE submission_id = ?",
            (result["submission_id"],),
        ).fetchone()["conversation_id"]
        edits = conn.execute(
            "SELECT * FROM conversation_edits WHERE conversation_id = ? ORDER BY path",
            (conversation_id,),
        ).fetchall()

    assert [(edit["path"], edit["change_type"]) for edit in edits] == [
        ("src/InputValidator.java", "A"),
        ("src/Main.java", "M"),
    ]
    assert "InputValidator" in edits[0]["patch"]
    assert edits[0]["occurred_at"] == "2026-10-13T14:03:00+00:00"


def test_per_turn_model_is_stored():
    result = client.post("/api/submissions", json=agentic_body(email="s905070809@vt.edu")).json()

    with research_db() as conn:
        rows = conn.execute(
            "SELECT t.role, t.model FROM turns t JOIN conversations c "
            "ON c.conversation_id = t.conversation_id WHERE c.submission_id = ? ORDER BY t.turn_id",
            (result["submission_id"],),
        ).fetchall()

    assert [(row["role"], row["model"]) for row in rows] == [
        ("user", None),
        ("assistant", "gpt-5.1-codex-max"),
    ]


def test_chat_conversations_leave_the_new_columns_empty():
    result = client.post("/api/submissions", json=submission_body(email="s905101112@vt.edu")).json()

    with research_db() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE submission_id = ?", (result["submission_id"],)
        ).fetchone()
        edits = conn.execute(
            "SELECT count(*) c FROM conversation_edits WHERE conversation_id = ?",
            (row["conversation_id"],),
        ).fetchone()["c"]

    assert row["workspace_repo_url"] is None
    assert row["tool_origin"] is None
    assert edits == 0


def test_config_exposes_a_project_date_window():
    projects = {p["id"]: p for p in client.get("/api/config").json()["projects"]}

    window = projects["P2"]["window"]
    assert window["start"] and window["end"]
    # P2 starts where P1's last deadline sits, and runs a week past its own.
    assert window["start"].startswith("2026-10-06")
    assert window["end"].startswith("2026-11-17")


def test_codex_is_an_offered_platform():
    platforms = {p["id"] for p in client.get("/api/config").json()["platforms"]}
    assert {"codex", "claude_code", "copilot"} <= platforms


def test_unknown_option_values_are_rejected():
    body = submission_body(email="s905111222@vt.edu")
    body["conversations"][0]["primary_purpose"] = "vibes"
    assert client.post("/api/submissions", json=body).status_code == 400


def test_empty_conversation_is_rejected():
    body = submission_body(email="s905333444@vt.edu")
    body["conversations"][0]["turns"] = []
    assert client.post("/api/submissions", json=body).status_code == 400


# --- re-submitting a session that kept growing ---------------------------------

def session_body(email, turns, session_id="sess-1", edits=1):
    body = submission_body(email=email)
    body["conversations"] = [
        {
            "platform": "claude_code",
            "title": "Designing validation",
            "source_format": "claude_code",
            "parse_quality": "structured",
            "primary_purpose": "implementation",
            "reported_change": "implementation",
            "source_session_id": session_id,
            "turns": [
                {"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i}",
                 "timestamp": f"2026-10-13T14:{i:02d}:00Z"}
                for i in range(turns)
            ],
            "ai_edits": [
                {"path": f"src/File{i}.java", "change_type": "edit", "patch": "+x", "ts": None}
                for i in range(edits)
            ],
        }
    ]
    return body


def conversations_for(submission_id):
    with research_db() as conn:
        row = conn.execute(
            "SELECT participant_code FROM submissions WHERE submission_id = ?", (submission_id,)
        ).fetchone()
        rows = conn.execute(
            "SELECT * FROM conversations WHERE participant_code = ? AND source_session_id = 'sess-1'",
            (row["participant_code"],),
        ).fetchall()
    return rows


def test_a_grown_session_updates_instead_of_filing_a_second_copy():
    first = client.post("/api/submissions", json=session_body("s905121212@vt.edu", turns=4)).json()
    second = client.post("/api/submissions", json=session_body("s905121212@vt.edu", turns=9, edits=3)).json()

    assert first["conversations_stored"] == 1
    assert second["conversations_stored"] == 0
    assert second["conversations_updated"] == 1

    rows = conversations_for(second["submission_id"])
    assert len(rows) == 1, "the same session must not occupy two rows"
    assert rows[0]["turn_count"] == 9


def test_the_update_replaces_turns_and_edits_rather_than_appending():
    result = client.post("/api/submissions", json=session_body("s905131313@vt.edu", turns=4, edits=1)).json()
    client.post("/api/submissions", json=session_body("s905131313@vt.edu", turns=9, edits=3))

    with research_db() as conn:
        conversation_id = conversations_for(result["submission_id"])[0]["conversation_id"]
        turns = conn.execute(
            "SELECT count(*) c FROM turns WHERE conversation_id = ?", (conversation_id,)
        ).fetchone()["c"]
        edits = conn.execute(
            "SELECT count(*) c FROM conversation_edits WHERE conversation_id = ?", (conversation_id,)
        ).fetchone()["c"]

    assert (turns, edits) == (9, 3)


def test_an_older_bundle_arriving_late_does_not_shrink_the_record():
    client.post("/api/submissions", json=session_body("s905141414@vt.edu", turns=9))
    late = client.post("/api/submissions", json=session_body("s905141414@vt.edu", turns=4)).json()

    assert late["conversations_updated"] == 0
    assert late["duplicates_skipped"] == 1
    assert conversations_for(late["submission_id"])[0]["turn_count"] == 9


def test_an_identical_resubmission_is_still_a_duplicate():
    client.post("/api/submissions", json=session_body("s905151515@vt.edu", turns=4))
    again = client.post("/api/submissions", json=session_body("s905151515@vt.edu", turns=4)).json()

    assert again["duplicates_skipped"] == 1
    assert again["conversations_updated"] == 0


def test_pasted_conversations_without_a_session_id_still_dedupe_by_content():
    client.post("/api/submissions", json=submission_body(email="s905161616@vt.edu"))
    again = client.post("/api/submissions", json=submission_body(email="s905161616@vt.edu")).json()

    assert again["duplicates_skipped"] == 1


def test_the_collector_script_is_served():
    response = client.get("/collect_ai_logs.py")

    assert response.status_code == 200
    assert response.text.startswith("#!/usr/bin/env python3")


# --- annotations are optional --------------------------------------------------

def test_a_conversation_can_be_submitted_with_no_annotations():
    body = submission_body(email="s905171717@vt.edu")
    body["conversations"][0].pop("primary_purpose")
    body["conversations"][0].pop("reported_change")

    result = client.post("/api/submissions", json=body)

    assert result.status_code == 200
    assert result.json()["conversations_stored"] == 1


def test_the_two_unanswered_cases_are_recorded_differently():
    """"Skipped" and "no longer asked" must not collapse into one value.

    A dataset spanning the change would otherwise be unanalysable: purpose is
    still offered and may be declined, while the change question is gone.
    """
    body = submission_body(email="s905181818@vt.edu")
    body["conversations"][0].pop("primary_purpose")
    body["conversations"][0].pop("reported_change")
    result = client.post("/api/submissions", json=body).json()

    with research_db() as conn:
        row = conn.execute(
            "SELECT primary_purpose, reported_change FROM conversations WHERE submission_id = ?",
            (result["submission_id"],),
        ).fetchone()

    assert row["primary_purpose"] == "unspecified"
    assert row["reported_change"] == "not_asked"


def test_a_purpose_that_is_given_is_still_kept_and_validated():
    body = submission_body(email="s905191919@vt.edu")
    body["conversations"][0]["primary_purpose"] = "debugging"
    result = client.post("/api/submissions", json=body).json()

    with research_db() as conn:
        row = conn.execute(
            "SELECT primary_purpose FROM conversations WHERE submission_id = ?",
            (result["submission_id"],),
        ).fetchone()
    assert row["primary_purpose"] == "debugging"

    bad = submission_body(email="s905202020@vt.edu")
    bad["conversations"][0]["primary_purpose"] = "vibes"
    assert client.post("/api/submissions", json=bad).status_code == 400


# ---------- the (student ID, team) gate ----------
#
# There is no login. The pair is what stands between a mistyped student ID and a
# submission filed under somebody else, so these pin down exactly what it does
# and does not stop.


def write_roster(tmp_path, monkeypatch, rows):
    from app import config

    roster = tmp_path / "roster.csv"
    roster.write_text(
        "email,project_id,team_instance_id,joined_at,left_at\n" + "".join(rows),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "ROSTER_CSV", roster)
    config.roster.cache_clear()


def test_a_matching_pair_is_let_through():
    response = client.post(
        "/api/session/start",
        json={"email": "s905123456@vt.edu", "project_id": "P2", "team_id": "T12"},
    )

    assert response.status_code == 200
    assert response.json()["team_instance_id"] == "P2_T12"


def test_a_real_address_with_the_wrong_team_is_turned_away():
    """The case the pair exists for: an ID typed one digit off lands elsewhere."""
    response = client.post(
        "/api/session/start",
        json={"email": "s905123456@vt.edu", "project_id": "P2", "team_id": "T99"},
    )

    assert response.status_code == 400


def test_a_student_the_roster_does_not_know_is_turned_away():
    response = client.post(
        "/api/session/start",
        json={"email": "s905999999@vt.edu", "project_id": "P2", "team_id": "T12"},
    )

    assert response.status_code == 400


def test_the_two_refusals_are_indistinguishable():
    """Separate messages would confirm which student IDs are on the roster."""
    wrong_team = client.post(
        "/api/session/start",
        json={"email": "s905123456@vt.edu", "project_id": "P2", "team_id": "T99"},
    ).json()
    unknown_student = client.post(
        "/api/session/start",
        json={"email": "s905999999@vt.edu", "project_id": "P2", "team_id": "T12"},
    ).json()

    assert wrong_team["detail"] == unknown_student["detail"]


def test_the_submission_endpoint_checks_the_pair_itself():
    """The first screen is a convenience; this endpoint is the boundary."""
    response = client.post(
        "/api/submissions", json=submission_body(email="s905123456@vt.edu", team_id="T99")
    )

    assert response.status_code == 400


def test_a_missing_team_is_answered_by_the_roster():
    """Omitting the team is now legitimate, and cannot be used to reach another.

    It used to be a 400: the typed team was the check that made a borrowed
    address fail. Identity is signed for now, so the roster can simply be asked
    -- and asked about the signed-in student, which is the reason this is safe.
    A caller who sends nothing gets their own team, never a choice of one.
    """
    for missing in (None, "", "   "):
        response = client.post(
            "/api/submissions", json=submission_body(email="s905123456@vt.edu", team_id=missing)
        )
        assert response.status_code == 200, missing
        assert response.json()["team_id"] == "T12", missing


def test_either_side_of_a_mid_project_team_change_is_accepted(tmp_path, monkeypatch):
    """A student who moved teams may be submitting work from before the move."""
    write_roster(
        tmp_path,
        monkeypatch,
        [
            "s905123456@vt.edu,P2,P2_T08a,2026-09-28,2026-10-12\n",
            "s905123456@vt.edu,P2,P2_T20,2026-10-13,\n",
        ],
    )

    for team in ("T08", "T20"):
        response = client.post(
            "/api/session/start",
            json={"email": "s905123456@vt.edu", "project_id": "P2", "team_id": team},
        )
        assert response.status_code == 200, team

    from app import config

    config.roster.cache_clear()


def test_a_team_from_another_project_does_not_open_this_one(tmp_path, monkeypatch):
    write_roster(tmp_path, monkeypatch, ["s905123456@vt.edu,P2,P2_T12,2026-08-01,\n"])

    response = client.post(
        "/api/session/start",
        json={"email": "s905123456@vt.edu", "project_id": "P3", "team_id": "T12"},
    )

    assert response.status_code == 400

    from app import config

    config.roster.cache_clear()


# ---------- consent ----------
#
# The protocol says the portal presents the consent information before any
# research data are collected, and enrolls only students who affirmatively
# consent. These pin down that this is true of the endpoint and not only of the
# screen.


def clear_consent(*emails):
    with identity_db() as conn:
        conn.executemany(
            "DELETE FROM consent_records WHERE email = ?", [(email,) for email in emails]
        )


def test_a_student_who_has_not_answered_is_shown_the_form_first():
    clear_consent("s905010203@vt.edu")

    body = client.post(
        "/api/session/start",
        json={"email": "s905010203@vt.edu", "project_id": "P2", "team_id": "T12"},
    ).json()

    assert body["consent_required"] is True
    assert body["previously_declined"] is False
    assert TEST_CONSENT_FORM.strip() in body["consent_form"]["text"]
    assert body["consent_form"]["version"]


def test_a_student_who_has_agreed_goes_straight_through():
    body = client.post(
        "/api/session/start",
        json={"email": "s905010203@vt.edu", "project_id": "P2", "team_id": "T12"},
    ).json()

    assert body["consent_required"] is False
    assert "consent_form" not in body, "no reason to send the text again"


def test_agreeing_records_the_wording_that_was_on_screen(tmp_path, monkeypatch):
    """"They consented" is a weaker record than "they consented to this text"."""
    from app import consent

    clear_consent("s905040506@vt.edu")
    version = consent.form()["version"]

    response = client.post(
        "/api/consent",
        json={
            "email": "s905040506@vt.edu",
            "decision": "agree",
            "is_adult": True,
            "form_version": version,
        },
    )

    assert response.status_code == 200
    stored = consent.decision_for("s905040506@vt.edu")
    assert (stored["decision"], stored["form_version"]) == ("agree", version)


def test_an_answer_to_a_stale_version_of_the_form_is_refused():
    response = client.post(
        "/api/consent",
        json={
            "email": "s905040506@vt.edu",
            "decision": "agree",
            "is_adult": True,
            "form_version": "outdated",
        },
    )

    assert response.status_code == 409


def test_declining_is_recorded_rather_than_left_blank():
    """Absence and refusal gate the same way, but they are not the same fact."""
    from app import consent

    clear_consent("s905070809@vt.edu")
    client.post(
        "/api/consent",
        json={
            "email": "s905070809@vt.edu",
            "decision": "decline",
            "is_adult": True,
            "form_version": consent.form()["version"],
        },
    )

    assert consent.decision_for("s905070809@vt.edu")["decision"] == "decline"


def test_a_student_who_declined_is_asked_again_rather_than_locked_out():
    """Someone who said no and changes their mind needs a way back in."""
    from app import consent

    clear_consent("s905070809@vt.edu")
    client.post(
        "/api/consent",
        json={
            "email": "s905070809@vt.edu",
            "decision": "decline",
            "is_adult": True,
            "form_version": consent.form()["version"],
        },
    )

    body = client.post(
        "/api/session/start",
        json={"email": "s905070809@vt.edu", "project_id": "P2", "team_id": "T12"},
    ).json()

    assert body["consent_required"] is True
    assert body["previously_declined"] is True
    assert body["consent_form"]["text"]


def test_a_submission_without_consent_is_refused_by_the_endpoint():
    """The screen is a convenience; this is the boundary."""
    clear_consent("s905101112@vt.edu")

    response = client.post(
        "/api/submissions", json=submission_body(email="s905101112@vt.edu")
    )

    assert response.status_code == 403


def test_a_submission_after_declining_is_refused_too():
    from app import consent

    clear_consent("s905111222@vt.edu")
    client.post(
        "/api/consent",
        json={
            "email": "s905111222@vt.edu",
            "decision": "decline",
            "is_adult": True,
            "form_version": consent.form()["version"],
        },
    )

    response = client.post(
        "/api/submissions", json=submission_body(email="s905111222@vt.edu")
    )

    assert response.status_code == 403


def test_an_unfilled_consent_form_is_never_shown_to_a_student(tmp_path, monkeypatch):
    """The guard that matters: a draft must not reach anyone.

    config/consent_form.md ships with [PI TO COMPLETE:] markers in it. Serving
    that as though it were the approved document is not a cosmetic bug.
    """
    from app import consent

    draft = tmp_path / "draft.md"
    draft.write_text(
        "# Consent\n\nPrincipal Investigator: [PI TO COMPLETE: name]\n", encoding="utf-8"
    )
    monkeypatch.setattr(consent, "CONSENT_FORM_MD", draft)
    consent.form.cache_clear()
    clear_consent("s905131313@vt.edu")

    response = client.post(
        "/api/session/start",
        json={"email": "s905131313@vt.edu", "project_id": "P2", "team_id": "T12"},
    )

    assert response.status_code == 503
    assert "instructor" in response.json()["detail"]
    consent.form.cache_clear()


# ---------- the team's repository ----------


def test_a_repository_link_is_recorded_for_the_team():
    response = client.post(
        "/api/repository",
        json={
            "email": "s905171717@vt.edu",
            "project_id": "P2",
            "team_id": "T12",
            "repo_url": "https://github.com/vt-cs2114-f26/team12-project2",
        },
    )

    assert response.status_code == 200
    assert response.json()["repo_url"] == "https://github.com/vt-cs2114-f26/team12-project2"


@pytest.mark.parametrize(
    "pasted",
    [
        "https://github.com/vt-cs2114-f26/team12-project2",
        "https://github.com/vt-cs2114-f26/team12-project2.git",
        "http://github.com/vt-cs2114-f26/team12-project2/",
        "github.com/vt-cs2114-f26/team12-project2",
        "git@github.com:vt-cs2114-f26/team12-project2.git",
        # Copied from the page rather than the clone button.
        "https://github.com/vt-cs2114-f26/team12-project2/tree/main/src",
        "https://github.com/vt-cs2114-f26/team12-project2?tab=readme-ov-file",
    ],
)
def test_every_way_a_student_might_copy_the_link_lands_on_one_url(pasted):
    """Students paste the address bar, the clone button, or a link to a file."""
    from app.repository import normalize

    assert normalize(pasted) == "https://github.com/vt-cs2114-f26/team12-project2"


@pytest.mark.parametrize(
    "bad", ["", "   ", "not a url", "https://gitlab.com/org/repo", "https://github.com/only-owner"]
)
def test_a_link_that_is_not_a_github_repository_is_refused(bad):
    """A plausible-but-wrong URL is worse than a rejected one.

    It is discovered at extraction, months later, when the student has gone.
    """
    from app.repository import InvalidRepositoryURL, normalize

    with pytest.raises(InvalidRepositoryURL):
        normalize(bad)


def test_a_later_link_replaces_the_earlier_one():
    """A team that renamed or re-created their repository has to be able to fix it."""
    from app import repository

    for name in ("team12-first-try", "team12-project2"):
        client.post(
            "/api/repository",
            json={
                "email": "s905181818@vt.edu",
                "project_id": "P3",
                "team_id": "T12",
                "repo_url": f"https://github.com/vt-cs2114-f26/{name}",
            },
        )

    stored = repository.for_team("P3", "T12")
    assert stored["repo_url"].endswith("team12-project2")
    with research_db() as conn:
        count = conn.execute(
            "SELECT count(*) c FROM team_repositories WHERE project_id = 'P3' AND team_id = 'T12'"
        ).fetchone()["c"]
    assert count == 1, "one repository per team per project, not a history of guesses"


def test_a_teammate_can_hand_in_the_repository_the_other_started():
    """It belongs to the team, so any member may submit or correct it."""
    from app import repository

    client.post(
        "/api/repository",
        json={"email": "s905191919@vt.edu", "project_id": "P1", "team_id": "T12",
              "repo_url": "https://github.com/vt-cs2114-f26/team12-p1"},
    )
    first = repository.for_team("P1", "T12")["submitted_by"]

    client.post(
        "/api/repository",
        json={"email": "s905202020@vt.edu", "project_id": "P1", "team_id": "T12",
              "repo_url": "https://github.com/vt-cs2114-f26/team12-p1-renamed"},
    )
    second = repository.for_team("P1", "T12")

    assert second["submitted_by"] != first, "whoever last handed it in is on record"
    assert second["repo_url"].endswith("team12-p1-renamed")


def test_a_repository_needs_the_same_gates_a_submission_does():
    wrong_team = client.post(
        "/api/repository",
        json={"email": "s905171717@vt.edu", "project_id": "P2", "team_id": "T99",
              "repo_url": "https://github.com/vt-cs2114-f26/team12-project2"},
    )
    assert wrong_team.status_code == 400

    clear_consent("s905333444@vt.edu")
    without_consent = client.post(
        "/api/repository",
        json={"email": "s905333444@vt.edu", "project_id": "P2", "team_id": "T12",
              "repo_url": "https://github.com/vt-cs2114-f26/team12-project2"},
    )
    assert without_consent.status_code == 403


def test_the_session_reports_what_the_team_already_handed_in():
    client.post(
        "/api/repository",
        json={"email": "s905171717@vt.edu", "project_id": "P2", "team_id": "T12",
              "repo_url": "https://github.com/vt-cs2114-f26/team12-project2"},
    )

    body = client.post(
        "/api/session/start",
        json={"email": "s905171717@vt.edu", "project_id": "P2", "team_id": "T12"},
    ).json()

    assert body["repository"]["repo_url"].endswith("team12-project2")


def test_consent_recorded_outside_the_portal_is_not_asked_for_again(tmp_path, monkeypatch):
    """The screen and the submission endpoint have to agree about who consented.

    config/consent.csv is the researcher's record of consent collected on paper
    or before the portal existed. The submission endpoint accepts it, so the
    first screen must too -- otherwise the student is asked to consent to
    something they already consented to, and told they had when they submit.
    """
    from app import config, consent

    clear_consent("s905888999@vt.edu")
    paper = tmp_path / "consent.csv"
    paper.write_text("email,consent,recorded_at\ns905888999@vt.edu,yes,2026-08-15\n", encoding="utf-8")
    monkeypatch.setattr(config, "CONSENT_CSV", paper)
    config.consent.cache_clear()

    body = client.post(
        "/api/session/start",
        json={"email": "s905888999@vt.edu", "project_id": "P2", "team_id": "T12"},
    ).json()

    assert body["consent_required"] is False
    assert consent.decision_for("s905888999@vt.edu") is None, "and no row was invented"
    config.consent.cache_clear()


# ---------- health and the admin status page ----------


def test_healthz_is_open_and_says_nothing():
    """A check that needs a secret is a check that stops being run.

    systemd, a load balancer and an uptime monitor all call this and none of
    them carry credentials, so it is public -- and safe to be, because the
    answer holds nothing worth protecting.
    """
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_healthz_reports_degraded_rather_than_ok_when_a_database_is_unreadable():
    """Answering "ok" while the database is broken is the one unforgivable lie."""
    import app.main as main

    def broken():
        raise sqlite3.OperationalError("unable to open database file")

    original = main.research_db
    main.research_db = broken
    try:
        response = client.get("/healthz")
    finally:
        main.research_db = original

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert any("research database" in p for p in body["problems"])


def test_the_admin_status_page_is_hidden_without_the_token(monkeypatch):
    """404 rather than 401: no reason to confirm the page exists."""
    monkeypatch.setenv("GENAI_ADMIN_TOKEN", "s3cret")

    assert client.get("/api/admin/status").status_code == 404
    assert client.get(
        "/api/admin/status", headers={"X-Admin-Token": "wrong"}
    ).status_code == 404


def test_the_admin_status_page_is_closed_when_no_token_is_configured(monkeypatch):
    """Falling back to public when a variable is unset is the worst of both."""
    monkeypatch.delenv("GENAI_ADMIN_TOKEN", raising=False)

    assert client.get("/api/admin/status").status_code == 503


def test_the_admin_status_page_reports_what_the_study_team_needs(monkeypatch):
    monkeypatch.setenv("GENAI_ADMIN_TOKEN", "s3cret")
    client.post("/api/submissions", json=submission_body(email="s905010203@vt.edu"))

    body = client.get(
        "/api/admin/status", headers={"X-Admin-Token": "s3cret"}
    ).json()

    assert body["counts"]["submissions"] >= 1
    assert body["last_submission_at"]
    assert body["consent"]["agreed"] >= 1
    assert body["consent_form"]["available"] is True
    assert body["disk_free_gb"] > 0
    assert set(body["database_mb"]) == {"identity", "research"}


# ---------- the admin accounts and the sandbox project ----------


def test_the_admin_accounts_are_declared_in_the_course_configuration():
    """Their roster rows live in config/roster.csv, which is real data and not
    committed, so what is testable is the declaration the rest of the code reads:
    who counts as staff, and therefore whose records the export drops.

    Asserted as a shape rather than a list of addresses. The study team changes
    between semesters, and pinning the names here turns an ordinary edit to
    config/projects.yaml into a failing build -- which, since deploy.sh runs
    this suite before restarting, would mean a deploy that refuses to go out
    because somebody added a collaborator.
    """
    from app import config

    admins = config.admins()
    assert admins, "at least one staff account, or nobody can walk the flow"
    for email in admins:
        assert email == email.strip().lower(), f"{email!r} is not normalised"
        domain = email.rsplit("@", 1)[-1]
        assert domain == "vt.edu" or domain.endswith(".vt.edu"), (
            f"{email!r} cannot sign in: sign-in is a VT Google account"
        )


def test_admins_share_one_team_across_the_sandbox_and_two_projects(tmp_path, monkeypatch):
    """One team, so a real multi-member team can be exercised end to end."""
    from app import config

    rows = [
        f"{email},{project_id},{project_id}_T00,2026-08-01,\n"
        for email in sorted(config.admins())
        for project_id in ("P0", "P1", "P2")
    ]
    write_roster(tmp_path, monkeypatch, rows)

    for email in config.admins():
        for project_id in ("P0", "P1", "P2"):
            assert config.verify_team(email, project_id, "T00") == f"{project_id}_T00"
        assert config.verify_team(email, "P3", "T00") is None, "staff are not in P3"

    config.roster.cache_clear()


def test_the_sandbox_is_reachable_but_not_offered_to_students():
    from app import config

    assert "P0" in config.project_ids(), "the server must still accept it"
    assert "P0" not in [p["id"] for p in config.visible_projects()]

    listed = client.get("/api/config").json()["projects"]
    sandbox = next(p for p in listed if p["id"] == "P0")
    assert sandbox["hidden"] is True, "the page decides whether to list it"


def test_the_sandbox_has_no_date_window_and_leaves_the_first_project_alone():
    """P0 sits first in the file, so an accident here would narrow P1 silently.

    project_window() reads the previous project's stages to find where one
    starts. An empty P0 leaves P1 falling back to three weeks before its first
    deadline, exactly as it did before the sandbox existed.
    """
    from app import config

    assert config.project_window("P0") == (None, None)
    assert config.project_window("P1")[0] == "2026-08-18T23:59:00"


def test_admins_are_not_exempt_from_consent():
    """The consent screen is the first thing a student sees, so a test account
    has to be able to check it."""
    from app import config, consent

    for email in config.admins():
        assert consent.decision_for(email) is None
        assert not consent.has_consented(email)


# ---------- eligibility ----------


def test_consent_cannot_be_recorded_without_confirming_age():
    """The protocol has the portal confirm eligibility before consent, so an
    agreement that does not carry that confirmation is not one we can keep."""
    from app import consent

    clear_consent("s905161616@vt.edu")

    response = client.post(
        "/api/consent",
        json={
            "email": "s905161616@vt.edu",
            "decision": "agree",
            "is_adult": False,
            "form_version": consent.form()["version"],
        },
    )

    assert response.status_code == 400
    assert "18" in response.json()["detail"]
    assert consent.decision_for("s905161616@vt.edu") is None, "and nothing was filed"


def test_the_age_confirmation_is_stored_with_the_answer():
    from app import consent

    clear_consent("s905171717@vt.edu")
    client.post(
        "/api/consent",
        json={
            "email": "s905171717@vt.edu",
            "decision": "agree",
            "is_adult": True,
            "form_version": consent.form()["version"],
        },
    )

    assert consent.decision_for("s905171717@vt.edu")["is_adult"] == 1


def test_an_agreement_recorded_before_the_age_question_existed_does_not_count():
    """is_adult defaults to 0 on migration, and that has to mean "not confirmed".

    Reading a missing confirmation as a yes would quietly enrol anyone who
    consented before the question was asked.
    """
    from app import consent

    clear_consent("s905181818@vt.edu")
    with identity_db() as conn:
        conn.execute(
            "INSERT INTO consent_records (email, decision, form_version, recorded_at, "
            "updated_at) VALUES (?, 'agree', 'old', '2026-08-01', '2026-08-01')",
            ("s905181818@vt.edu",),
        )

    assert not consent.has_consented("s905181818@vt.edu")
    assert client.post(
        "/api/submissions", json=submission_body(email="s905181818@vt.edu")
    ).status_code == 403


def test_the_consent_form_is_complete_and_servable():
    """The shipped form must no longer carry a placeholder, or students see 503."""
    from app import consent

    shipped = consent._load(consent.config.CONFIG_DIR / "consent_form.md")

    assert shipped["available"] is True, shipped.get("problem")
    for required in ("26-883", "dhsmith4@vt.edu", "18 years of age or older", "prize drawing"):
        assert required in shipped["text"], required
