# GenAI Interaction Log + GitHub Development History

Collects the GenAI conversations students used on open-ended collaborative
projects, normalizes them into one format regardless of which tool produced
them, and — after the semester — links them to the development history already
recorded in the course GitHub repositories.

Students install nothing and submit no commits. The only thing they do is upload
or paste their conversations once per project.

```
VT email ──► Participant Code   
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
Universal GenAI Uploader   Course GitHub
        │                       │
Normalized Conversations   Commit History
        └───────────┬───────────┘
                    ▼
      Project / Team / Time-based matching
                    ▼
             Content comparison
                    ▼
             Validated linkage
```

## Layout

See [docs/backend.md](docs/backend.md) for how the backend fits together.

| Path | What it is |
| --- | --- |
| `app/` | Submission service (FastAPI) and the shared normalizing/matching logic |
| `static/` | The student-facing page and the browser-side export parsers |
| `scripts/` | Researcher tools: git extraction, candidate matching, dataset export |
| `config/` | Everything the instructor edits per semester |
| `data/` | SQLite databases and exports (git-ignored) |

## Two databases, on purpose

`data/identity.db` is the only place a real identity exists. It holds nothing
but `email ↔ participant_code`.

`data/research.db` holds submissions, conversations, turns, commits, diffs,
stage snapshots, AI-applied edits and linkages — all keyed by participant code.
No table in it contains an email, and a test asserts that.

Provenance the tools already record — which model answered (per turn, so a
mid-conversation model switch stays visible), client version, effort level,
repository, branch, commit — is extracted automatically. Students are never
asked to type any of it; a remembered model name would not be reliable anyway.

## Teams change; participants do not

The course rebuilds teams at the start of P2 and P3, and a team can also change
membership mid-project. So the participant is the stable unit and a team is an
entity created per project:

| participant | project | team instance | teammates |
| --- | --- | --- | --- |
| S001 | P1 | `P1_T17` | S002, S003 |
| S001 | P2 | `P2_T08a` | S021, S044 |
| S001 | P2 | `P2_T08b` | S021, S073 |
| S001 | P3 | `P3_T31` | S007, S118 |

`S001` is the backbone all semester — the same code the IRB already uses for
surveys, questionnaires and interviews. Only the team instance changes.

A membership change **never edits an existing row**. It closes one instance and
opens another, so anything that happened before the change stays attributed to
the team as it was. `config/roster.csv` carries this directly:

```csv
email,project_id,team_instance_id,joined_at,left_at
905123456,P2,P2_T08a,2026-09-28,2026-10-12
905123456,P2,P2_T08b,2026-10-13,
```

```bash
.venv/bin/python scripts/sync_roster.py
```

This loads `team_instances`, `participant_team_membership` and
`participant_consent`. It mints participant codes for **every** student on the
roster, not just the ones who submitted — a teammate who never submitted still
has to appear, because their consent gates their team's repository.

### What attaches to what

- **Participant-level** — AI interaction logs. Attributed to the individual, and
  to whichever team instance was in force at the conversation's timestamp. A
  pasted conversation with no timestamp falls back to the submission time, and
  records `team_assignment` so a fallback across a mid-project change is visible
  rather than reading like a fact.
- **Team-level** — the GitHub repository, which mixes several students' work.
  Each commit is attributed to the instance in force when it was authored.
- **Temporal linkage** — `participant_team_membership` is the join, with
  `joined_at` / `left_at`.

Matching scopes by team *label* (`T08`), not instance, since the instances of one
team share a repository — a conversation from before a change can still relate to
a commit from after it. The review CSV records both instances and a
`same_team_instance` flag rather than hiding the pair.

### Consent gates repository collection

A repository is collected only when **every member of every instance** of that
team has consented. One non-consenting member keeps the whole repository out,
because collecting it would pull in their code, commit messages and design
decisions too. A member who left mid-project still counts — they authored part of
the history.

Consent is normally given in the portal itself, on a student's first visit, and
stored in `identity.db` beside the address it belongs to — never in
`research.db`, because a consent decision is about a named person, which is
exactly what that database must not contain. Each answer records a fingerprint of
the wording that was on screen: consent forms get revised, and "they consented"
is a much weaker record than "they consented to this text".

`config/consent.csv` remains for consent collected outside the portal — on paper,
or before it existed. Either route counts. **Anyone absent from both counts as
not consenting**, which is the only safe default.

