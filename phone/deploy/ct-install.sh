#!/bin/bash
# Inside CT 104 (the runner's container), as root. Pushed and run by provision.sh,
# after the runner itself is deployed (its phone token is copied from here).
# Every step checks before acting, so running it again only updates the service.
#
# Accounts:
#   teezphone   the service. Alone reads /etc/teez-phone (Feed keys, VAPID,
#               Proxmox auditor token, runner phone token, Claude token) and
#               owns the vault clone with its write deploy key. May run
#               commands as phoneagent (sudoers), nothing else.
#   phoneagent  runs the phone chats (agy, optionally Claude Code) with its
#               own HOME and agy login. Reads the vault clone through the
#               teezvault group; no access to /etc/teez-phone or the data dir.
#   The runner's runner/agent accounts are untouched.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# Somewhere every account may stand: commands run as teezphone/phoneagent inherit it.
cd /

VAULT_REMOTE="git@github.com:MarioBelTeez/TeezMind.git"
VAULT_BRANCH="main"
STATE=/var/lib/teez-phone
VAULT="$STATE/vault"
DATA="$STATE/data"
ETC=/etc/teez-phone
OPT=/opt/teez-phone
BUNDLE=/root/teez-phone.tgz
GITHUB_HOST_KEY="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"

as_phone() { sudo -n -H -u teezphone -- "$@"; }
as_agent() { sudo -n -H -u phoneagent -- "$@"; }
# Reads a secret from stdin into $ETC/<name>: 600 teezphone, never echoed.
put_secret() {
	local tmp
	tmp="$(mktemp "$ETC/.$1.XXXXXX")"
	cat > "$tmp"
	chown teezphone:teezphone "$tmp"
	chmod 600 "$tmp"
	mv -f "$tmp" "$ETC/$1"
}

[ -s "$BUNDLE" ] || { echo "No $BUNDLE: run provision.sh on the host, it pushes the build."; exit 1; }

echo "-- packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates openssl sudo acl python3 ffmpeg >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
	curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
	apt-get install -y -qq nodejs >/dev/null
fi
# yt-dlp from its own releases (Debian's lags behind the sites it reads).
if [ ! -x /usr/local/bin/yt-dlp ]; then
	curl -fsSL -o /usr/local/bin/yt-dlp.tmp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
	chmod 755 /usr/local/bin/yt-dlp.tmp
	mv -f /usr/local/bin/yt-dlp.tmp /usr/local/bin/yt-dlp
else
	/usr/local/bin/yt-dlp -U >/dev/null 2>&1 || echo "   yt-dlp update failed; keeping the installed one"
fi
ln -sf /usr/share/zoneinfo/Europe/Rome /etc/localtime

echo "-- accounts"
getent group teezvault >/dev/null || groupadd --system teezvault
id teezphone >/dev/null 2>&1 || useradd --system --user-group --home-dir "$STATE" --shell /usr/sbin/nologin teezphone
id phoneagent >/dev/null 2>&1 || useradd -m -d /home/phoneagent -s /bin/bash phoneagent
usermod -aG teezvault phoneagent
# phoneagent must never be in teezphone (that group reads /etc/teez-phone and /opt/teez-phone).
if id -nG phoneagent | tr ' ' '\n' | grep -qx teezphone; then gpasswd -d phoneagent teezphone >/dev/null; fi
install -d -o phoneagent -g phoneagent -m 750 /home/phoneagent

echo "-- folders"
install -d -o teezphone -g teezvault -m 750 "$STATE"
install -d -o teezphone -g teezphone -m 700 "$DATA" "$STATE/.ssh"
install -d -o root -g teezphone -m 750 "$ETC"

echo "-- sudo: teezphone may act as phoneagent, and only as phoneagent"
# SETENV: the Claude engine passes CLAUDE_CODE_OAUTH_TOKEN and CI with
# --preserve-env (phone/server/src/chat/engines.ts), as the runner does.
cat > /etc/sudoers.d/teez-phone <<'SUDO'
Defaults:teezphone !requiretty, !lecture
teezphone ALL=(phoneagent) NOPASSWD:SETENV: ALL
SUDO
chmod 440 /etc/sudoers.d/teez-phone
visudo -cf /etc/sudoers.d/teez-phone >/dev/null

