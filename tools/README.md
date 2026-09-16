# Lab tools

Member-only services hosted on `ascend3.cs.vt.edu` under `/tools/<name>/`.
Each one is a folder here. Merging it to master deploys it; nobody SSHes.

Not the same thing as the wiki's **Research tools** (the bib checker and
friends): those are static pages open to everyone. Lab tools are running
services, and only approved lab members (`status: "member"` in Firestore,
the same approval the wiki uses) can reach them.

## Add a tool

1. Copy [`hello/`](hello/) to `tools/<name>/`. The directory name is the
   tool's name and its URL: lowercase letters, digits and hyphens, 2 to 32
   characters, not starting with `_`.
2. Edit `tool.json`. Four fields, all required:

   ```json
   { "title": "Code Tracer", "blurb": "One sentence for the wiki card.", "icon": "🧪", "owner": "pid@vt.edu" }
   ```

   A tool that is a **study instrument** adds two more, so the students in
   the study can use it without being lab members (see *Study tools* below):

   ```json
   { "...": "...", "access": "participants", "participantsUntil": "2026-12-20" }
   ```
3. Write the app so that it listens on **`0.0.0.0:$PORT`** (`PORT` is always
   8080 inside the container), writes only under **`/data`**, and starts
   cleanly more than once.
4. Write the `Containerfile` (a `Dockerfile` also works). End it with a
   non-root `USER`; see the starters below.
5. Try it the way the server runs it:

   ```bash
   docker build -t mytool tools/<name>
   mkdir -p /tmp/mytool-data
   docker run --rm -p 127.0.0.1:8080:8080 -e PORT=8080 -e HOME=/tmp \
     -e TOOL_ROOT_PATH=/tools/<name> -v /tmp/mytool-data:/data \
     --user "$(id -u):$(id -g)" --cap-drop ALL --memory 512m mytool
   ```
