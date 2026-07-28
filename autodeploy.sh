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
# ONE-TIME PREREQ — update.sh uses `sudo rsync`, which can't prompt under
# cron. Allow that exact command without a password (sudo visudo):
#
#   <your-user> ALL=(root) NOPASSWD: /usr/bin/rsync -av --delete dist/ /var/www/ascend3/
#
set -euo pipefail
cd "$(dirname "$0")"

# One deploy at a time; a second cron tick exits quietly instead of stacking.
exec 9>"/tmp/ascend3-autodeploy.lock"
flock -n 9 || exit 0

git fetch origin master --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "── $(date '+%F %T') deploying ${LOCAL:0:7} → ${REMOTE:0:7}"
git merge --ff-only origin/master

# Refresh deps only when the lockfile actually changed in the pull.
if git diff --name-only "$LOCAL" "$REMOTE" | grep -q '^package-lock\.json$'; then
  npm install --no-audit --no-fund
fi

./update.sh
echo "── $(date '+%F %T') deployed $(git rev-parse --short HEAD)"
