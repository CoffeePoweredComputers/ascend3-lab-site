"""A small synthetic dataset, so the tool can be developed and demoed with no
real student data anywhere near it.

    ANNOTATE_DATA_DIR=./data python -m annotate.seed [--reset]

Three studies. "demo": twelve submissions, each a drawn "diagram" (a few
sideways, one with a stand-in for something identifying, one missing) with an
approach and a challenges reflection. "ethics-demo": fourteen invented ethics
questions with a topic and a hidden lens. "sessions-demo": three invented
think-aloud sessions, with no video, cut into episodes by the sessions
importer. Each has a lead, two coders and a published codebook, and stands at
calibration. Running it again adds only a study that is missing; --reset
empties the data directory first, all but incoming/ and briefs/.
"""

from __future__ import annotations

import io
import random
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from annotate import config, db, import_sessions, importer, repo, studies

PEOPLE = (("lead@example.edu", "lead"), ("coder1@example.edu", "coder"), ("coder2@example.edu", "coder"))
HOMEWORKS = (("Homework05", "text_stats"), ("Homework06", "grade_report"))
STEPS = ("split", "count", "average", "longest", "report", "clean", "filter", "total")
APPROACH = (
    "I listed the outputs first and worked backwards to what each step needed as input.",
    "I started by writing the steps in order and then drew boxes around them.",
    "I thought about which parts could be reused and made those their own step.",
)
CHALLENGES = (
    "Deciding what counts as one step was hard. I kept wanting to write the code.",
    "It was hard to describe a loop without writing the loop.",
    "Fine.",
    "Connecting the boxes was confusing because I was not sure what the arrows should mean.",
)

# (key, name, single or multi, what it is about, codes)
CODEBOOK = [
    ("relation", "Relation type", "single", "diagram", [
        ("sequence", "Sequencing", "Arrows give the order steps run in."),
        ("dataflow", "Data flow", "Arrows show one step's output feeding another's input."),
        ("unclear", "Unclear", "No diagram, no arrows, or their meaning cannot be told."),
    ]),
    ("issues", "Issues", "multi", "diagram", [
        ("vague", "Vague language", "A description too underspecified to implement."),
        ("code-on-paper", "Code on paper", "The description is code or near-code, not intent."),
        ("no-io", "Missing input or output", "A step with no stated input or output."),
    ]),
    ("challenge", "Challenge named", "multi", "reflection", [
        ("granularity", "Step granularity", "Deciding what should be one step."),
        ("abstraction", "Abstraction", "Describing without writing code."),
        ("relations", "Relations", "Deciding how steps connect."),
    ]),
]


# Invented, in the shape of the real form: topic, question, the lens ticked.
QUESTIONS = [
    ("AI writing code", "If an assistant writes most of my program, who answers for the bugs in it?", "Duty: what do I owe the users and what do they expect from me?"),
    ("ai code", "Is it honest to hand in code I could not have written myself?", "Character: What does this action say about me?"),
    ("Face recognition", "Can a person consent to being scanned in a public place?", "Duty: what do I owe the users and what do they expect from me?"),
    ("faces", "Who is harmed when a face match is wrong, and who pays for it?", "Outcomes: What is the sum of my actions?"),
    ("Jobs", "Should a company replace a team with a model if the product gets better?", "Outcomes: What is the sum of my actions?"),
    ("AI taking jobs", "Do I owe anything to the people my software puts out of work?", "Moral distance: many hands"),
    ("Feeds and attention", "Is it wrong to design a feed to be hard to put down?", "Character: What does this action say about me?"),
    ("attention", "How many small nudges add up to manipulation?", "Outcomes: What is the sum of my actions?, Moral distance: many hands"),
    ("Self-driving cars", "Whose safety should the car put first?", "None, or not sure"),
    ("Environment", "Does the energy a model uses outweigh what it is used for?", "Outcomes: What is the sum of my actions?"),
    ("AI", "How do we regulate ai", "None, or not sure"),
    ("Academic integrity", "Is using a chatbot for homework different from asking a friend? Where is the line?", "Character: What does this action say about me?"),
    ("Data", "If I only store the data and someone else misuses it, is that on me?", "Moral distance: many hands"),
    ("Ai", "Ai", "None, or not sure"),
]
ETHICS_CODEBOOK = [
    ("topic", "Topic area", "single", "question", [
        ("ai-code", "AI writing code", "Authorship, honesty or responsibility when a model writes the code."),
        ("faces", "Faces and surveillance", "Recognition, scanning, consent to being identified."),
        ("work", "Jobs", "Software replacing or changing people's work."),
        ("attention", "Feeds and attention", "Design that shapes what people look at and for how long."),
        ("other", "Other", "A clear topic that is none of the above."),
        ("unclear", "Unclear", "No topic can be told from the response."),
    ]),
]


