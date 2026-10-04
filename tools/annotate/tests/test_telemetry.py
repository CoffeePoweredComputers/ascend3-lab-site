"""The study app's telemetry on a session's page: the importer, the rows set
in among the transcript's lines, the timeline and the specification panel.
The task, its wording and every name here are invented."""

import csv
import json
import re
from datetime import datetime, timedelta

import pytest
from conftest import CODER1, LEAD, OUTSIDER
from test_import_sessions import PEOPLE, RESEARCHER, export  # noqa: F401  (export is the fixture)
from test_session_page import jot, set_status
from test_sessions_pages import client, finish, study  # noqa: F401  (client and study are fixtures)

from annotate import db, import_telemetry

START = datetime.fromisoformat("2026-03-02T15:00:00+00:00")
USERS = {"usr-7f3a01": "kx101", "usr-7f3a02": "kx102", "usr-7f3a03": "kx103", "usr-7f3a99": "pilot9"}
SCENARIOS = [
    {"id": "scn-a", "title": "Dry spell", "clauses": [{"id": "c1", "text": "No rain for a week; the tomatoes wilt by noon."}]},
    {"id": "scn-b", "title": "Frost night", "clauses": [{"id": "c2", "text": "Ask Harbor about the frost cover."}]},
]
INSTRUMENT = [{"id": "stdy-1", "authored_data": {"modules": [
    {"id": "mod-warm", "type": "warmup"},
    {"id": "mod-task", "type": "task", "scenarios": SCENARIOS},
    {"id": "mod-wrap", "type": "wrap-up"},
]}}]
ENTITIES = json.dumps([{"id": "e1", "name": "Bed", "elements": [{"id": "x", "name": "moisture"}, {"id": "y", "name": "crop"}]}])
# (seconds on kx101's video, event type, payload, module)
EVENTS = [
    (-900, "spec_edit", {"value": "a warm-up answer"}, "mod-warm"),
    (-60, "step_advance", {"from": "intro", "to": "initial_spec"}, "mod-task"),
    (5, "spec_edit", {"value": "Water each bed daily."}, "mod-task"),
    (10, "spec_edit", {"value": "Water each bed daily.\nSkip after rain."}, "mod-task"),
    (15, "spec_edit", {"value": "Water each bed daily.\nSkip after rain, as Lantern says."}, "mod-task"),
    (16, "module_start", {"moduleNumber": 2}, "mod-task"),
    (50, "step_advance", {"from": "initial_spec", "to": "scenario_0_read"}, "mod-task"),
    (90, "step_advance", {"from": "scenario_0_read", "to": "scenario_0_revise"}, "mod-task"),
    (95, "entities_edit", {"value": ENTITIES}, "mod-task"),
    (121, "step_advance", {"from": "scenario_0_revise", "to": "scenario_0_retro_0"}, "mod-task"),
    (125, "researcher_push", {"kind": "retro_question", "text": "What did Teal miss?", "scenarioIdx": 0}, "mod-other"),
    (170, "step_advance", {"from": "scenario_0_retro_0", "to": "scenario_1_read"}, "mod-task"),
    (171, "step_advance", {"from": "scenario_0_retro_0", "to": "scenario_1_read"}, "mod-task"),
    (175, "map_marker_add", {"label": "Plum bed", "markerId": "mk-1"}, "mod-task"),
    (176, "map_cart_move", {"x": 1, "y": 2}, "mod-task"),
    (177, "map_cart_move", {"x": 3, "y": 4}, "mod-task"),
    (330, "step_advance", {"from": "intro", "to": "retro_0"}, "mod-wrap"),
    (400, "spec_edit", {"value": "late"}, "mod-task"),
]
CHAT = [(65, "user", "Should Orange water twice a day?"), (66, "assistant", "A soil sensor would tell you.")]
IDS = ["usr-7f3a", "evt-91c2", "msg-55d0", "stdy-1", "mod-task", "scn-a", "mk-1"]
NAMES = ("teal", "harbor", "orange", "lantern", "plum", "anchor", "grey", "meadow")


def stamp(seconds: float) -> str:
    return (START + timedelta(seconds=seconds)).isoformat(timespec="microseconds")


