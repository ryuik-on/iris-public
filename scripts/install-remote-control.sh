#!/usr/bin/env bash
#
# Keeps Remote Control listening, so the phone has something to connect to.
#
# Without a session listening on this machine, every attempt from the phone
# creates an empty entry in the account's session list and leaves it waiting —
# 「Remote Control の接続が完了しませんでした」 — and those entries cannot be
# cleared from here, because nothing about them exists on this machine.
#
# What this grants is worth saying plainly: with it loaded, the phone can drive
# Claude Code on this Mac at any time, whether or not anybody is at the
# keyboard. That is the point of asking for it, and it is also the whole of the
# risk. `npm run remote:uninstall` takes it away again.
#
# The wrapper is copied outside the repository on purpose: launchd cannot
# execute a script inside ~/Downloads at all — "Operation not permitted" —
# because the folder is ACL-guarded. The same lesson is written at the top of
# install-launchd.sh, learned the same way.
set -euo pipefail

IRIS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.user.iris.remote"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/IRIS"
SUPPORT_DIR="$HOME/Library/Application Support/IRIS"
RUNNER="$SUPPORT_DIR/remote-control.sh"
PREFIX="${IRIS_REMOTE_PREFIX:-mac}"

CLAUDE="$(command -v claude || true)"
if [ -z "$CLAUDE" ]; then
  for candidate in "$HOME/.npm-global/bin/claude" "$HOME/.local/bin/claude" /usr/local/bin/claude; do
    [ -x "$candidate" ] && CLAUDE="$candidate" && break
  done
fi
if [ -z "$CLAUDE" ]; then
  echo "claude が見つかりません。" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$SUPPORT_DIR"

sed -e "s|@CLAUDE@|$CLAUDE|g" -e "s|@WORKDIR@|$IRIS_DIR|g" \
  "$IRIS_DIR/scripts/remote-control-service.sh" > "$RUNNER"
chmod +x "$RUNNER"

# Kept, not overwritten. Going back to something that worked is worth more
# than a tidy directory.
if [ -f "$PLIST_PATH" ]; then
  cp "$PLIST_PATH" "$PLIST_PATH.bak.$(date +%Y%m%d%H%M%S)"
  echo "▸ 既存の plist を退避しました"
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <key>ProgramArguments</key>
  <array><string>$RUNNER</string></array>

  <!-- Not the repository. A working directory inside a guarded folder makes
       getcwd() fail before any of our code runs; the wrapper cd's to the
       trusted repository itself once it is running. -->
  <key>WorkingDirectory</key><string>/tmp</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin</string>
    <key>IRIS_LOG_DIR</key><string>$LOG_DIR</string>
    <key>IRIS_REMOTE_PREFIX</key><string>$PREFIX</string>
    <!-- The credential lives in the Keychain and the lookup wants a user
         identity. HOME and PATH alone produce "Not logged in" in three
         seconds, with nothing to say why. -->
    <key>USER</key><string>$USER</string>
    <key>LOGNAME</key><string>$USER</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <!-- Restarted when it dies, which for an interactive session means whenever
       the connection drops. Ten seconds so a repeated failure does not spin. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>

  <key>StandardOutPath</key><string>$LOG_DIR/remote-control.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/remote-control.err.log</string>
</dict>
</plist>
PLIST

echo "▸ plist: $PLIST_PATH"
echo "▸ 起動係: $RUNNER"
echo
echo "手で開いている Remote Control があれば先に閉じてから、次を実行してください:"
echo "  launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null; launchctl bootstrap gui/\$(id -u) \"$PLIST_PATH\""
