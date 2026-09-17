#!/bin/bash
# One-time provisioning of the transcript submission service on ascend3.cs.vt.edu.
#
# Run as the deploying user, from anywhere:
#   ~/ascend3-lab-site/transcript-drop/deploy/provision.sh [--firebase-from-site]
#
# Idempotent: every step checks before it acts, so the intended use is to run
# it, supply what it says it could not, and run it again. It stops before the
# deploy while either of the two things only a person can provide is missing:
# the four GENAI_FIREBASE_* values in .env, and config/roster.csv.
#
# --firebase-from-site copies the PUBLIC_FIREBASE_* values from the lab site's
# own .env one level up, which reuses the site's Firebase project. Every student
# who signs in then becomes a user in the lab's project, and because the page
# shares the site's origin, shares its session too. A project of the study's
# own keeps them apart; without the flag, fill in the four values by hand.
#
# Not done here, because it needs root: copying nginx-configs/ascend3.conf into
# /etc/nginx. deploy.sh says so when that is still outstanding.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> transcript-drop/

FROM_SITE=0
for arg in "$@"; do
  case "$arg" in
    --firebase-from-site) FROM_SITE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

DATA_DIR="$HOME/transcript-drop-data"
BACKUP_DIR="$HOME/transcript-drop-backups"
UNIT_DIR="$HOME/.config/systemd/user"
PUBLIC_URL="https://ascend3.cs.vt.edu/transcript-drop"

# KEY from an env file: last assignment wins, quotes and whitespace stripped.
env_get() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]"'"'"; }
# Replace the KEY= line in place. The values written here are Firebase
# identifiers, a base64 token and a home path: none contains the '|' delimiter.
env_set() { sed -i "s|^$1=.*|$1=$2|" "$3"; }
# A value still at its .env.example placeholder counts as unset.
is_set() { [ -n "$1" ] && [[ "$1" != *your-project* ]]; }

echo "── provision: directories"
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chmod 700 "$DATA_DIR" "$BACKUP_DIR"

echo "── provision: linger"
# Without linger the --user manager stops with the last login session and takes
# the service down with it. The only step that needs sudo; already done on this
# box if the survey service was set up the same way.
if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  sudo loginctl enable-linger "$USER"
fi

echo "── provision: .env"
[ -f .env ] || cp .env.example .env
chmod 600 .env
if ! is_set "$(env_get GENAI_ADMIN_TOKEN .env)"; then
  env_set GENAI_ADMIN_TOKEN "$(openssl rand -base64 32)" .env
fi
dest=$(env_get BACKUP_DEST .env)
if [ -z "$dest" ] || [[ "$dest" == *CHANGE_ME* ]]; then
  env_set BACKUP_DEST "$BACKUP_DIR" .env
fi
if [ "$FROM_SITE" = 1 ]; then
  SITE_ENV=../.env
  [ -f "$SITE_ENV" ] || { echo "no $SITE_ENV to copy Firebase settings from" >&2; exit 1; }
  for key in API_KEY AUTH_DOMAIN PROJECT_ID APP_ID; do
    if ! is_set "$(env_get "GENAI_FIREBASE_$key" .env)"; then
      value=$(env_get "PUBLIC_FIREBASE_$key" "$SITE_ENV")
      [ -n "$value" ] || { echo "PUBLIC_FIREBASE_$key is not in $SITE_ENV" >&2; exit 1; }
      env_set "GENAI_FIREBASE_$key" "$value" .env
    fi
  done
fi

MISSING=()
for key in API_KEY AUTH_DOMAIN PROJECT_ID APP_ID; do
  is_set "$(env_get "GENAI_FIREBASE_$key" .env)" || MISSING+=("GENAI_FIREBASE_$key in transcript-drop/.env")
done
[ -f config/roster.csv ] || MISSING+=("transcript-drop/config/roster.csv  (header: email,project_id,team_instance_id,joined_at,left_at)")
if [ ${#MISSING[@]} -gt 0 ]; then
  echo
  echo "Stopping before the deploy. Still needed, then run this again:"
  printf '   - %s\n' "${MISSING[@]}"
  exit 1
fi

echo "── provision: systemd --user units"
mkdir -p "$UNIT_DIR"
cp deploy/ascend-transcript-drop.service \
   deploy/ascend-transcript-drop-backup.service \
   deploy/ascend-transcript-drop-backup.timer "$UNIT_DIR/"
systemctl --user daemon-reload
# enable, not enable --now: the virtualenv the unit runs from does not exist
# until deploy.sh creates it, and deploy.sh starts the service itself.
systemctl --user enable ascend-transcript-drop
systemctl --user enable --now ascend-transcript-drop-backup.timer

./deploy/deploy.sh

echo "── provision: public check"
# deploy.sh checks loopback. The question that matters is whether the URL the
# students are given reaches the service through nginx.
if curl -fsS --max-time 10 "$PUBLIC_URL/healthz" | grep -q '"ok"'; then
  echo "   $PUBLIC_URL/ is live"
else
  echo "   $PUBLIC_URL/healthz did not answer ok — see the nginx note above" >&2
  exit 1
fi
echo
echo "Remaining, in the Firebase console for project $(env_get GENAI_FIREBASE_PROJECT_ID .env):"
echo "   Authentication → Settings → Authorized domains must include ascend3.cs.vt.edu"
