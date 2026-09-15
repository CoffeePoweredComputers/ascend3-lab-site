# How the backend works

A short tour for someone reading the code for the first time. The operator-facing
setup instructions live in [README.md](../README.md).

## Shape of the system

There are two halves that never run at the same time.

**Online** — a small FastAPI app students hit once per project. It accepts
conversations, normalizes them, and stores them. It does no matching.

**Offline** — scripts the research team runs after the semester: pull commits out
of the course repositories, score candidate links, export CSVs.

```
student browser                    researcher shell
      │                                   │
      ▼                                   ▼
 app/main.py  ──►  data/research.db  ◄──  scripts/extract_git.py
      │                    ▲              scripts/match_candidates.py
      ▼                    │              scripts/export_dataset.py
 app/identity.py ──► data/identity.db
```

## Two databases, never joined

`data/identity.db` holds one table, `identities`, mapping a real VT email to a
participant code (`905123456 ↔ S037`).

`data/research.db` holds everything else, keyed only by participant code.

`app/identity.py` is the only module that touches the identity database, and
nothing joins across the two files. A test asserts no email appears anywhere
in the research database.

Codes are assigned on first submission and reused, so one student keeps one code
all semester. Assignment runs inside `BEGIN IMMEDIATE` so two simultaneous
submissions cannot be handed the same code.

## Modules

| File | Responsibility |
| --- | --- |
| `app/main.py` | HTTP endpoints, request validation, the write path |
| `app/schemas.py` | Pydantic request models (typing syntax kept 3.9-compatible) |
| `app/identity.py` | VT email ↔ participant code. The only identity-aware module |
| `app/db.py` | Schema, connections, and the `ensure_columns` migration |
| `app/normalize.py` | Turning any input into the common conversation format |
| `app/matching.py` | Scoring functions. Pure, no I/O — which is why they are testable |
| `app/config.py` | Reads `config/projects.yaml` and the optional roster |
| `app/timeutil.py` | UTC conversion; a naive timestamp is read as course-local |

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /` | Serves the single-page submission form |
| `GET /api/config` | Projects (with date windows), platforms, and the annotation options — the form is built from this, not hardcoded |
| `GET /healthz` | Public liveness. Reads both databases so it cannot answer "ok" while one is unreadable |
| `GET /api/admin/status` | Counts, consent totals, disk and database sizes. Gated on `GENAI_ADMIN_TOKEN`; 404 without it |
| `POST /api/repository` | Records the team's GitHub repository for one project. Same gates as a submission; normalizes whatever was pasted to one canonical URL |
| `POST /api/consent` | Records agree/decline against the fingerprint of the wording shown. Refuses an answer to a stale version |
| `POST /api/session/start` | Validates the email and checks the (email, team) pair against the roster. Deliberately mints **no** participant code, so a typo on screen one leaves no stray identity row |
| `POST /api/preview` | Segments pasted text and returns the turns |
| `POST /api/submissions` | The real write. Validates, normalizes, deduplicates, stores |

A middleware rejects bodies over 40 MB before parsing them.

## Where parsing happens, and why

Split deliberately between the browser and the server:

- **Browser** (`static/parsers.js`) handles *files*. A whole-account export
  contains conversations that have nothing to do with the course, so it is parsed
  locally and only the ticked conversations are ever sent.
- **Server** (`app/normalize.py`) handles *text*. Pasted transcripts and HTML are
  segmented here so there is one implementation of the heuristic, and the preview
  a student sees is exactly what gets stored.

`POST /api/preview` exists purely to keep that second promise.

### The common format

Whatever came in, a stored conversation is the same shape: platform, title,
timing, and an ordered list of `{turn_id, role, timestamp, content, model}`.

`normalize.py` also carries two guards worth knowing about. Speaker-label
splitting ignores labels inside fenced code blocks and requires at least two
distinct roles in the document, so prose like `- Cursor: an editor` is not
shredded into fake turns; failing that guard keeps the text whole as one
`unsegmented` turn rather than losing it. And a pasted document that opens with
`<!doctype html>` is stripped to its text first, because page source would
otherwise become the matching signal.

## Data model

```
participant (participant_code)
      │
      ├──< submissions ──< conversations ──< turns
      │                          │
      │                          └────────< conversation_edits
      │
      ├──< participant_team_membership >── team_instances
      │         (joined_at, left_at)
      │
      └──< participant_consent

commits ──< commit_files          stage_snapshots

