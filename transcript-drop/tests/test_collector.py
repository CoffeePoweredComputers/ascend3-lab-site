"""The collector must find a project's sessions without sweeping in others."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from collect_ai_logs import (  # noqa: E402
    cursor_project_name,
    cursor_timestamp,
    find_claude_code,
    find_cursor,
    project_dir_name,
)


def session_records(cwd: str, session: str):
    return [
        {"type": "user", "sessionId": session, "cwd": cwd, "gitBranch": "main",
         "timestamp": "2026-10-13T14:22:00Z", "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "sessionId": session, "cwd": cwd,
         "timestamp": "2026-10-13T14:23:00Z",
         "message": {"role": "assistant", "model": "claude-opus-5",
                     "content": [{"type": "text", "text": "hello"}]}},
    ]


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    (tmp_path / ".claude" / "projects").mkdir(parents=True)
    return tmp_path


def write_session(home: Path, dir_name: str, session: str, cwd: str):
    folder = home / ".claude" / "projects" / dir_name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{session}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in session_records(cwd, session)), encoding="utf-8"
    )


def test_project_dir_name_matches_claude_codes_scheme():
    assert project_dir_name(Path("/Users/me/Projects/app")) == "-Users-me-Projects-app"
    # Spaces and non-ASCII both collapse to one hyphen per character.
    assert project_dir_name(Path("/Users/me/Desktop/Data Collection")) == "-Users-me-Desktop-Data-Collection"
    assert project_dir_name(Path("/a/업무")) == "-a---"


def test_finds_sessions_for_the_named_project(fake_home, tmp_path):
    repo = tmp_path / "team12-p2"
    repo.mkdir()
    write_session(fake_home, project_dir_name(repo), "s1", str(repo))

    found = find_claude_code(repo)

    assert [s["source"] for s in found] == ["s1.jsonl"]


def test_a_moved_project_keeps_its_earlier_sessions(fake_home, tmp_path):
    """The case that silently lost history: cwd is stale, the folder name is not.

    Claude Code re-files a session under the new path when a project moves, but
    the records still carry the old working directory. Matching only on cwd threw
    away everything from before the move.
    """
    repo = tmp_path / "moved-here"
    repo.mkdir()
    write_session(fake_home, project_dir_name(repo), "old", "/somewhere/that/no/longer/exists")

    found = find_claude_code(repo)

    assert [s["source"] for s in found] == ["old.jsonl"]


def test_other_projects_are_never_swept_in(fake_home, tmp_path):
    mine = tmp_path / "mine"
    theirs = tmp_path / "theirs"
    mine.mkdir()
    theirs.mkdir()
    write_session(fake_home, project_dir_name(mine), "mine", str(mine))
    write_session(fake_home, project_dir_name(theirs), "theirs", str(theirs))

    assert [s["source"] for s in find_claude_code(mine)] == ["mine.jsonl"]
    assert [s["source"] for s in find_claude_code(theirs)] == ["theirs.jsonl"]


def test_a_subfolder_session_still_belongs_to_the_repo(fake_home, tmp_path):
    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    write_session(fake_home, "-unrelated-name", "sub", str(repo / "src"))

    assert [s["source"] for s in find_claude_code(repo)] == ["sub.jsonl"]


# --- VS Code chat sessions -----------------------------------------------------

from collect_ai_logs import load_chat_session, replay_chat_journal  # noqa: E402


def test_replays_the_append_only_chat_journal(tmp_path):
    """Newer VS Code writes a snapshot plus patches, not one JSON object.

    kind 0 is the snapshot, kind 1 sets a key path, kind 2 appends to a list.
    Reading only the snapshot would report an empty session, which is exactly how
    real Copilot conversations went missing.
    """
    path = tmp_path / "s.jsonl"
    path.write_text(
        "\n".join(
            json.dumps(r)
            for r in [
                {"kind": 0, "v": {"sessionId": "abc", "creationDate": 1787335000000, "requests": []}},
                {"kind": 1, "k": ["customTitle"], "v": "Add functions in file"},
                {"kind": 2, "k": ["requests"], "v": [
                    {"requestId": "r1", "timestamp": 1787335081105, "modelId": "copilot/auto",
                     "message": {"text": "How to add functions in this file"},
                     "response": [{"value": "Here is the pattern."}]}
                ]},
                {"kind": 1, "k": ["inputState", "inputText"], "v": ""},
            ]
        ),
        encoding="utf-8",
    )

    session = replay_chat_journal(path)

    assert session["customTitle"] == "Add functions in file"
    assert len(session["requests"]) == 1
    assert session["requests"][0]["message"]["text"] == "How to add functions in this file"


def test_a_patch_that_cannot_be_placed_does_not_lose_the_session(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(
        "\n".join(
            json.dumps(r)
            for r in [
                {"kind": 0, "v": {"sessionId": "abc", "requests": []}},
                {"kind": 1, "k": ["nope", "deeper", "still"], "v": "x"},
                {"kind": 2, "k": ["requests"], "v": [{"requestId": "r1", "message": {"text": "hi"}}]},
            ]
        ),
        encoding="utf-8",
    )

    session = replay_chat_journal(path)

    assert len(session["requests"]) == 1


def test_the_older_single_object_format_still_loads(tmp_path):
    path = tmp_path / "s.json"
    path.write_text(json.dumps({"sessionId": "abc", "requests": [{"message": {"text": "hi"}}]}), encoding="utf-8")

    assert len(load_chat_session(path)["requests"]) == 1


# --- output location and the git guard -----------------------------------------

from collect_ai_logs import DEFAULT_OUTPUT_DIR, ensure_git_ignored  # noqa: E402


def test_the_folder_is_excluded_from_git_on_creation(tmp_path):
    folder = tmp_path / DEFAULT_OUTPUT_DIR
    folder.mkdir()

    created = ensure_git_ignored(folder)

    assert created is True
    # "*" excludes the folder and this file, so a bundle cannot be committed by
    # accident -- and the project's own .gitignore is never touched.
    assert "*" in (folder / ".gitignore").read_text().split()


def test_an_existing_gitignore_is_left_alone(tmp_path):
    folder = tmp_path / DEFAULT_OUTPUT_DIR
    folder.mkdir()
    (folder / ".gitignore").write_text("mine\n", encoding="utf-8")

    assert ensure_git_ignored(folder) is False
    assert (folder / ".gitignore").read_text() == "mine\n"


def test_git_really_ignores_the_folder(tmp_path):
    """The assertion that matters: git must not offer the bundle for commit."""
    import subprocess

    repo = tmp_path / "repo"
    (repo / DEFAULT_OUTPUT_DIR).mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    ensure_git_ignored(repo / DEFAULT_OUTPUT_DIR)
    (repo / DEFAULT_OUTPUT_DIR / "genai-logs-repo.jsonl").write_text("secret", encoding="utf-8")

    status = subprocess.run(
        ["git", "status", "--short"], cwd=repo, capture_output=True, text=True
    ).stdout

    assert DEFAULT_OUTPUT_DIR not in status


# ---------- Cursor ----------
#
# Cursor is the one tool that records no working directory inside the file, so
# these tests pin down what stands in for it.


def cursor_records(prompt, stamp, edited=None, read=None):
    """A transcript the shape Cursor writes: tagged prompts, untimed replies."""
    blocks = []
    if read:
        blocks.append({"type": "tool_use", "name": "Read", "input": {"path": read}})
    if edited:
        blocks.append(
            {
                "type": "tool_use",
                "name": "StrReplace",
                "input": {"path": edited, "old_string": "a", "new_string": "b"},
            }
        )
    blocks.append({"type": "text", "text": "on it"})
    return [
        {
            "role": "user",
            "message": {
                "content": [
                    {"type": "text", "text": f"<timestamp>{stamp}</timestamp>\n<user_query>\n{prompt}\n</user_query>"}
                ]
            },
        },
        {"role": "assistant", "message": {"content": blocks}},
        {"type": "turn_ended", "status": "success"},
    ]


def write_cursor_session(home, workspace, session, records):
    folder = home / ".cursor" / "projects" / workspace / "agent-transcripts" / session
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{session}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records), encoding="utf-8"
    )


def test_cursor_project_name_matches_cursors_scheme():
    # The same flattening Claude Code uses, minus the leading separator.
    assert cursor_project_name(Path("/Users/me/Projects/app")) == "Users-me-Projects-app"
    assert project_dir_name(Path("/Users/me/Projects/app")) == "-" + cursor_project_name(
        Path("/Users/me/Projects/app")
    )


def test_cursor_timestamp_honours_the_recorded_offset():
    """The whole point of reading the tag by hand rather than with a date parser.

    Cursor writes a human-readable local time with the offset in brackets. Both
    Date() in the browser and a naive parse here would drop the offset and apply
    whatever timezone the reader happens to be in, moving the conversation by
    hours -- which is fatal when the conversation is being lined up with commits.
    """
    assert cursor_timestamp("<timestamp>Friday, Aug 21, 2026, 3:47 PM (UTC-4)</timestamp>") == "2026-08-21T19:47:00Z"
    assert cursor_timestamp("<timestamp>Monday, December 1, 2026, 12:05 AM (UTC+9)</timestamp>") == "2026-11-30T15:05:00Z"
    assert cursor_timestamp("nothing here") is None


def test_finds_a_cursor_session_for_the_open_workspace(fake_home, tmp_path):
    repo = tmp_path / "team12-p2"
    repo.mkdir()
    write_cursor_session(
        fake_home, cursor_project_name(repo), "aaaaaaaa-1111-2222-3333-444444444444",
        cursor_records("add a test", "Tue, Oct 13, 2026, 2:22 PM (UTC-4)"),
    )

    found = find_cursor(repo)

    assert [s["tool"] for s in found] == ["cursor"]
    # The student's own message is the only clock the transcript carries.
    assert found[0]["latest"] == "2026-10-13T18:22:00Z"


def test_a_cursor_workspace_inside_the_repo_still_belongs_to_it(fake_home, tmp_path):
    repo = tmp_path / "team12-p2"
    (repo / "src").mkdir(parents=True)
    write_cursor_session(
        fake_home, cursor_project_name(repo / "src"), "bbbbbbbb-1111-2222-3333-444444444444",
        cursor_records("why does this fail", "Tue, Oct 13, 2026, 2:22 PM (UTC-4)"),
    )

    assert len(find_cursor(repo)) == 1


def test_a_lookalike_sibling_project_is_never_swept_in(fake_home, tmp_path):
    """The ambiguity the flattening creates: "proj-old" and "proj/old" collide.

    Names are generated from the repository's own folders rather than matched as
    prefixes, so a neighbouring project cannot pass for one of ours.
    """
    repo = tmp_path / "p2"
    repo.mkdir()
    sibling = tmp_path / "p2-old"
    sibling.mkdir()
    write_cursor_session(
        fake_home, cursor_project_name(sibling), "cccccccc-1111-2222-3333-444444444444",
        cursor_records("last semester", "Tue, Oct 13, 2026, 2:22 PM (UTC-4)"),
    )

    assert find_cursor(repo) == []


def test_a_session_elsewhere_that_edited_this_repo_is_included(fake_home, tmp_path):
    """A window opened somewhere else still counts once it writes to the project."""
    repo = tmp_path / "p2"
    repo.mkdir()
    write_cursor_session(
        fake_home, "empty-window", "dddddddd-1111-2222-3333-444444444444",
        cursor_records("fix the bag", "Tue, Oct 13, 2026, 2:22 PM (UTC-4)", edited=str(repo / "Bag.java")),
    )

    assert len(find_cursor(repo)) == 1


def test_a_session_elsewhere_that_only_read_this_repo_is_not(fake_home, tmp_path):
    """Reading is incidental; editing is participation in the project."""
    repo = tmp_path / "p2"
    repo.mkdir()
    write_cursor_session(
        fake_home, "empty-window", "eeeeeeee-1111-2222-3333-444444444444",
        cursor_records("what is this", "Tue, Oct 13, 2026, 2:22 PM (UTC-4)", read=str(repo / "Bag.java")),
    )

    assert find_cursor(repo) == []
