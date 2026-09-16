#!/usr/bin/env bash
set -e

LABEL="com.user.iris"
DOMAIN="gui/$(id -u)"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST_PATH" ]; then
  launchctl bootout "$DOMAIN" "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "IRIS launchd を解除しました。"
else
  echo "IRIS launchd plist は存在しません。"
fi
