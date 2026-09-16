#!/usr/bin/env bash
#
# 落ちていたときだけ起こす。
#
# `open -a` on an application that is already running does not start a second
# copy — it *activates* the one that is there, bringing it to the front. Run on
# a timer that would steal focus every two minutes, which is worse than the
# problem it was meant to fix. So it looks first.
set -euo pipefail

APP="@APP@"
if pgrep -f "IRIS HUD.app/Contents/MacOS/IRIS HUD" >/dev/null 2>&1; then
  exit 0
fi
echo "$(date '+%Y-%m-%d %H:%M:%S') 起動していなかったので起こします"
exec /usr/bin/open -a "$APP"
