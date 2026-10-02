"""Agreement statistics. Pure functions, no database.

Every function takes `units`: one row per item, one entry per coder, with None
where that coder did not code the item. Values are nominal category labels.

Each returns None when the statistic is undefined. In particular, when only
one category was ever used there is no variation to correct for chance
against, and the chance-corrected statistics are undefined rather than 1: a
code nobody applied is not evidence that coders agree on when to apply it.

Cohen's kappa and Gwet's AC1 use the same formulas as the wiki's
KappaCalculator (src/components/wiki/KappaCalculator.astro), so the two give
the same number for the same 2x2 table.
"""

from __future__ import annotations

from collections import Counter
from typing import Hashable, Optional, Sequence

Units = Sequence[Sequence[Optional[Hashable]]]


def _rated(units: Units) -> list[list[Hashable]]:
    """Rows with at least two ratings, missing values dropped."""
    rows = [[v for v in row if v is not None] for row in units]
    return [row for row in rows if len(row) >= 2]


def _one_category(rows: list[list[Hashable]]) -> bool:
    return len({v for row in rows for v in row}) < 2


def percent_agreement(units: Units) -> Optional[float]:
    """Mean, over items, of the share of coder pairs that agree."""
    rows = _rated(units)
    if not rows:
        return None
    total = 0.0
    for row in rows:
        r = len(row)
        counts = Counter(row)
        total += sum(c * (c - 1) for c in counts.values()) / (r * (r - 1))
    return total / len(rows)


def cohen_kappa(units: Units) -> Optional[float]:
    """Two coders only, over the items both coded."""
    if not units or any(len(row) != 2 for row in units):
        return None
    pairs = [(a, b) for a, b in units if a is not None and b is not None]
    if not pairs or _one_category([list(p) for p in pairs]):
        return None
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    first = Counter(a for a, _ in pairs)
    second = Counter(b for _, b in pairs)
    pe = sum(first[c] * second[c] for c in first.keys() | second.keys()) / (n * n)
    if pe == 1:
        return None
    return (po - pe) / (1 - pe)


def krippendorff_alpha(units: Units) -> Optional[float]:
    """Nominal alpha. Any number of coders, missing data allowed."""
    rows = _rated(units)
    if not rows or _one_category(rows):
        return None
    coincidences: Counter = Counter()
    for row in rows:
        m = len(row)
        counts = Counter(row)
        for c, n_c in counts.items():
            for k, n_k in counts.items():
                pairs = n_c * (n_c - 1) if c == k else n_c * n_k
                coincidences[(c, k)] += pairs / (m - 1)
    totals: Counter = Counter()
    for (c, _), value in coincidences.items():
        totals[c] += value
    n = sum(totals.values())
    observed = sum(v for (c, k), v in coincidences.items() if c != k) / n
    expected = sum(totals[c] * totals[k] for c in totals for k in totals if c != k) / (n * (n - 1))
    if expected == 0:
        return None
    return 1 - observed / expected


def gwet_ac1(units: Units, n_categories: Optional[int] = None) -> Optional[float]:
    """Gwet's AC1 for any number of coders. `n_categories` is how many
    categories were available, which can be more than were used."""
    rows = _rated(units)
    if not rows or _one_category(rows):
        return None
    used = {v for row in rows for v in row}
    q = max(n_categories or 0, len(used))
    pa = percent_agreement(units)
    # pi_k: the mean, over items, of the share of that item's coders choosing k.
    # Gwet's definition: agreement over items with two or more ratings, but the
    # category shares over every item anyone rated.
    seen = [r for r in ([v for v in row if v is not None] for row in units) if r]
    pi: Counter = Counter()
    for row in seen:
        for value, count in Counter(row).items():
            pi[value] += count / len(row)
    pe = sum((p / len(seen)) * (1 - p / len(seen)) for p in pi.values()) / (q - 1)
    if pe == 1:
        return None
    return (pa - pe) / (1 - pe)


def band(value: Optional[float]) -> str:
    """Landis and Koch (1977). A rough heuristic, not a standard."""
    if value is None:
        return "undefined (no variation)"
    if value < 0:
        return "poor"
    for limit, name in ((0.2, "slight"), (0.4, "fair"), (0.6, "moderate"), (0.8, "substantial")):
        if value <= limit:
            return name
    return "almost perfect"
