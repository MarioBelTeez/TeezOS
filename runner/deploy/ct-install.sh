#!/bin/bash
# Inside the runner's container, as root. Pushed and run by provision.sh.
# Every step checks before acting, so running it again only updates the runner.
#
# Two accounts:
#   runner  the service. Alone can read the API token, the TLS key and the
#           Claude token. May run commands as `agent` (sudoers), nothing else.
#   agent   runs the jobs (Claude Code, git). Owns the work folders and its
#           own GitHub deploy key; cannot read anything of runner's.
set -euo pipefail
IP="${1:-192.168.1.250}"
export DEBIAN_FRONTEND=noninteractive

echo "-- packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates openssl sudo less >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
	curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
	apt-get install -y -qq nodejs >/dev/null
fi
ln -sf /usr/share/zoneinfo/Europe/Rome /etc/localtime

echo "-- accounts"
id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
id runner >/dev/null 2>&1 || useradd --system --home-dir /var/lib/teez-runner --shell /usr/sbin/nologin runner
usermod -aG agent runner
install -d -o agent -g agent -m 750 /home/agent /home/agent/work
install -d -o runner -g runner -m 700 /var/lib/teez-runner
chown -R runner:runner /var/lib/teez-runner
install -d -m 750 -o root -g runner /etc/teez-runner

echo "-- sudo: runner may act as agent, and only as agent"
cat > /etc/sudoers.d/teez-runner <<'SUDO'
Defaults:runner !requiretty, !lecture
runner ALL=(agent) NOPASSWD:SETENV: ALL
SUDO
chmod 440 /etc/sudoers.d/teez-runner
visudo -cf /etc/sudoers.d/teez-runner >/dev/null

echo "-- API token and TLS certificate"
if [ ! -s /etc/teez-runner/token ]; then
	openssl rand -hex 32 > /etc/teez-runner/token
fi
# A second, narrower token for the phone companion: list, run now, cancel.
# Task 11's install script in phone/deploy copies it to the phone service.
if [ ! -s /etc/teez-runner/phone-token ]; then
	openssl rand -hex 32 > /etc/teez-runner/phone-token
fi
if [ ! -s /etc/teez-runner/tls.crt ]; then
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
		-subj "/CN=teez-runner" -addext "subjectAltName=IP:$IP,DNS:agents" \
		-keyout /etc/teez-runner/tls.key -out /etc/teez-runner/tls.crt 2>/dev/null
fi
chown root:runner /etc/teez-runner/token /etc/teez-runner/phone-token /etc/teez-runner/tls.key /etc/teez-runner/tls.crt
chmod 640 /etc/teez-runner/token /etc/teez-runner/phone-token /etc/teez-runner/tls.key
chmod 644 /etc/teez-runner/tls.crt

echo "-- Claude Code for the agent account"
if ! sudo -u agent bash -lc 'command -v claude' >/dev/null 2>&1; then
	sudo -u agent bash -lc 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null
fi
echo "-- Antigravity CLI for the agent account (optional; log in once over SSH:"
echo "   ssh -t pve \"pct exec <vmid> -- su - agent -c agy\", open the printed link, paste the code back)"
if ! sudo -u agent bash -lc 'command -v agy' >/dev/null 2>&1; then
	sudo -u agent bash -lc 'curl -fsSL https://antigravity.google/cli/install.sh | bash' >/dev/null || echo "   agy install failed: Antigravity jobs stay unavailable"
fi
sudo -u agent bash -lc 'git config --global user.name "teez-runner"; git config --global user.email "teez-runner@agents.lan"; git config --global pull.ff only'

echo "-- SSH key for GitHub (add the public key as a deploy key)"
sudo -u agent bash -c '[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "teez-runner@agents" -f ~/.ssh/id_ed25519'
# GitHub's published ed25519 host key, pinned — not trusted on first use.
sudo -u agent bash -c 'install -d -m 700 ~/.ssh; echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > ~/.ssh/known_hosts; chmod 644 ~/.ssh/known_hosts'

echo "-- the runner"
rm -rf /opt/teez-runner && mkdir -p /opt/teez-runner
tar --no-same-owner -C /opt/teez-runner -xzf /root/teez-runner.tgz
rm -f /root/teez-runner.tgz /root/ct-install.sh
cp /opt/teez-runner/deploy/teez-runner.service /etc/systemd/system/teez-runner.service
systemctl daemon-reload
systemctl enable teez-runner >/dev/null 2>&1
systemctl restart teez-runner
sleep 3
systemctl is-active teez-runner
echo "deploy key: $(cat /home/agent/.ssh/id_ed25519.pub)"
