from datetime import datetime, timedelta, timezone

from app.matching import (
    artifact_score,
    edits_before,
    band,
    commit_tokens,
    content_score,
    conversation_tokens,
    extract_filenames,
    extract_identifiers,
    normalize_repo_url,
    rank_key,
    score_pair,
    stage_for,
    time_delta_minutes,
    time_score,
)
from app.timeutil import deadline_to_utc

UTC = timezone.utc

CONVERSATION = [
    {"role": "user", "content": "Should validation be inside Main?"},
    {
        "role": "assistant",
        "content": "I recommend creating an InputValidator class and moving the "
        "validation logic out of Main.java into it.",
    },
]

COMMIT_FILES = [
    {
        "path": "src/InputValidator.java",
        "diff": "diff --git a/src/InputValidator.java b/src/InputValidator.java\n"
        "+public class InputValidator {\n+  public boolean isValidRange(int low) {\n",
    },
    {
        "path": "src/Main.java",
        "diff": "--- a/src/Main.java\n+++ b/src/Main.java\n-  boolean ok = checkRange(low);\n",
    },
]


def test_extracts_class_names_and_filenames():
    identifiers = extract_identifiers("Create an InputValidator with is_valid_range()")
    assert "inputvalidator" in identifiers
    assert "is_valid_range" in identifiers

    filenames = extract_filenames("move it out of Main.java")
    assert "main.java" in filenames


def test_boilerplate_is_not_a_signal():
    identifiers = extract_identifiers("public static void main(String[] args) { System.out.println(x); }")
    assert "main" not in identifiers
    assert "println" not in identifiers


def test_diff_context_lines_are_ignored():
    _, paths = commit_tokens(
        "cleanup",
        [{"path": "src/Bag.java", "diff": "   BagHelper unchanged = null;\n+ RealChange made = null;\n"}],
    )
    identifiers, _ = commit_tokens(
        "cleanup",
        [{"path": "src/Bag.java", "diff": "   BagHelper unchanged = null;\n+ RealChange made = null;\n"}],
    )
    assert "realchange" in identifiers
    assert "baghelper" not in identifiers


def test_the_worked_example_scores_high_on_content():
    # Content scores are relative, not probabilities; a strong pair sits around
    # 0.5-0.7 and only near-identical vocabulary approaches 1.0.
    score, shared = content_score(
        conversation_tokens(CONVERSATION), commit_tokens("Extract validation", COMMIT_FILES)
    )
    assert score > 0.5
    assert "inputvalidator" in shared


def test_unrelated_commit_scores_near_zero():
    unrelated = commit_tokens(
        "Update README", [{"path": "README.md", "diff": "+ Team roster and meeting notes\n"}]
    )
    score, shared = content_score(conversation_tokens(CONVERSATION), unrelated)
    assert score < 0.2
    assert shared == []


def test_commits_after_a_conversation_outrank_commits_before_it():
    start = datetime(2026, 10, 13, 14, 22, tzinfo=UTC)
    end = datetime(2026, 10, 13, 14, 57, tzinfo=UTC)

    after = time_score(time_delta_minutes(start, end, end + timedelta(hours=2)))
    before = time_score(time_delta_minutes(start, end, start - timedelta(hours=2)))
    during = time_score(time_delta_minutes(start, end, start + timedelta(minutes=5)))

    assert during == 1.0
    assert after > before
    assert 0 < after < 1


def test_conversation_without_timestamps_still_scores_on_content():
    result = score_pair(
        conv_tokens=conversation_tokens(CONVERSATION),
        commit_tok=commit_tokens("Extract validation", COMMIT_FILES),
        conv_start=None,
        conv_end=None,
        commit_time=datetime(2026, 10, 13, 15, 10, tzinfo=UTC),
        author_match=True,
    )

    assert result["time_known"] is False
    assert result["time_delta_minutes"] is None
    assert result["candidate_score"] > 0.6
    assert result["auto_band"] == "high"


def test_timing_and_content_together_beat_timing_alone():
    start = datetime(2026, 10, 13, 14, 22, tzinfo=UTC)
    end = datetime(2026, 10, 13, 14, 57, tzinfo=UTC)
    commit_time = datetime(2026, 10, 13, 15, 10, tzinfo=UTC)

    strong = score_pair(
        conv_tokens=conversation_tokens(CONVERSATION),
        commit_tok=commit_tokens("Extract validation into InputValidator", COMMIT_FILES),
        conv_start=start, conv_end=end, commit_time=commit_time, author_match=True,
    )
    weak = score_pair(
        conv_tokens=conversation_tokens(CONVERSATION),
        commit_tok=commit_tokens("Update README", [{"path": "README.md", "diff": "+ notes\n"}]),
        conv_start=start, conv_end=end, commit_time=commit_time, author_match=False,
    )

    assert strong["candidate_score"] > weak["candidate_score"]
    assert strong["auto_band"] == "high"


def test_repo_urls_compare_across_ssh_and_https():
    ssh = normalize_repo_url("git@github.com:vt/team12-p2.git")
    https = normalize_repo_url("https://github.com/vt/team12-p2")

    assert ssh == https == "github.com/vt/team12-p2"
    assert normalize_repo_url(None) is None
    assert normalize_repo_url("git@github.com:vt/other.git") != ssh


def test_absolute_edit_paths_match_repo_relative_commit_paths():
    score, matched = artifact_score(
        ["/Users/s/team12-p2/src/InputValidator.java"], ["src/InputValidator.java"]
    )

    assert score > 0.9
    assert matched == ["src/InputValidator.java"]


def test_a_shared_basename_alone_is_not_a_match():
    # Every team has a Main.java; only the whole relative path counts.
    score, matched = artifact_score(["/Users/s/other-project/Main.java"], ["src/app/Main.java"])

    assert score == 0.0
    assert matched == []