6. Open a pull request. CI validates `tool.json`. After the merge, the tool is
   live within about five minutes at `https://ascend3.cs.vt.edu/tools/<name>/`
   and listed under **Lab tools** on the wiki. Sign in on
   [`/wiki/lab-tools`](https://ascend3.cs.vt.edu/wiki/lab-tools), then
   `/tools/_/status` shows what the last deploy did to every tool.

## What your container gets

| | |
| --- | --- |
| `PORT=8080` | listen here, on all interfaces inside the container |
| `TOOL_ROOT_PATH=/tools/<name>` | the public prefix. nginx strips it before proxying, so your app sees `/`; relative URLs need nothing. Frameworks that build absolute URLs take it as a root path: uvicorn `--root-path $TOOL_ROOT_PATH`, Streamlit `--server.baseUrlPath`, Gradio `root_path=`, Express `app.use(process.env.TOOL_ROOT_PATH, router)` |
| `X-Forwarded-Prefix` header | the same value, per request |
| `X-Tool-User`, `X-Tool-Uid`, `X-Tool-Role` headers | who is asking, on every request: their VT email, their Firebase uid, and `member` or `participant`. nginx sets these from the gate's answer and overwrites anything a client sent, so they can be trusted. Key your tool's own data by `X-Tool-Uid` |
| `TOOL_ACCESS` | `members` or `participants`, from your `tool.json` |
| `/data` | persistent, per tool, kept across deploys, never deleted by the runner. Owned by the deploy user, which your process runs as |
| `HOME=/tmp` | your process runs as a uid the image has no passwd entry for |
| secrets | if `~/.config/ascend-tools/tools/<name>.env` exists on the server it is loaded as environment. Ask an admin to place it; never commit one |
| network | outbound internet, yes. Other tools, the gate, and services on the host's loopback: no (each tool is alone on its own bridge network, `10.200.<n>.0/24`) |

## What it cannot do

512 MB of memory, one CPU, 256 processes, no Linux capabilities, no privilege
escalation, no mounts other than `/data`, no port other than the loopback one
the runner assigns. Every `docker run` flag comes from
[`_lib/deploy.mjs`](_lib/deploy.mjs), not from your files. Logs are capped
at 30 MB per tool. A build has fifteen minutes; keep images small.

## Two rules the framework cannot enforce for you

**Escape everything you render.** Your tool's pages are served from the same
origin as the wiki. JavaScript running in them can read the signed-in
member's session, exactly as the wiki's own scripts can. One unescaped text
field is an XSS hole into the lab's Firestore and every other tool. Use a
framework that escapes by default and review your tool's frontend as you
would review site code, because that is what it is.

**Start idempotently.** The runner starts each new build twice (a pre-flight
on a scratch port, then for real), and Docker restarts a crashed container.
Migrations, seed data and caches must tolerate that.

## Study tools: participants

By default only approved lab members can open a tool. A tool that students
use as part of a study sets `"access": "participants"` and a study end date,
`"participantsUntil": "YYYY-MM-DD"` (inclusive, end of that day Eastern).
Then:

- **Any verified @vt.edu Google sign-in is admitted** to that tool, and only
  that tool. No roster, no admin approval. Lab members can open it too.
- **The participant role is assigned at sign-in** by the gate, never by an
  admin, and never touches the `members` collection: participants do not
  appear as pending members in the admin dashboard. Send students to
  `https://ascend3.cs.vt.edu/tools/<name>/`; the sign-in page adapts.
- **Two Firestore records are written per person per study**, with the
  student's own token, so the security rules bound them:
  `participants/<tool>_<uid>` (`uid`, `email`, `tool`, `createdAt`,
  `lastLoginAt`, `expiresAt`) is the active role and **auto-deletes after the
  study**: a Firestore TTL policy on `expiresAt` removes it within about a
  day of the end date. `participations/<tool>_<uid>` (`uid`, `email`, `tool`,
  `firstLoginAt`, `lastLoginAt`, `participantsUntil`) is **kept**: who took
  part in which study. Only `lastLoginAt` ever changes.
- **After `participantsUntil`** no participant can sign in and existing
  participant cookies stop working at the tool, immediately. Change the date
  in `tool.json` and merge to extend a study.
- A member using a study tool is a member, not a participant: no records.
- Firebase Auth accounts themselves are not deleted by any of this.

Your tool learns who the participant is from `X-Tool-Uid` and `X-Tool-User`
on every request. Store your study data under `/data`, keyed by uid; the
gate's records are the roster, not the data.

## Containerfile starters

Python:

```Dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8080
EXPOSE 8080
USER 65534
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--root-path", "/tools/CHANGE-ME"]
```

Node:

```Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
```

## How it works

```
browser ─▶ nginx ─▶ /tools/<name>/…  auth_request ─▶ gate (tools/_gate) ─▶ 200 + X-Tool-Port
                                      proxy_pass 127.0.0.1:<that port>  ─▶ ascend-tool-<name>
cron ─▶ autodeploy.sh ─▶ node tools/_lib/deploy.mjs   (build, pre-flight, swap, status.json)
```

- **nginx** has one static block for `/tools/`. It never changes per tool. The
  gate answers both "is this a member?" and "which port is `<name>` on?", so
  there is no per-tool location to add and nothing to reload.
- **The gate** (`_gate/`) verifies the person's Firebase ID token against
  Google's public keys and reads `members/{uid}` through the Firestore REST
  API as that user, so the existing rules decide. For a study tool it also
  writes the two participant records the same way. It sets a signed cookie
  scoped to `/tools`, valid for 24 hours, carrying the role and, for
  participants, which tools they are in. No Admin SDK and no service-account
  key exist on the server.
- **The runner** (`_lib/deploy.mjs`) builds every changed tool, starts the new
  image on a scratch port until it answers HTTP, then swaps it in. A build
  that fails or never answers leaves the running tool untouched. Outcomes go
  to `~/.local/state/ascend-tools/status.json`, which the gate routes from
  and serves at `/tools/_/status`.
- **State** lives outside the checkout: `~/ascend-tools-data/<name>/` (your
  `/data`), `~/.config/ascend-tools/` (secrets), `~/.local/state/ascend-tools/`.

Runner flags: `--validate` (manifests only, used by CI), `--dry-run` (print
the docker commands), `--force <name>` (redeploy even if unchanged; `all`).

## One-time server setup

Done once by an admin, as the deploy user on `ascend3.cs.vt.edu`:

```bash
# 1. nginx: the /tools/ block is in nginx-configs/ascend3.conf
sudo cp ~/ascend3-lab-site/nginx-configs/ascend3.conf /etc/nginx/sites-available/
sudo nginx -t && sudo systemctl reload nginx

# 2. gate secrets
mkdir -p ~/.config/ascend-tools/tools
printf 'TOOLS_COOKIE_SECRET=%s\nFIREBASE_PROJECT_ID=ascend3-lab\nSITE_ORIGIN=https://ascend3.cs.vt.edu\n' \
  "$(openssl rand -hex 32)" > ~/.config/ascend-tools/_gate.env
chmod 600 ~/.config/ascend-tools/_gate.env

# 3. docker sanity (the runner creates each tool's network itself)
docker run --rm --memory 64m hello-world
ss -ltn | grep -v 127.0.0.1      # nothing else should listen on 0.0.0.0

# 4. Firestore, for study tools (from any machine with the Firebase CLI signed in):
#    deploy the rules for the participants/participations collections, and turn
#    on the TTL policy that auto-deletes participant records after a study.
#      firebase deploy --only firestore:rules --project ascend3-lab
#      gcloud firestore fields ttls update expiresAt --collection-group=participants \
#        --enable-ttl --project=ascend3-lab
#    (or Firebase console → Firestore → Time-to-live → add policy:
#     collection group "participants", field "expiresAt")

# 5. first deploy, without waiting for cron
cd ~/ascend3-lab-site && node tools/_lib/deploy.mjs --force all
curl -i https://ascend3.cs.vt.edu/tools/_/healthz
curl -i https://ascend3.cs.vt.edu/tools/hello/     # 302 to /wiki/lab-tools: the gate works
```

After that, the only SSH a tool ever needs is a secrets file, and only if it
declares one.
