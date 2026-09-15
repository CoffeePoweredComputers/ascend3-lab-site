"""Team membership is temporal: a team is per-project, and can change mid-project."""

from datetime import datetime, timezone

import pytest

from app import config

UTC = timezone.utc

ROSTER = """email,project_id,team_instance_id,joined_at,left_at
s905000001@vt.edu,P1,P1_T17,2026-08-24,
s905000002@vt.edu,P1,P1_T17,2026-08-24,
s905000001@vt.edu,P2,P2_T08a,2026-09-28,2026-10-12
s905000021@vt.edu,P2,P2_T08a,2026-09-28,2026-10-12
s905000001@vt.edu,P2,P2_T08b,2026-10-13,
s905000073@vt.edu,P2,P2_T08b,2026-10-13,
s905000001@vt.edu,P3,P3_T31,2026-11-16,
"""

CONSENT = """email,consent,recorded_at
s905000001@vt.edu,yes,2026-09-01
s905000021@vt.edu,no,2026-09-01
"""


@pytest.fixture
def roster_files(tmp_path, monkeypatch):
    roster = tmp_path / "roster.csv"
    consent = tmp_path / "consent.csv"
    roster.write_text(ROSTER, encoding="utf-8")
    consent.write_text(CONSENT, encoding="utf-8")
    monkeypatch.setattr(config, "ROSTER_CSV", roster)
    monkeypatch.setattr(config, "CONSENT_CSV", consent)
    config.roster.cache_clear()
    config.consent.cache_clear()
    yield
    config.roster.cache_clear()
    config.consent.cache_clear()


def test_a_student_keeps_one_identity_across_changing_teams(roster_files):
    per_project = {
        row["project_id"]: row["team_instance_id"]
        for row in config.roster()
        if row["email"] == "s905000001@vt.edu" and not row["left_at"]
    }

    assert per_project == {"P1": "P1_T17", "P2": "P2_T08b", "P3": "P3_T31"}


def test_mid_project_change_resolves_by_when_it_happened(roster_files):
    before, how_before = config.lookup_team_instance(
        "s905000001@vt.edu", "P2", datetime(2026, 10, 5, tzinfo=UTC)
    )
    after, how_after = config.lookup_team_instance(
        "s905000001@vt.edu", "P2", datetime(2026, 10, 20, tzinfo=UTC)
    )

    assert (before, how_before) == ("P2_T08a", "roster")
    assert (after, how_after) == ("P2_T08b", "roster")


def test_a_moment_outside_every_window_is_flagged_not_guessed(roster_files):
    # Before the project began, both instances are equally (im)plausible.
    instance, how = config.lookup_team_instance(
        "s905000001@vt.edu", "P2", datetime(2026, 8, 1, tzinfo=UTC)
    )

    assert how == "ambiguous", "a fallback across a team change must stay visible"
    assert instance == "P2_T08b"


def test_a_project_with_one_team_is_never_ambiguous(roster_files):
    instance, how = config.lookup_team_instance(
        "s905000001@vt.edu", "P1", datetime(2020, 1, 1, tzinfo=UTC)
    )

    assert (instance, how) == ("P1_T17", "roster")


def test_a_student_not_on_the_roster_is_unknown(roster_files):
    assert config.lookup_team_instance("s905999999@vt.edu", "P2", None) == (None, "unknown")


def test_instances_of_one_team_share_a_label(roster_files):
    labels = {
        row["team_instance_id"]: row["team_label"]
        for row in config.roster()
        if row["project_id"] == "P2"
    }

    # The label is what ties the two instances to one repository.
    assert labels == {"P2_T08a": "T08", "P2_T08b": "T08"}


def test_unrecorded_consent_counts_as_no(roster_files):
    assert config.has_consented("s905000001@vt.edu") is True
    assert config.has_consented("s905000021@vt.edu") is False
    assert config.has_consented("s905000073@vt.edu") is False, "absent from the file means no"


# --- the consent gate on repository collection ---------------------------------

import sys  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from extract_git import consent_blockers, instance_at, team_instances_for  # noqa: E402


