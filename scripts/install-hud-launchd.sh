#!/usr/bin/env bash
#
# Keeps the band and its keys alive.
#
# The HUD is where ⌥⌘D and ⌥⌘B live, so when it dies the shortcuts do nothing
# at all — no error, no window, just a key that stops working. That happened
# three times in a week, and each time the answer was "the process was gone",
# which is not something a person should have to guess.
#
# IRIS itself has been under launchd since the start; the HUD was left to a
# login item and a hand-run `open`. This is the same treatment: started at
# login, restarted when it dies.
#
# A wrapper, because `open -a` on a running application does not start a second
# copy — it activates the one that is there and brings it to the front. On a
# two-minute timer that steals focus every two minutes, which is worse than the
# problem. The wrapper looks before it opens.
#
# And `open` rather than the executable inside the bundle: macOS gives an
# application its activation policy through the bundle, and panels from a
# process started as a bare binary do not always take focus properly.
set -euo pipefail

LABEL="com.user.iris.hud.keepalive"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/IRIS HUD.app"
LOG_DIR="$HOME/Library/Logs/IRIS"
SUPPORT_DIR="$HOME/Library/Application Support/IRIS"
RUNNER="$SUPPORT_DIR/hud-keepalive.sh"

if [ ! -d "$APP" ]; then
  echo "IRIS HUD.app が見つかりません: $APP" >&2
  echo "先に menubar/install.sh を実行してください。" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$SUPPORT_DIR"

# 監視係もリポジトリの外へ。launchd は ~/Downloads の中のスクリプトを実行できない。
sed "s|@APP@|$APP|g" "$(cd "$(dirname "$0")" && pwd)/hud-keepalive.sh" > "$RUNNER"
chmod +x "$RUNNER"

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

  <key>RunAtLoad</key><true/>
  <!-- The wrapper exits immediately when the HUD is already up, so KeepAlive
       would spin. A two-minute check is what notices a dead one. -->
  <key>KeepAlive</key><false/>
  <key>StartInterval</key><integer>120</integer>

  <key>StandardOutPath</key><string>$LOG_DIR/hud.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/hud.err.log</string>
</dict>
</plist>
PLIST

echo "▸ plist: $PLIST_PATH"
echo
echo "読み込むには:"
echo "  launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null; launchctl bootstrap gui/\$(id -u) \"$PLIST_PATH\""
