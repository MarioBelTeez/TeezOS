#!/bin/bash
# Create the runner's container on the Proxmox host and install everything in it.
# Run as root on the host:  bash provision.sh [vmid] [ip/cidr] [gateway] [storage]
# Safe to re-run: an existing container is reused and each install step checks first.
set -euo pipefail

VMID="${1:-104}"
IP="${2:-192.168.1.250/24}"
GW="${3:-192.168.1.1}"
STORAGE="${4:-tank-vm}"
HERE="$(cd "$(dirname "$0")" && pwd)"

TEMPLATE="$(pveam list local | awk '/debian-13-standard/ {print $1}' | tail -1)"
[ -n "$TEMPLATE" ] || { echo "No Debian 13 template in local storage (pveam download local debian-13-standard...)."; exit 1; }

if ! pct status "$VMID" >/dev/null 2>&1; then
	echo "== creating CT $VMID from $TEMPLATE on $STORAGE, $IP"
	pct create "$VMID" "$TEMPLATE" \
		--hostname agents \
		--description "teez-runner: scheduled Claude Code jobs for TeezAI" \
		--cores 2 --memory 4096 --swap 1024 \
		--rootfs "$STORAGE:16" \
		--net0 "name=eth0,bridge=vmbr0,ip=$IP,gw=$GW" \
		--nameserver "1.1.1.1" \
		--unprivileged 1 --features nesting=1,keyctl=1 \
		--onboot 1 --startup order=4 \
		--ostype debian
fi

if [ "$(pct status "$VMID" | awk '{print $2}')" != "running" ]; then
	pct start "$VMID"
	for _ in $(seq 1 30); do pct exec "$VMID" -- true 2>/dev/null && break; sleep 1; done
fi

echo "== pushing the runner"
tar --owner=0 --group=0 -C "$HERE/.." -czf /tmp/teez-runner.tgz src deploy
# Not /tmp: Debian 13 mounts a tmpfs there, hiding files pushed from the host.
pct push "$VMID" /tmp/teez-runner.tgz /root/teez-runner.tgz
pct push "$VMID" "$HERE/ct-install.sh" /root/ct-install.sh
rm -f /tmp/teez-runner.tgz

echo "== installing inside CT $VMID"
pct exec "$VMID" -- bash /root/ct-install.sh "${IP%/*}"
