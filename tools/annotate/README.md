# Annotation bench

A lab tool for coding a qualitative dataset as a team: read and jot, ask
questions, build your own codes on the same cards as everyone else, merge them
into one codebook, code blind, measure agreement, resolve, repeat. Served at `/tools/annotate/` behind the lab-tools gate (see
[`../README.md`](../README.md)).

It is laid out as a hike. The sidebar is a trail of stages from trailhead to
summit, the work is done one card at a time with a key for every action, and
people gain elevation for work done, measured against real mountains (`annotate/peaks.py`).

## Studies

Several studies run side by side, each with its own roster, codebook and
export. A study has a **kind**, defined in
[`annotate/studies.py`](annotate/studies.py), which says what an item is made
of, what a codebook question can be about, why an item can be excluded and,
for spreadsheet data, which column is which part.

| Kind | An item is | Coded as |
| --- | --- | --- |
| `decomp` | a student's diagram photo with their written approach and challenges | questions about the diagram, and about the reflection |
| `ethics` | a student's topic and ethics question; the lens they ticked is stored but hidden | questions about the question |
| `sessions` | an episode: a minute or two of a recorded session, its video with the transcript lines beside it | questions about the episode |

The stage guides people follow are in [`briefs/`](briefs/). A study's own
version in `briefs/<kind>/` wins over the shared one. A study whose guides
should not be in this repo keeps them in the data directory instead, at
`/data/briefs/<kind>/`, which is looked in first and which `--reset` leaves alone.

## How access works

The gate admits any approved lab member. Each study has its own **roster**, and
every route checks it. A lab member who is not on a roster gets a refusal page.

- **coder**: everything in the analysis: read and jot, code, edit and publish
  the codebook, take part in the merge, record consensus.
- **lead**: a coder who also runs things: the roster, opening each stage,
  dealing and closing decks, running the merge, the export.
