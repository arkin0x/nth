#!/usr/bin/env bash
#
# Mirror every kind 321 hyperjump anchor from the relay into the local archive.
#
# This is the "never lose the whole set again" backstop: the corpus published
# between 2024 and now exists only on cyberspace.nostr1.com. Pulling it to disk
# makes it rebroadcastable to any relay without re-deriving anything from a
# Bitcoin API.
#
# Walks block heights via the indexed `B` tag rather than paginating over
# `created_at`. Time-based pagination silently loses events: a fast backfill
# publishes thousands per second, so many share one timestamp and the `until`
# cursor steps over them. A time-based attempt recovered 296,458 of ~962,000
# heights and missed the 2024 publisher entirely; the height walk gets all of it.
#
# Safe to re-run, and resumes if interrupted.

set -uo pipefail

NTH_HOME=${NTH_HOME:-/data/projects/nth}
NTH_REPO=${NTH_REPO:-/data/repos/nth}
NODE_BIN=${NODE_BIN:-/usr/bin/node}

mkdir -p "$NTH_HOME/archive" "$NTH_HOME/logs" "$NTH_HOME/state"

exec "$NODE_BIN" "$NTH_REPO/mirror-by-height.mjs" 2>&1 | tee -a "$NTH_HOME/logs/mirror.log"
