"""Statistics against worked examples with known answers."""

import pytest

from annotate import stats

N = None


def table(a, b, c, d):
    """A 2x2 table as units: a both present, b only the first coder, c only the
    second, d both absent. The same layout as the wiki's KappaCalculator."""
    return [(1, 1)] * a + [(1, 0)] * b + [(0, 1)] * c + [(0, 0)] * d


def test_cohen_kappa_textbook_table():
    assert stats.cohen_kappa(table(20, 5, 10, 15)) == pytest.approx(0.40)


# The three presets in src/components/wiki/KappaCalculator.astro. The tool and
# the lesson must give the same numbers for the same table.
@pytest.mark.parametrize(
    "cells, kappa, ac1",
    [
        ((40, 8, 7, 45), 0.699, 0.700),
        ((85, 5, 8, 2), 0.167, 0.846),  # the kappa paradox
        ((25, 0, 0, 25), 1.0, 1.0),
    ],
)
def test_matches_wiki_calculator_presets(cells, kappa, ac1):
    units = table(*cells)
    assert stats.cohen_kappa(units) == pytest.approx(kappa, abs=0.001)
    assert stats.gwet_ac1(units, 2) == pytest.approx(ac1, abs=0.001)


def test_kappa_paradox_has_high_raw_agreement():
    assert stats.percent_agreement(table(85, 5, 8, 2)) == pytest.approx(0.87)


def test_krippendorff_two_observers_binary():
    # Krippendorff (2011), Computing Krippendorff's Alpha-Reliability, example B.
    a = [0, 1, 0, 0, 0, 0, 0, 0, 1, 0]
    b = [1, 1, 1, 0, 0, 1, 0, 0, 0, 0]
    assert stats.krippendorff_alpha(list(zip(a, b))) == pytest.approx(0.095, abs=0.001)


def test_krippendorff_four_observers_with_missing_data():
    # Krippendorff (2011), example C: nominal alpha = 0.743.
    a = [1, 2, 3, 3, 2, 1, 4, 1, 2, N, N, N]
    b = [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, N, 3]
    c = [N, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, N]
    d = [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, N]
    assert stats.krippendorff_alpha(list(zip(a, b, c, d))) == pytest.approx(0.743, abs=0.001)


def test_alpha_equals_one_on_perfect_agreement_with_variation():
    assert stats.krippendorff_alpha([(1, 1), (2, 2), (1, 1)]) == pytest.approx(1.0)


def test_kappa_needs_exactly_two_coders():
    assert stats.cohen_kappa([(1, 1, 1), (0, 0, 1)]) is None


def test_kappa_ignores_items_one_coder_skipped():
    units = table(20, 5, 10, 15) + [(1, N), (N, 0)]
    assert stats.cohen_kappa(units) == pytest.approx(0.40)


@pytest.mark.parametrize("fn", [stats.cohen_kappa, stats.krippendorff_alpha, stats.gwet_ac1])
def test_no_variation_is_undefined_not_perfect(fn):
    # A code that neither coder ever applied: full raw agreement, no evidence.
    units = [(0, 0)] * 10
    assert stats.percent_agreement(units) == 1.0
    assert fn(units) is None


@pytest.mark.parametrize(
    "fn",
    [stats.percent_agreement, stats.cohen_kappa, stats.krippendorff_alpha, stats.gwet_ac1],
)
def test_nothing_double_coded_is_undefined(fn):
    assert fn([]) is None
    assert fn([(1, N), (N, 0)]) is None


def test_ac1_counts_unused_categories():
    units = [("a", "a"), ("b", "b"), ("a", "b")]
    assert stats.gwet_ac1(units, 5) > stats.gwet_ac1(units, 2)


def test_bands():
    assert stats.band(None).startswith("undefined")
    assert stats.band(-0.1) == "poor"
    assert stats.band(0.4) == "fair"
    assert stats.band(0.41) == "moderate"
    assert stats.band(0.9) == "almost perfect"
