#!/usr/bin/env bash
#
# Idempotent launcher, safe to call from .bashrc on every interactive shell.
# Returns immediately and prints nothing on the happy path.
#
#   nth-start.sh [role]     role defaults to "tip"

set -u

NTH_HOME=${NTH_HOME:-/data/projects/nth}
ROLE=${1:-tip}
PIDFILE="$NTH_HOME/run/$ROLE.supervisor.pid"

mkdir -p "$NTH_HOME/run" "$NTH_HOME/logs"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=/dev/null
. "$SCRIPT_DIR/nth-lib.sh"

# Already supervised? Nothing to do.
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if process_alive "${pid:-}" "nth-supervisor"; then
    exit 0
  fi
fi

# Built artifact must exist; a shell start is not the place to run a build.
if [ ! -f "${NTH_REPO:-/data/repos/nth}/dist/index.js" ]; then
  echo "nth: ${NTH_REPO:-/data/repos/nth}/dist/index.js missing - run 'npm run build' in the repo" >&2
  exit 1
fi

# setsid detaches from this shell's session so the publisher survives logout.
setsid nohup "$SCRIPT_DIR/nth-supervisor.sh" "$ROLE" \
  >> "$NTH_HOME/logs/$ROLE.supervisor.log" 2>&1 &

echo $! > "$PIDFILE"
