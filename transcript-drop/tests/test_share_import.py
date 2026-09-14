"""Importing a ChatGPT conversation from its share link.

The page format is a private detail of someone else's frontend, so these tests
pin the two things that must not drift: the URL guard, and that a format change
sends the student to the paste box rather than surfacing as a crash.
"""

import json

import pytest

from app.share_import import (
    ShareImportError,
    conversation_from_page,
    decode_stream,
    share_id,
)


SHARE_URL = "https://chatgpt.com/share/6a889e59-d140-83e8-8234-a3f296be3fc0"


def page_with(table):
    """A share page carrying React Router's interned value table."""
    payload = json.dumps(json.dumps(table))
    return f"<html><script>streamController.enqueue({payload});</script></html>"



@pytest.mark.parametrize(
    "url",
    [
        "https://chatgpt.com/share/6a889e59-d140-83e8-8234-a3f296be3fc0",
        "https://chat.openai.com/share/6a889e59-d140-83e8-8234-a3f296be3fc0",
        "https://chatgpt.com/share/6a889e59-d140-83e8-8234-a3f296be3fc0/",
    ],
)
def test_share_urls_are_accepted(url):
    assert share_id(url) == "6a889e59-d140-83e8-8234-a3f296be3fc0"


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example.com/share/6a889e59-d140-83e8-8234-a3f296be3fc0",
        "http://localhost:8000/api/config",
        "https://chatgpt.com/c/6a889e59-d140-83e8-8234-a3f296be3fc0",  # private link
        "https://chatgpt.com.evil.test/share/6a889e59",
        "file:///etc/passwd",
        "",
    ],
)
def test_everything_else_is_refused(url):
    """The URL pattern is the whole SSRF defence, so it must not be generous."""
    assert share_id(url) is None


def test_a_private_conversation_link_is_rejected_with_guidance():
    from app.share_import import fetch_share_page

    with pytest.raises(ShareImportError, match="not a ChatGPT share link"):
        fetch_share_page("https://chatgpt.com/c/6a889e59-d140-83e8-8234-a3f296be3fc0")


def test_a_page_without_the_payload_sends_the_student_to_paste():
    with pytest.raises(ShareImportError, match="[Pp]aste"):
        conversation_from_page("<html><body>nothing here</body></html>", "u")


def test_a_payload_that_holds_no_conversation_sends_the_student_to_paste():
    html = page_with([{"_1": 2}, "loaderData", {"_3": 4}, "title", "Empty"])

    with pytest.raises(ShareImportError, match="[Pp]aste"):
        conversation_from_page(html, "u")


def test_the_interned_table_is_resolved_by_index():
    # Objects and strings reference each other by position rather than nesting.
    html = page_with([{"_1": 2}, "greeting", "hello"])

    assert decode_stream(html) == {"greeting": "hello"}


def test_negative_indexes_read_as_absent():
    html = page_with([{"_1": -5}, "maybe"])

    assert decode_stream(html) == {"maybe": None}


# A conversation as the page actually encodes it: every string and object lives
# in the flat table and is referenced by position.
CONVERSATION_TABLE = [
    {"_1": 2},                                  # 0  root
    "loaderData",                               # 1
    {"_3": 4, "_5": 6},                         # 2  {title, linear_conversation}
    "title",                                    # 3
    "Designing a Bag",                          # 4
    "linear_conversation",                      # 5
    [7, 23],                                    # 6  two nodes
    {"_8": 9},                                  # 7
    "message",                                  # 8
    {"_10": 11, "_12": 13, "_20": 21, "_28": 29},  # 9
    "author",                                   # 10
    {"_18": 19},                                # 11
    "content",                                  # 12
    {"_14": 15, "_16": 17},                     # 13
    "content_type",                             # 14
    "text",                                     # 15
    "parts",                                    # 16
    [22],                                       # 17
    "role",                                     # 18
    "user",                                     # 19
    "create_time",                              # 20
    1782212853.5,                               # 21  float: ints would look like indexes
    "how should Bag<T> store items?",           # 22
    {"_8": 24},                                 # 23  second node
    {"_10": 25, "_12": 26, "_28": 29},          # 24
    {"_18": 30},                                # 25  assistant
    {"_14": 15, "_16": 27},                     # 26
    [31],                                       # 27
    "metadata",                                 # 28
    {"_32": 33},                                # 29
    "assistant",                                # 30
    "Use a resizable array.",                   # 31
    "model_slug",                               # 32
    "gpt-5-5",                                  # 33
]


def test_a_shared_conversation_becomes_turns():
    conversation = conversation_from_page(page_with(CONVERSATION_TABLE), SHARE_URL)

    assert conversation["title"] == "Designing a Bag"
    assert [t["role"] for t in conversation["turns"]] == ["user", "assistant"]
    assert conversation["turns"][0]["content"] == "how should Bag<T> store items?"
    assert conversation["turns"][0]["timestamp"] == 1782212853.5


def test_the_model_and_the_link_are_kept_as_provenance():
    conversation = conversation_from_page(page_with(CONVERSATION_TABLE), SHARE_URL)

    assert conversation["models"] == ["gpt-5-5"]
    # Only the reply came from that model; the student's own message did not.
    assert conversation["turns"][0]["model"] is None
    assert conversation["turns"][1]["model"] == "gpt-5-5"
    # The share id doubles as the stable identity for re-submission.
    assert conversation["source_session_id"] == "6a889e59-d140-83e8-8234-a3f296be3fc0"
    assert conversation["source_url"] == SHARE_URL


def test_system_and_non_text_nodes_are_not_turns():
    table = list(CONVERSATION_TABLE)
    table[19] = "system"          # the first node becomes a system message
    conversation = conversation_from_page(page_with(table), SHARE_URL)

    assert [t["role"] for t in conversation["turns"]] == ["assistant"]


def test_a_claude_share_link_explains_itself():
    """Claude's page holds no conversation and its API is bot-protected.

    Reading one would mean defeating that protection, so the student gets the
    two routes that do work rather than a rejection they cannot act on.
    """
    from app.share_import import fetch_share_page

    with pytest.raises(ShareImportError, match="paste it|paste|export"):
        fetch_share_page("https://claude.ai/share/dcf08df9-b68c-4eb8-8073-35067515e02a")


def test_a_gemini_share_link_explains_itself():
    """Gemini's page is filled in by an internal RPC of positional arrays.

    Reading it would mean depending on array positions in an undocumented API,
    which breaks quietly. The student is sent to the copy that cannot rot.
    """
    from app.share_import import fetch_share_page

    for url in (
        "https://share.gemini.google/e9PPX8yGx7vj",
        "https://gemini.google.com/share/cdb5f60aae38",
    ):
        with pytest.raises(ShareImportError, match="paste"):
            fetch_share_page(url)
