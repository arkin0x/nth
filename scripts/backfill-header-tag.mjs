/**
 * Publish ONE extra kind 321 anchor per height: a copy of the anchor already
 * archived for that height, plus the raw 80-byte block header as
 * `["header", "<160 hex>"]`.
 *
 * Why: readers that need block time (ONOSENDAI's block-paced clock wants the
 * header time of each retarget window's last block, height 2016k + 2015) can
 * only take it from a header that hashes to the anchor's H. Anchors signed
 * before the publisher learned the header tag lack it; this adds it for the
 * heights that matter, without touching the corpus otherwise.
 *
 *   node scripts/backfill-header-tag.mjs <height> [height ...]            # dry run (default)
 *   node scripts/backfill-header-tag.mjs --publish <height> [height ...]  # sign and publish
 *
 * Heights may also be comma separated. The dry run reads the archive and the
 * Bitcoin API, signs in memory, prints each event, and writes and sends nothing.
 *
 * For each height:
 *   1. take the last signing of that height from the archive; it must be ours
 *      (the loaded key's pubkey), kind 321, intact, and have no header tag yet;
 *   2. ask the Bitcoin API (NTH_BITCOIN_API_BASE_URL, the publisher's own
 *      source) for the block hash at that height, which must equal the
 *      anchor's H, and for the header, which must hash to H and agree with the
 *      anchor's M and P;
 *   3. build the same kind, content and tags, with the header tag where the
 *      publisher puts it (right after B), and a fresh created_at; sign it;
 *   4. (--publish) append it to archive/backfill-header.<role>.ndjson BEFORE
 *      sending, then publish to the primary relay and every mirror, each
 *      waiting for OK true.
 *
 * Sign once: a height that already has a signed copy in the backfill archive
 * (same H, valid signature) reuses that event instead of signing again, so a
 * rerun after a refusal or a crash resends the same id and the relays dedupe
 * it. That is what keeps each height at exactly one extra anchor.
 *
 * Exits 1 if any height could not be prepared or any relay refused, so a
 * failed run is never mistaken for a quiet one. Rerunning is safe.
 */
import { appendFileSync, createReadStream, existsSync, mkdirSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import WebSocket from 'ws';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: `${REPO}/.env` });
if (!global.WebSocket) global.WebSocket = WebSocket;

const DIST = `${REPO}/dist`;
if (!existsSync(`${DIST}/lib/blockHeader.js`)) {
  console.error(`Missing ${DIST}/lib/blockHeader.js -- run "npm run build" first.`);
  process.exit(1);
}

const { SimplePool, getEventHash, getPublicKey, getSignature, validateEvent, verifySignature } = await import('nostr-tools');
const { connectPublisher } = await import(`${DIST}/lib/publisher.js`);
const { loadPrivateKey, privateKeyPath } = await import(`${DIST}/lib/privateKey.js`);
const { createBitcoinApi, getBitcoinApiBaseUrlFromEnv } = await import(`${DIST}/lib/bitcoin.js`);
const { HEADER_TAG, headerFields, headerMismatch } = await import(`${DIST}/lib/blockHeader.js`);
const { parseMirrorRelays } = await import(`${DIST}/lib/mirrors.js`);

// ---- arguments ----

const args = process.argv.slice(2);
const PUBLISH = args.includes('--publish');
const heights = [];
for (const arg of args) {
  if (arg === '--publish' || arg === '--dry-run') continue;
  for (const part of arg.split(',')) {
    if (!part.trim()) continue;
    if (!/^\d+$/.test(part.trim())) {
      console.error(`Not a block height: "${part}"`);
      process.exit(1);
    }
    heights.push(Number(part.trim()));
  }
}
const wanted = [...new Set(heights)].sort((a, b) => a - b);
if (wanted.length === 0) {
  console.error('Usage: node scripts/backfill-header-tag.mjs [--publish] <height> [height ...]');
  process.exit(1);
}

// ---- environment ----

const HOME = process.env.NTH_HOME || '/data/projects/nth';
const ROLE = process.env.NTH_ROLE || 'tip';
const ARCHIVE = process.env.NTH_ARCHIVE || `${HOME}/archive/published.${ROLE}.ndjson`;
const BACKFILL_ARCHIVE = process.env.NTH_HEADER_BACKFILL_ARCHIVE || `${HOME}/archive/backfill-header.${ROLE}.ndjson`;
const RELAY = (process.env.NTH_RELAY || 'wss://cyberspace.nostr1.com').trim();
const MIRRORS = parseMirrorRelays(process.env.NTH_MIRROR_RELAYS, RELAY);
const bitcoin = createBitcoinApi(getBitcoinApiBaseUrlFromEnv());

if (!existsSync(ARCHIVE)) {
  console.error(`No archive at ${ARCHIVE}`);
  process.exit(1);
}

// Never generate a key: these anchors must carry the publisher's pubkey.
const keySource = loadPrivateKey();
if (!keySource) {
  console.error(`No signing key found (looked at ${privateKeyPath()} and $NTH_PRIVATE_KEY).`);
  process.exit(1);
}
const privateKey = keySource.key;
const pubkey = getPublicKey(privateKey);

const tagValue = (event, name) => event.tags?.find((t) => t[0] === name)?.[1] ?? null;
const hasTag = (event, name) => (event.tags || []).some((t) => t[0] === name);

/** Verify a plain JSON copy, so no cached verdict rides along on the object. */
function intact(event) {
  const copy = JSON.parse(JSON.stringify(event));
  return validateEvent(copy) && getEventHash(copy) === copy.id && verifySignature(copy);
}

/** Last line per wanted height from an ndjson archive. */
async function lastByHeight(path, want) {
  const found = new Map();
  if (!existsSync(path)) return found;
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const h = Number.parseInt(tagValue(event, 'B') ?? '', 10);
    if (want.has(h)) found.set(h, event);
  }
  return found;
}

