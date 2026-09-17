from app.normalize import (
    build_conversation,
    clean_turns,
    normalize_role,
    normalize_timestamp,
    segment_text,
    strip_html_document,
)


def test_segments_a_labelled_transcript():
    text = "You: Should validation live in Main?\nChatGPT: I recommend an InputValidator class."
    turns, quality = segment_text(text)

    assert quality == "heuristic"
    assert [turn["role"] for turn in turns] == ["user", "assistant"]
    assert turns[1]["content"].startswith("I recommend")


def test_keeps_multiline_answers_together():
    text = (
        "You: how do I fix this\n"
        "Claude: Two steps.\n"
        "\n"
        "First, extract the method.\n"
        "Second, add a test.\n"
        "You: thanks\n"
    )
    turns, _ = segment_text(text)

    assert len(turns) == 3
    assert "Second, add a test." in turns[1]["content"]


def test_ignores_speaker_labels_inside_code_fences():
    text = (
        "You: review this\n"
        "Claude: sure\n"
        "```java\n"
        "System.out.println(user: name);\n"
        "Assistant: not a real turn\n"
        "```\n"
        "You: thanks\n"
    )
    turns, _ = segment_text(text)

    assert len(turns) == 3
    assert "Assistant: not a real turn" in turns[1]["content"]


def test_prose_mentioning_a_tool_is_not_segmented():
    # A single speaker "role" across the whole document means these colons are
    # prose, not a transcript, so the text is kept whole rather than shredded.
    text = "Tools I looked at:\n- Cursor: an editor\n- Copilot: an autocomplete\n"
    turns, quality = segment_text(text)

    assert quality == "unsegmented"
    assert len(turns) == 1


def test_unlabelled_text_survives_as_one_turn():
    turns, quality = segment_text("just some notes about the bag class")

    assert quality == "unsegmented"
    assert turns[0]["role"] == "unknown"
    assert turns[0]["content"] == "just some notes about the bag class"


def test_empty_text():
    assert segment_text("   ") == ([], "empty")


PASTED_PAGE_SOURCE = """<!doctype html>
<html lang="ko-KR" data-build="prod-1b777b39db92">
<head><style>.cm-scroller {display: flex !important; font-family: monospace;}</style>
<script src="/_next/static/chunks/017c9c5c-my7xdcu6wvldl5lz.js"></script></head>
<body><div class="msg"><p>You: Should validation be inside Main?</p></div>
<div class="msg"><p>ChatGPT: I recommend an InputValidator class.</p></div></body></html>"""


def test_pasted_page_source_is_reduced_to_the_conversation():
    # Pasting "view source" of a chat page buries the conversation in CSS and
    # bundle names, which would otherwise become the matching signal.
    turns, quality = segment_text(PASTED_PAGE_SOURCE)

    assert quality == "heuristic"
    assert [turn["role"] for turn in turns] == ["user", "assistant"]
    assert "InputValidator" in turns[1]["content"]
    joined = " ".join(turn["content"] for turn in turns)
    assert "cm-scroller" not in joined
    assert "my7xdcu6wvldl5lz" not in joined


def test_html_entities_are_decoded():
    page = "<html><body><p>You: does Bag&lt;T&gt; work?</p><p>ChatGPT: yes &amp; simply.</p></body></html>"
    turns, _ = segment_text(page)

    assert "Bag<T>" in turns[0]["content"]
    assert "yes & simply." in turns[1]["content"]


def test_a_conversation_about_html_is_left_alone():
    # Only a full document triggers stripping; markup discussed inside a normal
    # conversation must survive intact.
    text = (
        "You: why does my <div> not center?\n"
        "ChatGPT: wrap it:\n"
        "```html\n"
        "<div class=\"box\">hi</div>\n"
        "```\n"
    )
    turns, quality = segment_text(text)

    assert quality == "heuristic"
    assert strip_html_document(text) is None
    assert '<div class="box">hi</div>' in turns[1]["content"]


def test_strip_html_document_ignores_plain_text():
    assert strip_html_document("You: hello\nChatGPT: hi") is None


def test_role_aliases():
    assert normalize_role("Human") == "user"
    assert normalize_role("ASSISTANT") == "assistant"
    assert normalize_role("gemini") == "assistant"
    assert normalize_role("weird-tool") == "unknown"


def test_timestamp_formats_converge_on_iso():
    assert normalize_timestamp(1760365320).startswith("2025-10-13")
    assert normalize_timestamp(1760365320000).startswith("2025-10-13")
    assert normalize_timestamp("2026-10-13T14:22:00Z") == "2026-10-13T14:22:00+00:00"
    assert normalize_timestamp("2026-10-13 14:22:00") == "2026-10-13T14:22:00"
    assert normalize_timestamp("not a date") is None
    assert normalize_timestamp(None) is None


def test_clean_turns_flattens_content_blocks_and_renumbers():
    turns = clean_turns(
        [
            {"role": "human", "content": [{"type": "text", "text": "hello"}]},
            {"role": "assistant", "content": "   "},
            {"role": "assistant", "content": "hi"},
        ]
    )

    assert [turn["turn_id"] for turn in turns] == [1, 2]
    assert turns[0]["content"] == "hello"
    assert turns[1]["role"] == "assistant"


def test_build_conversation_derives_bounds_and_stable_hash():
    turns = [
        {"role": "user", "content": "a", "timestamp": "2026-10-13T14:22:00"},
        {"role": "assistant", "content": "b", "timestamp": "2026-10-13T14:57:00"},
    ]
    first = build_conversation(
        platform="claude", title="Designing Bag<T>", source_format="claude_export",
        turns=turns, parse_quality="structured",
    )
    second = build_conversation(
        platform="claude", title="different title", source_format="paste",
        turns=turns, parse_quality="heuristic",
    )

    assert first["conversation_start"] == "2026-10-13T14:22:00"
    assert first["conversation_end"] == "2026-10-13T14:57:00"
    assert first["turn_count"] == 2
    # The hash covers content only, so re-submitting the same conversation is
    # detected as a duplicate even if the student retitles it.
    assert first["content_hash"] == second["content_hash"]
