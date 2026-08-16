#!/usr/bin/env bash
#
# Keepalive supervisor for a single nth role.
#
# There is no systemd and no cron in this container (pid 1 is `start-container`),
# so process supervision is done here and started from .bashrc. The publisher
# itself holds a per-role lock, so a second supervisor cannot produce a second
# publisher even if this script is somehow launched twice.

set -u

NTH_HOME=${NTH_HOME:-/data/projects/nth}
NTH_REPO=${NTH_REPO:-/data/repos/nth}
NODE_BIN=${NODE_BIN:-/usr/bin/node}
ROLE=${1:-tip}

LOG="$NTH_HOME/logs/$ROLE.log"
MAX_LOG_BYTES=${NTH_MAX_LOG_BYTES:-268435456} # 256 MiB

mkdir -p "$NTH_HOME/logs" "$NTH_HOME/run"

# A previous backfill run left a 1.4 GB log on the old host. Roll before writing.
roll_log_if_large() {
  if [ -f "$LOG" ]; then
    local size
    size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
      mv -f "$LOG" "$LOG.1"
    fi
  fi
}

backoff=5

while true; do
  roll_log_if_large

  started=$(date +%s)
  echo "[supervisor] $(date -Is) starting nth role=$ROLE" >> "$LOG"

  ( cd "$NTH_REPO" && NTH_ROLE="$ROLE" "$NODE_BIN" ./dist/index.js ) >> "$LOG" 2>&1
  code=$?

  ended=$(date +%s)
  echo "[supervisor] $(date -Is) nth role=$ROLE exited code=$code" >> "$LOG"

  # A completed backfill exits 0 on purpose; do not resurrect it.
  if [ "$ROLE" = "backfill" ] && [ "$code" -eq 0 ]; then
    echo "[supervisor] backfill finished; supervisor exiting" >> "$LOG"
    break
  fi

  # Reset backoff if the process stayed up long enough to be doing real work.
  if [ $((ended - started)) -ge 60 ]; then
    backoff=5
  else
    backoff=$((backoff * 2))
    [ "$backoff" -gt 300 ] && backoff=300
  fi

  echo "[supervisor] restarting in ${backoff}s" >> "$LOG"
  sleep "$backoff"
done

rm -f "$NTH_HOME/run/$ROLE.supervisor.pid"
