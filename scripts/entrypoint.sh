#!/bin/sh
set -eu

if [ "${GHIDRA_TUNNEL_ENABLED:-false}" = "true" ]; then
  /app/scripts/start-ghidra-tunnel.sh
fi

exec "$@"
