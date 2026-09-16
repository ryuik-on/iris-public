#!/usr/bin/env bash
#
# Registers IRIS as a login-time service.
#
# Three things this does differently from the version it replaces, each of them
# a problem observed on the running service rather than anticipated:
#
#   - `npm start` behind a wrapper, not `npm run dev`. A dev server restarts on
#     every file change and serves through a bundler; neither belongs in
#     something meant to stay up.
#   - IRIS_SPEECH_BINARY points at the installed .app. The repository sits in a
#     TCC-guarded folder, and a helper launched from inside one hangs in dyld
#     before main — no error, no crash, no exit.
#   - Logs go somewhere that rotates. /tmp/iris.stdout.log grew unbounded.
#
# And one the first attempt taught: the wrapper itself cannot live in the
# repository. launchd could not execute it there at all —
#   bash: .../Downloads/iris/scripts/iris-service.sh: Operation not permitted
# — because ~/Downloads is ACL-guarded and the shell has no grant for it. npm
# does, which is why the old `npm run dev` service ran for hours and hid this.
# So the wrapper is installed next to the speech helper, outside the guard.
set -euo pipefail

IRIS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.user.iris"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/IRIS"
SUPPORT_DIR="$HOME/Library/Application Support/IRIS"
SPEECH_APP="$SUPPORT_DIR/IrisSpeech.app/Contents/MacOS/IrisSpeech"
RUNNER="$SUPPORT_DIR/iris-service.sh"

NPM_PATH="$(command -v npm || true)"
if [ -z "$NPM_PATH" ]; then
  echo "npm が見つかりません。Node.js/npm のインストールを確認してください。" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NPM_PATH")"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$SUPPORT_DIR"

# Copied out of the guarded folder, because launchd cannot execute it inside one.
sed "s|@IRIS_DIR@|$IRIS_DIR|g" "$IRIS_DIR/scripts/iris-service.sh" > "$RUNNER"
chmod +x "$RUNNER"

# Kept, not overwritten. Reverting to a service that was working is worth more
# than a tidy directory.
if [ -f "$PLIST_PATH" ]; then
  cp "$PLIST_PATH" "$PLIST_PATH.bak.$(date +%Y%m%d%H%M%S)"
  echo "▸ 既存の plist を退避しました"
fi

if [ ! -x "$SPEECH_APP" ]; then
  echo "▸ 音声ヘルパが未インストールです — 先に npm run install:speech を実行してください（音声なしでも起動はします）"
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <key>ProgramArguments</key>
  <array><string>$RUNNER</string></array>

  <!-- Deliberately not the repository: a working directory inside a guarded
       folder makes getcwd() itself fail, before any of our code runs. -->
  <key>WorkingDirectory</key><string>/tmp</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- Outside the guarded folder the repository lives in. -->
    <key>IRIS_SPEECH_BINARY</key><string>$SPEECH_APP</string>
    <key>IRIS_LOG_DIR</key><string>$LOG_DIR</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <!-- Restart when it dies, but not when it exited because someone stopped
         it: a crash loop that fights an operator is its own outage. -->
    <key>SuccessfulExit</key><false/>
  </dict>
  <!-- Backs off a genuine crash loop instead of spinning. -->
  <key>ThrottleInterval</key><integer>10</integer>

  <key>StandardOutPath</key><string>$LOG_DIR/iris.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/iris.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo "▸ 登録しました: $PLIST_PATH"
echo "  ログ: $LOG_DIR/iris.log（${IRIS_LOG_MAX_BYTES:-10MB} で世代交代・5世代保持）"
echo "  起動: $RUNNER"
echo "  音声: $SPEECH_APP"
echo
echo "状態確認: npm run launchd:status"
