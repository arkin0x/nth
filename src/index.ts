import dotenv from 'dotenv';
import WebSocket from 'ws';

import { getPublicKey, SimplePool } from 'nostr-tools';

import { createBitcoinApi, getBitcoinApiBaseUrlFromEnv } from './lib/bitcoin.js';
import { loadOrCreatePrivateKey } from './lib/privateKey.js';
import { DEFAULT_RELAY, getLatestPublishedHeight } from './lib/nostr.js';
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

async function main() {
  const keySource = loadOrCreatePrivateKey();
  const privateKey = keySource.key;
  const pubkey = getPublicKey(privateKey);

  const relay = (process.env.NTH_RELAY || DEFAULT_RELAY).trim() || DEFAULT_RELAY;

  const bitcoinApi = createBitcoinApi(getBitcoinApiBaseUrlFromEnv());
  const pool = new SimplePool();

  console.log(`Using relay: ${relay}`);
  console.log(`Using bitcoin API: ${bitcoinApi.baseUrl}`);
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

  const startHeightOverride = parseStartHeightFromEnv();
  const latestHeight = await getLatestPublishedHeight({ pool, relays: [relay], pubkey });

  const startHeight = startHeightOverride ?? latestHeight + 1;
  console.log(`Starting from block height ${startHeight}`);
  console.log(`Publish delay: ${publishDelayMs}ms`);

  let blockHeight = startHeight;
  let currentHash: string | null = null;
  let nextHash: string | null = null;
  let consecutiveErrors = 0;

  while (true) {
    try {
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
        relay,
        pool,
        privateKey,
      });

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

      await sleep(delayMs);
    }
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
