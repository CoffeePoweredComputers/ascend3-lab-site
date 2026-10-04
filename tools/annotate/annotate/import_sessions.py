"""Load an export of recorded sessions: one video and one timestamped
transcript each. Run it where the data is, inside the container on the server:

    docker exec ascend-tool-annotate python -m annotate.import_sessions /data/incoming/export \\
        --dataset sessions --title "Think-aloud sessions" --lead someone@vt.edu

One item is an episode: a stretch of one session. A session is cut where the
researcher next speaks once an episode has run a minute, or at two and a half
minutes if they do not, so the episodes of a session tile it end to end.

It reads session-index.csv, file-manifest.csv and, for each session in the
"study" collection, one transcript JSON and the primary video. Nothing else in
the export is opened.

Speaker labels in the export are people's names. None is stored: each becomes
a role, and its parts are blanked where they are spoken. A label that cannot
be given a role stops the import before anything is copied or written.

Safe to run again: a session that is already there is left alone with its
items. One whose transcript or cut has changed is reported and not touched,
unless --replace, which starts the dataset's items afresh and is refused once
anyone has worked on them.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import re
import shutil
import sqlite3
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from annotate import config, db, importer, repo, studies

KIND = "sessions"
COLLECTION = "study"
CUT_RULE = "ep-v1"
TARGET_MS = 60_000  # an episode can end at the researcher's next prompt after this
CAP_MS = 150_000  # and ends here if there was none
MIN_MS = 20_000  # a shorter last piece joins the episode before it
RESEARCHER_SESSIONS = 3  # a label on this many sessions is the researcher
ROLES = {"R": "Researcher", "P": "Participant", "?": "Speaker"}
BLANK = "[name]"
GENERIC = "speaker"  # the export's label for a line nobody was matched to
LONG_WORDS = 150
ORDER_GAP = 1e-3  # between two sessions in the reading order
ITEM_STEP = 1e-6  # between two episodes of one session
CHUNK = 1 << 20


@dataclass
class Seg:
    start: int
    end: int
    label: str  # "" when the export names nobody
    text: str
    src_id: str
    src_ordinal: int
    role: str = "?"


@dataclass
class Session:
    pid: str
    video: Path
    sha256: str
    size: int
    duration_ms: int
    kind: str
    version: str
    segs: list[Seg]
    dropped: int = 0  # lines of the duplicate, unnamed track
    clamped: int = 0
    episodes: list[tuple[int, int, int, int]] = field(default_factory=list)  # start ms, end ms, first seg, last seg


def digest(text: str) -> str:
    """How a label or a name is referred to in reports and in the names file."""
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def normalize(rows: list[dict]) -> tuple[list[Seg], int, int]:
    """The transcript's lines in time order. Returns (lines, unnamed lines
    dropped, end times fixed). Where a transcript has named speakers, its
    lines labelled only "speaker" are a second pass over the same audio and
    are dropped. The stored order is not time order, so it only breaks ties."""
    named = any(r["speaker"] not in (None, GENERIC) for r in rows)
    kept = [r for r in rows if not (named and r["speaker"] == GENERIC)]
    kept.sort(key=lambda r: (r["t_start_ms"], r["ordinal"]))
    clamped = sum(r["t_end_ms"] < r["t_start_ms"] for r in kept)
    segs = [
        Seg(
            start=r["t_start_ms"], end=max(r["t_end_ms"], r["t_start_ms"]),
            label="" if r["speaker"] in (None, GENERIC) else r["speaker"],
            text=" ".join(r["text"].split()), src_id=r["id"], src_ordinal=r["ordinal"],
        )
        for r in kept
    ]
    return segs, len(rows) - len(kept), clamped


def scan(folder: Path) -> list[Session]:
    """Every study session in the export, checked before anything is copied:
    a bad file found halfway would leave videos behind in /data."""
    with open(folder / "session-index.csv", encoding="utf-8", newline="") as f:
        index = [r for r in csv.DictReader(f) if r["collection"] == COLLECTION]
    with open(folder / "file-manifest.csv", encoding="utf-8", newline="") as f:
        manifest = {r["path"]: r for r in csv.DictReader(f)}
    sessions = []
    for row in index:
        pid = row["participant_id"]
        video = folder / row["primary_video"]
        listed = manifest.get(row["primary_video"])
        if not video.is_file() or not listed:
            raise ValueError(f"Session {pid}: the primary video is missing or not in file-manifest.csv.")
        transcripts = folder / "sessions" / COLLECTION / pid / "transcripts"
        # "restored" is the punctuated version; "original" is what there is otherwise.
        path = next((p for k in ("restored", "original") if (p := transcripts / f"{pid}.{k}.json").is_file()), None)
        if not path:
            raise ValueError(f"Session {pid}: no transcript.")
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = data.get("segments") or []
        for n, r in enumerate(rows, start=1):
            if not (isinstance(r.get("t_start_ms"), int) and isinstance(r.get("t_end_ms"), int) and isinstance(r.get("ordinal"), int)
                    and isinstance(r.get("text"), str) and isinstance(r.get("id"), str) and "speaker" in r):
                raise ValueError(f"{path.name}, segment {n}: missing or mistyped fields.")
        if not rows:
            raise ValueError(f"Session {pid}: the transcript is empty.")
        segs, dropped, clamped = normalize(rows)
        sessions.append(Session(
            pid=pid, video=video, sha256=listed["sha256"], size=int(listed["bytes"]),
            duration_ms=max(round(float(row["video_duration_seconds"]) * 1000), segs[-1].start + 1),
            kind=data["version"]["kind"], version=data["version"]["id"], segs=segs, dropped=dropped, clamped=clamped,
        ))
    if not sessions:
        raise ValueError(f"No '{COLLECTION}' sessions in session-index.csv.")
    return sessions


def classify(sessions: list[Session], given: dict[str, str]) -> None:
    """Give every line a role. A label on several sessions is the researcher;
    a session's one other label is its participant. `given` (label digest ->
    role) settles what that rule cannot. Raises before anything is written."""
    on = Counter(label for s in sessions for label in {g.label for g in s.segs if g.label})
    problems = []
    for s in sessions:
        labels = Counter(g.label for g in s.segs if g.label)
        roles = {label: given[digest(label)] for label in labels if digest(label) in given}
        rest = [label for label in labels if label not in roles]
        for label in rest:
            if on[label] >= RESEARCHER_SESSIONS:
                roles[label] = "R"
        rest = [label for label in rest if label not in roles]
        if len(rest) == 1 and "P" not in roles.values():
            roles[rest[0]] = "P"
            rest = []
        problems += [f"session {s.pid}: label {digest(label)} on {labels[label]} lines" for label in rest]
        for g in s.segs:
            g.role = roles.get(g.label, "?")
    if problems:
        raise ValueError(
            "These speaker labels could not be given a role. Add a line 'digest,R' (or P, or ?) for each to the --names file:\n  "
            + "\n  ".join(problems)
        )


def name_parts(label: str) -> set[str]:
    """The words a label is made of: 'TealHarbor' -> Teal, Harbor. Shorter
    than three letters is not a name; a label cut short can end in one."""
    return {w for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+", label) + [label] if len(w) >= 3}


def names_of(sessions: list[Session], extra: set[str]) -> set[str]:
    """Every word to blank: the parts of every speaker label, and the --names file's words."""
    return {part for s in sessions for g in s.segs if g.label for part in name_parts(g.label)} | extra