@pytest.fixture()
def telemetry(tmp_path):
    """An export for kx101 (all of the above), kx102 (no start time) and
    kx103 (one message), and a start time for a pid not in the dataset."""
    root = tmp_path / "telemetry"
    (root / "raw").mkdir(parents=True)
    events = [
        {"id": f"evt-91c2-{n}", "user_id": "usr-7f3a01", "study_id": "stdy-1", "module_id": module, "event_type": kind, "payload": payload, "created_at": stamp(t)}
        for n, (t, kind, payload, module) in enumerate(EVENTS)
    ]
    events.append({"id": "evt-91c2-x", "user_id": "usr-7f3a02", "study_id": "stdy-1", "module_id": "mod-task",
                   "event_type": "spec_edit", "payload": {"value": "no start"}, "created_at": stamp(20)})
    messages = [
        {"id": f"msg-55d0-{n}", "user_id": "usr-7f3a01", "module_id": "mod-task", "scenario_idx": 0, "role": role, "content": text,
         "state_spec": "", "state_entities": [], "created_at": stamp(t)}
        for n, (t, role, text) in enumerate(CHAT)
    ]
    messages.append({"id": "msg-55d0-x", "user_id": "usr-7f3a03", "module_id": "mod-task", "scenario_idx": 0, "role": "user",
                     "content": "Hello?", "state_spec": "", "state_entities": [], "created_at": stamp(30)})
    for name, rows in (("study_events", events), ("study_assistant_messages", messages), ("studies", INSTRUMENT),
                       ("users", [{"id": k, "pid": v} for k, v in USERS.items()])):
        (root / "raw" / f"{name}.json").write_text(json.dumps(rows))
    with open(root / "video-starts.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["pid", "started_at", "source"])
        for pid in ("kx101", "kx103", "kx999"):
            writer.writerow([pid, START.isoformat(), "clock"])
    return root


def load(telemetry, export, **kwargs):  # noqa: F811
    return import_telemetry.run(telemetry, export, "sessions", telemetry / "video-starts.csv", **kwargs)


def table(name: str) -> list[dict]:
    with db.db() as conn:
        return [dict(r) for r in conn.execute(f"SELECT * FROM {name}")]


def alias(pid: str) -> str:
    with db.db() as conn:
        return conn.execute("SELECT alias FROM session WHERE pid = ?", (pid,)).fetchone()["alias"]


def rows(pid: str) -> list[dict]:
    with db.db() as conn:
        return [dict(r, data=json.loads(r["data"])) for r in conn.execute(
            "SELECT t.t_ms, t.kind, t.data FROM telemetry t JOIN session s ON s.id = t.session_id WHERE s.pid = ? ORDER BY t.t_ms, t.id", (pid,)
        )]


def test_a_dry_run_counts_and_writes_nothing(study, telemetry, export):  # noqa: F811
    report = load(telemetry, export, dry_run=True)
    assert report["sessions_matched"] == 2
    assert report["sessions_without_start"] == alias("kx102") and report["starts_not_in_dataset"] == "kx999"
    assert report["rows"] == "chat 3, edit 5, map 3, prompt 1, step 6"
    assert (report["before_start"], report["after_end"], report["edits_outside_task"]) == (1, 1, 1)
    assert report["names_blanked"] != "none"
    assert not table("telemetry") and {s["started_at"] for s in table("session")} == {None}


def test_times_are_measured_from_the_start_of_the_video(study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    got = rows("kx101")
    assert [r["t_ms"] for r in got] == [-60_000, 5_000, 10_000, 15_000, 50_000, 65_000, 66_000, 90_000, 95_000, 121_000, 125_000,
                                        170_000, 175_000, 176_000, 177_000, 330_000, 400_000]
    assert [r["kind"] for r in got][:7] == ["step", "edit", "edit", "edit", "step", "chat", "chat"]
    assert [r["t_ms"] for r in rows("kx103")] == [30_000] and rows("kx102") == []
    started = {s["pid"]: s["started_at"] for s in table("session")}
    assert started == {"kx101": START.isoformat(), "kx102": None, "kx103": START.isoformat()}


def test_steps_are_labelled_and_the_first_of_a_scenario_carries_its_text(study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    steps = [r["data"] for r in rows("kx101") if r["kind"] == "step"]
    assert [s["label"] for s in steps] == ["Initial spec", "Scenario 1 · read", "Scenario 1 · revise", "Scenario 1 · retro 1", "Scenario 2 · read", "Retro 1"]
    assert [s["retro"] for s in steps] == [False, False, False, True, False, True]
    assert steps[1]["text"] == "Dry spell\nNo rain for a week; the tomatoes wilt by noon."
    assert steps[4]["text"] == "Frost night\nAsk [name] about the frost cover." and "text" not in steps[2]


def test_only_the_main_tasks_edits_are_kept(study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    edits = [r["data"] for r in rows("kx101") if r["kind"] == "edit"]
    assert [e["of"] for e in edits] == ["spec", "spec", "spec", "entities", "spec"]
    assert edits[3]["text"] == "Bed: moisture, crop"
    assert "a warm-up answer" not in json.dumps(table("telemetry"))


def test_no_name_or_id_is_stored(study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    with db.db() as conn:
        tables = [r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    stored = " ".join(str(v) for t in tables for row in table(t) for v in row.values())
    for word in NAMES:
        assert word not in stored.casefold()
    for label in (RESEARCHER, *PEOPLE.values()):
        assert label not in stored
    for secret in IDS + list(USERS):
        assert secret not in stored
    by_kind = {r["kind"]: r["data"] for r in rows("kx101")}
    assert by_kind["chat"]["text"] == "A soil sensor would tell you."
    texts = json.dumps([r["data"] for r in rows("kx101")])
    assert "Should [name] water twice a day?" in texts and "Skip after rain, as [name] says." in texts
    assert "What did [name] miss?" in texts and "[name] bed" in texts


def test_running_again_replaces_and_does_not_duplicate(study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    before = table("telemetry")
    load(telemetry, export)
    after = table("telemetry")
    assert len(after) == len(before) and not {r["id"] for r in after} & {r["id"] for r in before}
    assert [(r["t_ms"], r["data"]) for r in after] == [(r["t_ms"], r["data"]) for r in before]


def page(client, study, pid="kx101", headers=CODER1) -> str:  # noqa: F811
    response = client.get(f"/t/{study}/session/{alias(pid)}", headers=headers)
    assert response.status_code == 200
    return response.text


def test_the_page_sets_the_record_in_among_the_lines(client, study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    text = page(client, study)
    where = lambda s: text.index(s)  # noqa: E731
    line = lambda ms: where(f'data-t="{ms}"')  # noqa: E731
    # The step under way at 0 heads the transcript; edits between two lines are one row.
    assert where("<b>Initial spec</b>") < line(0) < where("specification edited ×3") < line(20_000)
    assert line(40_000) < where("<b>Scenario 1 · read</b>") < where("No rain for a week") < line(60_000)
    assert line(60_000) < where("Should [name] water twice a day?") < where("A soil sensor would tell you.") < line(80_000)
    assert where("Chat · participant") < where("Chat · assistant")
    assert line(80_000) < where("<b>Scenario 1 · revise</b>") < line(100_000) and where("entities edited") < line(100_000)
    assert line(120_000) < where("Prompt · retro question") < where("What did [name] miss?") < line(140_000)
    assert line(160_000) < where("<b>Scenario 2 · read</b>") < where("map: marker add, cart move ×2 · “[name] bed”") < line(180_000)
    assert "late" not in text  # past the end of the video
    # Lines in the reflection step are marked; the others are not.
    marked = [int(t) for t in re.findall(r'<li class="line [^"]*line--retro[^"]*" data-t="(\d+)"', text)]
    assert marked == [140_000, 160_000, 340_000]
    # The rows take no jot and are not lines the script follows.
    assert len(re.findall(r'<li class="line[^"]*" data-t=', text)) == 18
    assert not re.search(r'<li class="(tel|tstep)[^"]*"[^>]* data-(t|seq)=', text)
    # The timeline and the panel, with their script.
    assert 'data-timeline data-duration="365500"' in text and "static/telemetry.js" in text
    assert 'data-at="0" data-to="50000" title="Initial spec"' in text and 'data-key="s"' in text
    assert text.count('class="tl__tick"') == 4 + 3 + 2 + 1
    for secret in IDS + list(USERS) + list(PEOPLE):
        assert secret not in text


def test_a_session_without_telemetry_renders_as_before(client, study, telemetry, export):  # noqa: F811
    before = page(client, study, "kx102")
    load(telemetry, export)
    assert page(client, study, "kx102") == before
    assert "data-timeline" not in before and "telemetry.js" not in before and "tel--" not in before


def test_jots_still_work_beside_the_record(client, study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    finish(study, 0)
    with db.db() as conn:
        assert conn.execute("SELECT alias FROM session WHERE pid = 'kx101'").fetchone()["alias"]
    response = jot(client, CODER1, 1, "right after the edits", alias=alias("kx101"))
    assert response.status_code == 200 and response.json() == {"body": "right after the edits"}
    text = page(client, study)
    assert text.index("specification edited ×3") < text.index("right after the edits</p>") < text.index('data-t="40000"')


def state(client, study, at, since="save", headers=CODER1):  # noqa: F811
    response = client.get(f"/t/{study}/session/{alias('kx101')}/state", params={"at": at, "since": since}, headers=headers)
    assert response.status_code == 200
    return response.json()


def test_the_state_route_gives_the_fields_as_they_stood(client, study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    first = state(client, study, 1_000)
    assert first["saved"] is None and first["from"] is None and first["until"] == 5_000
    assert [f["name"] for f in first["fields"]] == ["Specification", "Entities"] and all(f["lines"] == [] for f in first["fields"])

    between = state(client, study, 12_000)
    assert (between["saved"], between["from"], between["until"]) == (10_000, 10_000, 15_000)
    assert between["fields"][0]["lines"] == [["", "Water each bed daily."], ["add", "Skip after rain."]]

    # The latest save was the entities; the specification shows no change.
    later = state(client, study, 100_000)
    assert later["fields"][0]["lines"] == [["", "Water each bed daily."], ["", "Skip after rain, as [name] says."]]
    assert later["fields"][1]["lines"] == [["add", "Bed: moisture, crop"]] and later["until"] == 400_000

    # Against the start of the scenario (its read step at 50 s), until the next step.
    scenario = state(client, study, 100_000, "scenario")
    assert (scenario["from"], scenario["until"]) == (95_000, 121_000)
    assert scenario["fields"][1]["lines"] == [["add", "Bed: moisture, crop"]]
    assert all(mark == "" for mark, _ in scenario["fields"][0]["lines"])
    next_one = state(client, study, 200_000, "scenario")
    assert all(mark == "" for f in next_one["fields"] for mark, _ in f["lines"])

    after = state(client, study, 500_000)
    assert after["fields"][0]["lines"] == [["del", "Water each bed daily."], ["del", "Skip after rain, as [name] says."], ["add", "late"]]
    assert after["until"] is None


def test_the_state_route_is_for_the_roster(client, study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    url = f"/t/{study}/session/{alias('kx101')}/state?at=0"
    assert client.get(url, headers=OUTSIDER).status_code == 403
    assert client.get(f"/t/{study}/session/S09/state?at=0", headers=LEAD).status_code == 404


def test_an_excluded_episode_shows_a_coder_none_of_its_record(client, study, telemetry, export):  # noqa: F811
    load(telemetry, export)
    with db.db() as conn:
        ep = conn.execute(
            "SELECT sp.item_id, sp.t_start_ms, sp.t_end_ms FROM item_span sp JOIN session s ON s.id = sp.session_id"
            " WHERE s.pid = 'kx101' AND sp.t_start_ms <= 65000 AND sp.t_end_ms > 65000"
        ).fetchone()
    set_status(ep["item_id"], "excluded")
    assert "A soil sensor" not in page(client, study) and "A soil sensor" in page(client, study, headers=LEAD)
    hidden = state(client, study, 65_000)
    assert hidden == {"hidden": True, "from": ep["t_start_ms"], "until": ep["t_end_ms"]}
    assert "fields" in state(client, study, 65_000, headers=LEAD)
