import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { createHash } from 'crypto';
import { createServer, type Server } from 'net';
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
  /** The signed-but-not-yet-accepted anchor for the current height (sign once). */
  pending: string;
  lock: string;
  archive: string;
  /** One line per height a mirror relay did not take, for exact catch-up later. */
  mirrorMissed: string;
};

export function rolePaths(role: Role): RolePaths {
  return {
    state: `${NTH_HOME}/state/${role}.json`,
    pending: `${NTH_HOME}/state/${role}.pending.json`,
    lock: `${NTH_HOME}/run/${role}.pid`,
    archive: `${NTH_HOME}/archive/published.${role}.ndjson`,
    mirrorMissed: `${NTH_HOME}/state/${role}.mirror-missed.ndjson`,
  };
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Replace `filePath` with `body` so a reader only ever sees the old file or the
 * new one, never a torn mix: write a private temp file, fsync it, then rename
 * over the target (rename is atomic on one filesystem). The temp name carries
 * the pid so two processes can never write into each other's temp file.
 */
function writeFileAtomic(filePath: string, body: string): void {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);

  // Make the rename itself durable: without a directory fsync, a power loss
  // can forget a freshly renamed file (a lost pending anchor means a re-sign).
  try {
    const dirFd = openSync(dirname(filePath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Some filesystems refuse fsync on a directory; the file itself is synced.
  }
}

/* ------------------------------------------------------------------ */
/* Single-instance lock                                                */
/* ------------------------------------------------------------------ */

/**
 * Is this pid a live publisher?
 *
 * `kill(pid, 0)` is not sufficient: it succeeds for zombies, and pid 1 in this
 * container does not reap, so dead publishers linger as `<defunct>` entries
 * indefinitely. Treating a zombie as alive makes the lock permanent and the
 * bashrc autostart a silent no-op forever.
 *
 * Reading /proc also lets us confirm the pid is still the process we started,
 * which guards against pid reuse after a wrap-around.
 */
function processAlive(pid: number, expectCmdlineSubstring?: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ..." -- comm may contain spaces and parentheses, so
    // split on the last ')' rather than by whitespace.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim();
    const state = afterComm.split(/\s+/)[0];
    if (state === 'Z') return false;
  } catch {
    return false; // no /proc entry: the process is gone
  }

  if (expectCmdlineSubstring) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!cmdline.includes(expectCmdlineSubstring)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * The kernel-held half of the lock: a Linux abstract-namespace unix socket.
 *
 * Binding a name is atomic (exactly one process gets it, the rest get
 * EADDRINUSE), and the kernel releases it the instant the holder dies, however
 * it dies. So there is no check-then-write window for two supervisors to slip
 * through together, and no stale lock to reclaim. The name is derived from
 * NTH_HOME and the role, so separate runtime homes never contend.
 */
function lockSocketName(role: Role): string {
  const digest = createHash('sha256').update(`${NTH_HOME}\0${role}`).digest('hex').slice(0, 32);
  return `\0nth-lock-${digest}`;
}

let heldLockServer: Server | null = null;

function bindLockSocket(role: Role): Promise<Server> {
  return new Promise<Server>((resolvePromise, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`nth:${role} already running (instance lock for ${NTH_HOME} is held by another process)`));
      } else {
        reject(new Error(`nth:${role} could not take its instance lock: ${error.message}`));
      }
    });
    server.listen({ path: lockSocketName(role), exclusive: true }, () => resolvePromise(server));
  });
}

/**
 * Acquire an exclusive per-role lock.
 *
 * bashrc launches the supervisor on every interactive shell, so without this a
 * second publisher would race the first and duplicate every event -- which is
 * exactly how the relay ended up with 3-8 copies of the early blocks.
 *
 * The previous version was check-then-write on the pidfile alone, so two
 * processes starting in the same instant could both see "no live owner" and
 * both run. Exclusion now comes from the abstract socket above. The pidfile is
 * still checked (so a worker built before this change, which only knows the
 * pidfile, still keeps a new one out) and still written (nth-status.sh reads
 * it), but it is no longer what makes the lock exclusive.
 */