def blanker(names: set[str], hits: Counter) -> Callable[[str], str]:
    """A function that blanks every name part in a text, counting each in `hits`."""
    if not names:
        return lambda text: text
    pattern = re.compile(r"\b(" + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r")\b", re.IGNORECASE)

    def blank(match: re.Match) -> str:
        hits[match[0].casefold()] += 1
        return BLANK

    return lambda text: pattern.sub(blank, text)


def scrub(sessions: list[Session], extra: set[str]) -> Counter:
    """Blank every name part where it is spoken. Returns hits per name."""
    hits: Counter = Counter()
    blank = blanker(names_of(sessions, extra), hits)
    for s in sessions:
        for g in s.segs:
            g.text = blank(g.text)
    return hits


def cut_episodes(segs: list[Seg], duration_ms: int) -> list[tuple[int, int, int, int]]:
    """(start ms, end ms, first line, last line) for each episode. The first
    starts at 0, each ends where the next starts, the last at the video's end.
    A line belongs to the episode its start falls in; end times are not used,
    since many run long."""
    firsts, began = [0], 0
    for i in range(1, len(segs)):
        ran = segs[i].start - began
        prompt = segs[i].role == "R" and segs[i - 1].role == "P"
        if ran >= CAP_MS or ran >= TARGET_MS and prompt:
            firsts.append(i)
            began = segs[i].start
    if len(firsts) > 1 and duration_ms - segs[firsts[-1]].start < MIN_MS:
        firsts.pop()
    starts = [0] + [segs[i].start for i in firsts[1:]]
    ends = starts[1:] + [duration_ms]
    lasts = [i - 1 for i in firsts[1:]] + [len(segs) - 1]
    return list(zip(starts, ends, firsts, lasts))