echo "-- the service build"
rm -rf "$OPT.new"
mkdir -p "$OPT.new"
tar --no-same-owner -C "$OPT.new" -xzf "$BUNDLE"
# Exactly the versions locked at build time (phone/dist/package-lock.json).
(cd "$OPT.new" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
rm -rf "$OPT.old"
if [ -d "$OPT" ]; then mv "$OPT" "$OPT.old"; fi
mv "$OPT.new" "$OPT"
rm -rf "$OPT.old"
chown -R root:teezphone "$OPT"
chmod -R u=rwX,g=rX,o= "$OPT"
chmod 750 "$OPT"
[ -f "$OPT/watch/watch.py" ] || echo "   WARNING: no watch.py in the build; video sources will not work"

echo "-- Antigravity CLI for phoneagent (log in once over SSH:"
echo "   ssh -t pve \"pct exec 104 -- su - phoneagent -c agy\", open the printed link, paste the code back)"
if ! as_agent bash -lc 'command -v agy' >/dev/null 2>&1; then
	as_agent bash -lc 'curl -fsSL https://antigravity.google/cli/install.sh | bash' >/dev/null || echo "   agy install failed: phone chats stay unavailable"
fi
echo "-- Claude Code for phoneagent (used only once /etc/teez-phone/claude-token exists)"
if ! as_agent bash -lc 'command -v claude' >/dev/null 2>&1; then
	as_agent bash -lc 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null || echo "   claude install failed: the Claude switch stays off"
fi

echo "-- secrets"
if [ -s /etc/teez-runner/phone-token ]; then
	put_secret runner-token < /etc/teez-runner/phone-token
else
	echo "   WARNING: /etc/teez-runner/phone-token is missing (deploy the runner first); Runs stay unavailable"
fi
if [ -s /etc/teez-runner/tls.crt ]; then
	install -m 644 -o root -g teezphone /etc/teez-runner/tls.crt "$ETC/runner.crt"
else
	echo "   WARNING: /etc/teez-runner/tls.crt is missing; Runs stay unavailable"
fi
if [ ! -s "$ETC/vapid.json" ]; then
	# Generated into a variable and checked first: never an empty or broken vapid.json.
	VAPID="$(node -e '
		const { publicKey, privateKey } = require("/opt/teez-phone/node_modules/web-push").generateVAPIDKeys();
		process.stdout.write(JSON.stringify({ publicKey, privateKey }));
	')"
	if printf '%s' "$VAPID" | node -e '
		const keys = JSON.parse(require("fs").readFileSync(0, "utf8"));
		process.exit(typeof keys.publicKey === "string" && keys.publicKey && typeof keys.privateKey === "string" && keys.privateKey ? 0 : 1);
	' 2>/dev/null; then
		printf '%s' "$VAPID" | put_secret vapid.json
		echo "   generated vapid.json (phones subscribed before this must subscribe again)"
	else
		echo "   WARNING: VAPID generation failed; push notifications stay off until a re-run"
	fi
	unset VAPID
fi
for name in keys.json vapid.json proxmox.json runner-token claude-token; do
	if [ -e "$ETC/$name" ]; then chown teezphone:teezphone "$ETC/$name"; chmod 600 "$ETC/$name"; fi
done

echo "-- vault deploy key (write access) for teezphone"
as_phone bash -c '[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "teez-phone@agents" -f ~/.ssh/id_ed25519'
# GitHub's published ed25519 host key, pinned — not trusted on first use.
echo "$GITHUB_HOST_KEY" > "$STATE/.ssh/known_hosts"
chown teezphone:teezphone "$STATE/.ssh/known_hosts"
chmod 644 "$STATE/.ssh/known_hosts"

echo "-- Tailscale (userspace networking: this is an unprivileged container)"
if ! command -v tailscale >/dev/null; then
	curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
fi
DROPIN=/etc/systemd/system/tailscaled.service.d/userspace.conf
install -d -m 755 "$(dirname "$DROPIN")"
cat > "$DROPIN.new" <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=${PORT} --tun=userspace-networking $FLAGS
UNIT
systemctl enable tailscaled >/dev/null 2>&1
# Restart only when the drop-in changed or tailscaled is down: a restart drops the phone's connection.
if ! cmp -s "$DROPIN.new" "$DROPIN" || ! systemctl is-active --quiet tailscaled; then
	mv -f "$DROPIN.new" "$DROPIN"
	systemctl daemon-reload
	systemctl restart tailscaled
else
	rm -f "$DROPIN.new"
fi
backend_state() { { tailscale status --json 2>/dev/null || true; } | grep -o '"BackendState": *"[A-Za-z]*"' | grep -o '"[A-Za-z]*"$' | tr -d '"' || true; }
# NoState/Starting are transient: wait (60 s at most) for a settled state before deciding on `up`.
for _ in $(seq 1 60); do
	case "$(backend_state)" in Running | NeedsLogin | NeedsMachineAuth | Stopped) break ;; esac
	sleep 1