# Invented sessions: a student plans a library book-return sorter aloud. The
# speaker labels stand in for the names a real export carries; the importer
# turns them into roles and blanks them where they are spoken.
RESEARCHER = "QuartzHeron"
PARTICIPANTS = ("PebbleFinch", "MarbleOtter", "CobaltMoth")
INTRO = "Hi, I am Heron. Start whenever you are ready, and say what you are thinking as you go."
PROMPTS = ("What are you thinking?", "Keep talking.", "What made you change that?", "What are you looking at now?", "Can you say more about that?")
TALK = (
    "Okay, so a book comes down the return chute and the scanner reads the barcode.",
    "The things it has to keep track of are books, bins and holds, I think.",
    "A book has a barcode, a home branch and a shelf number.",
    "A hold has the book and whoever is waiting for it, but the sorter only needs to know there is one.",
    "So my first rule: if a book has a hold, it goes to the holds bin.",
    "Otherwise it goes to the bin for its floor.",
    "Let me read the first case again. Given a book from another branch, when it is returned here...",
    "Oh, I did not have anything for other branches. It would just go to a floor bin.",
    "So I need a transit bin, and the rule has to check the home branch.",
    "Wait, which comes first, the hold or the branch? If someone here is waiting for it, it should stay.",
    "I will put holds first, then branch, then floor.",
    "Second case: the barcode cannot be read.",
    "Right now nothing happens, it just sits in the scanner. That cannot be right.",
    "Unreadable goes to a bin for a person to check. I will call it the desk bin.",
    "Third case is a damaged book. How would the machine even know it is damaged?",
    "Maybe it cannot, maybe that is not the sorter's job. I will leave that one.",
    "Hmm, but the case says it should go to repairs, so somebody marks it somewhere.",
    "Okay, if the record says damaged, it goes to the desk bin too. Same bin, different reason.",
    "Last case: two books for the same hold arrive one after the other.",
    "The second one does not need to go to holds, the hold is already filled.",
    "So the hold has to be marked filled when the first book lands. I did not have that.",
    "Let me go back through all four with the new order and see if anything breaks.",
    "First one still works, the transit bin catches it.",
    "The unreadable one never gets to the other rules, so that is fine.",
    "What happens when a bin is full? None of the cases say.",
    "I will write that down as a question rather than a rule.",
    "So the order matters more than I thought it would.",
    "I think I am happy with this, though the floor bins might fill up.",
)
SESSIONS_CODEBOOK = [
    ("activity", "Activity", "multi", "episode", [
        ("reads", "Reads the task", "Reads or rereads a requirement or a case."),
        ("traces", "Traces a case", "Steps through a case against the rules."),
        ("revises", "Revises a rule", "Adds, removes or reorders a rule."),
        ("asks", "Asks for help", "Asks the researcher or a tool something about the task."),
    ]),
    ("impasse", "Impasse", "single", "episode", [
        ("none", "No impasse", "Work goes on without a stop."),
        ("stuck", "Stuck", "Stops and does not find a way on within the episode."),
        ("unstuck", "Gets unstuck", "Stops, then finds a way on."),
    ]),
]


def draw_diagram(rng: random.Random, sideways: bool, identifying: bool) -> bytes:
    image = Image.new("RGB", (900, 1200), (247, 246, 240))
    pen = ImageDraw.Draw(image)
    previous = None
    for i, name in enumerate(rng.sample(STEPS, rng.randint(3, 5))):
        x, y = 120 + rng.randint(-40, 260), 90 + i * 210
        pen.rectangle((x, y, x + 380, y + 140), outline=(70, 60, 140), width=4)
        pen.text((x + 16, y + 14), name, fill=(40, 40, 40))
        pen.text((x + 16, y + 52), "I: list of words", fill=(90, 90, 90))
        pen.text((x + 16, y + 84), "O: a number", fill=(90, 90, 90))
        if previous:
            pen.line((previous[0] + 190, previous[1] + 140, x + 190, y), fill=(200, 80, 70), width=4)
        previous = (x, y)
    if identifying:
        # Stands in for a face reflected in a screen: the thing triage is for.
        pen.ellipse((690, 40, 860, 240), fill=(205, 170, 150))
        pen.text((725, 130), "FACE", fill=(90, 40, 40))
    if sideways:
        image = image.transpose(Image.Transpose.ROTATE_90)
    out = io.BytesIO()
    image.save(out, "JPEG", quality=80)
    return out.getvalue()


def run() -> bool:
    """Adds each study that is not there yet. Returns False if none was missing."""
    db.init()
    with db.db() as conn:
        have = {r["slug"] for r in conn.execute("SELECT slug FROM dataset")}
        builders = (("demo", _diagrams), ("ethics-demo", _ethics), ("sessions-demo", _sessions))
        for slug, build in builders:
            if slug not in have:
                build(conn)
    return any(slug not in have for slug, _ in builders)