def episode_text(segs: list[Seg]) -> str:
    """An episode as it is stored for reading without the video: one line per
    turn, the role in front."""
    turns: list[list[str]] = []
    role = None
    for g in segs:
        if g.role != role:
            turns.append([ROLES[g.role] + ":"])
            role = g.role
        turns[-1].append(g.text)
    return "\n".join(" ".join(turn) for turn in turns)


def capitalised(sessions: list[Session]) -> list[tuple[str, int]]:
    """Words that are capitalised mid-sentence and never appear in lower case:
    what a name the labels did not give away would look like. For the lead to
    read, and to put in the --names file."""
    lower, found = set(), Counter()
    for s in sessions:
        for g in s.segs:
            for m in re.finditer(r"[A-Za-z][A-Za-z'’-]*", g.text):
                word = m[0]
                if word.islower():
                    lower.add(word)
                elif word[0].isupper() and word[1:].isalpha() and word[1:].islower() and g.text[: m.start()].rstrip()[-1:] not in ("", ".", "?", "!", "…", "]"):
                    found[word] += 1
    return sorted(((w, n) for w, n in found.items() if w.lower() not in lower), key=lambda x: (-x[1], x[0]))


def read_names(path: Optional[Path]) -> tuple[dict[str, str], set[str]]:
    """The --names file: one per line, either 'digest,role' for a speaker
    label the rule could not place, or a word to blank where it is spoken."""
    given, extra = {}, set()
    for line in path.read_text(encoding="utf-8").splitlines() if path else ():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, role = line.partition(",")
        if role.strip() in ROLES:
            given[key.strip()] = role.strip()
        else:
            extra.add(line)
    return given, extra


