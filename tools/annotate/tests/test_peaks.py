from annotate import peaks


def test_the_ladder_is_in_order_and_links_to_wikipedia():
    heights = [p.feet for p in peaks.PEAKS]
    assert heights == sorted(heights) and len({p.name for p in peaks.PEAKS}) == len(peaks.PEAKS)
    assert all(p.url.startswith("https://en.wikipedia.org/wiki/") and " " not in p.url for p in peaks.PEAKS)


def test_passed_and_ahead():
    first, everest = peaks.PEAKS[0], next(p for p in peaks.PEAKS if p.name == "Mount Everest")
    assert peaks.passed(first.feet - 1) is None and peaks.ahead(first.feet - 1) == first
    assert peaks.passed(everest.feet) == everest and peaks.ahead(everest.feet).feet > everest.feet
    assert peaks.ahead(10**9) is None and peaks.passed(10**9) == peaks.PEAKS[-1]


def test_only_landmarks_are_announced_and_the_highest_wins():
    assert peaks.crossed(3100, 3300).name == "Old Rag Mountain"  # McAfee Knob is passed too, lower down
    assert peaks.crossed(3100, 3100) is None
    assert peaks.crossed(95, 114) is None  # Rocher Clipperton is not a landmark, and it was already passed
    olympus = next(p for p in peaks.PEAKS if p.name == "Olympus Mons")
    assert olympus.landmark and olympus.where == "Mars"