def _diagrams(conn) -> None:
    rng = random.Random(7)
    dataset_id, track_id = importer.ensure_dataset(conn, "demo", "Demo study (synthetic)", "decomp")
    decomp = studies.get("decomp")
    with tempfile.TemporaryDirectory() as scratch:
        n = 0
        for student in range(6):
            for homework, project in HOMEWORKS:
                key = (f"demo{student:08x}", homework, project)
                source_id = importer.ensure_source(conn, dataset_id, key, str(900000 + n))
                photo = None
                if n != 10:  # one student handed in no diagram
                    photo = Path(scratch) / f"{n}.jpg"
                    photo.write_bytes(draw_diagram(rng, sideways=n in (3, 8), identifying=n == 5))
                parts = [("approach", rng.choice(APPROACH), False), ("challenges", rng.choice(CHALLENGES), False)]
                importer.add_item(conn, track_id, source_id, "demo", decomp, photo, parts)
                n += 1
    # Leave the awkward ones for triage; clear the rest so there is
    # something to read and code straight away.
    conn.execute(
        "UPDATE item_state SET status = 'cleared', updated_by = 'seed' WHERE item_id IN"
        " (SELECT i.id FROM item i JOIN source s ON s.id = i.source_id"
        "  WHERE i.track_id = ? AND s.submission_id NOT IN ('900003', '900005', '900008'))",
        (track_id,),
    )
    _team_and_codebook(conn, track_id, decomp, CODEBOOK)


def _ethics(conn) -> None:
    ethics = studies.get("ethics")
    dataset_id, track_id = importer.ensure_dataset(conn, "ethics-demo", "Ethics questions (synthetic)", "ethics")
    for n, (topic, question, lens) in enumerate(QUESTIONS):
        source_id = importer.ensure_source(conn, dataset_id, (f"resp{n:08x}", "Week06", ethics.task))
        parts = [("topic", topic, False), ("question", question, False), ("lens", lens, True)]
        importer.add_item(conn, track_id, source_id, "ethics-demo", ethics, None, parts)
    _team_and_codebook(conn, track_id, ethics, ETHICS_CODEBOOK)


def _sessions(conn) -> None:
    """Built as the importer builds a real export, from rows shaped like its
    transcript JSON, so the labels go through the same roles and blanking."""
    rng = random.Random(11)
    sessions = []
    for n, participant in enumerate(PARTICIPANTS):
        pid = f"sess{n:04x}"
        script = [(RESEARCHER, INTRO)]
        for k, line in enumerate(sorted(rng.sample(range(len(TALK)), 20))):
            script.append((participant, TALK[line]))
            if k % 4 == 3:
                script.append((RESEARCHER, rng.choice(PROMPTS)))
        rows, t = [], 0
        for ordinal, (label, text) in enumerate(script):
            length = rng.randint(8, 16) * 1000
            rows.append({"id": f"{pid}-{ordinal}", "speaker": label, "t_start_ms": t, "t_end_ms": t + length - 1000, "text": text, "ordinal": ordinal})
            t += length
        segs, _, _ = import_sessions.normalize(rows)
        sessions.append(import_sessions.Session(
            pid=pid, video=None, sha256=None, size=0, duration_ms=t, kind="restored", version=f"demo-{pid}", segs=segs,
        ))
    import_sessions.classify(sessions, {})
    import_sessions.scrub(sessions, set())
    dataset_id, track_id = importer.ensure_dataset(conn, "sessions-demo", "Think-aloud sessions (synthetic)", import_sessions.KIND)
    taken = []
    for n, s in enumerate(sessions, start=1):
        s.episodes = import_sessions.cut_episodes(s.segs, s.duration_ms)
        import_sessions._store(conn, dataset_id, track_id, "sessions-demo", s, None, f"S{n:02d}", import_sessions._order_key(taken, rng))
    _team_and_codebook(conn, track_id, studies.get(import_sessions.KIND), SESSIONS_CODEBOOK)


def _team_and_codebook(conn, track_id: int, study: studies.Study, codebook) -> None:
    for email, role in PEOPLE:
        repo.add_roster(conn, track_id, email, role)
    repo.new_draft(conn, track_id, "seed")
    for dim_key, name, mode, part, codes in codebook:
        repo.save_dimension(conn, track_id, dim_key, name, mode, part, study.parts)
        for key, label, definition in codes:
            repo.save_code(conn, track_id, dim_key, key, {"label": label, "definition": definition})
    repo.publish(conn, track_id, "Seed codebook for the demo dataset.")
    # The demo team has a codebook, so it stands at calibration with every
    # earlier stage open.
    conn.executemany(
        "INSERT INTO stage_done (track_id, stage, done_by, done_at) VALUES (?, ?, 'seed', ?)",
        [(track_id, n, repo.now()) for n in (0, 1, 2, 3, 4)],
    )


def reset() -> None:
    """Developer machines only: start from an empty data directory, keeping
    incoming/ and briefs/."""
    directory = config.data_dir().resolve()
    if directory == Path("/data") or not config.dev_user() and not str(directory).startswith(str(config.APP_DIR)):
        raise SystemExit(f"Refusing to delete {directory}: --reset is for a local data directory.")
    # incoming/ is where real exports wait to be imported, and briefs/ holds the
    # guides kept out of the repo; neither is the tool's to delete.
    for child in directory.iterdir() if directory.is_dir() else ():
        if child.name in ("incoming", "briefs"):
            continue
        shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)


if __name__ == "__main__":
    if "--reset" in sys.argv:
        reset()
    print("Seeded the demo studies." if run() else "The demo studies are already there.")
