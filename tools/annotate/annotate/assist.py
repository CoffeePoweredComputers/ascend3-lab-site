"""The two things a model does here, each run once: propose candidate codes
for one person from their own jots, and propose a merged codebook from
everyone's personal codes.

A model call can take a minute, and a request holds the database's write lock,
so the call never happens inside one. The route records the job as 'working'
and returns; the call runs on a thread with no connection open; the result is
written in one short transaction. Pages show the job's state.
"""

from __future__ import annotations

import os
import re
import threading
from collections import Counter
from typing import Callable

from annotate import db, llm, merge, repo, studies

MAX_CANDIDATES = 8

SYSTEM = (
    "You help a small research team do qualitative coding of student work. "
    "You propose; the people decide. Reply with one JSON object and nothing else."
)


def run(track_id: int, kind: str, roster_id: int, think: Callable[[], object], store: Callable[[object, object], str]) -> None:
    """Carry out a job the caller has already recorded with repo.start_job,
    after its transaction has committed. `think` does the slow part with no
    database; `store(conn, result)` saves it and returns the line people see."""

    def work() -> None:
        try:
            result = think()
            with db.db() as conn:
                repo.finish_job(conn, track_id, kind, roster_id, "ready", store(conn, result))
        except Exception as error:  # noqa: BLE001 - whatever went wrong, the job must not stay 'working'
            shown = str(error) if isinstance(error, (RuntimeError, repo.Refused)) else "Something went wrong."
            with db.db() as conn:
                repo.finish_job(conn, track_id, kind, roster_id, "failed", shown)

    if os.environ.get("ANNOTATE_JOBS") == "inline":  # tests
        work()
    else:
        threading.Thread(target=work, daemon=True).start()


def _mode(study: studies.Study) -> str:
    """llm.mode(), except that a study whose items may not leave the server
    never reaches a live model."""
    mode = llm.mode()
    return "off" if mode == "live" and not study.model_ok else mode


# ------------------------------------------------------------------ candidates


def candidates(study: studies.Study, given: dict) -> tuple[list[dict], str]:
    """(candidate codes, a note when there are none). `given` is
    repo.candidate_inputs: one person's jots and the team's questions."""
    if not given["jots"]:
        return [], "You have no jots, so there is nothing to propose from."
    if _mode(study) == "off":
        return [], "No model is set up, so there are no candidates."
    if _mode(study) == "mock":
        return _stand_in(study, given), ""
    jots = "\n".join(f"- [{j['item']}] -> {j['jot']}" for j in given["jots"])
    questions = "\n".join(f"- {q}" for q in given["questions"]) or "- (none yet)"
    parts = ", ".join(study.parts)
    reply = llm.json_of(llm.chat(SYSTEM, (
        f"{study.about}\n\nThe team's research questions:\n{questions}\n\n"
        "One team member read the items and wrote these jots (item in brackets, then the jot):\n"
        f"{jots}\n\n"
        f"Propose at most {MAX_CANDIDATES} candidate codes this person could apply to items, drawn from what "
        "their jots notice and useful for the research questions. A code names one thing that can be seen in an "
        "item. Use the person's own wording where you can. Do not invent themes their jots do not support.\n\n"
        'Reply as {"codes": [{"name": "two to five words", "definition": "one sentence saying when it applies", '
        f'"part": "one of: {parts}"}}]}}'
    )))
    out = []
    for c in reply.get("codes") or []:
        if isinstance(c, dict) and str(c.get("name") or "").strip() and str(c.get("definition") or "").strip():
            part = c.get("part") if c.get("part") in study.parts else study.parts[-1]
            out.append({"name": str(c["name"]), "definition": str(c["definition"]), "part": part})
    return out[:MAX_CANDIDATES], "" if out else "The model proposed nothing."


STOP = set(
    "the a an and or but of to in on for with is are was were be it this that they them their there here not no "
    "about what which who how why when where does do did has have had can could would should more most some any "
    "very just also than then into from by as at if so i we you he she his her its our your one two same again "
    "asks ask asking question questions student students response".split()
)


def _stand_in(study: studies.Study, given: dict) -> list[dict]:
    """For a developer's machine: the words the jots use most. Not a model."""
    words = Counter(w for j in given["jots"] for w in set(re.findall(r"[a-z]{4,}", j["jot"].lower())) if w not in STOP)
    return [
        {"name": word.capitalize(), "definition": f"Your jots mention “{word}” on {n} card(s). (Stand-in, no model.)", "part": study.parts[-1]}
        for word, n in words.most_common(MAX_CANDIDATES)
    ]


def store_candidates(track_id: int, roster_id: int) -> Callable:
    def store(conn, result) -> str:
        found, note = result
        added = repo.add_candidates(conn, track_id, roster_id, found)
        return note or f"{added} candidate code(s)."

    return store