const want = new Set(wanted);
const archived = await lastByHeight(ARCHIVE, want);
const alreadySigned = await lastByHeight(BACKFILL_ARCHIVE, want);

console.log(`Mode:     ${PUBLISH ? 'PUBLISH' : 'dry run (nothing is written or sent; pass --publish to publish)'}`);
console.log(`Archive:  ${ARCHIVE}`);
console.log(`Backfill: ${BACKFILL_ARCHIVE}`);
console.log(`Bitcoin:  ${bitcoin.baseUrl}`);
console.log(`Relays:   ${[RELAY, ...MIRRORS].join(', ')}`);
console.log(`Pubkey:   ${pubkey}`);
console.log(`Heights:  ${wanted.join(', ')}\n`);

/** Build (or reuse) the header-carrying copy for one height. Throws with a reason. */
async function prepare(height) {
  const original = archived.get(height);
  if (!original) throw new Error(`no anchor for height ${height} in ${ARCHIVE}`);
  if (original.kind !== 321) throw new Error(`archived event ${original.id} is kind ${original.kind}`);
  if (original.pubkey !== pubkey) throw new Error(`archived event ${original.id} was signed by ${original.pubkey}, not by the loaded key`);
  if (!intact(original)) throw new Error(`archived event ${original.id} does not verify`);
  if (hasTag(original, HEADER_TAG)) throw new Error(`archived event ${original.id} already carries a header tag; nothing to add`);

  const H = tagValue(original, 'H');
  if (!H) throw new Error(`archived event ${original.id} has no H tag`);

  // The chain must still have this block at this height.
  const chainHash = await bitcoin.getBlockHashByHeight(height);
  if (!chainHash || chainHash.toLowerCase() !== H) {
    throw new Error(`the Bitcoin API has ${chainHash ?? 'no block'} at height ${height}, but the anchor names ${H}`);
  }

  const header = (await bitcoin.getBlockHeader(H, { heightHint: height })).toLowerCase();
  // Legacy anchors (DECK-0001 §2.2) have no M: their C is the merkle root.
  const merkleRoot = tagValue(original, 'M') ?? tagValue(original, 'C');
  const problem = headerMismatch(header, { blockHash: H, merkleRoot, prevBlockHash: tagValue(original, 'P') });
  if (problem) throw new Error(`the Bitcoin API's header for ${H} does not match the anchor (${problem})`);

  // Sign once: reuse a copy this script already signed for this height.
  const prior = alreadySigned.get(height);
  if (prior && prior.pubkey === pubkey && intact(prior) && tagValue(prior, 'H') === H && tagValue(prior, HEADER_TAG) === header) {
    return { event: prior, original, header, reused: true };
  }

  const tags = [];
  for (const tag of original.tags) {
    tags.push([...tag]);
    if (tag[0] === 'B') tags.push([HEADER_TAG, header]);
  }
  const unsigned = {
    kind: original.kind,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: original.content,
  };
  const event = { ...unsigned, id: getEventHash(unsigned), sig: getSignature(unsigned, privateKey) };
  return { event, original, header, reused: false };
}

const prepared = [];
let failures = 0;

for (const height of wanted) {
  try {
    const p = await prepare(height);
    prepared.push({ height, ...p });
    const f = headerFields(p.header);
    console.log(
      `${height}: copy of ${p.original.id}${p.reused ? ' (REUSING the copy already signed; not re-signing)' : ''}\n` +
        `  header time ${f.time} (${new Date(f.time * 1000).toISOString()}), bits 0x${f.bits.toString(16).padStart(8, '0')}, hashes to H ${tagValue(p.event, 'H')}`,
    );
    console.log(JSON.stringify(p.event, null, 2));
    console.log();
  } catch (err) {
    failures++;
    console.error(`${height}: SKIPPED: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

if (!PUBLISH) {
  console.log(`Dry run: ${prepared.length} prepared, ${failures} skipped. Nothing was written or sent.`);
  if (prepared.some((p) => !p.reused)) {
    console.log('A --publish run signs again with a fresh created_at, so its ids will differ from the ones printed here.');
  }
  process.exit(failures > 0 ? 1 : 0);
}

// ---- publish ----

// Archive before sending, as the publisher does: the signed copy must survive a
// relay that drops it, and it is what makes a rerun reuse this id.
for (const p of prepared) {
  if (p.reused) continue;
  mkdirSync(dirname(BACKFILL_ARCHIVE), { recursive: true });
  appendFileSync(BACKFILL_ARCHIVE, `${JSON.stringify(p.event)}\n`, 'utf8');
}

const pool = new SimplePool();
const refused = [];
for (const url of [RELAY, ...MIRRORS]) {
  let publisher;
  try {
    publisher = await connectPublisher({ pool, url, privateKey });
  } catch (err) {
    for (const p of prepared) refused.push({ url, height: p.height, reason: err instanceof Error ? err.message : String(err) });
    console.error(`${url}: could not connect: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  for (const p of prepared) {
    try {
      await publisher.publish(p.event);
      console.log(`${url}: ${p.height} ok ${p.event.id}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      refused.push({ url, height: p.height, reason });
      console.error(`${url}: ${p.height} REFUSED ${p.event.id}: ${reason}`);
    }
  }
}

console.log(`\n${prepared.length} prepared, ${failures} skipped, ${refused.length} refusals across ${1 + MIRRORS.length} relay(s).`);
if (refused.length > 0) console.log('Rerun the same command to retry: it resends the same signed events.');
pool.close([RELAY, ...MIRRORS]);
process.exit(failures > 0 || refused.length > 0 ? 1 : 0);
