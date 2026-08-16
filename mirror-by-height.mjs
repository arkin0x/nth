/**
 * Mirror every kind 321 hyperjump anchor by walking block heights.
 *
 * Time-based pagination (`--paginate` over `until`) loses events here: a fast
 * backfill publishes thousands of events per second, so many share a single
 * created_at and the `until` cursor either stalls or steps over them. A first
 * attempt recovered only 296,458 of ~962,000 heights.
 *
 * `B` is a single-letter tag and therefore indexed per NIP-01, so querying
 * explicit height batches is exact and complete regardless of publish order.
 */
import WebSocket from 'ws';
import { appendFileSync, writeFileSync, renameSync, existsSync, readFileSync } from 'fs';

if (!global.WebSocket) global.WebSocket = WebSocket;
const { SimplePool } = await import('nostr-tools');

const RELAY = process.env.NTH_RELAY || 'wss://cyberspace.nostr1.com';
const HOME = process.env.NTH_HOME || '/data/projects/nth';
const OUT = `${HOME}/archive/relay-mirror.ndjson`;
const TMP = `${OUT}.building`;
const PROGRESS = `${HOME}/state/mirror-progress.json`;

const CHUNK = Number(process.env.MIRROR_CHUNK || 400);
const MAX_HEIGHT = Number(process.env.MIRROR_MAX_HEIGHT || 962700);

const pool = new SimplePool();

// Resume support: this walk takes a while and should survive a restart.
let start = 0;
if (existsSync(PROGRESS) && existsSync(TMP)) {
  try {
    start = Number(JSON.parse(readFileSync(PROGRESS, 'utf8')).nextHeight) || 0;
  } catch {
    start = 0;
  }
}
if (start === 0) writeFileSync(TMP, '');

console.log(`Mirroring kind 321 from ${RELAY}`);
console.log(`heights ${start}..${MAX_HEIGHT} in chunks of ${CHUNK} -> ${OUT}`);

let total = start === 0 ? 0 : readFileSync(TMP, 'utf8').split('\n').filter(Boolean).length;
const seen = new Set();
let emptyChunks = 0;

for (let h = start; h <= MAX_HEIGHT; h += CHUNK) {
  const heights = [];
  for (let i = 0; i < CHUNK && h + i <= MAX_HEIGHT; i++) heights.push(String(h + i));

  let events = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      events = await pool.list([RELAY], [{ kinds: [321], '#B': heights }]);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }

  const lines = [];
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    lines.push(JSON.stringify(ev));
  }

  if (lines.length) {
    appendFileSync(TMP, lines.join('\n') + '\n');
    total += lines.length;
    emptyChunks = 0;
  } else {
    emptyChunks++;
  }

  writeFileSync(PROGRESS, JSON.stringify({ nextHeight: h + CHUNK, total }));

  if ((h / CHUNK) % 25 === 0 || lines.length === 0) {
    console.log(`  h=${h.toString().padStart(7)}  +${String(lines.length).padStart(5)}  total=${total}`);
  }

  // Past the frontier there is nothing left to find.
  if (emptyChunks >= 12) {
    console.log(`  ${emptyChunks} consecutive empty chunks at h=${h}; stopping.`);
    break;
  }

  await new Promise((r) => setTimeout(r, 60));
}

renameSync(TMP, OUT);
console.log(`\nDone: ${total} events -> ${OUT}`);
process.exit(0);
