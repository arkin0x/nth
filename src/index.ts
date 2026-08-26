import dotenv from 'dotenv';
import WebSocket from 'ws';

import { getPublicKey, SimplePool } from 'nostr-tools';

import { createBitcoinApi, getBitcoinApiBaseUrlFromEnv } from './lib/bitcoin.js';
import { loadOrCreatePrivateKey } from './lib/privateKey.js';
import { DEFAULT_RELAY, findFrontierHeight } from './lib/nostr.js';
import { connectPublisher } from './lib/publisher.js';
import { acquireLock, appendArchive, readState, writeState, NTH_HOME, type Role } from './lib/runtime.js';
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
 */
async function resolveStartHeight(opts: {
  role: Role;
  pool: SimplePool;
  relays: string[];
  pubkey: string;
}): Promise<number> {
  const { role, pool, relays, pubkey } = opts;

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

  console.log('No local state; probing relay for published frontier...');
  const frontier = await findFrontierHeight({ pool, relays, pubkey });

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

  acquireLock(role);

  const keySource = loadOrCreatePrivateKey();
  const privateKey = keySource.key;
  const pubkey = getPublicKey(privateKey);

  const relay = (process.env.NTH_RELAY || DEFAULT_RELAY).trim() || DEFAULT_RELAY;
  const network = (process.env.NTH_NETWORK || 'mainnet').trim() || 'mainnet';

  const bitcoinApi = createBitcoinApi(getBitcoinApiBaseUrlFromEnv());
  const pool = new SimplePool();

  console.log(`Role: ${role}`);
  console.log(`Runtime home: ${NTH_HOME}`);
  console.log(`Using relay: ${relay}`);
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

  const startHeight = await resolveStartHeight({ role, pool, relays: [relay], pubkey });

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

      await processBlock({
        blockHeight,
        blockHash: currentHash,
        nextBlockHash: nextHash,
        bitcoin: bitcoinApi,
        publish: publisher.publish,
        privateKey,
        network,
        onSigned: (event) => appendArchive(role, event),
      });

      // Advance the durable resume point only after the relay accepted the
      // event. processBlock throws on rejection, so a refused block is retried
      // here rather than skipped over.
      writeState(role, blockHeight + 1);

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
