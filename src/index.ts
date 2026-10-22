import dotenv from 'dotenv';
import WebSocket from 'ws';

import { getPublicKey, SimplePool } from 'nostr-tools';

import { createBitcoinApi, getBitcoinApiBaseUrlFromEnv } from './lib/bitcoin.js';
import { loadOrCreatePrivateKey } from './lib/privateKey.js';
import { DEFAULT_RELAY, findFrontierHeight } from './lib/nostr.js';
import { MirrorSet, parseMirrorRelays } from './lib/mirrors.js';
import { connectPublisher } from './lib/publisher.js';
import {
  acquireLock,
  appendArchive,
  appendMirrorMiss,
  clearPending,
  readPending,
  readState,
  writePending,
  writeState,
  NTH_HOME,
  type Role,
} from './lib/runtime.js';
import { processBlock } from './processBlock.js';

if (!global.WebSocket) {
  global.WebSocket = WebSocket as any;
}

dotenv.config();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return defaultValue;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseStartHeightFromEnv(): number | null {
  const raw = (process.env.NTH_START_HEIGHT || '').trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function computeBackoffMs(attempt: number, opts: { baseMs: number; maxMs: number }): number {
  const pow = Math.min(attempt, 30); // prevent overflow
  const ms = Math.min(opts.baseMs * Math.pow(2, pow), opts.maxMs);

  // small jitter to avoid synchronizing with other clients
  const jitter = 0.2;
  const rand = 1 - jitter + Math.random() * (2 * jitter);
  return Math.max(0, Math.floor(ms * rand));
}

/**
 * Resolve where to start publishing.
 *
 * Order: explicit override -> persisted local state -> relay frontier probe.
 * If none of those produce an answer we abort rather than defaulting to zero.
 * Silently falling back to height 0 is precisely what caused the relay to
 * accumulate 3-8 duplicate copies of every early block.
 *
 * The probe asks the PRIMARY relay only, and takes a single URL so a mirror
 * cannot be passed in by mistake: an empty or partial mirror must never be
 * able to lower the resume point.
 */
async function resolveStartHeight(opts: {
  role: Role;
  pool: SimplePool;
  primaryRelay: string;
  pubkey: string;
}): Promise<number> {
  const { role, pool, primaryRelay, pubkey } = opts;

  const override = parseStartHeightFromEnv();
  if (override !== null) {
    console.log(`Start height ${override} (NTH_START_HEIGHT override)`);
    return override;
  }

  const persisted = readState(role);
  if (persisted) {
    console.log(`Start height ${persisted.nextHeight} (resumed from local state)`);
    return persisted.nextHeight;
  }

  console.log(`No local state; probing the primary relay ${primaryRelay} for the published frontier...`);
  const frontier = await findFrontierHeight({ pool, relays: [primaryRelay], pubkey });

  if (frontier >= 0) {
    console.log(`Start height ${frontier + 1} (relay frontier ${frontier})`);
    return frontier + 1;
  }

  throw new Error(
    'Cannot determine a start height: no local state and this pubkey has published nothing. ' +
      'Set NTH_START_HEIGHT explicitly to choose a starting block.',
  );
}

async function main() {
  const role = ((process.env.NTH_ROLE || 'tip').trim() as Role) || 'tip';
  if (role !== 'tip' && role !== 'backfill') {
    throw new Error(`Invalid NTH_ROLE "${role}" (expected "tip" or "backfill")`);
  }

  await acquireLock(role);

  const keySource = loadOrCreatePrivateKey();
  const privateKey = keySource.key;
  const pubkey = getPublicKey(privateKey);

  const relay = (process.env.NTH_RELAY || DEFAULT_RELAY).trim() || DEFAULT_RELAY;
  const network = (process.env.NTH_NETWORK || 'mainnet').trim() || 'mainnet';
  const mirrorUrls = parseMirrorRelays(process.env.NTH_MIRROR_RELAYS, relay);

  const bitcoinApi = createBitcoinApi(getBitcoinApiBaseUrlFromEnv());
  const pool = new SimplePool();

  console.log(`Role: ${role}`);
  console.log(`Runtime home: ${NTH_HOME}`);
  console.log(`Using relay: ${relay} (primary: only its OK advances state)`);
  console.log(`Mirror relays: ${mirrorUrls.length > 0 ? `${mirrorUrls.join(', ')} (best effort)` : 'none'}`);
  console.log(`Using bitcoin API: ${bitcoinApi.baseUrl}`);
  console.log(`Bitcoin network: ${network}`);
  console.log(`Publisher pubkey: ${pubkey}`);
  if (keySource.type === 'generated') {
    console.log(`Generated new private key at ${keySource.path}`);
  } else if (keySource.type === 'file') {
    console.log(`Loaded private key from ${keySource.path}`);
  } else {
    console.log(`Loaded private key from environment`);
  }

  const publishDelayMs = parseIntEnv('NTH_PUBLISH_DELAY_MS', 200);
  const notMinedDelayMs = parseIntEnv('NTH_NOT_MINED_DELAY_MS', 300_000);
  const backoffBaseMs = parseIntEnv('NTH_ERROR_BACKOFF_BASE_MS', 1_000);
  const backoffMaxMs = parseIntEnv('NTH_ERROR_BACKOFF_MAX_MS', 300_000);

  // Confirmation depth. NTH already needs block h+1 to fill the `N` tag, so it
  // is inherently 1 deep; a reorg at that depth would publish an anchor that
  // permanently disagrees with consensus, and DECK-0001 requires verifiers to
  // reject exactly that. 6 is the conventional settlement depth.
  const confirmations = Math.max(1, parseIntEnv('NTH_CONFIRMATIONS', 6));

  // `backfill` walks historical blocks and stops before the frontier the tip
  // role owns, so the two roles never publish the same height.
  const stopAt = role === 'backfill' ? parseIntEnv('NTH_STOP_HEIGHT', -1) : Number.MAX_SAFE_INTEGER;

  // Authenticate before the first read. This relay's `auth_required` covers REQ
  // as well as EVENT, and the challenge is sent once per socket, so the frontier
  // probe must not be what opens it.
  const publisher = await connectPublisher({ pool, url: relay, privateKey });

  const startHeight = await resolveStartHeight({ role, pool, primaryRelay: relay, pubkey });

  // Mirrors start only after the start height is settled, so they play no part
  // in choosing it. They connect in their own sockets, never through `pool`.
  const mirrors = new MirrorSet(mirrorUrls, privateKey, {
    connectTimeoutMs: parseIntEnv('NTH_MIRROR_CONNECT_TIMEOUT_MS', 15_000),
    okTimeoutMs: parseIntEnv('NTH_MIRROR_OK_TIMEOUT_MS', 15_000),
    authWaitMs: parseIntEnv('NTH_MIRROR_AUTH_WAIT_MS', 5_000),
    minIntervalMs: parseIntEnv('NTH_MIRROR_MIN_INTERVAL_MS', 1_000),
    retryBaseMs: parseIntEnv('NTH_MIRROR_RETRY_BASE_MS', 5_000),
    retryMaxMs: parseIntEnv('NTH_MIRROR_RETRY_MAX_MS', 300_000),
    queueMax: parseIntEnv('NTH_MIRROR_QUEUE_MAX', 10_000),
    maxAttempts: Math.max(1, parseIntEnv('NTH_MIRROR_MAX_ATTEMPTS', 5)),
    onMiss: (miss) => appendMirrorMiss(role, miss),
  });
  // Heights still queued when the process ends are recorded as missed, so the
  // missed file stays a complete list for catch-up (a SIGKILL is the exception).
  process.on('exit', () => mirrors.stop('process exited before the mirror took it'));
  mirrors.start();

  console.log(`Publish delay: ${publishDelayMs}ms`);
  console.log(`Confirmation depth: ${confirmations}`);
  if (role === 'backfill') console.log(`Stop after height: ${stopAt}`);

  let blockHeight = startHeight;
  let currentHash: string | null = null;
  let nextHash: string | null = null;
  let consecutiveErrors = 0;

  // Cached chain tip, refreshed only when the confirmation gate would block.
  let tipHeight = -1;

  while (true) {
    try {
      if (role === 'backfill' && stopAt >= 0 && blockHeight > stopAt) {
        console.log(`Backfill complete: reached stop height ${stopAt}.`);
        return;
      }

      // Confirmation gate: refuse to publish within `confirmations` of the tip.
      if (tipHeight - blockHeight < confirmations) {
        tipHeight = await bitcoinApi.getTipHeight();

        if (tipHeight - blockHeight < confirmations) {
          const need = confirmations - (tipHeight - blockHeight);
          console.log(
            `Block ${blockHeight} has ${Math.max(0, tipHeight - blockHeight)}/${confirmations} confirmations ` +
              `(tip ${tipHeight}); waiting for ${need} more. Retrying in ${notMinedDelayMs}ms.`,
          );
          await sleep(notMinedDelayMs);
          continue;
        }
      }

      if (!currentHash) {
        currentHash = await bitcoinApi.getBlockHashByHeight(blockHeight);
      }

      if (!currentHash) {
        // 404 only
        console.log(`Block ${blockHeight} not found yet (404). Retrying in ${notMinedDelayMs}ms.`);
        await sleep(notMinedDelayMs);
        continue;
      }

      if (!nextHash) {
        nextHash = await bitcoinApi.getBlockHashByHeight(blockHeight + 1);
      }

      if (!nextHash) {
        // 404 only
        console.log(`Block ${blockHeight + 1} not mined yet (404). Retrying in ${notMinedDelayMs}ms.`);
        await sleep(notMinedDelayMs);
        continue;
      }

      const event = await processBlock({
        blockHeight,
        blockHash: currentHash,
        nextBlockHash: nextHash,
        bitcoin: bitcoinApi,
        publish: publisher.publish,
        privateKey,
        network,
        store: {
          read: () => readPending(role),
          write: (anchor) => writePending(role, anchor),
          archive: (signed) => appendArchive(role, signed),
        },
      });

      // Advance the durable resume point only after the PRIMARY accepted the
      // event. processBlock throws on rejection, so a refused block is retried
      // here, with the same signed event, rather than skipped over.
      writeState(role, blockHeight + 1);

      // Only now is the pending anchor done with. Stopping between these two
      // lines is harmless: the next start resumes at blockHeight + 1 and the
      // leftover pending anchor (for blockHeight) is simply not reused.
      try {
        clearPending(role);
      } catch (error) {
        console.error(`Could not clear the pending anchor for block ${blockHeight} (harmless; it is not reused):`, error);
      }

      // Best effort, in the background; never waits, never throws.
      mirrors.enqueue(blockHeight, event);

      consecutiveErrors = 0;

      await sleep(publishDelayMs);

      blockHeight++;
      currentHash = nextHash;
      nextHash = null;
    } catch (error) {
      consecutiveErrors++;
      const delayMs = computeBackoffMs(consecutiveErrors, { baseMs: backoffBaseMs, maxMs: backoffMaxMs });

      console.error(`Error at height ${blockHeight} (consecutive ${consecutiveErrors}):`, error);
      console.log(`Backing off for ${delayMs}ms...`);

      // A failed block may have left a stale hash pair; re-fetch on retry.
      currentHash = null;
      nextHash = null;

      await sleep(delayMs);
    }
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
