#!/bin/bash
# Install the TeezOS phone companion into the runner's container (CT 104).
# Run as root on the Proxmox host, from a copy of the repo that holds
# phone/deploy, phone/dist (npm run build:phone) and runner/:
#   bash phone/deploy/provision.sh [vmid]
# Env: SKIP_RUNNER=1 skips redeploying the runner; PVE_HOST_IP overrides the
# address the phone service uses for the Proxmox API.
# Safe to re-run: every step checks first. The first run prints the vault
# deploy key and the Tailscale login URL; re-run after the owner has done both.
set -euo pipefail

VMID="${1:-104}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PHONE="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PHONE/.." && pwd)"
PVE_USER="teezphone@pve"
PVE_TOKEN="phone"
CT_SECRET=/etc/teez-phone/proxmox.json

for file in server.mjs package.json package-lock.json app/index.html; do
	[ -s "$PHONE/dist/$file" ] || { echo "Missing phone/dist/$file: run npm run build:phone on the PC and copy phone/dist."; exit 1; }
done

# The runner first: Task 8 changed it (phone token, 0.3.0), and the phone
# install copies that token.
if [ "${SKIP_RUNNER:-0}" != "1" ]; then
	[ -f "$REPO/runner/deploy/provision.sh" ] || { echo "No runner/ next to phone/ (copy it, or SKIP_RUNNER=1 if the runner is current)."; exit 1; }
	echo "== redeploying the runner"
	bash "$REPO/runner/deploy/provision.sh" "$VMID"
fi

if [ "$(pct status "$VMID" | awk '{print $2}')" != "running" ]; then
	pct start "$VMID"
	for _ in $(seq 1 30); do pct exec "$VMID" -- true 2>/dev/null && break; sleep 1; done
fi

echo "== pushing the phone service"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar --owner=0 --group=0 --exclude=node_modules -czf "$WORK/teez-phone.tgz" -C "$PHONE/dist" . -C "$PHONE" deploy
# Not /tmp: Debian 13 mounts a tmpfs there, hiding files pushed from the host.
pct push "$VMID" "$WORK/teez-phone.tgz" /root/teez-phone.tgz
pct push "$VMID" "$HERE/ct-install.sh" /root/teez-phone-install.sh

echo "== installing inside CT $VMID"
pct exec "$VMID" -- bash /root/teez-phone-install.sh

echo "== Proxmox: read-only API token for the phone ($PVE_USER, PVEAuditor on /)"
pveum user add "$PVE_USER" --comment "TeezOS phone companion (read-only)" 2>/dev/null || true
pveum acl modify / -user "$PVE_USER" -role PVEAuditor
has_token() { pveum user token list "$PVE_USER" --output-format json 2>/dev/null | grep -q "\"tokenid\" *: *\"$PVE_TOKEN\""; }
if has_token && pct exec "$VMID" -- test -s "$CT_SECRET"; then
	echo "   token and $CT_SECRET exist; kept"
else
	# The secret is shown only at creation: without the file, make a new token.
	if has_token; then pveum user token remove "$PVE_USER" "$PVE_TOKEN"; fi
	HOST_IP="${PVE_HOST_IP:-$(ip -4 -o addr show vmbr0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)}"
	[ -n "$HOST_IP" ] || HOST_IP="$(hostname -I | awk '{print $1}')"
	# Port 8006 serves pveproxy-ssl.pem when a custom certificate is installed, else pve-ssl.pem.
	CERT=/etc/pve/local/pve-ssl.pem
	if [ -f /etc/pve/local/pveproxy-ssl.pem ]; then CERT=/etc/pve/local/pveproxy-ssl.pem; fi
	FINGERPRINT="$(openssl x509 -noout -fingerprint -sha256 -in "$CERT" | cut -d= -f2)"
	umask 077
	pveum user token add "$PVE_USER" "$PVE_TOKEN" --privsep 1 --comment "TeezOS phone" --output-format json |
		BASE_URL="https://$HOST_IP:8006" NODE_NAME="$(hostname)" FINGERPRINT="$FINGERPRINT" CA_FILE=/etc/pve/pve-root-ca.pem \
		perl -MJSON::PP -e '
			local $/;
			my $out = <STDIN>;
			$out =~ s/^[^{]*//s;
			# Generic errors only: a parse message could quote part of the secret.
			my $token = eval { decode_json($out) };
			die "pveum did not return a token (unreadable output)\n" unless ref($token) eq "HASH" && $token->{value} && $token->{"full-tokenid"};
			open(my $fh, "<", $ENV{CA_FILE}) or die "cannot read $ENV{CA_FILE}\n";
			my $ca = <$fh>;
			die "$ENV{CA_FILE} is not a certificate\n" unless $ca =~ /BEGIN CERTIFICATE/;
			print JSON::PP->new->canonical->encode({
				baseUrl => $ENV{BASE_URL}, node => $ENV{NODE_NAME}, tokenId => $token->{"full-tokenid"},
				fingerprint => $ENV{FINGERPRINT}, ca => $ca, secret => $token->{value},
			});
		' > "$WORK/proxmox.json"
	umask 022
	# privsep: the token has its own ACL, and only the rights both it and the user hold.
	pveum acl modify / -token "$PVE_USER!$PVE_TOKEN" -role PVEAuditor
	pct push "$VMID" "$WORK/proxmox.json" "$CT_SECRET.new" --perms 0600
	rm -f "$WORK/proxmox.json"
	pct exec "$VMID" -- sh -c "chown teezphone:teezphone '$CT_SECRET.new' && mv -f '$CT_SECRET.new' '$CT_SECRET'"
	echo "   wrote $CT_SECRET (https://$HOST_IP:8006, node $(hostname))"
	# Server alerts start only when proxmox.json exists at launch.
	pct exec "$VMID" -- systemctl try-restart teez-phone
fi

echo "== status"
# shellcheck disable=SC2016 # expanded inside the container
pct exec "$VMID" -- sh -c 'echo "teez-phone: $(systemctl is-active teez-phone || true)"; tailscale serve status 2>/dev/null || true'
SOCK=/run/teez-phone/phone.sock
echo "local check as root, no identity (expect 403): $(pct exec "$VMID" -- curl -s -o /dev/null -w '%{http_code}' --unix-socket "$SOCK" http://localhost/api/chats || true)"
# Every other account, the runner's agent included, must not reach the socket at all (curl prints 000).
echo "local check as agent (expect 000): $(pct exec "$VMID" -- sudo -n -u agent curl -s -o /dev/null -w '%{http_code}' --unix-socket "$SOCK" -H 'Tailscale-User-Login: owner@github' http://localhost/api/chats 2>/dev/null || true)"
echo "local check as phoneagent (expect 000): $(pct exec "$VMID" -- sudo -n -u phoneagent curl -s -o /dev/null -w '%{http_code}' --unix-socket "$SOCK" -H 'Tailscale-User-Login: owner@github' http://localhost/api/chats 2>/dev/null || true)"
echo "no TCP listener on 7430 (expect nothing): $(pct exec "$VMID" -- sh -c "ss -Hltn 'sport = :7430'" 2>/dev/null || true)"
