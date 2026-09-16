#!/usr/bin/env bash
#
# What launchd runs to keep Remote Control up.
#
# Remote Control is an interactive Claude Code session that a phone connects
# to. Without one listening, every attempt from the phone creates an empty
# session in the account's list and leaves it waiting — which is where the
# pile of `<hostname>-<two words>` entries came from, none of them started by
# IRIS and none of them removable from this machine.
#
# Three things it has to get right, all of them learned elsewhere in this
# project rather than guessed:
#
#   - A pty. `--remote-control` is interactive and launchd gives no terminal,
#     so it runs under `script`, the same way the allowance probe does.
#   - A trusted working directory. Claude Code stops on "Is this a project you
#     trust?" in a folder it has not seen, and waits for a keypress that never
#     comes.
#   - USER and LOGNAME. The credential is in the Keychain and the lookup wants
#     a user identity; HOME and PATH alone get "Not logged in" in three
#     seconds.
#
# Logs rotate here rather than growing until the disk is full.
set -euo pipefail

CLAUDE="@CLAUDE@"
WORKDIR="@WORKDIR@"
PREFIX="${IRIS_REMOTE_PREFIX:-mac}"
LOG_DIR="${IRIS_LOG_DIR:-$HOME/Library/Logs/IRIS}"
MAX_BYTES=${IRIS_LOG_MAX_BYTES:-5242880}   # 5MB
KEEP=${IRIS_LOG_KEEP:-3}

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/remote-control.log"
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt "$MAX_BYTES" ]; then
  for i in $(seq $((KEEP - 1)) -1 1); do
    [ -f "$LOG.$i" ] && mv "$LOG.$i" "$LOG.$((i + 1))"
  done
  mv "$LOG" "$LOG.1"
fi

cd "$WORKDIR"
exec /usr/bin/script -q /dev/null "$CLAUDE" \
  --remote-control \
  --remote-control-session-name-prefix "$PREFIX" >> "$LOG" 2>&1