```csv
email,consent,recorded_at
hokie@vt.edu,yes,2026-09-01
```

Individual AI logs are not gated this way: a student submits their own
conversations, and only their own.

The repository itself is handed in by the students, into `team_repositories`.
`config/repos.csv` is therefore optional — `scripts/extract_git.py` falls back to
what was submitted when the file is absent, and the file remains for archives and
local checkouts. `config/projects.yaml` carries the `repository.access_note`
shown on that page: a private repository URL on its own gets the research team
nowhere, so that line has to say how access actually works on this course.

### Staff accounts and the sandbox

`config/projects.yaml` names three admin addresses. They are staff, not
participants: `scripts/export_dataset.py` drops their records from the exported
corpus, because a test conversation in a published dataset is not a mistake
anyone notices later.

They are **not** exempt from the consent screen. It is the first thing every
student sees, so it is the first thing a test account has to be able to check.

`P0` is a sandbox project for them. It is deliberately first in the file and
deliberately has no stages — without stages it has no date window, so nothing a
tester submits gets filtered by date, and because `project_window()` reads the
previous project's stages to find where the next one starts, an empty `P0` leaves
`P1`'s window exactly as it was. It is `hidden`, so it does not appear in the
student dropdown; reach it at `/?sandbox=1`.

### Health and status

```bash
curl https://transcript-drop.cs.vt.edu/healthz
curl -H "X-Admin-Token: $GENAI_ADMIN_TOKEN" https://transcript-drop.cs.vt.edu/api/admin/status
```

`/healthz` is public and says nothing: `{"status": "ok"}`, or `503` with which
database it could not read. It is open on purpose — systemd, a load balancer and
an uptime monitor all call it and none of them carry credentials, and a check
that needs a secret is a check that stops being run. It is safe to leave open
because there is nothing in the answer.

`/api/admin/status` holds what is actually worth protecting: counts, the last
submission, consent totals, whether the consent form is usable, disk free and
database sizes. It is gated on `GENAI_ADMIN_TOKEN`, a shared secret set on the
server — **not** on the admin email addresses, which are printed on the consent
form and control nothing. With no token configured the page is closed rather than
open, and a wrong token gets a `404`: there is no reason to confirm the page
exists to someone who cannot open it.

### Where it runs

Mounted inside the lab site, at **`https://ascend3.cs.vt.edu/transcript-drop/`**.
It is a service in this repository the same way `survey/` is: its own folder, its
own dependencies, a systemd `--user` unit owned by the deploying account, and
nginx proxying one path prefix to it on loopback.

| | |
| --- | --- |
| URL | `https://ascend3.cs.vt.edu/transcript-drop/` |
| Port | `127.0.0.1:8788` (survey is 8787) |
| Unit | `ascend-transcript-drop` (`systemctl --user`) |
| Checkout | `~/ascend3-lab-site/transcript-drop` |
| Databases | `~/transcript-drop-data`, **outside the checkout** |
| Deploy | `autodeploy.sh` → `transcript-drop/deploy/deploy.sh` on any push touching `transcript-drop/` |

Living here settles what a VM of its own could not. `ascend3.cs.vt.edu` is on a
public address with an ordinary Let's Encrypt certificate, so the site is
reachable from off campus and the certificate renews itself — where a private
RFC 1918 address made HTTP-01 impossible and left students outside the VT
network unable to reach the page at all.

The databases live outside the checkout because `autodeploy.sh` runs
`git merge --ff-only` on every deploy. A SQLite file inside the working tree
would be sitting in the path of that.

**What it costs.** On its own VM the two databases had different owners and
different permissions, which is the separation the whole design rests on. Here
both are files owned by one account, and the service runs as the deploying user
rather than a locked-down system account with `ProtectSystem=strict`. The
separation is now a matter of directory permissions and the application never
joining them, not of the operating system enforcing it. `deploy/standalone/`
keeps the units for the stricter arrangement if the protocol needs it back.

#### Server provisioning (one time, on ascend3.cs.vt.edu)

```bash
~/ascend3-lab-site/transcript-drop/deploy/provision.sh
```

It creates the data and backup directories, enables linger, writes `.env` from
the example with an admin token and backup path filled in, installs the
`systemd --user` units, runs `deploy/deploy.sh`, and checks the public URL. It
is idempotent, and stops before the deploy while either of the two things only
a person can supply is missing — the four `GENAI_FIREBASE_*` values in `.env`
and `config/roster.csv` — saying which; supply them and run it again.
`--firebase-from-site` fills the Firebase values from the lab site's own `.env`,
which reuses the site's project: every student who signs in becomes a user
there and shares the site's session on this origin. A project of the study's
own keeps them apart.

