#!/usr/bin/env bash

LABEL="com.user.iris"
DOMAIN="gui/$(id -u)"
# Overridable so this can be exercised against a fixture directory.
BACKUP_DIR="${IRIS_BACKUP_DIR:-$HOME/Library/Application Support/IRIS/backups}"

echo "=== IRIS launchd ==="
LAUNCHD_OK=1
if ! launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|runs =|last exit code ="; then
  echo "IRIS launchd は登録されていません。"
  # Reported at the end rather than here. An unregistered service is exactly
  # when the backup age below matters most, and exiting on the first section
  # hid it.
  LAUNCHD_OK=0
fi

echo
echo "=== バックアップ ==="
# Newest by the timestamp in the name, not by mtime and not by lexical order of
# the whole filename — a hand-made snapshot with a different prefix would sort
# after a newer automatic one. Same rule BackupService.list() uses.
NEWEST=""
if [ -d "$BACKUP_DIR" ]; then
  NEWEST="$(
    for f in "$BACKUP_DIR"/*.db; do
      [ -e "$f" ] || continue
      base="${f##*/}"
      stamp="$(printf '%s\n' "$base" | grep -oE '[0-9]{8}-[0-9]{6}' | head -n 1)"
      [ -n "$stamp" ] || continue
      printf '%s\t%s\n' "$stamp" "$base"
    done | LC_ALL=C sort | tail -n 1
  )"
fi

if [ -z "$NEWEST" ]; then
  if [ ! -d "$BACKUP_DIR" ]; then
    echo "バックアップがありません（$BACKUP_DIR がありません）"
  else
    # 'Empty' and 'has files, none of them recognisable' are different
    # situations and were reported identically. Before 2026-08-20 this
    # directory held exactly the second case — two hand-made snapshots named
    # jarvis_memory-pre-reliable-state-*.db — and the script would have said
    # there were no backups while someone looking at the folder saw two files.
    IGNORED="$(ls -1 "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$IGNORED" -gt 0 ]; then
      echo "認識できるバックアップがありません（$BACKUP_DIR に $IGNORED 件ありますが、名前が iris-YYYYMMDD-HHMMSS.db ではありません）"
      echo "  BackupService も同じ規則で選ぶため、これらは間引きの対象にも復元の候補にもなりません。"
    else
      echo "バックアップがありません（$BACKUP_DIR は空です）"
    fi
  fi
  echo "  取得: curl -X POST localhost:3002/api/backups"
else
  STAMP="${NEWEST%%$'\t'*}"
  NAME="${NEWEST#*$'\t'}"

  # The name is written in local time, so it is read back in local time.
  # There is no mtime fallback here: anything reaching this point already
  # matched the timestamp pattern, so a fallback for names that did not match
  # could never run. One was written and removed on review.
  TAKEN="$(date -j -f '%Y%m%d-%H%M%S' "$STAMP" '+%s' 2>/dev/null)"

  COUNT="$(ls -1 "$BACKUP_DIR"/*.db 2>/dev/null | wc -l | tr -d ' ')"
  BYTES="$(stat -f '%z' "$BACKUP_DIR/$NAME" 2>/dev/null)"
  SIZE=""
  [ -n "$BYTES" ] && SIZE="$(awk -v b="$BYTES" 'BEGIN { printf "%.1fMB", b / 1048576 }')"

  echo "最新: $NAME${SIZE:+（$SIZE）}"

  if [ -n "$TAKEN" ]; then
    AGE=$(( $(date '+%s') - TAKEN ))
    if [ "$AGE" -lt 0 ]; then
      echo "経過: 未来の時刻です（時計のずれを疑ってください）"
    else
      D=$(( AGE / 86400 ))
      H=$(( (AGE % 86400) / 3600 ))
      M=$(( (AGE % 3600) / 60 ))
      if [ "$D" -gt 0 ]; then
        echo "経過: ${D}日${H}時間前"
      elif [ "$H" -gt 0 ]; then
        echo "経過: ${H}時間${M}分前"
      else
        echo "経過: ${M}分前"
      fi
      # The same 48 hours health treats as failing, so the two never disagree.
      if [ "$AGE" -ge 172800 ]; then
        echo "▸ 48時間以上取れていません。日次バックアップが止まっています。"
      fi
    fi
  else
    echo "経過: 不明（名前も更新時刻も読めませんでした）"
  fi

  echo "保管: $COUNT 件 / $BACKUP_DIR"
fi

echo
echo "=== Backend :3002 ==="
lsof -nP -iTCP:3002 -sTCP:LISTEN 2>/dev/null || echo "3002 LISTENなし"

echo
echo "=== Frontend :5173 ==="
lsof -nP -iTCP:5173 -sTCP:LISTEN 2>/dev/null || echo "5173 LISTENなし"

echo
echo "=== Health ==="
curl -fsS http://localhost:3002/api/health 2>/dev/null || echo "Health API応答なし"
echo

# Kept from the version that exited on the first section: an unregistered
# service is still a failure, it is just reported after everything has printed.
[ "$LAUNCHD_OK" = 1 ] || exit 1
