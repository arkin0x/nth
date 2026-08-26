/**
 * Re-send archived kind 321 anchors to the relay.
 *
 * The archive is written before the publish is attempted, so it holds every
 * anchor NTH ever signed -- including the ~450 that the relay silently refused
 * once it turned on NIP-42. Those events are already signed and still valid;
 * nothing has to be re-derived from a Bitcoin API, they only have to arrive.
 *
 * Safe to re-run: a relay dedupes by event id, so an anchor it already stores is
 * answered OK true ("duplicate: have this event") and counted as accepted. That
 * is why there is no progress file here -- resuming from a stale cursor could
 * skip an event, while simply running the same range again cannot.
 *
 *   node scripts/republish-archive.mjs <startHeight> [endHeight]
 *
 * Exits non-zero if the relay refused anything, so a failed run is not mistaken
 * for a quiet one.
 */
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import WebSocket from 'ws';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load the repo's .env by absolute path: this script is invoked from anywhere,
// and dotenv's default is relative to the current working directory.
dotenv.config({ path: `${REPO}/.env` });

if (!global.WebSocket) global.WebSocket = WebSocket;

const DIST = `${REPO}/dist`;
if (!existsSync(`${DIST}/lib/publisher.js`)) {
  console.error(`Missing ${DIST}/lib/publisher.js -- run "npm run build" first.`);
  process.exit(1);
}

const { SimplePool } = await import('nostr-tools');
const { connectPublisher } = await import(`${DIST}/lib/publisher.js`);
const { loadPrivateKey, privateKeyPath } = await import(`${DIST}/lib/privateKey.js`);

const startHeight = Number(process.argv[2]);
const endHeight = process.argv[3] === undefined ? Infinity : Number(process.argv[3]);

if (!Number.isFinite(startHeight) || startHeight < 0) {
  console.error('Usage: node scripts/republish-archive.mjs <startHeight> [endHeight]');
  process.exit(1);
}
if (!(endHeight >= startHeight)) {
  console.error(`endHeight ${process.argv[3]} is below startHeight ${startHeight}`);
  process.exit(1);
}

const HOME = process.env.NTH_HOME || '/data/projects/nth';
const ROLE = process.env.NTH_ROLE || 'tip';
const ARCHIVE = process.env.NTH_ARCHIVE || `${HOME}/archive/published.${ROLE}.ndjson`;
const RELAY = (process.env.NTH_RELAY || 'wss://cyberspace.nostr1.com').trim();

// Modest pacing so a long catch-up does not look like a flood to the relay.
const DELAY_MS = Number(process.env.REPUBLISH_DELAY_MS || 100);

if (!existsSync(ARCHIVE)) {
  console.error(`No archive at ${ARCHIVE}`);
  process.exit(1);
}

// Never generate: this tool rebroadcasts an existing corpus and must sign its
// NIP-42 auth event as the pubkey that authored it.
const keySource = loadPrivateKey();
if (!keySource) {
  console.error(`No signing key found (looked at ${privateKeyPath()} and $NTH_PRIVATE_KEY).`);
  process.exit(1);
}

function tagValue(event, name) {
  for (const tag of event.tags || []) {
    if (tag[0] === name) return tag[1];
  }
  return null;
}

/**
 * Collect the events to re-send, keyed by height.
 *
 * A block that was signed more than once (a retry after a mid-publish failure)
 * appears in the archive several times with different ids. Sending all of them
 * would put several anchors for one height on the relay, which is the duplicate
 * problem this corpus already had to be cleaned of once. Keep the last signing
 * of each height and send only that.
 */
const selected = new Map();
let scanned = 0;
let malformed = 0;

const lines = createInterface({ input: createReadStream(ARCHIVE, 'utf8'), crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  scanned++;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    malformed++;
    continue;
  }

  const raw = tagValue(event, 'B');
  const height = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(height)) {
    malformed++;
    continue;
  }

  if (height < startHeight || height > endHeight) continue;
  selected.set(height, event);
}

const heights = [...selected.keys()].sort((a, b) => a - b);

console.log(`Archive: ${ARCHIVE}`);
console.log(`Relay:   ${RELAY}`);
console.log(`Scanned ${scanned} lines, ${malformed} unusable.`);
console.log(`Republishing ${heights.length} anchors in [${startHeight}, ${endHeight}] at ${DELAY_MS}ms apart.\n`);

if (heights.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const pool = new SimplePool();

let publisher;
try {
  publisher = await connectPublisher({ pool, url: RELAY, privateKey: keySource.key });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

let accepted = 0;
const refused = [];

for (const height of heights) {
  const event = selected.get(height);

  try {
    await publisher.publish(event);
    accepted++;
    console.log(`${height} ok ${event.id}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    refused.push({ height, reason });
    console.error(`${height} REFUSED ${event.id}: ${reason}`);
  }

  await new Promise((r) => setTimeout(r, DELAY_MS));
}

console.log(`\nAccepted ${accepted}/${heights.length}; refused ${refused.length}.`);

if (refused.length > 0) {
  console.log('Refused heights (first 20):');
  for (const { height, reason } of refused.slice(0, 20)) {
    console.log(`  ${height}: ${reason}`);
  }
}

pool.close([RELAY]);
process.exit(refused.length > 0 ? 1 : 0);