conversations ──< linkages >── commits
```

### Consent is asked once, and checked every time

`config/consent_form.md` holds the IRB-approved text; `app/consent.py` serves it
and records what was answered. The answer lives in `identity.db`, beside the
address it belongs to — a consent decision is about a named person, which is
what `research.db` must never hold.

Two properties are worth knowing about.

**A draft cannot reach a student.** The shipped form carries `[PI TO COMPLETE:]`
markers and `form()` reports it unavailable while any remain, so both
`/api/session/start` and `/api/consent` answer 503. This is the one guard in the
module that protects something other than data quality.

**The answer is filed against a wording, not just a date.** `form_version` is a
fingerprint of the text as displayed, and `/api/consent` refuses an answer whose
version does not match the current file — a form revised while someone was
reading it must not record their answer against text they never saw.

Eligibility comes before the text. The protocol has the portal confirm age and
enrolment before the consent information is presented, so the age question is the
first thing on the screen and the document stays hidden behind it -- asking
somebody to read a consent form they cannot act on is worse than asking one
question first. Enrolment is already settled by the roster match, so only age is
asked. The answer is stored on the consent row: `is_adult` defaults to 0, and
`has_consented` reads a missing confirmation as "not confirmed" rather than as a
yes, so an agreement recorded before the question existed does not quietly
enrol anyone.

A decline is stored rather than left blank, and a declining student is shown the
form again next visit rather than locked out. `consent.has_consented` treats
absence in both the database and `config/consent.csv` as refusal, which is what
keeps the repository gate safe by default.

### The (email, team) pair is the only gate

There is no login. A student types both their ID and their team, and
`config.verify_team` lets them through only if the roster agrees on the pair --
checked at `/api/session/start` and again at `/api/submissions`, because the form
is a convenience and the endpoint is the boundary.

What it buys is the typo: an address entered wrongly will not also carry the
right team, so it fails instead of filing someone's work under a classmate.
What it does not buy is authentication. Teams number a few dozen, and the most
likely impersonator -- a teammate -- knows both values already. Treat it as a
checksum on identity, not a control.

Two smaller decisions follow from that. Labels are compared after normalising
(`T08`, `t8`, `Team 08`, `8` are one team), because a formatting slip would
otherwise surface as "you are not on this roster", which a student cannot act on.
And both refusals return one message, so the form cannot be used to enumerate
which addresses are on the roster.

### Teams are temporal, participants are not

A participant code is stable for the semester. A **team instance** is created per
project (`P2_T08`), and a mid-project membership change opens a *new* instance
(`P2_T08a` → `P2_T08b`) rather than editing the old one. `team_label` (`T08`) ties
the instances of one team together, because they share a repository.

`participant_team_membership` is therefore the join, not a column on the
participant: `(participant_code, team_instance_id, project_id, joined_at,
left_at)`. Everything else derives from it —

- a conversation is attributed to the instance in force at its timestamp,
  falling back to the submission time and recording which basis was used in
  `team_assignment`, so a fallback across a team change stays visible;
- a commit is attributed to the instance in force when it was authored;
- candidate matching scopes by *label*, not instance, since a conversation from
  before a change can still relate to a commit from after it.

`scripts/sync_roster.py` builds all of this from `config/roster.csv`, minting
participant codes for every roster student rather than only those who submitted.

- `conversations` carries the annotations and, for IDE tools only,
  `workspace_*`, `models`, `tool_version`. Annotations are optional;
  `primary_purpose = "unspecified"` (offered and skipped) and
  `reported_change = "not_asked"` (no longer asked) are deliberately different
  values, so a dataset spanning the change stays analysable.
- `conversation_edits` holds files the AI itself recorded editing, with the diff.
  `change_type = "context"` means the file was only shown to the model.
- `linkages` is the review table. `candidate_score` and its components are
  written by the matcher; `linkage_confidence` is left blank for a human.
- `participant_consent` mirrors the IRB record. `extract_git.py` refuses to
  collect a repository unless every member of every instance of that team has
  consented — a repository mixes several students' work, and a member who left
  mid-project still authored part of the history. Absence counts as "no".
- Duplicate submissions are caught by `content_hash` over the turns, so a student
  who submits twice does not inflate their conversation count.

## Migrations

`CREATE TABLE IF NOT EXISTS` does nothing to a database that already exists, so
columns added mid-semester would never appear. `ensure_columns()` in `app/db.py`
compares `PRAGMA table_info` against `ADDED_COLUMNS` and issues `ALTER TABLE` for
whatever is missing. It runs on every research connection and is idempotent.

## The offline scripts

**`scripts/extract_git.py`** — walks each repository from `config/repos.csv`,
writing commits, per-file diffs, branch membership, and the remote URL. It also
records a snapshot per project stage: the last commit at or before each deadline
in `projects.yaml`, which is what turns a flat commit list into
`P2_SPEC` / `P2_PROTOTYPE` / `P2_FINAL`. Re-running is safe.

**`scripts/match_candidates.py`** — for each conversation, scores the commits in
scope and keeps the top few. Writes to `linkages` and to a review CSV.

**`scripts/collect_ai_logs.py`** — the one script students run. Gathers Claude
Code / Codex / Copilot / Cursor sessions for a single project folder into an
uploadable bundle. Standard library only, and it uploads nothing.

**`scripts/export_dataset.py`** — participant-coded CSVs for analysis.

## How scoring works

Two paths, and the distinction matters more than the arithmetic.

**Recorded evidence.** If a conversation came from an IDE tool, the log already
says which files the model wrote. A commit whose changed files intersect those is
banded `direct`. Edited paths are absolute and commit paths are
repository-relative, so a match requires the commit path to be a whole trailing
segment of an edited path — matching basenames alone would collide on every
`Main.java` in the course.

**Inference.** Everything else is a ranked guess from three shared signals:
scope (participant/team/project), time proximity, and identifier overlap. A
commit *after* a conversation decays slowly (τ = 8 h); one *before* it decays
fast (τ = 3 h), since it can only have prompted the question.

Two rules keep the review queue honest:

- Content overlap gates the upper heuristic bands. Every conversation is near
  *some* commit, so a pair whose only evidence is "same student, same afternoon"
  stays `weak` however close the timestamps are.
- `rank_key` sorts by band before score. Without it a well-scoring guess could
  outrank a recorded edit and the `--top` cut would discard the one candidate
  that is not a guess.

Scores are relative, not probabilities. Nothing in the pipeline decides that a
conversation *caused* a commit; a human fills in `linkage_confidence`.

## Testing

`pytest` covers the identity split, segmentation guards, timestamp handling,
migrations, and scoring — including a test pinning that chat-tool scores did not
move when deterministic linkage was added. `node --test tests/parsers.test.js`
covers the browser parsers. Fixtures are synthetic; the real logs on a developer
machine contain private conversations.
