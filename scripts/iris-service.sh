#!/usr/bin/env bash
#
# What launchd actually runs.
#
# A wrapper rather than `npm start` directly, for two reasons that only show up
# once something is resident: logs that nothing rotates grow until the disk is
# full, and a service that serves stale assets after every edit is worse than
# one that refuses to start.
set -euo pipefail

# Substituted at install time. The runner is copied outside the repository,
# so it cannot find the repository by looking upward from itself.
IRIS_DIR="${IRIS_DIR:-@IRIS_DIR@}"
LOG_DIR="${IRIS_LOG_DIR:-$HOME/Library/Logs/IRIS}"
MAX_BYTES=${IRIS_LOG_MAX_BYTES:-10485760}   # 10MB
KEEP=${IRIS_LOG_KEEP:-5}

mkdir -p "$LOG_DIR"

# Rotate on start. launchd restarts on crash and at login, so this runs often
# enough to bound growth without a separate timer to forget about.
rotate() {
  local file="$1"
  [ -f "$file" ] || return 0
  local size
  size=$(stat -f%z "$file" 2>/dev/null || echo 0)
  [ "$size" -lt "$MAX_BYTES" ] && return 0
  for ((i = KEEP - 1; i >= 1; i--)); do
    [ -f "$file.$i" ] && mv "$file.$i" "$file.$((i + 1))"
  done
  mv "$file" "$file.1"
}
rotate "$LOG_DIR/iris.log"
rotate "$LOG_DIR/iris.err.log"
# Anything above KEEP is gone; a log nobody has read in five rotations is not
# going to be read.
find "$LOG_DIR" -name 'iris*.log.[0-9]*' -type f | while read -r old; do
  index="${old##*.}"
  [ "$index" -gt "$KEEP" ] 2>/dev/null && rm -f "$old"
done || true

# npm is invoked with --prefix rather than by changing directory. The shell
# cannot cd into a guarded folder at all ("getcwd: cannot access parent
# directories"), while npm itself has the grant — which is the only reason the
# previous service ran. Working around it here keeps the repository where the
# user put it.
# ── 港を取り戻してから起動する ───────────────────────────────
#
# launchd は落ちたものを起こし直すが、**掴んだまま応答しなくなったもの**は
# 落ちない。2026-09-02、一時間以上そうなっていた IRIS が 3002 を握り続け、
# 起こし直しは毎回 EADDRINUSE で死に、外からは「IRIS が上がってこない」と
# しか見えなかった。**再起動という手段そのものが効かない状態**で、これは
# 落ちるより悪い。
#
# 起動前に、3002 を掴んでいるのが自分の古い姿なら終わらせる。判定は
# コマンド行が `server/index.ts` を含むかどうか — **無関係のものは殺さない。**
PORT="${PORT:-3002}"
reclaim() {
  local pid
  for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in
      *server/index.ts*)
        echo "[iris] 港 $PORT を掴んでいた古い IRIS ($pid) を終了します"
        kill -TERM "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
          kill -0 "$pid" 2>/dev/null || return 0
          sleep 1
        done
        # 行儀よく終われないなら、強く。港が空かない限り次が上がれない。
        kill -KILL "$pid" 2>/dev/null || true
        sleep 1
        ;;
      *)
        echo "[iris] 港 $PORT は別のものが使っています ($pid)。触りません"
        ;;
    esac
  done
}
reclaim

if [ ! -d "$IRIS_DIR/dist" ]; then
  echo "[iris] building client…"
  npm --prefix "$IRIS_DIR" run build --silent || echo "[iris] build failed; API のみで起動します"
fi

exec npm --prefix "$IRIS_DIR" start
