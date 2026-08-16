import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, closeSync } from 'fs';
import { dirname, resolve } from 'path';

import type { Event } from 'nostr-tools';

/**
 * Runtime home for persistent state. Defaults to the agent-writable persistent
 * volume; `/data` is the only path on this host that survives a reboot.
 */
export const NTH_HOME = resolve(process.env.NTH_HOME || '/data/projects/nth');

export type Role = 'tip' | 'backfill';

export type RolePaths = {
  state: string;
  lock: string;
  archive: string;
};

export function rolePaths(role: Role): RolePaths {
  return {
    state: `${NTH_HOME}/state/${role}.json`,
    lock: `${NTH_HOME}/run/${role}.pid`,
    archive: `${NTH_HOME}/archive/published.${role}.ndjson`,
  };
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/* ------------------------------------------------------------------ */
/* Single-instance lock                                                */
/* ------------------------------------------------------------------ */

function processAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive per-role lock.
 *
 * bashrc launches the supervisor on every interactive shell, so without this a
 * second publisher would race the first and duplicate every event -- which is
 * exactly how the relay ended up with 3-8 copies of the early blocks.
 */
export function acquireLock(role: Role): void {
  const { lock } = rolePaths(role);
  ensureDir(lock);

  if (existsSync(lock)) {
    const raw = readFileSync(lock, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);

    if (Number.isFinite(pid) && processAlive(pid)) {
      throw new Error(`nth:${role} already running as pid ${pid} (lock ${lock})`);
    }

    // Stale lock from a killed process; reclaim it.
    console.log(`Reclaiming stale lock ${lock} (pid ${raw || 'unknown'} is gone)`);
  }

  const fd = openSync(lock, 'w');
  try {
    writeFileSync(fd, `${process.pid}\n`, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }

  const release = () => {
    try {
      if (existsSync(lock)) {
        const cur = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10);
        if (cur === process.pid) writeFileSync(lock, '');
      }
    } catch {
      // best effort
    }
  };

  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Resume state                                                        */
/* ------------------------------------------------------------------ */

export type RoleState = {
  nextHeight: number;
  updatedAt: number;
};

/**
 * Read the persisted resume point.
 *
 * The original implementation resumed by asking the relay for `limit: 1` and
 * reading its `B` tag, falling back to -1 when the query came back empty. On
 * nostr-tools 1.x an empty/flaky EOSE is common, so every such restart silently
 * began again at block 0. Local state is authoritative here; the relay is only
 * ever a fallback for a cold start.
 */
export function readState(role: Role): RoleState | null {
  const { state } = rolePaths(role);
  if (!existsSync(state)) return null;

  try {
    const parsed = JSON.parse(readFileSync(state, 'utf8')) as Partial<RoleState>;
    const nextHeight = Number(parsed.nextHeight);
    if (!Number.isFinite(nextHeight) || nextHeight < 0) return null;
    return { nextHeight, updatedAt: Number(parsed.updatedAt) || 0 };
  } catch {
    return null;
  }
}

/** Persist the resume point atomically so a crash mid-write cannot corrupt it. */
export function writeState(role: Role, nextHeight: number): void {
  const { state } = rolePaths(role);
  ensureDir(state);

  const tmp = `${state}.tmp`;
  const body: RoleState = { nextHeight, updatedAt: Math.floor(Date.now() / 1000) };
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, 'utf8');
  renameSync(tmp, state);
}

/* ------------------------------------------------------------------ */
/* Local event archive                                                 */
/* ------------------------------------------------------------------ */

/**
 * Append a signed event to the local archive as newline-delimited JSON.
 *
 * This is the durable copy of the hyperjump set: it is written before the
 * publish is considered done, so the corpus survives relay loss and can be
 * rebroadcast to any relay without re-deriving anything from a Bitcoin API.
 * O_APPEND writes of this size are atomic on Linux, so concurrent roles writing
 * their own files never interleave.
 */
export function appendArchive(role: Role, event: Event): void {
  const { archive } = rolePaths(role);
  ensureDir(archive);
  appendFileSync(archive, `${JSON.stringify(event)}\n`, 'utf8');
}