done
logged_in() { [ "$(backend_state)" = "Running" ]; }
if ! logged_in; then
	echo "   Owner: open the login URL below (waits up to 10 minutes)."
	echo "   Meanwhile add this deploy key on GitHub (TeezMind > Settings > Deploy keys, Allow write access):"
	echo "   $(cat "$STATE/.ssh/id_ed25519.pub")"
	tailscale up --hostname=teez-phone --timeout=10m || echo "   not logged in yet: re-run provision.sh after logging in"
fi
# The service listens on a unix socket only teezphone and root can open (see
# teez-phone.service); `tailscale serve` takes unix: targets since 1.94.
SOCKET=/run/teez-phone/phone.sock
ts_version="$(tailscale version 2>/dev/null | head -n1 || true)"
ts_minor="$(printf '%s' "$ts_version" | cut -d. -f2)"
if [ "$(printf '%s' "$ts_version" | cut -d. -f1)" != "1" ] || ! [ "$ts_minor" -ge 94 ] 2>/dev/null; then
	echo "   WARNING: tailscale $ts_version cannot serve a unix socket (needs 1.94+): run 'tailscale update' and re-run provision.sh"
elif logged_in; then
	# Replaces the old https:443 -> http://127.0.0.1:7430 handler (same port and path).
	tailscale serve --bg --https=443 "unix:$SOCKET" >/dev/null
	echo "   tailscale serve: https:443 -> unix:$SOCKET"
fi

echo "-- the vault clone"
if [ -d "$VAULT/.git" ]; then
	# Corrects a clone made with another remote.
	as_phone git -C "$VAULT" remote set-url origin "$VAULT_REMOTE"
else
	if as_phone env GIT_TERMINAL_PROMPT=0 git ls-remote "$VAULT_REMOTE" HEAD >/dev/null 2>&1; then
		as_phone git clone -q --branch "$VAULT_BRANCH" "$VAULT_REMOTE" "$VAULT"
	else
		echo "   GitHub refused the deploy key: add it (Allow write access), then re-run provision.sh"
	fi
fi
if [ -d "$VAULT/.git" ]; then
	as_phone git -C "$VAULT" config user.name "TeezOS Phone"
	as_phone git -C "$VAULT" config user.email "teez-phone@localhost"
	as_phone git -C "$VAULT" config pull.rebase true
	if ! as_phone env GIT_TERMINAL_PROMPT=0 git -C "$VAULT" push --dry-run -q origin "HEAD:$VAULT_BRANCH" >/dev/null 2>&1; then
		echo "   WARNING: a dry-run push was refused: the deploy key needs Allow write access"
	fi
	# phoneagent reads the clone through teezvault. Default ACLs make that hold for
	# every file git or the service creates later, despite the service's UMask=0077.
	chgrp teezvault "$VAULT"
	setfacl -R -m g:teezvault:rX "$VAULT"
	find "$VAULT" -type d -exec setfacl -m d:u::rwx,d:g::-,d:o::-,d:g:teezvault:rx,d:m::rx {} +
	as_agent git config --global --replace-all safe.directory "$VAULT"
fi

echo "-- the service"
cp "$OPT/deploy/teez-phone.service" /etc/systemd/system/teez-phone.service
systemctl daemon-reload
rm -f "$BUNDLE" /root/teez-phone-install.sh
# Enabled only once the vault clone exists (its --check-config refuses to start without one).
if [ -d "$VAULT/.git" ]; then
	systemctl enable teez-phone >/dev/null 2>&1
	systemctl restart teez-phone
	sleep 3
	echo "teez-phone: $(systemctl is-active teez-phone || true)"
else
	echo "teez-phone: not started (no vault clone yet)"
fi
echo "deploy key: $(cat "$STATE/.ssh/id_ed25519.pub")"
echo "agy login: ssh -t pve \"pct exec 104 -- su - phoneagent -c agy\""