export async function acquireLock(role: Role): Promise<void> {
  const { lock } = rolePaths(role);
  ensureDir(lock);

  const server = await bindLockSocket(role);

  if (existsSync(lock)) {
    const raw = readFileSync(lock, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);

    if (Number.isFinite(pid) && pid !== process.pid && processAlive(pid, 'index.js')) {
      server.close();
      throw new Error(`nth:${role} already running as pid ${pid} (lock ${lock})`);
    }

    if (raw) console.log(`Reclaiming stale lock ${lock} (pid ${raw} is gone)`);
  }

  // Never let the lock socket keep the process alive on its own.
  server.unref();
  heldLockServer = server;

  // Test hook: hold the gap between "exclusion decided" and "pidfile written",
  // which is exactly the window the old check-then-write lock lost races in,
  // so a test can start a rival inside it deterministically. Unset in production.
  const holdMs = Number.parseInt((process.env.NTH_TEST_LOCK_HOLD_MS || '').trim(), 10);
  if (Number.isFinite(holdMs) && holdMs > 0) {
    console.log(`Instance lock taken; holding ${holdMs}ms before writing the pidfile (NTH_TEST_LOCK_HOLD_MS)`);
    await new Promise((r) => setTimeout(r, holdMs));
  }

  writeFileAtomic(lock, `${process.pid}\n`);

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

/** For tests: true while this process holds the instance lock. */
export function holdsLock(): boolean {
  return heldLockServer !== null && heldLockServer.listening;
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

  const body: RoleState = { nextHeight, updatedAt: Math.floor(Date.now() / 1000) };
  writeFileAtomic(state, `${JSON.stringify(body)}\n`);
}

/* ------------------------------------------------------------------ */
/* Pending anchor (sign once per height)                               */
/* ------------------------------------------------------------------ */

/**
 * The anchor signed for the height currently being published.
 *
 * A height is signed exactly once. Retries, and restarts in the middle of a
 * retry, publish this same event again instead of signing a fresh one, so the
 * relay sees one event id per height (a resend is just a "duplicate" OK). The
 * old code re-signed on every retry, which left one height on nostr1 80 times.
 *
 * `archived` records whether the event is already in the local archive, so a
 * restart neither loses the archive line nor writes it twice.
 */
export type PendingAnchor = {
  height: number;
  archived: boolean;
  event: Event;
};

/** Read the pending anchor; a missing or unreadable file reads as none. */
export function readPending(role: Role): PendingAnchor | null {
  const { pending } = rolePaths(role);
  if (!existsSync(pending)) return null;

  try {
    const parsed = JSON.parse(readFileSync(pending, 'utf8')) as Partial<PendingAnchor>;
    const height = Number(parsed.height);
    const event = parsed.event as Event | undefined;
    if (!Number.isInteger(height) || height < 0 || !event || typeof event !== 'object' || typeof event.id !== 'string') {
      console.error(`Ignoring malformed pending anchor file ${pending}`);
      return null;
    }
    return { height, archived: parsed.archived === true, event };
  } catch (error) {
    console.error(`Ignoring unreadable pending anchor file ${pending}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Persist the pending anchor atomically (temp file, fsync, rename). */
export function writePending(role: Role, anchor: PendingAnchor): void {
  writeFileAtomic(rolePaths(role).pending, `${JSON.stringify(anchor)}\n`);
}

/** Drop the pending anchor once its height is durably past. */
export function clearPending(role: Role): void {
  try {
    unlinkSync(rolePaths(role).pending);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Mirror misses                                                       */
/* ------------------------------------------------------------------ */

export type MirrorMiss = {
  relay: string;
  height: number;
  id: string;
  reason: string;
};

/**
 * Record that a mirror did not take a height. Never throws: a mirror is best
 * effort, and failing to write this line must not reach the publish loop.
 */
export function appendMirrorMiss(role: Role, miss: MirrorMiss): void {
  try {
    const { mirrorMissed } = rolePaths(role);
    ensureDir(mirrorMissed);
    appendFileSync(mirrorMissed, `${JSON.stringify({ at: Math.floor(Date.now() / 1000), ...miss })}\n`, 'utf8');
  } catch (error) {
    console.error(`Could not record mirror miss for block ${miss.height} on ${miss.relay}:`, error);
  }
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

/** How much of the archive's end to check for an event before appending it. */
const ARCHIVE_TAIL_BYTES = 16 * 1024;

/**
 * Append unless the event is already one of the archive's last lines.
 *
 * The pending anchor's `archived` flag is written right after the append, so
 * a hard kill between the two would otherwise archive the same event twice on
 * restart. Only the tail needs checking: the event was appended last.
 */
export function appendArchiveOnce(role: Role, event: Event): void {
  const { archive } = rolePaths(role);
  if (existsSync(archive)) {
    const fd = openSync(archive, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, ARCHIVE_TAIL_BYTES);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, size - length);
      if (buf.toString('utf8').includes(`"id":"${event.id}"`)) return;
    } finally {
      closeSync(fd);
    }
  }
  appendArchive(role, event);
}
