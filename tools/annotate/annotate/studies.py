"""What differs between kinds of study.

The trail, the card decks, batches, agreement and the export are the same for
every study. This file holds the rest: what an item is made of, which of its
parts a codebook question can be about, why an item can be excluded, and, for
studies that arrive as a spreadsheet, which column is which part.

A dataset's `kind` column picks one of these. Stage guides live beside it, in
briefs/<kind>/, falling back to briefs/ for the stages that read the same for
every study.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Column:
    """One spreadsheet column that becomes a written part of an item."""

    part: str
    header: str  # the column's header starts with this, ignoring case
    hidden: bool = False  # stored and exported, never shown on a page


@dataclass(frozen=True)
class Study:
    kind: str
    track_title: str
    # What a codebook dimension can be a question about.
    parts: tuple[str, ...]
    has_image: bool
    # The written parts that decide "low content". Empty means all of them.
    main_parts: tuple[str, ...]
    # Why an item can be excluded: (value, what the button says). The choice
    # is written into the item's note, so exclusions can be reported.
    exclude_reasons: tuple[tuple[str, str], ...]
    task: str = ""
    columns: tuple[Column, ...] = ()
    # One sentence telling the model what an item is.
    about: str = ""


STUDIES = {
    "decomp": Study(
        kind="decomp",
        track_title="Submissions",
        parts=("diagram", "reflection"),
        has_image=True,
        main_parts=(),
        exclude_reasons=(
            ("off_task", "Not an attempt at the task"),
            ("unreadable", "Unreadable"),
            ("identifying", "Identifying, cannot be cropped"),
        ),
        about="Each item is a student's diagram breaking a programming problem into steps, with their written approach and challenges. Only the written parts are given here.",
    ),
    "ethics": Study(
        kind="ethics",
        track_title="Questions",
        parts=("question",),
        has_image=False,
        main_parts=("question",),
        exclude_reasons=(
            ("off_task", "Not about the assignment"),
            ("empty", "Blank or a test entry"),
        ),
        task="ethics_questions",
        columns=(
            Column("topic", "topic"),
            Column("question", "your question"),
            # What the student said they used. Coders judge the question
            # without it, so the two can be compared afterwards.
            Column("lens", "which lens", hidden=True),
        ),
        about="Each item is a question about ethics in computing written by a second-semester programming student, with the topic they gave it.",
    ),
}


def get(kind: str) -> Study:
    return STUDIES[kind]
