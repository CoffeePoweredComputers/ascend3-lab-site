#!/bin/bash
# Build, migrate and restart the survey service.
#
# Called by ../../autodeploy.sh whenever a pull touched files under survey/;
# safe to run by hand from anywhere. `set -e` means a failed install, build or
# migration stops BEFORE the restart, so the running process keeps serving the
# old version. Requires the systemd --user unit from ascend-survey.service.
set -euo pipefail
cd "$(dirname "$0")/.."   # → survey/

# systemctl --user from cron has no session bus; point it at the user's runtime dir.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if [ ! -f .env ]; then
  echo "survey/.env is missing — copy .env.example, fill it in, chmod 600" >&2
  exit 1
fi

echo "── survey: install"
npm ci --no-audit --no-fund
echo "── survey: build"
npm run build
echo "── survey: migrate"
npm run migrate
echo "── survey: restart"
systemctl --user restart ascend-survey
sleep 2

PORT=$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 | tr -d '[:space:]"'"'"); PORT=${PORT:-8787}
BASE=$(grep -E '^BASE_URL=' .env | tail -1 | cut -d= -f2- | tr -d '[:space:]"'"'" | sed -E 's#^https?://[^/]+##; s#/+$##')
curl -fsS "http://127.0.0.1:${PORT}${BASE}/healthz"
echo
echo "── survey: healthy"
