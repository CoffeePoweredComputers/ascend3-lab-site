"""Load the study app's own record of each session, for sessions already
imported by import_sessions. Run it where the data is:

    docker exec ascend-tool-annotate python -m annotate.import_telemetry /data/incoming/telemetry \\
        --sessions /data/incoming/export --dataset sessions --starts /data/incoming/telemetry/video-starts.csv

It reads raw/study_events.json, raw/study_assistant_messages.json,
raw/users.json and raw/studies.json, and a starts file with one line per
session: pid and started_at, the UTC time of the video's second 0. An event's
place on the video is its server time less that.

Kept: the steps the participant moved through in the main task (the module
of type "task") and the modules after it; the task's saved states of each
field in STATES, the full text each time; the map; the chat with the
assistant; and what the researcher pushed to the screen. Text is blanked
with the same names import_sessions blanks, read again from the sessions
export and the --names file. No id from the app is stored.

Safe to run again: a session's telemetry is replaced wholesale, since
nothing refers to it.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from annotate import config, db, import_sessions

TASK = "task"  # the instrument's module type for the main task
STATES = {"spec": "Specification", "entities": "Entities"}  # field -> name; saved as "<field>_edit"
EDIT = re.compile(r"^([a-z]+)_edit$")
STEP_EVENT = "step_advance"
PROMPT_EVENT = "researcher_push"
MAP_PREFIX = "map_"
SCENARIO_STEP = re.compile(r"^scenario_(\d+)_([a-z]+)(?:_(\d+))?$")
OTHER_STEP = re.compile(r"^([a-z]+(?:_[a-z]+)*?)(?:_(\d+))?$")
REFLECTIVE = ("retro", "reflect")  # a step whose phase starts so is answering questions


@dataclass
class Instrument:
    task: set[str] = field(default_factory=set)  # the main task's module id
    steps: set[str] = field(default_factory=set)  # it and every module after it
    scenarios: dict[str, list[str]] = field(default_factory=dict)  # module id -> its study's scenario texts


def instrument(studies: list[dict]) -> Instrument:
    """The main task module of each study, found by its type, not its id."""
    out = Instrument()
    for study in studies:
        modules = (study.get("authored_data") or {}).get("modules") or []
        at = next((i for i, m in enumerate(modules) if m.get("type") == TASK), None)
        if at is None:
            continue
        texts = [scenario_text(s) for s in modules[at].get("scenarios") or []]
        out.task.add(modules[at]["id"])
        for m in modules[at:]:
            out.steps.add(m["id"])
            out.scenarios[m["id"]] = texts
    return out


def scenario_text(scenario: dict) -> str:
    """A scenario as the participant read it: its title, then each clause."""
    parts = [scenario.get("title") or ""] + [c.get("text") or "" for c in scenario.get("clauses") or [] if isinstance(c, dict)]
    return "\n".join(p.strip() for p in parts if p and p.strip())


def parse_step(name: str) -> dict:
    """A step name as a header: scenario_1_revise -> Scenario 2 · revise,
    retro_0 -> Retro 1, initial_spec -> Initial spec. Numbers count from 0."""
    if m := SCENARIO_STEP.match(name):
        phase = m[2] + (f" {int(m[3]) + 1}" if m[3] else "")
        return {"label": f"Scenario {int(m[1]) + 1} · {phase}", "scenario": int(m[1]), "retro": m[2].startswith(REFLECTIVE)}
    if m := OTHER_STEP.match(name):
        words = m[1].replace("_", " ")
        return {"label": words.capitalize() + (f" {int(m[2]) + 1}" if m[2] else ""), "retro": words.startswith(REFLECTIVE)}
    return {"label": name or "Step", "retro": False}


def as_text(value) -> str:
    """A saved state as lines of text. A JSON list of named things, each with
    a list of named parts, is one line per thing: 'Name: part, part'."""
    if not isinstance(value, str):
        value = json.dumps(value)
    try:
        things = json.loads(value)
    except ValueError:
        return value
    if not isinstance(things, list):
        return value
    lines = []
    for thing in things:
        if not isinstance(thing, dict):
            lines.append(str(thing))
            continue
        parts = [str(p.get("name") or "") for v in thing.values() if isinstance(v, list) for p in v if isinstance(p, dict)]
        lines.append(str(thing.get("name") or "") + (": " + ", ".join(parts) if parts else ""))
    return "\n".join(lines)


def when(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp)


def timeline(events: list[dict], messages: list[dict], inst: Instrument, blank: Callable[[str], str], started: datetime) -> tuple[list[tuple[int, str, dict]], int]:
    """One session's rows, (ms on the video, kind, data), in time order.
    Returns them and how many field edits were outside the main task."""
    rows, skipped = [], 0
    last_step, shown, state = None, set(), {}
    for e in sorted(events, key=lambda e: when(e["created_at"])):
        kind, p, module = e["event_type"], e.get("payload") or {}, e.get("module_id")
        data = None
        if kind == STEP_EVENT and module in inst.steps:
            data = parse_step(str(p.get("to") or ""))
            if data["label"] == last_step:
                continue
            last_step = data["label"]
            k = data.get("scenario")
            if k is not None and k not in shown and k < len(inst.scenarios[module]):
                data["text"] = blank(inst.scenarios[module][k])  # what the participant is looking at
                shown.add(k)
            kind = "step"
        elif (m := EDIT.match(kind)) and m[1] in STATES:
            if module not in inst.task:
                skipped += 1
                continue
            text = blank(as_text(p.get("value", "")))
            if state.get(m[1]) == text:
                continue
            state[m[1]] = text
            kind, data = "edit", {"of": m[1], "text": text}
        elif kind.startswith(MAP_PREFIX) and module in inst.task:
            data = {"act": kind[len(MAP_PREFIX):].replace("_", " ")}
            if p.get("label"):
                data["label"] = blank(str(p["label"]))
            kind = "map"
        elif kind == PROMPT_EVENT:
            kind, data = "prompt", {"kind": str(p.get("kind") or "").replace("_", " "), "text": blank(str(p.get("text") or ""))}
        if data is not None:
            rows.append((e["created_at"], kind, data))
    for m in messages:
        rows.append((m["created_at"], "chat", {"who": "participant" if m["role"] == "user" else "assistant", "text": blank(m["content"] or "")}))
    rows.sort(key=lambda r: when(r[0]))  # stable, so chat in its stored order on a tie
    return [(round((when(at) - started).total_seconds() * 1000), kind, data) for at, kind, data in rows], skipped


def store(conn: sqlite3.Connection, session_id: int, started_at: str, rows: list[tuple[int, str, dict]]) -> None:
    conn.execute("DELETE FROM telemetry WHERE session_id = ?", (session_id,))
    conn.execute("UPDATE session SET started_at = ? WHERE id = ?", (started_at, session_id))
    conn.executemany(
        "INSERT INTO telemetry (session_id, t_ms, kind, data) VALUES (?, ?, ?, ?)",
        [(session_id, t, kind, json.dumps(data, ensure_ascii=False)) for t, kind, data in rows],
    )


def read_starts(path: Path) -> dict[str, str]:
    with open(path, encoding="utf-8", newline="") as f:
        return {r["pid"].strip(): r["started_at"].strip() for r in csv.DictReader(f) if r.get("pid") and r.get("started_at")}


def _sessions(conn: sqlite3.Connection, dataset: str) -> dict[str, sqlite3.Row]:
    found = conn.execute("SELECT id, kind FROM dataset WHERE slug = ?", (dataset,)).fetchone()
    if not found or found["kind"] != import_sessions.KIND:
        raise ValueError(f"No '{import_sessions.KIND}' dataset called {dataset}. Import its sessions first.")
    return {r["pid"]: r for r in conn.execute("SELECT id, pid, alias, duration_ms FROM session WHERE dataset_id = ? ORDER BY alias", (found["id"],))}


def run(folder: Path, export: Path, dataset: str, starts_path: Path, names: Optional[Path] = None, dry_run: bool = False) -> dict:
    raw = {name: json.loads((folder / "raw" / f"{name}.json").read_text(encoding="utf-8"))
           for name in ("study_events", "study_assistant_messages", "users", "studies")}
    starts = read_starts(starts_path)
    _, extra = import_sessions.read_names(names)
    hits: Counter = Counter()
    blank = import_sessions.blanker(import_sessions.names_of(import_sessions.scan(export), extra), hits)

    if dry_run:
        if not config.db_path().is_file():
            raise ValueError("No database yet. Import the sessions first.")
        conn = sqlite3.connect(f"file:{config.db_path()}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            sessions = _sessions(conn, dataset)
        finally:
            conn.close()
    else:
        db.init()
        with db.db() as conn:
            sessions = _sessions(conn, dataset)

    inst = instrument(raw["studies"])
    pid_of = {u["id"]: u["pid"] for u in raw["users"]}
    events, messages = defaultdict(list), defaultdict(list)
    for e in raw["study_events"]:
        events[pid_of.get(e["user_id"])].append(e)
    for m in raw["study_assistant_messages"]:
        messages[pid_of.get(m["user_id"])].append(m)

    built, skipped = {}, 0
    for pid in sessions:
        if pid in starts and (events[pid] or messages[pid]):
            built[pid], n = timeline(events[pid], messages[pid], inst, blank, when(starts[pid]))
            skipped += n
    rows = [(sessions[pid], r) for pid, rs in built.items() for r in rs]
    report = {
        "sessions_matched": len(built),
        "sessions_without_start": ", ".join(s["alias"] for pid, s in sessions.items() if pid not in starts) or "none",
        "sessions_without_events": ", ".join(s["alias"] for pid, s in sessions.items() if pid in starts and pid not in built) or "none",
        "starts_not_in_dataset": ", ".join(sorted(pid for pid in starts if pid not in sessions)) or "none",
        "rows": ", ".join(f"{k} {n}" for k, n in sorted(Counter(r[1] for _, r in rows).items())) or "none",
        "before_start": sum(r[0] < 0 for _, r in rows),
        "after_end": sum(r[0] > s["duration_ms"] for s, r in rows),
        "edits_outside_task": skipped,
        "names_blanked": ", ".join(f"{import_sessions.digest(n)} x{c}" for n, c in hits.most_common()) or "none",
    }
    if dry_run:
        return report
    with db.db() as conn:
        for pid, rs in built.items():
            store(conn, sessions[pid]["id"], starts[pid], rs)
    return report


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("folder", type=Path, help="the telemetry export, with raw/ in it")
    parser.add_argument("--sessions", type=Path, required=True, help="the sessions export the dataset was imported from, for the names")
    parser.add_argument("--dataset", required=True, help="the sessions dataset, e.g. sessions")
    parser.add_argument("--starts", type=Path, required=True, help="a CSV of pid,started_at (UTC, the video's second 0)")
    parser.add_argument("--names", type=Path, help="the same --names file given to import_sessions")
    parser.add_argument("--dry-run", action="store_true", help="count what is there, write nothing")
    args = parser.parse_args(argv)
    try:
        report = run(args.folder, args.sessions, args.dataset, args.starts, args.names, args.dry_run)
    except ValueError as e:
        raise SystemExit(str(e))
    for key, value in report.items():
        print(f"{key:24} {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