- **site admin** (an admin on the site's `/admin` page): a lead on every
  study, on its roster or not. This is how a study gets its first people: the
  admin opens it and adds them on the Roster page, and can make anyone else
  the lead. An admin who is not on a roster is not part of that team: they
  are dealt no cards and cannot jot or code until they add themselves.

## How the work goes

The team moves together. A stage is locked until the lead has finished the one
before it.

0. **Onboarding.** Everyone presses Start. The lead then locks the team:
   nobody joins after that, and in a study with photos the cleaning is divided
   evenly among the people on it. Taking someone off the roster passes their
   uncleaned photos to the others.

1. **Clean and read.** In a study with photos, the team first cleans them:
   each photo is turned and cropped once, by the person it was dealt to, and
   everyone after sees the crop. Then each person reads every item and jots. Anyone can
   flag an item; the lead keeps or excludes it. People start at different
   points in the order.
2. **Questions.** Each person shares a research question.
3. **Open coding.** Each person presses Generate once: a model proposes
   candidate codes from their own jots and the team's questions, and their
   jotting closes. The lead deals the same cards to everyone. Each person ticks
   their own codes and candidates on each card and adds new ones with a
   definition; the card a code is made on is its example. The lead closes.
4. **Codebook.** The lead runs the merge once. It groups everyone's codes by
   the cards they share, their names and definitions, and what was jotted
   under them, and proposes one code per group. The team meets: each personal
   code goes into a proposed code, becomes its own, or is dropped. The result
   is written to the codebook draft, which anyone edits and publishes.
5. **Calibration.** Blind rounds on fresh cards, agreement, consensus, a new
   codebook version, repeat. The page lists the codes whose agreement was weak
   in the last round. There is no bar to clear: the lead decides when to move
   on, but the latest version must have been through a round.
6. **Production.** The final pass. Every kept item is coded with the final
   codebook; most by one person, a share (20% by default) by two, and nobody
   is told which. Agreement on the doubled items is frozen at the close.
   Items two people coded differently are settled by consensus.
7. **Themes.** The topic map (items per code, with examples), and the themes
   the team writes over the codes. The lead can ask the model for a first
   proposal, once.
8. **Export.** A zip of CSVs joined on the item token, for leads only.
   `episodes.csv` places each item of a sessions study in its session.

## What it guarantees

- **Raw data is never in git or in the image.** It is copied into `/data` on
  the server by an importer. `.dockerignore` and the repo's `.gitignore` both
  exclude `data/`.
- **Photos are never served as files.** Each is rotated, cropped to the triage
  rectangle, resized and re-encoded from pixels, which drops EXIF.
- **Video is streamed to the study's people, and that is all.** A recording
  is reached through an item's token by someone on the study's roster or a
  site admin, with no download link and no participant id or file name in any
  URL or page. It is the recording as it was made: faces, voices and the
  screen are in it, a whole session is reachable from any of its episodes,
  and a browser can save what it plays.
- **Coding is blind.** While a deck is open, `repo.visible_annotations`
  returns only the caller's own codes, for leads too. Personal codes and jots
  are read together only by the merge, after open coding closes. The export
  leaves open decks out.
- **A model run happens once**, off the request: the page shows working, ready
  or failed, and only a failed run can be started again.
- **Hidden parts stay hidden.** A written part marked hidden (the ethics lens)
  is never loaded for a page; only the export reads it.
- **Coders never see who.** Pages do not carry the student hash, submission
  id or a session's participant id; items are addressed by a random token in a shuffled order.
- **Published codebook versions do not change**, and a deck is pinned to one.
- **Agreement is frozen when a deck closes.**
- **Elevation rewards work, not speed or agreement.** A person sees their own
  figure and the team total.

## Run it locally

No real data is needed. The seed script makes one synthetic study of each kind.

```bash
cd tools/annotate
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
ANNOTATE_DATA_DIR=./data .venv/bin/python -m annotate.seed      # add --reset to start over (it keeps data/incoming/ and data/briefs/)
ANNOTATE_DATA_DIR=./data ANNOTATE_DEV_USER=lead@example.edu PORT=8080 .venv/bin/python -m annotate
```

Open <http://127.0.0.1:8080/>. `ANNOTATE_DEV_USER` stands in for the gate's
headers; the bar at the bottom of the page switches between the seeded lead,
two coders and an outsider. Add `ANNOTATE_DEV_ADMIN=1` to be a site admin as
yourself. The deploy runner never sets these variables, so neither exists in
production.

Tests:

```bash
.venv/bin/python -m pytest
```

As the server runs it (see step 5 of [`../README.md`](../README.md)):

```bash
docker build -t annotate -f tools/annotate/Containerfile tools/annotate
mkdir -p /tmp/annotate-data
docker run --rm -p 127.0.0.1:8080:8080 -e PORT=8080 -e HOME=/tmp \
  -e TOOL_ROOT_PATH=/tools/annotate -v /tmp/annotate-data:/data \
  --user "$(id -u):$(id -g)" --cap-drop ALL --memory 512m annotate
```

Without the gate in front there are no identity headers, so every page but
`/healthz` answers 403. That is the intended behaviour.

## The model

Any OpenAI-compatible chat endpoint, set in the tool's secrets file on the
server (`~/.config/ascend-tools/tools/annotate.env`):

```
ANNOTATE_LLM_BASE_URL=https://.../v1
ANNOTATE_LLM_API_KEY=...
ANNOTATE_LLM_MODEL=...
```

It is sent one person's jots with the items they are about (candidates),
everyone's codes with example items and jots (merge), or the final codes with
their counts and example items (themes). Hidden parts of an item
are never sent. With no base URL the tool works without a model: no
candidates, and the merge groups by shared cards and names alone. Locally,
`ANNOTATE_LLM_BASE_URL=mock` is a stand-in that never leaves the process.

## Load a dataset

Once, on the server, after the tool's first deploy. Copy the data into the
tool's data directory, import, then delete the copy. Both importers take
`--dry-run`, can put a `--lead` on the roster (optional: a site admin can open
the study and add people without it),
start photos uncleaned and text in the data, and can be run again: what is already there is left
alone with its triage and codes, and only new items are added.

**A folder of diagrams** (`decomp`):

```bash
rsync -a Decomp_Anon/ ascend3:~/ascend-tools-data/annotate/incoming/decomp/
docker exec ascend-tool-annotate python -m annotate.importer /data/incoming/decomp \
    --dataset decomp --title "Decomposition diagrams" --lead you@vt.edu
```

It expects `manifest.csv`, `comments.jsonl` and
`by_project/Homework<NN>_<project>/<hash>/vt_<project>_<id>_diagram.jpeg`.

**A spreadsheet of form responses** (`ethics`), `.xlsx` or `.csv`:

```bash
docker exec ascend-tool-annotate python -m annotate.import_table /data/incoming/responses.xlsx \
    --dataset ethics-w6 --kind ethics --title "CS2114 ethics questions, week 6" \
    --occasion Week06 --lead you@vt.edu
```

Columns are found by their header text, so a reordered sheet still loads, and a
later download of the same form adds only the new responses.

**An export of recorded sessions** (`sessions`): `session-index.csv`,
`file-manifest.csv`, and per session a transcript JSON and a primary video.

```bash
docker exec ascend-tool-annotate python -m annotate.import_sessions /data/incoming/export \
    --dataset sessions --title "Think-aloud sessions" --lead you@vt.edu
```

Each session is cut into episodes: where the researcher next speaks once a
minute has passed, or at two and a half minutes. Speaker labels are names, so
none is stored: each becomes Researcher or Participant, and its parts are
blanked where they are spoken. A label the rule cannot place stops the import.
`--dry-run` also lists words that are capitalised mid-sentence, for names the
labels did not give away; put those in a `--names` file, kept beside the data.
`--replace` cuts the sessions again, and is refused once anyone has worked on
the items. The study's text is never sent to a live model (`model_ok`).
People read a session's episodes in order, a session at a time; the reading
list is by session.

## Add a kind of study

1. Add a `Study` to `annotate/studies.py`.
2. Write its guides in `briefs/<kind>/` for the stages that are about the data:
   onboarding, clean and read, questions, codebook, export.
3. If it is not a spreadsheet, write an importer that calls
   `importer.ensure_dataset`, `ensure_source` and `add_item`.

## Layout

| | |
| --- | --- |
| `annotate/main.py` | routes |
| `annotate/repo.py` | every query, and the blindness and immutability rules |
| `annotate/studies.py` | what differs between kinds of study |
| `annotate/auth.py` | identity from the gate, roster check |
| `annotate/stats.py` | agreement statistics, pure functions |
| `annotate/agreement.py` | builds the item x coder tables for a deck |
| `annotate/llm.py` | one call to a chat model |
| `annotate/assist.py` | the model jobs: candidate codes, merge proposal, theme proposal |
| `annotate/merge.py` | grouping personal codes, pure functions |
| `annotate/images.py` | rotate, crop, strip, cache |
| `annotate/importer.py`, `import_table.py`, `tabular.py`, `import_sessions.py` | real data in |
| `annotate/seed.py` | synthetic data in |
| `annotate/export.py` | CSVs out |
| `annotate/db.py` | schema, additive migrations, daily backup to `/data/backups` |
| `briefs/` | the stage guides, markdown |
| `static/deck.js`, `crop.js`, `player.js`, `theme.js` | keys and the trail marker, the crop box, the video keys, light and dark |

The statistics use the same formulas as the wiki's `KappaCalculator`, and the
tests assert its presets, so the tool and the lesson agree.

## Not built yet

A model check that definitions are applied consistently, sending diagram
photos to the model, and structured diagram transcription.
