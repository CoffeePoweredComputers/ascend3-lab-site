#!/usr/bin/env bash
#
# Get a browser-trusted certificate onto transcript-drop.cs.vt.edu.
#
#   sudo bash scripts/setup_tls.sh
#
# Safe to run before anything is ready: it does the parts it can, reports what
# is blocking, and stops. Safe to run again afterwards -- run it whenever
# something changes and it will pick up from wherever it got to.
#
# What it will not do: send the email asking VT for the CNAME delegation, or
# invent your Cloudflare API token. Those are yours.

set -euo pipefail

DOMAIN="transcript-drop.cs.vt.edu"
CHALLENGE="_acme-challenge.${DOMAIN}"
TLS_DIR="/etc/caddy/tls.d"
TLS_CONF="${TLS_DIR}/tls.conf"
CF_CREDS="/etc/letsencrypt/cloudflare.ini"
LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"
HOOK="/etc/letsencrypt/renewal-hooks/deploy/restart-caddy.sh"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mtodo\033[0m  %s\n' "$*"; }
info() { printf '        %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

# ---------------------------------------------------------------------------
bold "1. nginx"
# It arrives as a dependency of python3-certbot-nginx and immediately tries to
# take port 80, which Caddy already holds. Today it just fails; after a reboot
# it might win the race, and then the site is down.
if dpkg -l nginx-common 2>/dev/null | grep -q '^ii'; then
	systemctl disable --now nginx >/dev/null 2>&1 || true
	apt-get remove --purge -y nginx nginx-common python3-certbot-nginx >/dev/null
	ok "removed (it would have raced Caddy for port 80 after a reboot)"
else
	ok "not installed"
fi

# ---------------------------------------------------------------------------
bold "2. certbot and the Cloudflare plugin"
if ! dpkg -l python3-certbot-dns-cloudflare 2>/dev/null | grep -q '^ii'; then
	apt-get update -qq
	apt-get install -y certbot python3-certbot-dns-cloudflare >/dev/null
	ok "installed"
else
	ok "already installed"
fi

# ---------------------------------------------------------------------------
bold "3. Caddy is serving, and owns both ports"
if ! systemctl is-active --quiet caddy; then
	warn "caddy is not running -- fix that before going further"
	exit 1
fi
holder=$(ss -tlnp 2>/dev/null | awk '/:80 /{print $NF}' | head -1)
case "$holder" in
	*caddy*) ok "port 80 held by caddy" ;;
	"")      warn "nothing is listening on port 80" ;;
	*)       warn "port 80 held by something else: $holder" ; exit 1 ;;
esac

# Make sure the imported directory exists and has a certificate directive in
# it, whatever that directive currently says. The Caddyfile imports a glob; if
# the glob matches nothing the site has no tls directive at all, and Caddy
# falls back to trying ACME against an address the internet cannot reach.
mkdir -p "$TLS_DIR"
if [ ! -f "$TLS_CONF" ]; then
	echo "tls internal" > "$TLS_CONF"
	ok "wrote $TLS_CONF (tls internal, for now)"
fi

# ---------------------------------------------------------------------------
bold "4. Prerequisites for a real certificate"
blocked=0

if [ -f "$CF_CREDS" ]; then
	ok "Cloudflare credentials present"
	chmod 600 "$CF_CREDS"
else
	blocked=1
	warn "no Cloudflare API token at $CF_CREDS"
	info "Create one at Cloudflare with Zone:DNS:Edit on your own domain, then:"
	info ""
	info "  sudo install -m 600 /dev/null $CF_CREDS"
	info "  sudo nano $CF_CREDS"
	info ""
	info "  # one line, no quotes:"
	info "  dns_cloudflare_api_token = <token>"
	info ""
	info "Mode 600 matters -- certbot refuses a world-readable credentials file,"
	info "and the token can edit your DNS."
fi

