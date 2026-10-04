"""A small synthetic dataset, so the tool can be developed and demoed with no
real student data anywhere near it.

    ANNOTATE_DATA_DIR=./data python -m annotate.seed [--reset]

Two studies. "demo": twelve submissions, each a drawn "diagram" (a few
sideways, one with a stand-in for something identifying, one missing) with an
approach and a challenges reflection. "ethics-demo": fourteen invented ethics
questions with a topic and a hidden lens. Each has a lead, two coders and a
published codebook, and stands at calibration. Running it again changes nothing; --reset empties the data
directory first, all but incoming/.
"""

from __future__ import annotations

import io
import random
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from annotate import config, db, importer, repo, studies

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
    """Returns False if the demo dataset was already there."""
    db.init()
    rng = random.Random(7)
    with db.db() as conn:
        if conn.execute("SELECT 1 FROM dataset WHERE slug = 'demo'").fetchone():
            return False
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

        ethics = studies.get("ethics")
        dataset_id, track_id = importer.ensure_dataset(conn, "ethics-demo", "Ethics questions (synthetic)", "ethics")
        for n, (topic, question, lens) in enumerate(QUESTIONS):
            source_id = importer.ensure_source(conn, dataset_id, (f"resp{n:08x}", "Week06", ethics.task))
            parts = [("topic", topic, False), ("question", question, False), ("lens", lens, True)]
            importer.add_item(conn, track_id, source_id, "ethics-demo", ethics, None, parts)
        _team_and_codebook(conn, track_id, ethics, ETHICS_CODEBOOK)
    return True


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
    """Developer machines only: start from an empty data directory, keeping incoming/."""
    directory = config.data_dir().resolve()
    if directory == Path("/data") or not config.dev_user() and not str(directory).startswith(str(config.APP_DIR)):
        raise SystemExit(f"Refusing to delete {directory}: --reset is for a local data directory.")
    # incoming/ is where real exports wait to be imported; it is not the tool's to delete.
    for child in directory.iterdir() if directory.is_dir() else ():
        if child.name == "incoming":
            continue
        shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)


if __name__ == "__main__":
    if "--reset" in sys.argv:
        reset()
    print("Seeded the demo dataset." if run() else "The demo dataset is already there.")