def test_artifact_evidence_outranks_a_closer_in_time_commit():
    start = datetime(2026, 10, 13, 14, 22, tzinfo=UTC)
    edited = score_pair(
        conv_tokens=conversation_tokens(CONVERSATION),
        commit_tok=commit_tokens("wip", [{"path": "src/InputValidator.java", "diff": ""}]),
        conv_start=start, conv_end=start, commit_time=start + timedelta(hours=6),
        author_match=False,
        edits=["/Users/s/proj/src/InputValidator.java"],
        commit_paths=["src/InputValidator.java"],
    )
    closer = score_pair(
        conv_tokens=conversation_tokens(CONVERSATION),
        commit_tok=commit_tokens("Extract validation", COMMIT_FILES),
        conv_start=start, conv_end=start, commit_time=start + timedelta(minutes=5),
        author_match=True,
    )

    # The heuristic pair may well score higher on its own terms; what matters is
    # that a recorded edit is triaged first and so survives the --top cut.
    assert edited["auto_band"] == "direct"
    assert closer["auto_band"] == "high"
    assert sorted([closer, edited], key=rank_key, reverse=True)[0] is edited


def test_chat_conversations_score_exactly_as_before():
    # Class A behaviour must not shift when the artifact signal is absent.
    start = datetime(2026, 10, 13, 14, 22, tzinfo=UTC)
    kwargs = dict(
        conv_tokens=conversation_tokens(CONVERSATION),
        commit_tok=commit_tokens("Extract validation", COMMIT_FILES),
        conv_start=start, conv_end=start, commit_time=start + timedelta(hours=1),
        author_match=True,
    )

    without = score_pair(**kwargs)
    with_empty = score_pair(**kwargs, edits=[], commit_paths=["src/Main.java"])

    assert without["candidate_score"] == with_empty["candidate_score"]
    assert without["artifact_score"] == 0.0
    assert without["auto_band"] != "direct"


def test_bands():
    assert band(0.9, content=0.7) == "high"
    assert band(0.45, content=0.3) == "moderate"
    assert band(0.21, content=0.3) == "weak"


def test_timing_alone_never_promotes_a_pair_above_weak():
    # An unrelated conversation held the same afternoon as a commit scores well
    # on time and author, but shares no vocabulary with it.
    start = datetime(2026, 10, 13, 16, 0, tzinfo=UTC)
    result = score_pair(
        conv_tokens=conversation_tokens([{"role": "user", "content": "help me plan a trip to Seoul"}]),
        commit_tok=commit_tokens("Move validation logic into InputValidator", COMMIT_FILES),
        conv_start=start, conv_end=start, commit_time=start - timedelta(minutes=50),
        author_match=True,
    )

    assert result["content_score"] == 0.0
    assert result["candidate_score"] > 0.4
    assert result["auto_band"] == "weak"


def test_stage_is_the_first_deadline_a_commit_precedes():
    stages = [
        {"key": "SPEC", "deadline": "2026-10-20T23:59:00"},
        {"key": "PROTOTYPE", "deadline": "2026-11-03T23:59:00"},
        {"key": "FINAL", "deadline": "2026-11-10T23:59:00"},
    ]
    assert stage_for(datetime(2026, 10, 15, tzinfo=UTC), stages, deadline_to_utc) == "SPEC"
    assert stage_for(datetime(2026, 10, 25, tzinfo=UTC), stages, deadline_to_utc) == "PROTOTYPE"
    assert stage_for(datetime(2026, 12, 1, tzinfo=UTC), stages, deadline_to_utc) == "POST_FINAL"


def test_an_edit_logged_after_a_commit_cannot_have_produced_it():
    """Direction of time gates the "direct" band.

    Without this an AI edit at 18:14 claims credit for a commit made at 17:54,
    which is backwards. Observed on real data: every conversation matched every
    commit because they all touched the same file at some point.
    """
    commit_time = datetime(2026, 8, 21, 17, 54, tzinfo=UTC)
    after = [{"path": "helloworld.c", "occurred_at": datetime(2026, 8, 21, 18, 14, tzinfo=UTC)}]
    before = [{"path": "helloworld.c", "occurred_at": datetime(2026, 8, 21, 17, 40, tzinfo=UTC)}]

    assert edits_before(after, commit_time) == []
    assert edits_before(before, commit_time) == ["helloworld.c"]


def test_an_edit_with_no_timestamp_is_still_counted():
    # Some tools record only that a file was involved; dropping those would lose
    # real evidence rather than filter noise.
    edits = [{"path": "src/Main.java", "occurred_at": None}]

    assert edits_before(edits, datetime(2026, 8, 21, tzinfo=UTC)) == ["src/Main.java"]


def test_a_later_edit_does_not_earn_a_direct_band():
    commit_time = datetime(2026, 8, 21, 17, 54, tzinfo=UTC)
    result = score_pair(
        conv_tokens=conversation_tokens([{"role": "user", "content": "make a calculator"}]),
        commit_tok=commit_tokens("hello world", [{"path": "helloworld.c", "diff": "+int main(){}"}]),
        conv_start=datetime(2026, 8, 21, 18, 12, tzinfo=UTC),
        conv_end=datetime(2026, 8, 21, 18, 14, tzinfo=UTC),
        commit_time=commit_time,
        author_match=True,
        edits=[{"path": "helloworld.c", "occurred_at": datetime(2026, 8, 21, 18, 14, tzinfo=UTC)}],
        commit_paths=["helloworld.c"],
    )

    assert result["artifact_score"] == 0.0
    assert result["auto_band"] != "direct"
