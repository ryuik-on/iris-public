#!/usr/bin/env bash
#
# Takes Remote Control away again.
#
# Here because a capability that cannot be removed in one line is one people
# hesitate to grant. The log is left alone: it is the record of what the phone
# did while this was on.
set -euo pipefail
LABEL="com.user.iris.remote"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "▸ 停止しました" || echo "▸ 動いていませんでした"
if [ -f "$PLIST_PATH" ]; then
  mv "$PLIST_PATH" "$PLIST_PATH.removed.$(date +%Y%m%d%H%M%S)"
  echo "▸ plist を退避しました（消してはいません）"
fi
echo "▸ ログは $HOME/Library/Logs/IRIS/remote-control*.log に残しています"
