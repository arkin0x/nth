/**
 * Publish ONE extra kind 321 anchor per height: a copy of the anchor already
 * archived for that height, plus the raw 80-byte block header as
 * `["header", "<160 hex>"]`.
 *
 * Why: readers that need block time (ONOSENDAI's block-paced clock wants the
 * header time of each retarget window's last block, height 2016k + 2015) can
 * only take it from a header that hashes to the anchor's H. Anchors signed
 * before the publisher learned the header tag, or signed without it because
 * the header could not be fetched, lack it; this adds it for the heights that
 * matter, without touching the corpus otherwise.
 *
 *   node scripts/backfill-header-tag.mjs <height> [height ...]            # dry run (default)
 *   node scripts/backfill-header-tag.mjs --publish <height> [height ...]  # sign and publish
 *   node scripts/backfill-header-tag.mjs --from-missing [--publish]       # the publisher's header-missing list
 *
 * Heights may also be comma separated. More than MAX_WITHOUT_FLAG heights
 * need --many as well (see below). The dry run reads the archives and the
 * Bitcoin API, signs in memory, prints each event, and writes and sends nothing.
 *
 * For each height:
 *   1. take the last signing of that height from the archive; it must be ours
 *      (the loaded key's pubkey), kind 321, intact, and have no header tag yet;
 *   2. if this script already signed a copy (archive/backfill-header.<role>.ndjson)
 *      that is intact and whose header hashes to the anchor's H, resend that
 *      copy as it is: no Bitcoin API call, so a rerun works during an outage;
 *   3. otherwise ask the Bitcoin API (NTH_BITCOIN_API_BASE_URL, the publisher's
 *      own source) for the block hash at that height, which must equal H, and
 *      for the header, which must hash to H and agree with M and P (C on a
 *      legacy anchor without M); build the same kind, content and tags, with
 *      the header right after B, and created_at = the original's + 1; sign;
 *   4. (--publish) append it to the backfill archive BEFORE sending, then
 *      publish to the primary relay and every mirror, each waiting for OK true.
 *
 * created_at = original + 1, never "now": the copy sorts beside its original,
 * so it never poses as the newest anchor. Readers that look at "the newest
 * anchors" to find the tip (ONOSENDAI's discoverTip reads the newest 20, the
 * region gate's highestAnchored the newest 64) are not fooled by a backfill,
 * and the event id is the same on every run.
 *
 * The --many cap exists anyway, for whatever reader is not careful: a backfill
 * of a handful of retarget boundaries is the normal case, and a long list
 * should be a deliberate act.
 *
 * Exclusion: --publish holds the "backfill-header" abstract-socket lock for
 * NTH_HOME, so two publishing runs can never both sign.
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
const { acquireToolLock, rolePaths } = await import(`${DIST}/lib/runtime.js`);

const MAX_WITHOUT_FLAG = 5;

// ---- arguments ----

const FLAGS = new Set(['--publish', '--dry-run', '--many', '--from-missing']);
const args = process.argv.slice(2);
const PUBLISH = args.includes('--publish');
const MANY = args.includes('--many');
const FROM_MISSING = args.includes('--from-missing');
const USAGE = 'Usage: node scripts/backfill-header-tag.mjs [--publish] [--many] [--from-missing] [height ...]';

const heights = [];
for (const arg of args) {
  if (FLAGS.has(arg)) continue;
  if (arg.startsWith('--')) {
    console.error(`Unknown flag ${arg}\n${USAGE}`);
    process.exit(1);
  }
  for (const part of arg.split(',')) {
    if (!part.trim()) continue;
    if (!/^\d+$/.test(part.trim())) {
      console.error(`Not a block height: "${part}"`);
      process.exit(1);
    }
    heights.push(Number(part.trim()));
  }
}

// ---- environment ----

const HOME = process.env.NTH_HOME || '/data/projects/nth';
const ROLE = process.env.NTH_ROLE || 'tip';
const ARCHIVE = process.env.NTH_ARCHIVE || `${HOME}/archive/published.${ROLE}.ndjson`;
const BACKFILL_ARCHIVE = process.env.NTH_HEADER_BACKFILL_ARCHIVE || `${HOME}/archive/backfill-header.${ROLE}.ndjson`;
const MISSING = rolePaths(ROLE).headerMissing;
const RELAY = (process.env.NTH_RELAY || 'wss://cyberspace.nostr1.com').trim();
const MIRRORS = parseMirrorRelays(process.env.NTH_MIRROR_RELAYS, RELAY);
const bitcoin = createBitcoinApi(getBitcoinApiBaseUrlFromEnv());

if (FROM_MISSING) {
  if (!existsSync(MISSING)) {
    console.error(`--from-missing: no header-missing file at ${MISSING}`);
  } else {
    // Heights this script already signed a copy for are done: skip them here,
    // before the --many count, so the list does not grow with every run. To
    // resend such a copy (say a relay refused it), name the height explicitly.
    const done = new Set();
    if (existsSync(BACKFILL_ARCHIVE)) {
      const signed = createInterface({ input: createReadStream(BACKFILL_ARCHIVE, 'utf8'), crlfDelay: Infinity });
      for await (const line of signed) {
        try {
          const ev = JSON.parse(line);
          const b = ev.tags?.find((t) => t[0] === 'B')?.[1];
          if (b !== undefined && ev.tags.some((t) => t[0] === 'header')) done.add(Number.parseInt(b, 10));
        } catch {
          // a torn line counts as not done
        }
      }
    }
    const listed = new Set();
    const lines = createInterface({ input: createReadStream(MISSING, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const h = JSON.parse(line).height;
        if (Number.isSafeInteger(h) && h >= 0) listed.add(h);
      } catch {
        // a torn line is skipped; the anchor is still in the archive
      }
    }
    const skipped = [...listed].filter((h) => done.has(h));
    for (const h of listed) if (!done.has(h)) heights.push(h);
    if (skipped.length > 0) {
      console.log(
        `--from-missing: skipping ${skipped.length} height(s) already backfilled (${skipped.sort((x, y) => x - y).join(', ')}); ` +
          'name a height explicitly to resend its copy.',
      );
    }
  }
}

const wanted = [...new Set(heights)].sort((a, b) => a - b);
if (wanted.length === 0) {
  console.error(FROM_MISSING ? 'Nothing to do: no heights given and none listed as missing.' : USAGE);
  process.exit(FROM_MISSING ? 0 : 1);
}
if (wanted.length > MAX_WITHOUT_FLAG && !MANY) {
  console.error(
    `Refusing ${wanted.length} heights without --many (the limit is ${MAX_WITHOUT_FLAG}). ` +
      'Each one is a second anchor on every relay; a long list should be deliberate.',
  );
  process.exit(1);
}

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

// Before reading the backfill archive, so a second run cannot read it, sign,
// and append alongside this one.
if (PUBLISH) {
  try {
    await acquireToolLock('backfill-header');
  } catch (err) {
    console.error(`Another backfill-header run holds the lock for ${HOME}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

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

/** The header check against the original anchor's own H, M (or legacy C) and P. */
function headerProblem(header, original) {
  return headerMismatch(header, {
    blockHash: tagValue(original, 'H'),
    // Legacy anchors (DECK-0001 §2.2) have no M: their C is the merkle root.
    merkleRoot: tagValue(original, 'M') ?? tagValue(original, 'C'),
    prevBlockHash: tagValue(original, 'P'),
  });
}

