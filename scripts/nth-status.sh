#!/usr/bin/env bash
#
# One-screen health check for the hyperjump publisher.

set -u

NTH_HOME=${NTH_HOME:-/data/projects/nth}
PATH="$PATH:/data/go/bin"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=/dev/null
. "$SCRIPT_DIR/nth-lib.sh"

for ROLE in tip backfill; do
  STATE="$NTH_HOME/state/$ROLE.json"
  [ -f "$STATE" ] || continue

  PIDFILE="$NTH_HOME/run/$ROLE.supervisor.pid"
  LOCK="$NTH_HOME/run/$ROLE.pid"
  ARCHIVE="$NTH_HOME/archive/published.$ROLE.ndjson"

  running="stopped"
  if [ -f "$PIDFILE" ]; then
    pid=$(cat "$PIDFILE" 2>/dev/null || true)
    process_alive "${pid:-}" "nth-supervisor" && running="running (supervisor pid $pid)"
  fi

  worker=""
  if [ -f "$LOCK" ]; then
    wpid=$(cat "$LOCK" 2>/dev/null || true)
    process_alive "${wpid:-}" "index.js" && worker=" worker pid $wpid"
  fi

  next=$(python3 -c "import json;print(json.load(open('$STATE'))['nextHeight'])" 2>/dev/null || echo '?')
  updated=$(python3 -c "
import json,datetime
t=json.load(open('$STATE')).get('updatedAt',0)
print(datetime.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d %H:%M:%SZ') if t else '?')
" 2>/dev/null || echo '?')

  echo "role=$ROLE  $running$worker"
  echo "  next height : $next   (state written $updated)"
  [ -f "$ARCHIVE" ] && echo "  archived    : $(wc -l < "$ARCHIVE") events  ($(du -h "$ARCHIVE" | cut -f1))"
  echo "  last log    : $(tail -1 "$NTH_HOME/logs/$ROLE.log" 2>/dev/null || echo 'no log')"
done

TIP=$(curl -s --max-time 10 https://mempool.space/api/blocks/tip/height 2>/dev/null || echo '?')
echo
echo "bitcoin tip   : $TIP"
if command -v nak >/dev/null 2>&1; then
  PUB=$(cat "$NTH_HOME/secrets/active_publisher.hex" 2>/dev/null | xargs -r nak key public 2>/dev/null)
  [ -n "${PUB:-}" ] && echo "publisher     : $PUB"
fi
echo "relay mirror  : $( [ -f "$NTH_HOME/archive/relay-mirror.ndjson" ] && wc -l < "$NTH_HOME/archive/relay-mirror.ndjson" || echo 0 ) events"
