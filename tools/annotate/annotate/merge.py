"""Grouping everyone's personal codes into proposed codes. Pure functions:
no database, no model.

A code here is a dict with id, roster_id, name, part and items (the set of
cards it is on). Only codes from different people, about the same part, are
ever grouped: two codes one person kept apart are different to that person.
"""

from __future__ import annotations

MIN_SHARED = 2      # cards two codes must share before the cards alone link them
MIN_OVERLAP = 0.5   # and the share of either code's cards that must be shared


def norm(name: str) -> str:
    return " ".join(name.lower().split())


def overlaps(codes: list[dict], done: dict[int, set[int]]) -> dict[tuple[int, int], tuple[int, int]]:
    """{(id, id): (cards both codes are on, cards either is on)} for every pair
    that can be compared, counting only cards both people finished. A card one
    of them never reached says nothing about whether they agree."""
    out = {}
    for n, a in enumerate(codes):
        for b in codes[n + 1:]:
            if a["roster_id"] == b["roster_id"] or a["part"] != b["part"]:
                continue
            both = done.get(a["roster_id"], set()) & done.get(b["roster_id"], set())
            on_a, on_b = a["items"] & both, b["items"] & both
            out[(a["id"], b["id"])] = (len(on_a & on_b), len(on_a | on_b))
    return out


def by_cards(codes: list[dict], done: dict[int, set[int]]) -> list[dict]:
    """Proposed codes without a model: two codes go together when they have
    the same name, or sit on mostly the same cards."""
    parent = {c["id"]: c["id"] for c in codes}
    by_id = {c["id"]: c for c in codes}

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    why: dict[int, list[str]] = {}
    for (a, b), (shared, either) in overlaps(codes, done).items():
        same_name = norm(by_id[a]["name"]) == norm(by_id[b]["name"])
        same_cards = shared >= MIN_SHARED and shared / either >= MIN_OVERLAP
        if same_name or same_cards:
            reason = "same name" if same_name else f"{shared} of {either} cards shared"
            ra, rb = root(a), root(b)
            parent[rb] = ra
            why[ra] = why.pop(ra, []) + why.pop(rb, []) + [reason]

    groups: dict[int, list[dict]] = {}
    for c in codes:
        groups.setdefault(root(c["id"]), []).append(c)
    out = []
    for key, members in groups.items():
        if len(members) < 2:
            continue
        lead = max(members, key=lambda c: (len(c["items"]), -c["id"]))  # the most used wording
        out.append({
            "part": lead["part"], "name": lead["name"], "definition": lead.get("definition", ""),
            "reason": "; ".join(dict.fromkeys(why[root(key)])), "ids": [c["id"] for c in members],
        })
    return out


def clean_themes(proposed: object, known: set[str]) -> list[dict]:
    """Make a model's themes safe to store: [{name, statement, codes}], codes
    as "dimension/code". A code it made up is dropped, a code named twice
    stays in the first theme, and a theme left with no name or no codes is
    no theme."""
    taken: set[str] = set()
    out = []
    for t in proposed if isinstance(proposed, list) else []:
        if not isinstance(t, dict):
            continue
        codes = [c for c in dict.fromkeys(str(c) for c in t.get("codes") or []) if c in known and c not in taken]
        name = str(t.get("name") or "").strip()
        if not name or not codes:
            continue
        taken.update(codes)
        out.append({"name": name, "statement": str(t.get("statement") or "").strip(), "codes": codes})
    return out


def clean(proposed: object, codes: list[dict], part: str, shared: dict[tuple[int, int], tuple[int, int]]) -> list[dict]:
    """Make a model's grouping safe to store. It may name a code that does not
    exist, put one code in two groups, or mix parts; each code is kept in the
    first group that names it and the rest is dropped. A group left with one
    code is no group. Returns the same shape as by_cards."""
    known = {c["id"]: c for c in codes if c["part"] == part}
    taken: set[int] = set()
    out = []
    for g in proposed if isinstance(proposed, list) else []:
        if not isinstance(g, dict):
            continue
        ids = []
        for raw in g.get("ids") or []:
            try:
                i = int(raw)
            except (TypeError, ValueError):
                continue
            if i in known and i not in taken and i not in ids:
                ids.append(i)
        name, definition = str(g.get("name") or "").strip(), str(g.get("definition") or "").strip()
        if len(ids) < 2 or not name or not definition:
            continue
        taken.update(ids)
        # Say how much the cards back the model up, in counts the team can check.
        most = max((shared.get((min(a, b), max(a, b)), (0, 0)) for a in ids for b in ids if a != b), default=(0, 0))
        cards = f"{most[0]} of {most[1]} cards shared" if most[0] else "no shared cards: grouped on wording alone"
        reason = str(g.get("reason") or "").strip()
        out.append({"part": part, "name": name, "definition": definition, "reason": f"{reason} ({cards})" if reason else cards, "ids": ids})
    return out
