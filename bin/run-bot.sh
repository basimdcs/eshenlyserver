#!/usr/bin/env bash
# Run the Midasbuy bot under a cgroup with a hard memory ceiling.
# On 2 GB VPS, MemoryMax=1500M kills the bot before the kernel OOM-kills sshd.
# Falls back to plain node if systemd-run isn't available.

set -euo pipefail
cd "$(dirname "$0")/.."

MEM_MAX="${MEM_MAX:-1500M}"
ENTRY="dist/index.js"

if [ ! -f "$ENTRY" ]; then
  echo "build first: npm run build" >&2
  exit 1
fi

if command -v systemd-run >/dev/null 2>&1 && systemctl --user is-system-running >/dev/null 2>&1; then
  exec systemd-run --user --scope --quiet \
    -p MemoryMax="$MEM_MAX" \
    -p MemorySwapMax=0 \
    -- node "$ENTRY" "$@"
else
  exec node "$ENTRY" "$@"
fi
