# Lab tools: member-only hosted services, deployed by merge

Built 2026-09-14 on branch `lab-tools`. The student-facing contract, the
architecture and the one-time server setup live in [`tools/README.md`](tools/README.md);
this file records the decisions and why.

## Problem

`survey/` and `transcript-drop/` each needed three hand-written pieces: a
`deploy/deploy.sh` plus a hand-copied `systemd --user` unit, an `if` block in
`autodeploy.sh`, and a `location` block in `nginx-configs/ascend3.conf` that
only takes effect after `sudo cp` + `nginx -t` + reload over SSH. The nginx
step is why every new service cost an SSH session. The lab wants students to
build and host services with none of that, admitted only to approved members,
listed on the wiki under "Lab tools", deployed by merging to master.

## Decisions

| decision | why |
| --- | --- |
| **Docker containers**, one per `tools/<name>/` | Docker was already on the box and usable by the deploy user without sudo (purplex). Any language without installing runtimes on the host; memory/CPU/pid caps so a runaway tool cannot take the survey down; no access to the survey `.env`, the transcript roster or other tools' data |
| **One static nginx block**, the gate reports the port | `auth_request` to the gate returns `X-Tool-Port`; `proxy_pass` uses it. Adding a tool needs no nginx edit and no root. A second proxy (Caddy) would do the same with one more daemon |
| **Gate verifies the user's own Firebase ID token** (Google JWKS) and reads `members/{uid}` via Firestore REST as that user | Reuses the existing rules unchanged; no Admin SDK and no service-account key on the server. Cookie is HS256, `Path=/tools`, 24 h; that is the revocation bound |
| **Same origin**, `/tools/<name>/` (chosen by the lab over a separate hostname) | No DNS request to CS IT. Accepted tradeoff: a tool's JavaScript runs on the wiki's origin and can read the viewing member's Firebase session, so every tool PR is reviewed as site code and `tools/README.md` says so. A separate hostname (`tools.ascend3.cs.vt.edu`) would close that and is the upgrade path if it is ever wanted; nothing else in the design would change |
| **Manifest is four fields** (`title`, `blurb`, `icon`, `owner`) | Ports are assigned by the runner, health is "answers HTTP on `/`", memory is a constant. Fewer knobs for a PR to get wrong |
| **Pre-flight on a scratch port, then swap** | A build that fails or an image that never answers leaves the running tool untouched, including the gate itself. Replaces a tag-based rollback with two `docker run`s |
| **A failed tree is not retried** until it changes or `--force` | The runner runs on every merge; rebuilding a known-broken tool for every content push would be wasted minutes. A succeeded tree whose container vanished is redeployed |
| **Invalid `tool.json` is skipped by the site build**, failed by CI | A throw in `src/lib/lab-tools.ts` would fail `update.sh` and stall autodeploy for the site, survey and transcript-drop. CI runs `deploy.mjs --validate` on PRs touching `tools/**` |
| **Study tools admit participants** (`access: "participants"` + `participantsUntil`) | Added 2026-09-15 at the lab's request. Any verified VT sign-in is admitted to that one tool until the study end date; the gate assigns the participant role at sign-in (never an admin, never the `members` collection) and writes `participants/<tool>_<uid>` (TTL'd by a Firestore policy on `expiresAt`: auto-delete after the study) and `participations/<tool>_<uid>` (kept: who took part in which study, first/last sign-in). Chosen over a per-study roster (more setup) and over a per-student rolling window (no clean semester lifecycle). Retention keeps identity by decision, so auto-delete removes access, not personal data. Tools learn who is asking from `X-Tool-User`/`X-Tool-Uid`/`X-Tool-Role`, set by nginx from the gate's answer |
| **`survey/` and `transcript-drop/` unchanged** | They serve non-members with their own authentication; the member gate would be wrong for them |

## Trust boundary

Merge to master already means "run code as the deploy user" (`npm run build`
runs on whatever is merged, and the deploy user is in `docker`, which is
root-equivalent on the host). Tools get a narrower host lane than the site
build: own image, loopback port, capped, `--cap-drop ALL`, no host mounts, one
bridge network per tool (nothing else on it). In the browser they share the wiki's
origin. PR review is the control for both; branch protection and a
`CODEOWNERS` entry for `tools/_*`, `src/`, `*.sh`, `nginx-configs/` and
`package.json` are the recommended repo settings.

## Deliberately not in v1

`POST /logout` wired to the site's sign-out; admin-only tools; per-tool README
pages on the wiki; a `test` command in the manifest; migrating the survey or
transcript-drop into `tools/`.