delegation=$(dig +short CNAME "$CHALLENGE" 2>/dev/null || true)
if [ -n "$delegation" ]; then
	ok "delegation in place: $CHALLENGE -> $delegation"
else
	blocked=1
	warn "$CHALLENGE is not delegated"
	info "This is the one thing only VT can do. Ask techstaff for:"
	info ""
	info "  $CHALLENGE.  CNAME  <name>.<your-cloudflare-domain>."
	info ""
	info "Without it, Let's Encrypt has no way to verify this name: the address"
	info "is RFC 1918, so the HTTP-01 challenge cannot reach the host, and the"
	info "TXT record for DNS-01 has to live in a zone you can write to."
fi

if [ "$blocked" -eq 1 ]; then
	echo
	bold "Stopping here."
	info "Caddy keeps serving its own certificate, so the site stays up and the"
	info "study team can keep testing. Students will see a warning until the"
	info "above is resolved. Re-run this script when it is."
	exit 0
fi

# ---------------------------------------------------------------------------
bold "5. Certificate"
if [ -f "${LIVE_DIR}/fullchain.pem" ]; then
	ok "already issued (certbot renew handles it from here)"
else
	# --challenge-alias is not a certbot flag; certbot follows the CNAME on its
	# own when the record exists. If it instead complains that it cannot find
	# the zone, the plugin is not following the delegation -- acme.sh with
	# --challenge-alias, or lego, both handle it explicitly.
	certbot certonly \
		--non-interactive --agree-tos \
		--dns-cloudflare \
		--dns-cloudflare-credentials "$CF_CREDS" \
		--dns-cloudflare-propagation-seconds 60 \
		-d "$DOMAIN"
	ok "issued"
fi

# ---------------------------------------------------------------------------
bold "6. Renewal hook"
# Caddy caches certificates read from disk, and the admin API is off so there is
# no reload. Without this, certbot renews every 60 days and Caddy keeps serving
# the old certificate until it expires -- discovered by a class, all at once.
mkdir -p "$(dirname "$HOOK")"
cat > "$HOOK" <<'HOOK_EOF'
#!/bin/sh
# Caddy caches certificates from disk and has no reload (admin API is off), so
# a renewal only takes effect after a restart.
systemctl restart caddy
HOOK_EOF
chmod +x "$HOOK"
ok "$HOOK"

# ---------------------------------------------------------------------------
bold "7. Point Caddy at it"
backup="${TLS_CONF}.$(date +%Y%m%dT%H%M%S).bak"
cp "$TLS_CONF" "$backup"

cat > "$TLS_CONF" <<EOF
# Written by scripts/setup_tls.sh. Imported by /etc/caddy/Caddyfile.
tls ${LIVE_DIR}/fullchain.pem ${LIVE_DIR}/privkey.pem

# Safe only now that a trusted certificate is in place: this tells every
# browser to refuse plain HTTP to this name for a year, with no way to click
# past it.
header Strict-Transport-Security "max-age=31536000"
EOF

if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
	mv "$backup" "$TLS_CONF"
	warn "the new config did not validate -- reverted, Caddy untouched"
	caddy validate --config /etc/caddy/Caddyfile || true
	exit 1
fi

systemctl restart caddy
sleep 2

# Verified without -k on purpose: the whole point is that the certificate now
# validates against the system trust store, exactly as a student's browser will
# check it.
if curl -fsS "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
	ok "https://${DOMAIN} serves a trusted certificate"
	rm -f "$backup"
	echo
	bold "Done. The site is ready for students."
	info "Remaining, and not TLS: the IRB-approved consent wording in"
	info "config/consent_form.md, and the real class roster."
else
	mv "$backup" "$TLS_CONF"
	systemctl restart caddy
	warn "the site did not answer with a trusted certificate -- reverted"
	info "Caddy is back on its previous configuration and the site is up."
	info "curl -v https://${DOMAIN}/healthz  will say why."
	exit 1
fi