Then nginx, once, as root:

```bash
sudo cp ~/ascend3-lab-site/nginx-configs/ascend3.conf /etc/nginx/sites-available/
sudo nginx -t && sudo systemctl reload nginx
```

In the Firebase console, add `ascend3.cs.vt.edu` to **Authentication → Settings →
Authorized domains**, or the sign-in popup fails and fails quietly.

[docs/deployment.md](docs/deployment.md) covers the other model — a VM of its
own, Caddy, a `genai` system account — and the units for it are in
`deploy/standalone/`.

## Running the submission service

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
.venv/bin/python scripts/run_server.py
```

Then open `http://localhost:8000`. `PORT` and `HOST` are read from the
environment. Every URL the page uses is relative, so it works unchanged at the
root in development and under `/transcript-drop/` in production.

Never run it on plain HTTP anywhere but localhost: it holds student data, and
Google will not open a sign-in popup from an origin Firebase has not authorized.

### Sign-in settings

Students sign in with a VT Google account, so the server has to know which
Firebase project to trust. Copy the example and fill in four values from the
Firebase console (Project settings → Your apps):

```bash
cp .env.example .env
```

`.env` is git-ignored. None of the four are secrets — a Firebase web `apiKey`
names a project and ships to every browser — but which project a checkout talks
to is that checkout's business, and a committed one follows every clone.

All four must be set. With any missing, the server treats sign-in as
unconfigured, says so on the page, and refuses every request; it never falls
back to trusting a typed address. Without a `.env` at all, the page loads and
explains that sign-in is not set up, which is what a fresh clone should see.

`localhost` is already an authorized domain in Firebase, so a local run needs
nothing added there. The deployed hostname does — see
[docs/deployment.md](docs/deployment.md).

`run_server.py` sets its own working directory from its own file location rather
than trusting the one it inherits, so it still starts correctly from a launcher
that hands it a working directory it is not allowed to read.

> Keep this project out of `~/Desktop`, `~/Documents` and `~/Downloads`. macOS
> protects those folders, and a process launched by a *sandboxed* parent — an
> IDE preview runner, for instance — does not inherit access to them: it cannot
> read the project at all, and cannot even call `getcwd()` from inside it.
> Running the server yourself from a terminal is unaffected either way.

### What the student sees

1. **Sign in with a VT Google account, then pick a project.** The address is
   exchanged for a participant code and goes no further. It is also what git
   records as a commit author, so the string that opens a submission is the one
   that later ties a commit to a participant.

   **This is authentication, not a check.** The browser signs in with Google and
   the server verifies the resulting Firebase ID token — signature, audience,
   issuer, expiry, and Google's own `email_verified` claim — in `app/auth.py`.
   No endpoint reads an address out of a request body; `current_email` in
   `app/main.py` is the single place the question "who is calling?" is answered.
   Anything outside `@vt.edu` (or a subdomain of it) is refused, at the token
   and again in `normalize_email`.

   The team is no longer typed. It existed to make a mistyped or borrowed
   address visible — a wrong address would not also carry the right team — and
   an address that has to be signed for can be neither. The roster is asked
   instead, about the account that signed in, so a student can only ever be
   given their own team. The one exception is a student who changed teams during
   a project: both labels are truthfully theirs, so the portal asks once which
   one the work belongs to, and nobody else sees the question.

   A student the roster does not know cannot submit at all, and is told so
   plainly. That is on purpose: the roster is what links a submission to a team
   instance and therefore to a repository, so an unrostered submission would
   have little research value anyway, and the instructor's fix lands on the next
   request without a restart. Saying it plainly is safe now — the caller has
   already proved they own the address, so their own absence tells them nothing
   about anyone else.
