"""The stages a team works through, together.

A stage is locked until the lead has finished every stage before it (see
repo.is_open), so nobody runs ahead of the team. Each has a guide, written in
briefs/, shown on the page where the work happens.
"""

from __future__ import annotations

from annotate import config

# (number, brief file stem, title, key, page where the work happens)
STAGES = [
    (0, "00-onboarding", "Onboarding", "onboarding", "stage/0"),
    # Cleaning and first reading are one pass: every item is opened once, so
    # that is when it is checked and when first impressions are jotted.
    (1, "01-clean-and-read", "Clean and read", "triage", "triage"),
    (2, "02-ask-a-question", "Questions", "questions", "questions"),
    (3, "03-open-coding", "Open coding", "starter", "open"),
    (4, "04-codebook", "Codebook", "codebook", "codebook"),
    (5, "05-calibration", "Calibration", "calibration", "batches"),
    # The final pass: every kept item coded with the final codebook.
    (6, "06-production", "Production", "production", "production"),
    (7, "07-themes", "Themes", "themes", "themes"),
    (8, "08-export", "Export", "export", "export"),
]

def brief(stage: int, kind: str) -> str:
    """The stage's guide as markdown. A study's own version wins over the
    shared one in briefs/. Its own version is looked for in the data directory
    first, for a study whose guides are kept out of the repo, then in
    briefs/<kind>/. A study with no guide for a stage gets an empty one."""
    stem = next(s[1] for s in STAGES if s[0] == stage)
    for path in (
        config.data_dir() / "briefs" / kind / f"{stem}.md",
        config.APP_DIR / "briefs" / kind / f"{stem}.md",
        config.APP_DIR / "briefs" / f"{stem}.md",
    ):
        if path.exists():
            return path.read_text(encoding="utf-8")
    return ""


def sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    """A guide split at its "## " headings: (what comes before the first one,
    [(heading, body), ...]). The onboarding page lays these out as cards."""
    intro, *rest = ("\n" + text).split("\n## ")
    return intro.strip(), [tuple(part.split("\n", 1)) if "\n" in part else (part, "") for part in rest]