# ----------------------------------------------------------------------- merge


def proposal(study: studies.Study, given: dict, plain: bool = False) -> list[dict]:
    """Proposed codes from everyone's personal codes (repo.merge_inputs).
    Three things say two codes are alike: the cards they share, which is
    counted here; their names and definitions; and what was jotted and written
    on the cards under them. The model reads the last two with the counts
    beside them. Without a model, or with plain=True, the counts and the names
    decide alone."""
    codes, done = given["codes"], given["done"]
    if plain or _mode(study) != "live":
        return merge.by_cards(codes, done)
    shared = merge.overlaps(codes, done)
    owners = {r: chr(ord("A") + n) for n, r in enumerate(sorted({c["roster_id"] for c in codes}))}
    groups = []
    for part in study.parts:
        mine = [c for c in codes if c["part"] == part]
        if len({c["roster_id"] for c in mine}) < 2:
            continue
        lines = []
        for c in mine:
            first = min(c["items"], default=None)
            example = given["texts"].get(first, "")[:300]
            jot = "; ".join(given["jots"].get((c["roster_id"], first), []))[:200]
            lines.append(
                f"#{c['id']} | coder {owners[c['roster_id']]} | {c['name']} | {c['definition']} | on {len(c['items'])} cards"
                + (f" | example item: {example}" if example else "") + (f" | their jot on it: {jot}" if jot else "")
            )
        ids = {c["id"] for c in mine}
        pairs = "\n".join(
            f"#{a} and #{b}: on the same {s} of {e} cards" for (a, b), (s, e) in shared.items() if s and a in ids and b in ids
        ) or "(none share a card)"
        reply = llm.json_of(llm.chat(SYSTEM, (
            f"{study.about}\n\nEach coder open-coded the same items alone and built their own codes. "
            f"These are the codes about the {part}:\n" + "\n".join(lines) + "\n\n"
            f"How often two codes from different coders landed on the same cards:\n{pairs}\n\n"
            "Group codes from DIFFERENT coders that mean the same thing, judging by the definitions, the example "
            "items and jots, and the shared cards together. Similar names with different definitions are not the "
            "same code. Never put two codes from one coder in a group unless that coder's two codes both match the "
            "others. Leave a code out if nothing matches it. For each group write a name and a one-sentence "
            "definition the whole team could apply, and one short reason.\n\n"
            'Reply as {"groups": [{"name": "...", "definition": "...", "reason": "...", "ids": [1, 2]}]}'
        ), max_tokens=6000))
        groups += merge.clean(reply.get("groups"), codes, part, shared)
    return groups


def store_proposal(track_id: int, total: int) -> Callable:
    def store(conn, groups) -> str:
        repo.store_merge(conn, track_id, groups)
        merged = sum(len(g["ids"]) for g in groups)
        return f"{len(groups)} proposed code(s) from {merged} of {total} personal codes. {total - merged} undecided."

    return store


# ---------------------------------------------------------------------- themes


def themes(study: studies.Study, given: dict) -> tuple[list[dict], str]:
    """(proposed themes, a note when there are none). `given` is
    repo.topic_map: the final codes with their counts and examples. A theme
    is a claim about the data, so with no model there is no stand-in: the
    team writes them."""
    if _mode(study) != "live":
        return [], "No model is set up, so there is no proposal. Build the themes by hand."
    lines = "\n".join(
        f"{c['dimension']}/{c['key']} | {c['label']} | {c['definition']} | on {c['n']} of {given['total']} items"
        + "".join(f" | e.g. {e[:250]}" for e in c["examples"])
        for c in given["codes"]
    )
    reply = llm.json_of(llm.chat(SYSTEM, (
        f"{study.about}\n\nThe team coded every item with this codebook. Each line is a code: its id, name, "
        f"definition, how many items it is on, and example items.\n{lines}\n\n"
        "Propose three to six themes. A theme groups codes that together say one thing about the data, and its "
        "statement says that thing in one or two sentences, as a claim the counts and examples support. Use each "
        "code in at most one theme. Leave a code out if it fits none.\n\n"
        'Reply as {"themes": [{"name": "...", "statement": "...", "codes": ["dimension/code", ...]}]}'
    ), max_tokens=4000))
    found = merge.clean_themes(reply.get("themes"), {f"{c['dimension']}/{c['key']}" for c in given["codes"]})
    return found, "" if found else "The model proposed nothing."


def store_themes(track_id: int) -> Callable:
    def store(conn, result) -> str:
        found, note = result
        for t in found:
            theme_id = repo.save_theme(conn, track_id, None, t["name"], t["statement"])
            for code in t["codes"]:
                repo.set_code_theme(conn, track_id, *code.split("/", 1), theme_id)
        return note or f"{len(found)} theme(s) proposed. Change them as the team sees fit."

    return store
