#!/bin/bash
# Auto-deploy: publish master whenever the remote moves.
#
# Runs update.sh (build + rsync to /var/www/ascend3) only when origin/master
# has new commits, so the every-few-minutes cron is free when idle. Install on
# the SERVER (ascend3.cs.vt.edu) with:
#
#   crontab -e
#   */5 * * * * $HOME/ascend3-lab-site/autodeploy.sh >> $HOME/ascend3-autodeploy.log 2>&1
#
# No sudo prereq: /var/www/ascend3 is owned by the deploying user and update.sh
# rsyncs as that user. node/npm are at /usr/bin, so cron's minimal PATH finds
# them without sourcing a profile.
set -euo pipefail
cd "$(dirname "$0")"

# One deploy at a time; a second cron tick exits quietly instead of stacking.
exec 9>"/tmp/ascend3-autodeploy.lock"
flock -n 9 || exit 0

# A failed fetch is usually a GitHub blip (~1% of ticks); it must not stop a
# deploy that is already pending locally. origin/master simply stays where it
# was, so the ff-merge below is a no-op and we deploy what the checkout holds.
git fetch origin master --quiet || echo "── $(date '+%F %T') fetch failed; continuing with the local checkout"
git merge --ff-only --quiet origin/master

# What is DEPLOYED, not what the remote holds. Comparing HEAD to origin/master
# misses a commit made on the server itself — that commit is already equal to
# origin/master the moment it is pushed, so the deploy would be skipped while
# dist/ and /var/www keep serving the old build.
STAMP=.last-deployed
DEPLOYED=$(cat "$STAMP" 2>/dev/null || true)
# A stamp naming a commit this checkout no longer has (force-push, rebase)
# cannot be diffed against; treat it as a first run.
git cat-file -e "${DEPLOYED:-missing}^{commit}" 2>/dev/null || DEPLOYED=
HEAD_SHA=$(git rev-parse HEAD)
[ "$HEAD_SHA" = "$DEPLOYED" ] && exit 0

# With no usable stamp nothing can be ruled out, so every step runs once.
touched() { [ -z "$DEPLOYED" ] || git diff --name-only "$DEPLOYED" "$HEAD_SHA" | grep -q "$1"; }

echo "── $(date '+%F %T') deploying ${DEPLOYED:0:7}${DEPLOYED:+ → }${HEAD_SHA:0:7}"

# Refresh deps only when the lockfile actually changed.
if touched '^package-lock\.json$'; then
  npm install --no-audit --no-fund
fi

./update.sh

# Survey service (survey/): rebuild + migrate + restart only when the pull
# touched it. Its deploy.sh stops before restarting on any failure, so a bad
# migration leaves the running service untouched.
if touched '^survey/'; then
  ./survey/deploy/deploy.sh
fi

# Transcript submission service (transcript-drop/): same arrangement. Its
# deploy.sh runs the test suite and stops before restarting on any failure, so a
# broken commit leaves the running service — and a semester of submissions —
# untouched.
if touched '^transcript-drop/'; then
  ./transcript-drop/deploy/deploy.sh
fi

# Lab tools (tools/): every tool is a Docker container built and swapped in by
# the runner; a tool that fails to build or start never replaces a working one.
# Runs every deploy (cheap when nothing changed) so a missing container comes
# back. Its own failure must not block the line below or a future deploy.
node tools/_lib/deploy.mjs || echo "── tools: runner failed ($?)"

# Last: set -e means any step above aborts before this line, so a failed deploy
# leaves the stamp behind and the next tick retries it.
echo "$HEAD_SHA" > "$STAMP"
echo "── $(date '+%F %T') deployed $(git rev-parse --short HEAD)"
