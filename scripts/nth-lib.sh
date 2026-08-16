#!/usr/bin/env bash
#
# Shared liveness check.
#
# `kill -0` is NOT sufficient here: it succeeds for zombie processes, and pid 1
# in this container (`start-container`) does not reap children. Dead publishers
# therefore linger as <defunct> entries forever, and a naive check makes the
# autostart a permanent no-op. Read /proc instead and reject state Z, plus
# confirm the command line still matches to survive pid reuse.

process_alive() {
  local pid=${1:-} want=${2:-}
  [ -n "$pid" ] || return 1
  [ -r "/proc/$pid/stat" ] || return 1

  # "pid (comm) state ..."; comm can contain spaces, so cut after the last ')'.
  local state
  state=$(sed -e 's/^.*)[[:space:]]*//' "/proc/$pid/stat" 2>/dev/null | awk '{print $1}')
  [ "$state" = "Z" ] && return 1

  if [ -n "$want" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$want" || return 1
  fi

  return 0
}