/** Build (or reuse) the header-carrying copy for one height. Throws with a reason. */
async function prepare(height) {
  const original = archived.get(height);
  if (!original) throw new Error(`no anchor for height ${height} in ${ARCHIVE}`);
  if (original.kind !== 321) throw new Error(`archived event ${original.id} is kind ${original.kind}`);
  if (original.pubkey !== pubkey) throw new Error(`archived event ${original.id} was signed by ${original.pubkey}, not by the loaded key`);
  if (!intact(original)) throw new Error(`archived event ${original.id} does not verify`);
  if (hasTag(original, HEADER_TAG)) throw new Error(`archived event ${original.id} already carries a header tag; nothing to add`);

  const H = tagValue(original, 'H');
  if (!H || !/^[0-9a-f]{64}$/.test(H)) throw new Error(`archived event ${original.id} has no usable H tag`);

  // A copy this script already signed is checked locally and resent as is:
  // its header hashing to H is the whole proof, and no API is needed for it.
  const prior = alreadySigned.get(height);
  if (
    prior &&
    prior.pubkey === pubkey &&
    intact(prior) &&
    tagValue(prior, 'H') === H &&
    tagValue(prior, HEADER_TAG) !== null &&
    headerProblem(tagValue(prior, HEADER_TAG), original) === null
  ) {
    return { event: prior, original, header: tagValue(prior, HEADER_TAG), reused: true };
  }

  // The chain must still have this block at this height.
  const chainHash = await bitcoin.getBlockHashByHeight(height);
  if (!chainHash || chainHash.toLowerCase() !== H) {
    throw new Error(`the Bitcoin API has ${chainHash ?? 'no block'} at height ${height}, but the anchor names ${H}`);
  }

  const header = (await bitcoin.getBlockHeader(H, { heightHint: height })).toLowerCase();
  const problem = headerProblem(header, original);
  if (problem) throw new Error(`the Bitcoin API's header for ${H} does not match the anchor (${problem})`);

  const tags = [];
  for (const tag of original.tags) {
    tags.push([...tag]);
    if (tag[0] === 'B') tags.push([HEADER_TAG, header]);
  }
  const unsigned = {
    kind: original.kind,
    pubkey,
    created_at: original.created_at + 1,
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
      `${height}: copy of ${p.original.id}${p.reused ? ' (REUSING the copy already signed; no API call, not re-signing)' : ''}\n` +
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
  console.log('created_at is the original\'s + 1, so a --publish run produces these same ids (the signatures differ).');
  process.exit(failures > 0 ? 1 : 0);
}

// ---- publish ----

// Archive before sending, as the publisher does: the signed copy must survive a
// relay that drops it, and it is what lets a rerun skip the API.
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
