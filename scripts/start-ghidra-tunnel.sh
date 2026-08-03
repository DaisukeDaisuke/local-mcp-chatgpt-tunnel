#!/bin/sh
set -eu

: "${GHIDRA_SSH_HOST:?GHIDRA_SSH_HOST is required}"
: "${GHIDRA_SSH_PORT:?GHIDRA_SSH_PORT is required}"
: "${GHIDRA_SSH_USER:?GHIDRA_SSH_USER is required}"
: "${GHIDRA_SSH_KEY_FILE:?GHIDRA_SSH_KEY_FILE is required}"
: "${GHIDRA_KNOWN_HOSTS_FILE:?GHIDRA_KNOWN_HOSTS_FILE is required}"

test -s "$GHIDRA_SSH_KEY_FILE" || { echo "Ghidra SSH private key is missing" >&2; exit 70; }
test -s "$GHIDRA_KNOWN_HOSTS_FILE" || { echo "Pinned Ghidra SSH known_hosts file is missing" >&2; exit 70; }

install -m 0600 "$GHIDRA_SSH_KEY_FILE" /runtime/ssh/id_ed25519
install -m 0600 "$GHIDRA_KNOWN_HOSTS_FILE" /runtime/ssh/known_hosts

ssh -N -T \
  -p "$GHIDRA_SSH_PORT" \
  -i /runtime/ssh/id_ed25519 \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/runtime/ssh/known_hosts \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8089:127.0.0.1:8089 \
  -L 127.0.0.1:8099:127.0.0.1:8099 \
  "${GHIDRA_SSH_USER}@${GHIDRA_SSH_HOST}" &

pid=$!
sleep 1
kill -0 "$pid" 2>/dev/null || { echo "Ghidra SSH tunnel failed to start" >&2; wait "$pid"; exit 70; }