@pytest.fixture
def team_db():
    import sqlite3

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE team_instances (team_instance_id TEXT PRIMARY KEY, project_id TEXT,
            team_label TEXT, started_at TEXT, ended_at TEXT);
        CREATE TABLE participant_team_membership (participant_code TEXT,
            team_instance_id TEXT, project_id TEXT, joined_at TEXT, left_at TEXT);
        CREATE TABLE participant_consent (participant_code TEXT PRIMARY KEY, consented INTEGER);
        """
    )
    conn.executemany(
        "INSERT INTO team_instances VALUES (?, ?, ?, ?, ?)",
        [
            ("P2_T08a", "P2", "T08", "2026-09-28", "2026-10-12"),
            ("P2_T08b", "P2", "T08", "2026-10-13", None),
        ],
    )
    conn.executemany(
        "INSERT INTO participant_team_membership VALUES (?, ?, 'P2', NULL, NULL)",
        [("S001", "P2_T08a"), ("S021", "P2_T08a"), ("S001", "P2_T08b"), ("S073", "P2_T08b")],
    )
    conn.executemany(
        "INSERT INTO participant_consent VALUES (?, ?)",
        [("S001", 1), ("S021", 0), ("S073", 1)],
    )
    return conn


def test_a_member_who_left_still_gates_the_repository(team_db):
    # S021 was only on the first instance, but authored part of the history.
    instances = team_instances_for(team_db, "P2", "T08")
    assert [i["team_instance_id"] for i in instances] == ["P2_T08a", "P2_T08b"]
    assert consent_blockers(team_db, instances) == ["S021"]


def test_a_fully_consenting_team_is_collectable(team_db):
    team_db.execute("UPDATE participant_consent SET consented = 1 WHERE participant_code = 'S021'")

    assert consent_blockers(team_db, team_instances_for(team_db, "P2", "T08")) == []


def test_an_unrecorded_member_blocks_collection(team_db):
    team_db.execute("DELETE FROM participant_consent WHERE participant_code = 'S073'")

    assert "S073" in consent_blockers(team_db, team_instances_for(team_db, "P2", "T08"))


def test_commits_are_attributed_to_the_instance_in_force(team_db):
    instances = team_instances_for(team_db, "P2", "T08")
    at = lambda text: instance_at(instances, datetime.fromisoformat(text).replace(tzinfo=UTC))

    assert at("2026-10-05T12:00:00") == "P2_T08a"
    assert at("2026-10-20T12:00:00") == "P2_T08b"
    # Setup work predating the roster window belongs to the first instance, not
    # a team that did not exist yet.
    assert at("2026-09-01T12:00:00") == "P2_T08a"


def test_a_roster_edit_takes_effect_without_a_restart(tmp_path, monkeypatch):
    """An instructor's mid-semester edit must reach a long-running server.

    Caching the roster for the process lifetime would attribute every submission
    between the edit and the next restart to a stale team.
    """
    roster = tmp_path / "roster.csv"
    roster.write_text(
        "email,project_id,team_instance_id,joined_at,left_at\n"
        "s905000009@vt.edu,P2,P2_T05,2026-08-01,\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "ROSTER_CSV", roster)
    config.roster.cache_clear()

    assert config.lookup_team_instance("s905000009@vt.edu", "P2")[0] == "P2_T05"

    # The student moves to another team; only the file changes.
    roster.write_text(
        "email,project_id,team_instance_id,joined_at,left_at\n"
        "s905000009@vt.edu,P2,P2_T06,2026-08-01,\n",
        encoding="utf-8",
    )
    import os
    os.utime(roster, (0, 0))  # force a distinct mtime even on a fast filesystem

    assert config.lookup_team_instance("s905000009@vt.edu", "P2")[0] == "P2_T06"
    config.roster.cache_clear()


# ---------- the (student ID, team) gate ----------


@pytest.mark.parametrize(
    "typed,expected",
    [("T08", "8"), ("t8", "8"), ("Team 08", "8"), (" 8 ", "8"), ("T00", "0"), ("Alpha", "ALPHA")],
)
def test_team_labels_are_compared_by_what_identifies_them(typed, expected):
    """Formatting must not decide the match; identity must."""
    assert config.normalize_team_label(typed) == expected


def test_a_pair_the_roster_agrees_on_resolves_to_its_instance(roster_files):
    assert config.verify_team("s905000001@vt.edu", "P1", "T17") == "P1_T17"
    assert config.verify_team("s905000001@vt.edu", "P1", "t17") == "P1_T17"


def test_a_wrong_team_does_not_resolve(roster_files):
    assert config.verify_team("s905000001@vt.edu", "P1", "T18") is None


def test_a_student_absent_from_the_roster_does_not_resolve(roster_files):
    assert config.verify_team("s905999999@vt.edu", "P1", "T17") is None


def test_a_team_from_another_project_does_not_resolve(roster_files):
    """Teams are rebuilt per project, so last project's label is not a key."""
    assert config.verify_team("s905000001@vt.edu", "P3", "T17") is None


def test_both_labels_of_a_mid_project_change_are_the_students_own(roster_files):
    """Instances of one team share a label, so T08 stays right across the change.

    The moment decides which instance is returned; the label decides whether the
    student is let in at all. Someone submitting after a change may be handing in
    conversations from before it.
    """
    before = datetime(2026, 10, 1, tzinfo=UTC)
    after = datetime(2026, 10, 20, tzinfo=UTC)

    assert config.verify_team("s905000001@vt.edu", "P2", "T08", before) == "P2_T08a"
    assert config.verify_team("s905000001@vt.edu", "P2", "T08", after) == "P2_T08b"


def test_a_blank_team_never_resolves(roster_files):
    for blank in (None, "", "   "):
        assert config.verify_team("s905000001@vt.edu", "P1", blank) is None
