#!/bin/bash
# Refresh dependencies and restart the transcript submission service.
#
# Called by ../../autodeploy.sh whenever a pull touched files under
# transcript-drop/; safe to run by hand from anywhere. `set -e` means a failed
# install stops BEFORE the restart, so the running process keeps serving the
# old version. Requires the systemd --user unit from
# ascend-transcript-drop.service.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> transcript-drop/

# systemctl --user from cron has no session bus; point it at the user's runtime dir.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if [ ! -f .env ]; then
  echo "transcript-drop/.env is missing — copy .env.example, fill it in, chmod 600" >&2
  exit 1
fi

# The roster is the gate on every submission and is deliberately not in version
# control, so a fresh checkout has none. Catching it here beats a class of
# students all being told they are not enrolled.
if [ ! -f config/roster.csv ]; then
  echo "transcript-drop/config/roster.csv is missing — no student can submit without it" >&2
  exit 1
fi

echo "── transcript-drop: virtualenv"
[ -d .venv ] || python3 -m venv .venv
echo "── transcript-drop: install"
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt

echo "── transcript-drop: tests"
# There is no compile step to catch a bad deploy, so the suite stands in for
# one. It touches only a temporary data directory, never the live databases.
./.venv/bin/python -m pytest tests/ -q

echo "── transcript-drop: restart"
systemctl --user restart ascend-transcript-drop
sleep 2

PORT=$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 | tr -d '[:space:]"'"'"); PORT=${PORT:-8788}
curl -fsS "http://127.0.0.1:${PORT}/healthz"
echo
echo "── transcript-drop: healthy"
