"""Candidate codes built in steps: a draft, two coders on half the items, a
revision, two coders on every item. The model is a stand-in; what is tested
is what goes to it, in what order, and what is made of its replies."""

import re

from helpers import stand_in_model

from annotate import steps, studies

STUDY = studies.get("ethics")


def given(n=60):
    words = ("privacy", "jobs", "blame")
    return {
        "jots": [{"item": f"topic: t{k} | question: q{k}", "jot": f"about {words[k % 3]}"} for k in range(1, n + 1)],
        "questions": ["What concerns do students raise?"],
    }


def test_the_four_steps_run_in_order_and_each_is_a_call_of_its_own():
    asked, told = [], []

    def ask(prompt):
        asked.append(prompt)
        return stand_in_model(prompt)

    found, note, run = steps.candidates(STUDY, given(), ask, told.append)
    kinds = ["draft" if "Draft the codes" in p else "revise" if "Revise the codebook" in p else "coder" for p in asked]
    assert kinds == ["draft", "coder", "coder", "revise", "coder", "coder"]
    assert [line[:11] for line in told] == ["Step 1 of 4", "Step 2 of 4", "Step 3 of 4", "Step 4 of 4"]

    # The draft and the revision see every jot and the team's questions.
    assert "RQ1: What concerns do students raise?" in asked[0] and "60. [topic: t60 | question: q60] -> about privacy" in asked[0]
    # The first two coders get half the items, each in its own order, with the jots; the last two get them all.
    first, second = (re.findall(r"^(\d+)\. \[", p, re.M) for p in asked[1:3])
    assert sorted(first) == sorted(second) and first != second and 30 <= len(first) <= 45
    assert "-> about" in asked[1] and len(re.findall(r"^\d+\. \[", asked[4], re.M)) == 60
    # The reviser is told what the coders did, by code name.
    assert "Their code sets matched exactly on 100%" in asked[3] and "who is to blame" in asked[3]

    # What comes back: the revised codes, most used first, a made-up part and a doubled name put right.
    assert [c["name"] for c in found] == ["Privacy", "Jobs", "Blame"]
    assert {c["part"] for c in found} == {"question"} and set(found[0]) == {"name", "definition", "part"}
    assert note.startswith("3 candidate code(s). Two model coders tried them on all 60 items and gave the same codes on 100%.")
    assert [c["name"] for c in run["draft"]] == ["Privacy", "Jobs"] and run["changes"][0]["what"] == "Added Blame"
    assert run["full_pass"]["agreement"]["per"]["C03"]["both"] == 20 and len(run["test_fit"]["sample"]) == len(first)


def test_coders_who_disagree_are_counted_and_the_unsteady_code_is_named():
    calls = {"coder": 0}

    def ask(prompt):
        reply = stand_in_model(prompt)
        if "Apply the codebook" in prompt:
            calls["coder"] += 1
            if calls["coder"] % 2 == 0:  # the second coder of each pair never uses Jobs
                jobs = re.search(r"^(C\d\d) \| Jobs \|", prompt, re.M).group(1)
                reply["codes"] = {k: [c for c in v if c != jobs] for k, v in reply["codes"].items()}
        return reply

    _, note, run = steps.candidates(STUDY, given(), ask)
    per = run["full_pass"]["agreement"]["per"]
    assert per["C02"]["a"] == 20 and per["C02"]["b"] == 0 and per["C02"]["both"] == 0 and len(per["C02"]["only_a"]) == 20
    assert "gave the same codes on 67%" in note and "Least steady: Jobs." in note


def test_a_check_that_cannot_finish_still_leaves_the_person_their_codes():
    def ask(prompt):
        if "Revise the codebook" in prompt:
            raise RuntimeError("The model's server could not be reached.")
        return stand_in_model(prompt)

    found, note, run = steps.candidates(STUDY, given(), ask)
    assert [c["name"] for c in found] == ["Privacy", "Jobs"]
    assert "could not be checked all the way" in note and "could not be reached" in note and "stopped" in run

    # A coder whose reply holds no codes at all is the same: there is nothing to compare.
    found, note, _ = steps.candidates(STUDY, given(), lambda p: {"codes": {}} if "Apply the codebook" in p else stand_in_model(p))
    assert len(found) == 2 and "could not be read" in note


def test_a_draft_with_no_codes_is_the_end_of_it():
    asked = []
    found, note, _ = steps.candidates(STUDY, given(), lambda p: asked.append(p) or {"codes": []})
    assert found == [] and note == "The model proposed nothing." and len(asked) == 1


def test_the_coders_can_be_kept_from_the_jots(monkeypatch):
    monkeypatch.setattr(steps, "CODERS_SEE_JOTS", False)
    prompt = steps.coder_prompt(STUDY, given(3), [{"id": "C01", "name": "Privacy", "definition": "d", "part": "question", "example": 1}], [1, 2, 3])
    assert "2. topic: t2 | question: q2\n" in prompt and "-> about" not in prompt and "jot" not in prompt
