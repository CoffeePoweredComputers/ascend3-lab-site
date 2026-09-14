# Deploying to a VM of its own

> **This is not how the service currently runs.** It is mounted inside the lab
> site at `ascend3.cs.vt.edu/transcript-drop/`, provisioned as described in
> [../README.md](../README.md#where-it-runs), with the units in `deploy/`.
>
> This runbook covers the standalone arrangement — a dedicated VM, Caddy, a
> `genai` system account, `ProtectSystem=strict`. Its units are in
> `deploy/standalone/`. Keep it: it is the only arrangement that gives the two
> databases genuinely different owners, and the study's protocol may require
> that back.

The VM comes as a bare install and the cluster rules make security, backups and
patching the study team's responsibility. This is the runbook for the parts that
are ours.

`172.21.222.136` is a private address, and that single fact causes both of the
problems on this page. Let's Encrypt's HTTP-01 challenge cannot reach the host —
and neither can anyone who is not on the VT network. Off campus the name either
fails to resolve (many home routers drop RFC1918 answers as DNS rebinding) or the
connection hangs until it times out. `deploy/Caddyfile` therefore ships using
Caddy's own local CA, which serves real HTTPS immediately and makes the whole
path testable — with a browser warning, so it is for the study team and not for
students.

A public address fixes both at once, and there is precedent in this department:
`ascend3.cs.vt.edu` is a CS VM on `128.173.237.123`, holding an ordinary Let's
Encrypt certificate obtained with `certbot --nginx`, with no DNS delegation of
any kind. See "Still outstanding".

## 1. Account and directories

```bash
sudo useradd --system --home-dir /opt/genai-submission --shell /usr/sbin/nologin genai
sudo mkdir -p /opt/genai-submission /var/lib/genai-submission
sudo chown genai:genai /var/lib/genai-submission
sudo chmod 750 /var/lib/genai-submission
```

The databases live in `/var/lib/genai-submission`, outside the checkout. That is
what lets the checkout stay read-only under `ProtectSystem=strict`, and it means
a `git pull` cannot touch student data.

## 2. Code and virtualenv

There is no git remote yet, so the checkout is copied rather than cloned. From
the laptop that holds it:

```bash
rsync -av --delete \
  --exclude .git --exclude .venv --exclude data --exclude interaction-logging \
  --exclude .env \
  ~/Projects/data-collection/ <pid>@172.21.222.136:/tmp/genai-staging/
```

Then on the VM:

```bash
# --exclude repeated here on purpose: --delete removes anything the source does
# not have, and the source has no .venv or data because they were excluded on
# the way up. Without these two the virtualenv is deleted on every update.
sudo rsync -a --delete --exclude .venv --exclude data \
  /tmp/genai-staging/ /opt/genai-submission/
sudo chown -R genai:genai /opt/genai-submission
rm -rf /tmp/genai-staging

cd /opt/genai-submission
sudo -u genai python3 -m venv .venv
sudo -u genai .venv/bin/pip install -r requirements.txt
```

`config/roster.csv` and `config/consent.csv` are gitignored but the service needs
them, and rsync carries them across — which is the point of copying the working
tree rather than a clone. Check they arrived before enabling anything.

`.env` is excluded on purpose. It is the same four sign-in settings in the same
format, but a laptop's copy usually names a test Firebase project, and shipping
it would put that file next to the live configuration. On the server these
settings come from `/etc/genai-submission.env` instead, which systemd hands to
the service — and which wins over a `.env` anyway, since the loader only fills
in names the environment does not already have.

Put this in a private GitHub repository when there is time; `git pull` is a
better update path than remembering an rsync flag, and section 8 assumes it.

## 3. Configuration

```bash
sudo install -m 600 -o root -g genai /dev/null /etc/genai-submission.env
printf 'GENAI_ADMIN_TOKEN=%s\nBACKUP_DEST=%s\n' \
  "$(openssl rand -base64 32)" "/mnt/vt-research/genai-backups" \
  | sudo tee /etc/genai-submission.env > /dev/null
```

Mode 600 root:genai — readable by the service, not by anyone with a shell on the
box. Keep the token somewhere the three admins can find it; without it
`/api/admin/status` answers 503 rather than opening.

### Sign-in

Students sign in with a VT Google account and the server verifies the Firebase ID
token, so the service needs to know which Firebase project to trust. Append four
settings to the same env file:

```bash
printf 'GENAI_FIREBASE_API_KEY=%s\nGENAI_FIREBASE_AUTH_DOMAIN=%s\nGENAI_FIREBASE_PROJECT_ID=%s\nGENAI_FIREBASE_APP_ID=%s\n' \
  "<apiKey>" "<project>.firebaseapp.com" "<project>" "<appId>" \
  | sudo tee -a /etc/genai-submission.env > /dev/null
```

All four are public values — a Firebase web `apiKey` names a project, it does not
authorise anything — and they live here only so one deployment can point at a
different project than another. There is **no service-account key**: verifying a
signature needs Google's public keys, not the project's private one, so nothing
on this host is worth stealing.

All four must be set or the server treats sign-in as unconfigured and says so on
the page. It fails closed: a missing setting can never mean "skip the check".

In the Firebase console, once per project:

1. **Authentication → Sign-in method** → enable **Google**, set a support email.
2. **Authentication → Settings → Authorized domains** → add
   `transcript-drop.cs.vt.edu`. Sign-in popups fail on an unlisted origin, and
   they fail quietly.
3. **Project settings → Your apps** → register a Web app to get the four values.

Firebase Auth will hold the email address of everyone who signs in, including
students who then decline consent. That is a copy of identifiable data outside
the two databases this runbook otherwise accounts for — worth checking against
the protocol, and worth deciding whether it belongs in the lab's existing
Firebase project or one created for this study.

Then the files the instructor owns, which are **not** in version control:

| File | What it is |
| --- | --- |
| `config/roster.csv` | The class roster. Currently holds only the three staff accounts |
| `config/consent_form.md` | The consent document. In the repo, but check it matches the IRB-approved wording before anyone sees it |
| `config/consent.csv` | Optional. Consent collected outside the portal |

## 4. Services

```bash
sudo cp deploy/genai-submission.service /etc/systemd/system/
sudo cp deploy/genai-backup.service deploy/genai-backup.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/genai-submission.service
sudo systemctl daemon-reload
sudo systemctl enable --now genai-submission genai-backup.timer
```

`systemd-analyze verify` first: these units were written on a machine without
systemd and have never been parsed by it.

## 5. Caddy

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

`caddy validate` first: this file was written on a machine without Caddy and has
never been parsed by it.

`systemctl **restart**`, not reload — the config turns the admin API off, and
reload goes through it. Restarting drops connections in flight, so do it outside
a deadline.

The access log records client IP addresses, which for this study are personal
data. It rolls at 20 MB, keeps 5 files and expires at 30 days; check that suits
the protocol before term starts.

### TLS

```bash
sudo bash deploy/standalone/setup_tls.sh
```

Run it whenever something changes. It removes nginx if apt dragged it in,
installs certbot with the Cloudflare plugin, checks what is still missing, and
stops with a list rather than a failure if the API token or the CNAME delegation
is not there yet. Once both are, it obtains the certificate, installs a renewal
hook that restarts Caddy, points Caddy at it, and verifies the result with a
plain `curl` — no `-k`, because the question is precisely whether a browser
would accept it. Anything that fails validation or verification is rolled back
and Caddy is left running on what worked.

Which certificate to serve lives in `/etc/caddy/tls.d/tls.conf`, imported by the
Caddyfile, and not in the Caddyfile itself — otherwise deploying from version
control would put the browser warning back every time.

## 6. Check it

```bash
systemctl status genai-submission
journalctl -u genai-submission -n 50

curl -s localhost:8000/healthz                       # {"status":"ok"}
curl -s -H "X-Admin-Token: $TOKEN" localhost:8000/api/admin/status | python3 -m json.tool
```

`/healthz` reads both databases, so `ok` means more than "the process is alive".

From a laptop, before TLS exists:

```bash
ssh -L 8000:localhost:8000 you@transcript-drop.cs.vt.edu
```

## 7. Backups

```bash
systemctl list-timers genai-backup          # when it next runs
sudo systemctl start genai-backup           # run one now
journalctl -u genai-backup -n 20
```

Nightly at 03:15, keeping 30. Each run writes one self-contained gzipped file
per database into `identity/` and `research/` subdirectories of `BACKUP_DEST`,
and opens each copy to check it is intact before pruning old ones.

The directory has to exist and be writable by the service account:

```bash
sudo mkdir -p /var/backups/genai
sudo chown genai:genai /var/backups/genai
sudo chmod 750 /var/backups/genai
```

`BACKUP_DEST` is set in `/etc/genai-submission.env`, and the same path has to
appear in `ReadWritePaths` in `deploy/genai-backup.service`. They are two
separate places and both have to agree: `ProtectSystem=strict` makes the whole
filesystem read-only except what that directive names, and systemd cannot expand
an environment variable there. Miss it and the backup fails at 03:15 with a
read-only filesystem error — a failure nobody notices until the night they need
a restore.

**Point `BACKUP_DEST` off this VM as soon as research storage is available.** The cluster rules allow the machine to be
switched off without notice if it becomes a security risk, and a backup on the
same disk does not survive that. The two subdirectories exist so the identity
database and the research database can be given different permissions — putting
them back into one folder with one ACL undoes the separation the whole design
rests on.

To restore:

```bash
gunzip -c research/research-20260908T031500Z.db.gz > research.db
sqlite3 research.db 'PRAGMA integrity_check;'
```

## 8. Updating

Until there is a git remote, an update is the same two rsyncs as section 2 —
including `--exclude .venv --exclude data` on the server-side one.

```bash
cd /opt/genai-submission
sudo -u genai .venv/bin/pip install -r requirements.txt
sudo systemctl restart genai-submission
```

Restarting is what applies a change to `config/projects.yaml` — `course_config()`
is cached for the life of the process. `config/roster.csv`, `config/consent.csv`
and `config/consent_form.md` reload on their own and need no restart.

## Status

Deployed 27 August 2026. The service, the nightly backup timer and Caddy are all
running; `/healthz` answers `ok`, `/api/admin/status` answers with the token, and
a manual backup wrote and verified both databases.

Reachable from the campus network at **https://transcript-drop.cs.vt.edu**,
with a certificate warning because Caddy's local CA signed it.

Two things that were blocking are now done, and both are worth remembering for
next time. DNS was activated by CS techstaff on 27 August. **Inbound 443 was not
an upstream firewall at all** — it was `ufw` on the VM itself, default-deny with
only 22 allowed, and `ufw allow 443/tcp` fixed it without a ticket. Check the
machine's own firewall before assuming the block is somebody else's.

`ufw limit` on port 22 is also still in force: more than six SSH connections
from one address in thirty seconds get refused for a while. That looks exactly
like a fail2ban ban and is easy to trigger by retrying, or by probing the port
during diagnosis.

## Still outstanding

- **A public IP address**, which is the actual blocker and the fix for the
  certificate too. Ask CS techstaff to move `transcript-drop.cs.vt.edu` onto a
  routable address the way `ascend3.cs.vt.edu` already is. Then delete
  `/etc/caddy/tls.d/tls.conf` and restart Caddy: with no explicit `tls`
  directive the site falls through to Caddy's automatic HTTPS, which completes
  HTTP-01 on port 80 (already open in ufw) and renews itself every 60 days. No
  CNAME delegation, no Cloudflare token, no `deploy/standalone/setup_tls.sh`, and students
  can reach the site from off campus.

  Only if the address has to stay private: the `_acme-challenge` CNAME
  delegation described in `deploy/standalone/setup_tls.sh` is the fallback, and the
  instructions to students must then say the VT network or the VPN is required.
  Note that Caddy's local CA issues 12-hour leaf certificates, so until this is
  resolved the browser warning returns twice a day even for the study team.
- The IRB-approved consent wording in `config/consent_form.md`.
- The real class roster; it currently holds only the three staff accounts.
- `BACKUP_DEST` still points at `/var/backups/genai` on this same disk. Move it
  to research storage when there is some.
