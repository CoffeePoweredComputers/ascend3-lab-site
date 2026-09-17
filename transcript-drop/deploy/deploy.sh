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
  echo "transcript-drop/.env is missing — run deploy/provision.sh, or copy .env.example, fill it in, chmod 600" >&2
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
# Debian and Ubuntu ship python3 without the venv module; `python3 -m venv`
# then fails deep inside ensurepip with a message that does not name the
# package to install. This project has already lost an afternoon to it once.
if [ ! -d .venv ]; then
  if ! python3 -m venv .venv 2>/dev/null; then
    echo "python3 -m venv failed. On Debian/Ubuntu: sudo apt install python3-venv" >&2
    exit 1
  fi
fi

# 3.9 is the floor: the request models are evaluated at runtime by pydantic and
# use typing.Optional rather than PEP 604 unions for exactly that reason.
./.venv/bin/python - <<'PYVER' || exit 1
import sys
if sys.version_info < (3, 9):
    sys.exit(f"python {sys.version.split()[0]} is too old; this needs 3.9 or newer")
PYVER
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

# The service can be perfectly healthy on loopback while nobody can reach it:
# nginx-configs/ascend3.conf is version-controlled but nothing copies it to
# /etc/nginx, so a first deploy leaves /transcript-drop/ still answering with the
# Astro site's catch-all — a 200, with the lab homepage in it, which looks like
# the deploy worked.
if ! grep -qs 'transcript-drop' /etc/nginx/sites-enabled/*.conf; then
  echo
  echo "   NOTE: nginx is not routing /transcript-drop/ yet. As root, once:"
  echo "     sudo cp ~/ascend3-lab-site/nginx-configs/ascend3.conf /etc/nginx/sites-available/"
  echo "     sudo nginx -t && sudo systemctl reload nginx"
fi
