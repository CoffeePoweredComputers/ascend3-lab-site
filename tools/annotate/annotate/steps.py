"""Candidate codes built in steps, each a separate model call that sees no
other call's reply:

    1. draft the codes from the person's jots and the team's questions
    2. two coders apply the draft to half the items
    3. revise the codes from where the two disagreed
    4. two more coders apply the result to every item

The model is reached only through `ask`, a function from a prompt to the
reply's JSON, so nothing here knows what answers. The sampling, the shuffling
and the agreement figures are code (stats.py), not the model.

To change the procedure, replace `candidates`. To change the wording, the
prompts are the three functions under "the prompts".
"""

from __future__ import annotations

import random
from collections import Counter
from typing import Callable

from annotate import stats, studies

MAX_CODES = 60  # a guard against a runaway reply, not a target
SAMPLE_MIN = 40  # the first two coders get half the items, and at least this many
WEAK = 0.6  # kappa under this is named to the person, never cut
CODERS_SEE_JOTS = True  # False: the coders read the items alone

Ask = Callable[[str], dict]


def candidates(study: studies.Study, given: dict, ask: Ask, tell: Callable[[str], None] = None) -> tuple[list[dict], str, dict]:
    """(candidate codes, the line the person sees, the record of the run).
    `given` is repo.candidate_inputs. `tell` is given a line as each step
    starts. The record holds the drafts, what each coder did, the agreement
    and what the revision changed."""
    tell = tell or (lambda line: None)
    n = len(given["jots"])
    everyone = list(range(1, n + 1))
    run: dict = {"jots": n, "questions": given["questions"]}

    tell("Step 1 of 4, several minutes in all: drafting codes from your jots.")
    codes = _codes(ask(draft_prompt(study, given)), study, n)
    run["draft"] = codes
    if not codes:
        return [], "The model proposed nothing.", run
    note = f"{min(len(codes), MAX_CODES)} candidate code(s)."
    try:
        sample = sorted(set(random.Random(1).sample(everyone, min(n, max(SAMPLE_MIN, n // 2)))) | {c["example"] for c in codes})
        tell(f"Step 2 of 4: two coders are trying the draft on {len(sample)} of your items.")
        first, second = (_code(study, given, codes, sample, seed, ask) for seed in (1, 2))
        fit = _reconcile(codes, first, second, sample)
        run["test_fit"] = {"sample": sample, "agreement": fit, "coders": [_plain(first), _plain(second)]}

        tell("Step 3 of 4: revising the codes where the coders disagreed.")
        reply = ask(revise_prompt(study, given, codes, _evidence(codes, fit, first, second)))
        revised = _codes(reply, study, n)
        if revised:
            run["dropped"] = sorted({c["name"] for c in codes} - {c["name"] for c in revised})
            codes = revised
        run["revised"], run["changes"] = codes, [c for c in reply.get("changes") or [] if isinstance(c, dict)]
        note = f"{min(len(codes), MAX_CODES)} candidate code(s)."

        tell(f"Step 4 of 4: two more coders are trying the result on all {n} items.")
        first, second = (_code(study, given, codes, everyone, seed, ask) for seed in (3, 4))
        full = _reconcile(codes, first, second, everyone)
        run["full_pass"] = {"agreement": full, "coders": [_plain(first), _plain(second)]}
        codes = sorted(codes, key=lambda c: -full["per"][c["id"]]["both"])
        weak = [c["name"] for c in codes if full["per"][c["id"]]["either"] and (full["per"][c["id"]]["kappa"] or 0) < WEAK]
        note += (
            f" Two model coders tried them on all {n} items and gave the same codes on {full['exact']:.0%}."
            + (f" Least steady: {', '.join(weak[:4])}." if weak else "")
        )
    except RuntimeError as error:
        # The codes so far stand on their own: a check that could not finish
        # costs the person the check, not their candidates.
        run["stopped"] = str(error)
        note += f" They could not be checked all the way: {error}"
    return [{"name": c["name"], "definition": c["definition"], "part": c["part"]} for c in codes[:MAX_CODES]], note, run


# ------------------------------------------------------------------ the prompts

LEAD = "The research questions say what the team wants to learn. The jots show what this person found worth noticing."
PLAIN = (
    "Write each definition as plain text that stands on its own: name a neighbouring code by its name, and leave "
    "out how the code came about."
)
CODE_SHAPE = (
    '{{"name": "two to six words", "definition": "one or two sentences: when it applies, and how to choose between '
    'it and its nearest neighbour", "part": "one of: {parts}", "example": 12}}'
)


def _context(study: studies.Study, given: dict) -> str:
    questions = "\n".join(f"- RQ{n}: {q}" for n, q in enumerate(given["questions"], 1)) or "- (none yet)"
    return f"{study.about}\n\nThe team's research questions:\n{questions}"


def _listing(given: dict, numbers: list[int], jots: bool = True) -> str:
    return "\n".join(
        f"{n}. [{given['jots'][n - 1]['item']}] -> {given['jots'][n - 1]['jot']}" if jots else f"{n}. {given['jots'][n - 1]['item']}"
        for n in numbers
    )


def draft_prompt(study: studies.Study, given: dict) -> str:
    return (
        f"{_context(study, given)}\n\n"
        "One team member read the items and wrote a jot on each (number, the item in brackets, then the jot):\n"
        f"{_listing(given, list(range(1, len(given['jots']) + 1)))}\n\n"
        f"{LEAD} Draft the codes this person could apply to items. A code names one thing that can be seen in an "
        "item, comes from what the jots notice, and helps answer at least one research question. Read every jot "
        "before deciding, and use the person's own wording where you can. There is no target number of codes: "
        f"propose as many as the jots support, and none they do not support. {PLAIN}\n\n"
        'Reply as {"codes": [' + CODE_SHAPE.format(parts=", ".join(study.parts)) + "]} where example is the number "
        "of one item the code fits."
    )


def coder_prompt(study: studies.Study, given: dict, codes: list[dict], numbers: list[int]) -> str:
    book = "\n".join(
        f"{c['id']} | {c['name']} | {c['definition']} | e.g. item: {given['jots'][c['example'] - 1]['item'][:200]}" for c in codes
    )
    if CODERS_SEE_JOTS:
        items = (
            "One team member read the items and wrote a jot on each (number, the item in brackets, then the jot):\n"
            f"{_listing(given, numbers)}\n\n"
            "The jots show what this person found worth noticing. Apply the codebook to every item, reading the item "
            "and its jot together."
        )
    else:
        items = f"Items (number, then the item):\n{_listing(given, numbers, jots=False)}\n\nApply the codebook to every item."
    return (
        f"{_context(study, given)}\n\nA codebook (id | name | definition | an example item):\n{book}\n\n{items} "
        "An item may get several codes, or none. Go by the definitions and do not stretch a code to make it fit.\n\n"
        'Reply as {"codes": {"<item number>": ["C01"]}, "hard_to_tell_apart": [{"codes": ["C01", "C02"], "why": "..."}], '
        '"not_captured": ["something several ' + ("jots notice" if CODERS_SEE_JOTS else "items show") + ' that no code covers"]} '
        "with every item number present and an empty list where no code fits."
    )


def revise_prompt(study: studies.Study, given: dict, codes: list[dict], evidence: str) -> str:
    current = "\n".join(f"{c['name']} | {c['definition']} | {c['part']}" for c in codes)
    return (
        f"{_context(study, given)}\n\n"
        "One team member read the items and wrote a jot on each (number, the item in brackets, then the jot):\n"
        f"{_listing(given, list(range(1, len(given['jots']) + 1)))}\n\n"
        f"{LEAD} This codebook was drafted from the jots (name | definition | part):\n{current}\n\n"
        "Two coders then each applied it to a sample of the items, "
        + ("reading each item with its jot" if CODERS_SEE_JOTS else "seeing the items but not the jots")
        + f" and not seeing each other's work. What came back:\n{evidence}\n\n"
        "Revise the codebook from this evidence. Tighten a definition the coders read differently and say how to "
        "choose between neighbours. Split a code that was used for visibly different things. Merge codes that could "
        "not be told apart. Add a code for something the jots notice that no code covers. Keep a code that is rare. "
        f"{PLAIN}\n\n"
        'Reply with the whole revised codebook as {"codes": [' + CODE_SHAPE.format(parts=", ".join(study.parts))
        + '], "changes": [{"what": "one line", "why": "the evidence behind it, one line"}]}'
    )


# ---------------------------------------------------------- the code around them


def _codes(reply: dict, study: studies.Study, n: int) -> list[dict]:
    """The usable codes in a reply, one of each name, with the ids the coders
    use. The ids are ours, not the model's; a made-up part or example is put right."""
    out, seen = [], set()
    for c in reply.get("codes") or []:
        if not isinstance(c, dict):
            continue
        name, definition = (str(c.get(k) or "").strip() for k in ("name", "definition"))
        if not name or not definition or name.lower() in seen:
            continue
        seen.add(name.lower())
        example = c.get("example")
        out.append({
            "id": f"C{len(out) + 1:02d}", "name": name, "definition": definition,
            "part": c.get("part") if c.get("part") in study.parts else study.parts[-1],
            "example": example if type(example) is int and 1 <= example <= n else 1,
        })
    return out


def _code(study: studies.Study, given: dict, codes: list[dict], numbers: list[int], seed: int, ask: Ask) -> dict:
    """One coder: every item in `numbers`, in this coder's own order."""
    order = list(numbers)
    random.Random(seed).shuffle(order)
    reply = ask(coder_prompt(study, given, codes, order))
    ids = {c["id"] for c in codes}
    got = reply.get("codes") if isinstance(reply.get("codes"), dict) else {}
    return {
        "codes": {n: ({c for c in got[str(n)] if c in ids} if isinstance(got.get(str(n)), list) else None) for n in numbers},
        "hard": [h for h in reply.get("hard_to_tell_apart") or [] if isinstance(h, dict)],
        "missed": [str(m)[:300] for m in reply.get("not_captured") or []],
    }


def _plain(coder: dict) -> dict:
    """A coder's work in a shape that can be written down."""
    return {**coder, "codes": {str(n): (sorted(v) if v is not None else None) for n, v in coder["codes"].items()}}


def _reconcile(codes: list[dict], a: dict, b: dict, numbers: list[int]) -> dict:
    """Where two coders agreed: per code, and which codes one swapped for another."""
    both = [n for n in numbers if a["codes"].get(n) is not None and b["codes"].get(n) is not None]
    if not both:
        raise RuntimeError("the coders' replies could not be read.")
    per = {}
    for c in codes:
        units = [(c["id"] in a["codes"][n], c["id"] in b["codes"][n]) for n in both]
        only_a = [n for n, (x, y) in zip(both, units) if x and not y]
        only_b = [n for n, (x, y) in zip(both, units) if y and not x]
        agreed = sum(x and y for x, y in units)
        per[c["id"]] = {
            "a": agreed + len(only_a), "b": agreed + len(only_b), "both": agreed, "either": agreed + len(only_a) + len(only_b),
            "kappa": stats.cohen_kappa(units), "only_a": only_a, "only_b": only_b,
        }
    swaps: Counter = Counter()
    for n in both:
        for x in a["codes"][n] - b["codes"][n]:
            for y in b["codes"][n] - a["codes"][n]:
                swaps[tuple(sorted((x, y)))] += 1
    return {
        "items": len(both), "exact": sum(a["codes"][n] == b["codes"][n] for n in both) / len(both), "per": per,
        "swaps": [[x, y, v] for (x, y), v in swaps.most_common() if v >= 2],
        "uncoded": [n for n in both if not a["codes"][n] and not b["codes"][n]],
    }


def _evidence(codes: list[dict], fit: dict, a: dict, b: dict) -> str:
    """What the two coders did with the draft, as the reviser reads it. Codes
    go by name: the ids mean nothing outside one round of coding."""
    names = {c["id"]: c["name"] for c in codes}
    lines = [
        f"Items both coders returned: {fit['items']}. Their code sets matched exactly on {fit['exact']:.0%}.",
        "Per code (times coder 1 used it, coder 2 used it, both; kappa; then the item numbers only one of them gave it):",
    ]
    for cid, p in fit["per"].items():
        kappa = "undefined" if p["kappa"] is None else f"{p['kappa']:.2f}"
        lines.append(
            f"{names[cid]}: {p['a']}, {p['b']}, {p['both']}; kappa {kappa}; only coder 1: {p['only_a'][:12] or 'none'}; "
            f"only coder 2: {p['only_b'][:12] or 'none'}"
        )
    if fit["swaps"]:
        lines.append(
            "Code pairs where one coder chose the first and the other chose the second on the same item: "
            + "; ".join(f"{names[x]} / {names[y]} on {v} items" for x, y, v in fit["swaps"][:15])
        )
    hard = [f"{' / '.join(names.get(str(x), str(x)) for x in h.get('codes') or [])}: {h.get('why', '')}" for h in a["hard"] + b["hard"]]
    if hard:
        lines.append("Codes the coders said they could not tell apart:\n" + "\n".join(f"- {h[:300]}" for h in hard[:20]))
    missed = list(dict.fromkeys(a["missed"] + b["missed"]))
    if missed:
        lines.append("What the coders said no code covers:\n" + "\n".join(f"- {m}" for m in missed[:20]))
    if fit["uncoded"]:
        lines.append(f"Items neither coder gave any code: {fit['uncoded'][:60]}")
    return "\n".join(lines)