def quantile(values: list[int], q: float) -> int:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def prepare(folder: Path, names: Optional[Path]) -> tuple[list[Session], dict]:
    sessions = scan(folder)
    given, extra = read_names(names)
    classify(sessions, given)
    hits = scrub(sessions, extra)
    for s in sessions:
        s.episodes = cut_episodes(s.segs, s.duration_ms)
    seconds = [(end - start) // 1000 for s in sessions for start, end, _, _ in s.episodes]
    per = [len(s.episodes) for s in sessions]
    report = {
        "sessions": len(sessions),
        "transcripts": ", ".join(f"{n} {k}" for k, n in sorted(Counter(s.kind for s in sessions).items())),
        "lines_kept": sum(len(s.segs) for s in sessions),
        "unnamed_lines_dropped": sum(s.dropped for s in sessions),
        "end_times_fixed": sum(s.clamped for s in sessions),
        "long_lines": sum(len(g.text.split()) > LONG_WORDS for s in sessions for g in s.segs),
        "lines_without_role": sum(g.role == "?" for s in sessions for g in s.segs),
        "names_blanked": ", ".join(f"{digest(n)} x{c}" for n, c in hits.most_common()) or "none",
        "episodes": len(seconds),
        "episodes_per_session": f"{min(per)} to {max(per)}",
        "episode_seconds": f"p10 {quantile(seconds, 0.1)}, median {quantile(seconds, 0.5)}, p90 {quantile(seconds, 0.9)}, max {max(seconds)}",
        "video_bytes": sum(s.size for s in sessions),
    }
    return sessions, report


def video_path(session: Session, dataset: str) -> str:
    """Where the recording is kept, relative to the raw directory. The name is
    made from its content, so neither the participant nor the meeting it came
    from is in a path."""
    return f"{dataset}/video/{session.sha256[:16]}.mp4"


def _stored(session: Session, dataset: str) -> bool:
    target = config.raw_dir() / video_path(session, dataset)
    return target.is_file() and target.stat().st_size == session.size


def copy_video(session: Session, dataset: str) -> str:
    relative = video_path(session, dataset)
    target = config.raw_dir() / relative
    if _stored(session, dataset):
        return relative
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(".part")
    seen = hashlib.sha256()
    with open(session.video, "rb") as src, open(part, "wb") as out:
        while chunk := src.read(CHUNK):
            seen.update(chunk)
            out.write(chunk)
    if seen.hexdigest() != session.sha256:
        part.unlink()
        raise ValueError(f"Session {session.pid}: the video does not match its checksum in file-manifest.csv.")
    part.chmod(0o600)
    part.replace(target)
    return relative


def _free_bytes() -> int:
    directory = config.data_dir()
    while not directory.exists():
        directory = directory.parent
    return shutil.disk_usage(directory).free


def _worked_on(conn: sqlite3.Connection, track_id: int) -> list[str]:
    """Tables that hold someone's work on this track's items. Found from the
    schema, so a table added later is covered."""
    ours = {"item_text", "item_state", "item_span"}
    tables = [r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    busy = []
    for table in tables:
        for fk in conn.execute(f"PRAGMA foreign_key_list({table})"):
            if fk["table"] == "item" and table not in ours and conn.execute(
                f"SELECT 1 FROM {table} WHERE {fk['from']} IN (SELECT id FROM item WHERE track_id = ?) LIMIT 1", (track_id,)
            ).fetchone():
                busy.append(table)
    return busy


def _clear(conn: sqlite3.Connection, dataset_id: int, track_id: int) -> None:
    busy = _worked_on(conn, track_id)
    if busy:
        raise repo.Refused(f"Not replaced: there is already work on these items ({', '.join(sorted(set(busy)))}).")
    items = "(SELECT id FROM item WHERE track_id = ?)"
    for table in ("item_span", "item_text", "item_state"):
        conn.execute(f"DELETE FROM {table} WHERE item_id IN {items}", (track_id,))
    conn.execute("DELETE FROM item WHERE track_id = ?", (track_id,))
    conn.execute("DELETE FROM source WHERE dataset_id = ?", (dataset_id,))
    for table in ("segment", "telemetry"):
        conn.execute(f"DELETE FROM {table} WHERE session_id IN (SELECT id FROM session WHERE dataset_id = ?)", (dataset_id,))
    conn.execute("DELETE FROM session WHERE dataset_id = ?", (dataset_id,))


def _order_key(taken: list[float], rng: random.Random) -> float:
    """A place in the reading order clear of every other session's episodes."""
    while True:
        key = rng.uniform(0, 1 - 2 * ORDER_GAP)
        if all(abs(key - other) >= ORDER_GAP for other in taken):
            taken.append(key)
            return key


def _store(conn: sqlite3.Connection, dataset_id: int, track_id: int, dataset: str, s: Session, media: str, alias: str, order_key: float) -> int:
    study = studies.get(KIND)
    session_id = conn.execute(
        "INSERT INTO session (dataset_id, pid, alias, duration_ms, media_path, media_sha256, transcript_kind,"
        " transcript_version, cut_rule, order_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (dataset_id, s.pid, alias, s.duration_ms, media, s.sha256, s.kind, s.version, CUT_RULE, order_key),
    ).lastrowid
    conn.executemany(
        "INSERT INTO segment (session_id, seq, t_start_ms, t_end_ms, speaker, text, src_id, src_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [(session_id, n, g.start, g.end, g.role, g.text, g.src_id, g.src_ordinal) for n, g in enumerate(s.segs)],
    )
    for seq, (start, end, first, last) in enumerate(s.episodes):
        source_id = importer.ensure_source(conn, dataset_id, (s.pid, COLLECTION, f"t{start:08d}"))
        importer.add_item(conn, track_id, source_id, dataset, study, None, [("episode", episode_text(s.segs[first:last + 1]), False)])
        item_id = conn.execute("SELECT id FROM item WHERE track_id = ? AND source_id = ?", (track_id, source_id)).fetchone()["id"]
        # A session's episodes are read in order, one session after another.
        conn.execute("UPDATE item SET shuffle_key = ? WHERE id = ?", (order_key + seq * ITEM_STEP, item_id))
        conn.execute(
            "INSERT INTO item_span (item_id, session_id, seq, t_start_ms, t_end_ms, seg_first, seg_last) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (item_id, session_id, seq, start, end, first, last),
        )
    return len(s.episodes)


def run(folder: Path, dataset: str, title: str, lead: Optional[str], names: Optional[Path] = None, replace: bool = False, dry_run: bool = False) -> dict:
    sessions, report = prepare(folder, names)
    report["free_bytes"] = _free_bytes()
    if dry_run:
        report["capitalised_words"] = ", ".join(f"{w} x{n}" for w, n in capitalised(sessions)) or "none"
        return report

    db.init()
    with db.db() as conn:
        found = conn.execute(
            "SELECT d.id, t.id AS track_id FROM dataset d JOIN track t ON t.dataset_id = d.id WHERE d.slug = ?", (dataset,)
        ).fetchone()
        if found and replace and (busy := _worked_on(conn, found["track_id"])):
            raise repo.Refused(f"Not replaced: there is already work on these items ({', '.join(sorted(set(busy)))}).")
        stored = {} if not found or replace else {
            r["pid"]: r for r in conn.execute("SELECT * FROM session WHERE dataset_id = ?", (found["id"],))
        }
    new = [s for s in sessions if s.pid not in stored]
    changed = [s for s in sessions if s.pid in stored and (stored[s.pid]["transcript_version"], stored[s.pid]["cut_rule"]) != (s.version, CUT_RULE)]

    # Videos first, outside the write lock: they take minutes, and a failure
    # here leaves the database as it was.
    needed = sum(s.size for s in new if not _stored(s, dataset))
    if needed * 1.1 > _free_bytes():
        raise ValueError(f"Not enough room for the videos: {needed} bytes to copy.")
    media = {s.pid: copy_video(s, dataset) for s in new}

    rng = random.Random()
    counts = {"sessions_new": len(new), "sessions_kept": len(sessions) - len(new) - len(changed), "sessions_changed": len(changed), "items_new": 0}
    with db.db() as conn:
        dataset_id, track_id = importer.ensure_dataset(conn, dataset, title, KIND)
        if replace:
            _clear(conn, dataset_id, track_id)
        taken = [r["order_key"] for r in conn.execute("SELECT order_key FROM session WHERE dataset_id = ?", (dataset_id,))]
        used = {r["alias"] for r in conn.execute("SELECT alias FROM session WHERE dataset_id = ?", (dataset_id,))}
        aliases = [a for n in range(1, len(used) + len(new) + 1) if (a := f"S{n:02d}") not in used]
        rng.shuffle(new)  # so an alias says nothing about the participant id
        for s, alias in zip(new, aliases):
            counts["items_new"] += _store(conn, dataset_id, track_id, dataset, s, media[s.pid], alias, _order_key(taken, rng))
        if lead:
            repo.add_roster(conn, track_id, lead, "lead")
    return {**report, **counts}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("folder", type=Path)
    parser.add_argument("--dataset", required=True, help="short name, e.g. sessions")
    parser.add_argument("--title", default="", help="shown on the dashboard")
    parser.add_argument("--lead", help="email of the first lead")
    parser.add_argument("--names", type=Path, help="a file of 'label digest,role' lines and of words to blank; keep it out of git")
    parser.add_argument("--replace", action="store_true", help="start the dataset's items afresh; refused once there is work on them")
    parser.add_argument("--dry-run", action="store_true", help="count what is there, write nothing")
    args = parser.parse_args(argv)
    try:
        report = run(args.folder, args.dataset, args.title or args.dataset, args.lead, args.names, args.replace, args.dry_run)
    except (ValueError, repo.Refused) as e:
        raise SystemExit(str(e))
    for key, value in report.items():
        print(f"{key:24} {value}")
    if args.dry_run:
        print("\ncapitalised_words are capitalised mid-sentence and never in lower case. Put any that is a person's name in the --names file.")
    if report.get("sessions_changed"):
        print("\nSome sessions have a different transcript or cut from what was imported. They were left as they are.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