2. **Eligibility, then consent, once.** The first thing on the screen is the age
   question — this study is open to students aged 18 or older — and the consent
   document stays hidden until it is answered. That order comes from the
   protocol, which has the portal confirm eligibility before presenting the
   consent information; enrolment is already settled by the roster match, so only
   age is asked. Answering "under 18" replaces the form with a notice saying so.

   The student then reads `config/consent_form.md` and agrees or declines. After
   that they go straight to the submission page.

   Choosing "I do not agree" reveals, immediately and before it is confirmed,
   what declining costs: no access to the site, nothing collected, and no effect
   on their grade. A decline is recorded rather than left blank — absence and
   refusal gate the same way but are not the same fact — and a student who
   declined is shown the form again on their next visit rather than locked out,
   because a decision like this one has to be changeable.

   `POST /api/submissions` checks consent as well. The screen is a convenience;
   the endpoint is the boundary.

   The form is filled in from HRP-503a (IRB # 26-883). The server still refuses
   to display any form containing a `[PI TO COMPLETE: …]` marker, answering 503
   and telling the student to contact their instructor — showing an unapproved
   consent document is not a cosmetic bug, and "we forgot to fill in the PI's
   phone number" is exactly the mistake that survives a review.
3. **Add conversations.** Any tool, any format: JSON/JSONL exports, HTML, plain
   text, Markdown, or pasted text. Several files can go in at once and are merged
   into one selection list, so a folder of logs saved over the semester works.
   Conversations outside the project's dates are folded away behind a toggle.
   When a file format identifies its tool, that beats the platform the student
   picked — one upload can legitimately mix ChatGPT and Claude Code.
4. **One question per conversation, and it can be skipped.** Primary purpose.
   The tool is shown, not asked: the file format identifies it more reliably
   than a student recalling which window a conversation came from, so the field
   is fixed when detection succeeded and only becomes a choice for pasted text,
   where there is nothing to detect. Nothing is annotated per prompt.
5. **One completeness question**, then submit. They get a confirmation code.
6. **The team's repository**, on its own card and its own button. When a team
   has finished a project, any member hands in the GitHub link once; a later
   link replaces it, so a renamed or re-created repository is fixed in ten
   seconds rather than by email. It stays on screen after the logs are
   submitted, which is the moment students actually remember it.

   Whatever they paste is reduced to one canonical URL — the address bar, the
   clone button, an SSH remote, a link to a branch or a file all name the same
   repository. Anything that is not a GitHub repository is refused rather than
   accepted: a plausible-but-wrong URL is only discovered at extraction, months
   later, when the student has gone.

### What to submit, per tool

Two kinds of tool with very different data: chat tools, matched to commits
heuristically, and IDE tools whose logs also carry the repository and the edits
the model made. Ordered by how dependable the route is.

| Tool | Route | Watch out for |
| --- | --- | --- |
| VT Arc | The chat's own JSON download | Downloads on the spot — no export request, no waiting. The most dependable route here |
| Claude Code, Codex, Copilot, Cursor | `scripts/collect_ai_logs.py` (below) | Local session logs; nothing to request |
| ChatGPT | Paste a **share link** on the form | Supported by link only. Sharing makes that conversation readable by anyone with the URL |
| Claude | Paste, or Settings → Privacy → Export data | Share links cannot be read. **Check `conversations.json` is not empty** — one real export arrived with none — and note `projects/` holds uploaded documents, not chat. Export is web/desktop only |
| Anything else | Copy the conversation text and paste it | Copy the *messages*, not "view page source" |

**Gemini is deliberately not listed**, and falls under "anything else". A share
link is public and renders without a login, but the page ships 822 KB of
JavaScript and 56 characters of text — the conversation arrives afterwards over
an internal RPC, so fetching the URL server-side yields nothing. Saving the
rendered page does work: the DOM is cleanly structured (`share-turn-viewer` per
exchange, `user-query-content` and `response-container` inside it) and carries
the title, the model and both dates. What ruled it out is the instruction it
would take — Chrome saves a usable file only under *Web Page, Complete*, while
*Single File (.mhtml)* and Safari's default `.webarchive` both produce something
unparseable, and that is a lot of ceremony to get right across a whole class.
Pasting the text stays available, and the Takeout parser is still in the code for
anyone who uploads one anyway.

Pasting a Gemini conversation cannot be split into turns, incidentally: the page
labels the student's messages `You said` with no colon and the replies with
nothing at all, so once flattened to text the boundary between question and
answer is gone. Such a paste is stored whole, as one `unsegmented` turn.

**IDE and terminal tools** — local session logs that also record the repository,
the branch, and the edits the model applied.

| Tool | Where its logs live |
| --- | --- |
| Claude Code | `~/.claude/projects/<escaped-cwd>/<session>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Copilot Chat | `<VS Code>/User/workspaceStorage/<hash>/chatSessions/*.json` |
| Cursor | `~/.cursor/projects/<flattened-workspace>/agent-transcripts/<id>/<id>.jsonl` |

Students do not go hunting for those. One command gathers the ones belonging to a
single project:

```bash
curl -sSO https://transcript-drop.cs.vt.edu/collect_ai_logs.py
python3 collect_ai_logs.py --repo .
```

The service serves the script at `/collect_ai_logs.py`, so students always run the
current version — a copied script goes stale silently, and one did during testing,
missing an entire tool's conversations.

The bundle is written to `<repo>/interaction-logging/`, which the script excludes
from git the first time it creates the folder, using a `.gitignore` containing `*`
placed inside it. **Never commit these.** A repository is shared, so committed
conversations are readable by every teammate and stay in the history afterwards.

Sessions from other projects are never included — the filter is the session's own
working directory, and the project folder name for a project that has since moved.
Add `--dry-run` to see what it would pick up, or `--since 2026-10-01` to narrow it.

**Cursor is the exception to both of those.** It records no working directory in
the transcript, so the only links back to a project are the folder name — which
it flattens, turning `~/p2-old` and `~/p2/old` into the same string — and the
files the session edited. A session qualifies when it ran with the repository (or
a folder inside it) open, or when it edited a file inside the repository from
somewhere else. A session that merely *read* a file here does not: reading is
incidental, editing is not. The candidate names are generated from the
repository's own folders rather than pattern-matched, so a lookalike neighbour is
never swept in.

Cursor also stamps only the student's own messages, in prose — `Friday, Aug 21,
2026, 3:47 PM (UTC-4)` — and nothing else in the file carries a time. That offset
is parsed by hand on both sides, because `Date()` in the browser accepts the
string and then silently ignores the offset in favour of the reader's own
timezone, which would shift every conversation by hours for anyone uploading from
somewhere other than where they worked. Replies are left unstamped rather than
given an invented time. Its tool calls carry no results either, so its edits are
what the model asked for, not confirmation that the write landed.

### Reading a ChatGPT share link

The form accepts `https://chatgpt.com/share/…`. The server fetches the page and
recovers the conversation, with per-message timestamps and the model that
answered. This exists because exports are not dependable: one real Claude export
came back with zero conversations, and ChatGPT's can take a week.

**ChatGPT only.** Claude share links were tested and cannot be read this way:
the page is a client-side shell holding no conversation, and the API that fills
it sits behind bot protection. Reading one would mean defeating an access
control the site owner put there, so a Claude link is refused with the two
routes that do work — paste, or upload the export.

Gemini share links are refused for a different reason. The page does render, but
Google fills it in afterwards through its internal `batchexecute` RPC, whose
replies are positional arrays with no field names and whose requests need a
session id and a dated build label scraped from the page. Reading array
positions out of an undocumented internal API would break mid-semester and do it
silently, which is worse than not offering it. The rendered share page copies
cleanly and even shows the model and dates, so paste is the better route.

Two things to know. `chatgpt.com/backend-api/share/<id>` answers 403 to an
unauthenticated request, so the conversation is read out of the page itself,
where it sits in React Router's streamed value table — a private detail of
someone else's frontend that can change without notice. Every failure is
therefore reported as "paste it instead" rather than as an error. And only
share links work: a normal `/c/` link needs the student's own session and
cannot be fetched at all.

The URL pattern in `app/share_import.py` is the whole SSRF defence — only share
URLs on known hosts are fetched, and redirects are refused rather than followed
so one cannot walk the request onto another host.

Sharing is not free: it makes that conversation readable by anyone holding the
URL. Students who would rather not should upload the export or paste instead.

### Whole-account exports stay on the student's machine

A ChatGPT or Claude account export contains everything the student ever asked,
including conversations that have nothing to do with the course. `static/parsers.js`
parses the file **in the browser**, shows the conversation titles, and sends only
the ones the student ticks. Nothing is pre-selected.

### Adding a platform

Add an entry to `platforms:` in `config/projects.yaml`. That is all that is
required — the uploader already accepts files and pasted text for any tool, and
"Other" stays available for a service nobody anticipated.

If a new tool has a distinctive export format worth parsing structurally, add a
detector and parser to `static/parsers.js`. Unrecognised formats degrade to text
and are segmented server-side rather than being rejected.

## Researcher tools (after the semester)

Copy `config/repos.example.csv` to `config/repos.csv` and
`config/authors.example.csv` to `config/authors.csv` first.

```bash
.venv/bin/python scripts/extract_git.py --repos config/repos.csv
```

Pulls commit metadata, per-file diffs, branch membership, and the per-stage
snapshots (`P2_SPEC`, `P2_PROTOTYPE`, `P2_FINAL`, …) defined by the deadlines in
`config/projects.yaml`. Remote URLs are mirrored into `data/repos/`. Re-running
it is safe: commits are replaced by hash.

A commit authored from the student's VT email resolves on its own — that address
*is* the participant — so `authors.csv` is only needed for the addresses git
records instead: GitHub noreply aliases, and personal addresses left in a local
git config. An entry there wins over the direct match, since it is an explicit
statement by the researcher. Commits neither route resolves are still stored,
just without a participant code.

```bash
.venv/bin/python scripts/match_candidates.py --project P2
```

Scores every (conversation, commit) pair that shares a team and project and
falls inside the time window, then keeps the top candidates per conversation in
the `linkages` table and writes `data/export/linkage_review.csv` with
`linkage_confidence` left blank for a human.

```bash
.venv/bin/python scripts/export_dataset.py --out data/export
```

Participant-coded CSVs. Add `--include-content` to also write the raw
conversation text as JSONL.

## How candidate matching works

### When the tool recorded what it edited

Claude Code, Codex, Copilot and Cursor log the files the model touched, and Codex
also logs the repository URL, branch and HEAD commit. When a conversation carries
those, linkage stops being a guess: a commit whose changed files intersect the
files the AI is recorded as having written is banded **`direct`**.

Edited paths are absolute and commit paths are repository-relative, so a commit
path matches when it is a whole trailing segment of an edited path — matching on
basenames alone would collide on every `Main.java` in the course.

`direct` candidates are triaged ahead of every heuristic band, so the
per-conversation `--top` cut can never discard a recorded link in favour of a
well-scoring guess.

### Everything else

Nothing here claims causality. It narrows thousands of pairs down to a few a
researcher can actually review, from three signals the two sources share:

* **Scope** — same participant, team, project. Commits from other teams are not
  considered unless you pass `--all-teams`.
* **Time** — a commit made after a conversation decays slowly (τ = 8 h); one made
  before it decays fast (τ = 3 h), since it can only have prompted the question.
* **Content** — identifiers and filenames shared between the conversation text
  and the commit's message, changed paths, and added/removed diff lines. Diff
  *context* lines are ignored, and Java boilerplate (`public`, `static`,
  `println`, …) is stoplisted so it cannot make every pair look related.

Scores are relative, not probabilities. A genuinely strong pair — the
conversation names the class, the commit creates the file — lands around 0.5–0.7
on content; an unrelated pair sits near zero. Bands: `high` ≥ 0.60,
`moderate` ≥ 0.40, `weak` ≥ 0.20.

Content overlap gates the upper bands. Every conversation is temporally near
*some* commit, so a pair whose only evidence is "same student, same afternoon"
stays `weak` however close the timestamps are, and a reviewer's queue of `high`
candidates stays short enough to be worth reading.

Conversations pasted without timestamps are common. Those are matched on content
alone, with the weight redistributed rather than a timestamp assumed, and
`time_known = 0` is recorded so the two kinds of candidate are never silently
compared.

### The two asymmetric cases

A conversation may have no plausible commit. A commit may have no submitted
conversation near it. The second is reported as **"no corresponding GenAI
interaction observed in the submitted logs"** — never as evidence the code was
written without AI. Submission is self-reported and incomplete by construction,
which is exactly why every submission carries a completeness answer.

## Tests

```bash
.venv/bin/python -m pytest -q
```

Covers the segmentation heuristic and its guards, timestamp normalization,
duplicate detection, the identity split (including an assertion that no student
ID reaches the research database), the schema migration for databases created
before workspace context existed, and the matching scores — including that a
chat-tool conversation scores exactly as it did before deterministic linkage was
added.

```bash
node --test tests/parsers.test.cjs
```

Covers the browser-side parsers: the ChatGPT branch walk, Claude content blocks,
Takeout, JSONL, the Claude Code / Codex / Copilot / Cursor session formats, the
collector bundle, and the fallback to text for unrecognised formats.

## Not built yet

The researcher review UI (section 14) — reading `linkage_review.csv` and filling
in `linkage_confidence` works for the first pass. The `linkages` table already
has the columns a UI would write (`linkage_confidence`, `change_type`,
`reviewer`, `reviewed_at`, `notes`).
