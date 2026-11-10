// scripts/backfill-header-tag.mjs: one extra anchor per height, with the header, signed once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finishEvent, generatePrivateKey, getPublicKey } from 'nostr-tools';

import { blockHash, blockHeader, makeHome, readNdjson, startEsplora, startRelay, tagOf } from './helpers/fakes.mjs';

const { headerFields } = await import('../dist/lib/blockHeader.js');

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/backfill-header-tag.mjs');

/** An archived anchor for fake height h in today's format, without a header tag. */
function archivedAnchor(h, privateKey, extraTags = [], { legacy = false } = {}) {
  const f = headerFields(blockHeader(h));
  return finishEvent(
    {
      kind: 321,
      created_at: 1700000000 + h,
      content: `Block ${h}`,
      tags: [
        ['C', f.merkleRoot],
        // A legacy anchor (DECK-0001 §2.2) has no M: its C is the merkle root.
        ...(legacy ? [] : [['M', f.merkleRoot]]),
        ['X', '1'],
        ['Y', '2'],
        ['Z', '3'],
        ['S', '1-2-3'],
        ['H', blockHash(h)],
        ['P', f.prevBlockHash],
        ['N', blockHash(h + 1)],
        ['B', String(h)],
        ['net', 'mainnet'],
        ...extraTags,
      ],
    },
    privateKey,
  );
}

function writeArchive(home, events) {
  mkdirSync(join(home, 'archive'), { recursive: true });
  writeFileSync(join(home, 'archive', 'published.tip.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const backfillArchive = (home) => join(home, 'archive', 'backfill-header.tip.ndjson');

function run(args, { home, relay, mirrors = '', esplora, privateKey }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        NTH_HOME: home,
        NTH_RELAY: relay,
        NTH_MIRROR_RELAYS: mirrors,
        NTH_BITCOIN_API_BASE_URL: esplora,
        NTH_BITCOIN_API_ERROR_LOG: join(home, 'bitcoin_api_errors.jsonl'),
        NTH_PRIVATE_KEY: privateKey,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolveRun({ code, out }));
  });
}

/** The pretty-printed events in the script's output. */
function printedEvents(out) {
  return [...out.matchAll(/^\{\n[\s\S]*?^\}$/gm)].map((m) => JSON.parse(m[0]));
}

test('dry run prints the copy with the header and writes and sends nothing', async () => {
  const esplora = await startEsplora({ tip: 20 });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  const sk = generatePrivateKey();
  const original = archivedAnchor(15, sk);
  writeArchive(home, [archivedAnchor(14, sk), original]);

  try {
    const { code, out } = await run(['15'], { home, relay: relay.url, esplora: esplora.url, privateKey: sk });
    assert.equal(code, 0, out);
    assert.match(out, /dry run/);
    const [ev] = printedEvents(out);
    assert.equal(tagOf(ev, 'header'), blockHeader(15));
    assert.deepEqual(
      ev.tags.filter((t) => t[0] !== 'header'),
      original.tags,
      'every original tag, in order, and nothing else but the header',
    );
    assert.equal(ev.tags.findIndex((t) => t[0] === 'header'), ev.tags.findIndex((t) => t[0] === 'B') + 1);
    assert.equal(ev.content, original.content);
    assert.equal(ev.created_at, original.created_at + 1, 'sorts beside its original, never as the newest anchor');
    assert.equal(ev.pubkey, getPublicKey(sk));
    assert.notEqual(ev.id, original.id);
    assert.equal(relay.eventsReceived.length, 0, 'nothing sent');
    assert.equal(existsSync(backfillArchive(home)), false, 'nothing written');
  } finally {
    await relay.close();
    await esplora.close();
  }
});

test('--publish sends one copy to the primary and the mirror; a rerun resends the same id', async () => {
  const esplora = await startEsplora({ tip: 20 });
  const primary = await startRelay({ requireAuth: true });
  const mirror = await startRelay({ requireAuth: true });
  const home = makeHome();
  const sk = generatePrivateKey();
  writeArchive(home, [archivedAnchor(12, sk), archivedAnchor(15, sk)]);
  const opts = { home, relay: primary.url, mirrors: mirror.url, esplora: esplora.url, privateKey: sk };

  try {
    const first = await run(['--publish', '12,15'], opts);
    assert.equal(first.code, 0, first.out);
    const second = await run(['--publish', '15', '12'], opts);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /REUSING the copy already signed/);

    for (const relay of [primary, mirror]) {
      const stored = [...relay.stored.values()];
      assert.equal(stored.length, 2, 'one extra anchor per height, never two');
      for (const ev of stored) assert.equal(tagOf(ev, 'header'), blockHeader(Number(tagOf(ev, 'B'))));
    }
    assert.equal(readNdjson(backfillArchive(home)).length, 2, 'signed and archived once per height');
  } finally {
    await primary.close();
    await mirror.close();
    await esplora.close();
  }
});

test('a legacy anchor without M gets its header checked against C', async () => {
  const esplora = await startEsplora({ tip: 20 });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  const sk = generatePrivateKey();
  writeArchive(home, [archivedAnchor(9, sk, [], { legacy: true })]);
  try {
    const { code, out } = await run(['--publish', '9'], { home, relay: relay.url, esplora: esplora.url, privateKey: sk });
    assert.equal(code, 0, out);
    const [ev] = [...relay.stored.values()];
    assert.equal(tagOf(ev, 'M'), undefined, 'still legacy: nothing added but the header');
    assert.equal(tagOf(ev, 'header'), blockHeader(9));
  } finally {
    await relay.close();
    await esplora.close();
  }
});

test('a relay refusal, then a rerun during an API outage resends the same id without calling the API', async () => {
  const esplora = await startEsplora({ tip: 20 });
  let refuse = true;
  const relay = await startRelay({ requireAuth: true, policy: () => (refuse ? [false, 'error: try later'] : null) });
  const home = makeHome();
  const sk = generatePrivateKey();
  writeArchive(home, [archivedAnchor(15, sk)]);

  try {
    const first = await run(['--publish', '15'], { home, relay: relay.url, esplora: esplora.url, privateKey: sk });
    assert.equal(first.code, 1, first.out);
    assert.match(first.out, /REFUSED/);
    const sentFirst = relay.eventsReceived.map((e) => e.id);
    assert.equal(sentFirst.length, 1);

    await esplora.close(); // the Bitcoin API is now down
    refuse = false;
    const second = await run(['--publish', '15'], { home, relay: relay.url, esplora: esplora.url, privateKey: sk });
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /REUSING the copy already signed; no API call/);
    assert.equal(relay.eventsReceived.length, 2);
    assert.equal(relay.eventsReceived[1].id, sentFirst[0], 'the rerun resent the same id');
    assert.equal(relay.stored.size, 1);
    assert.equal(readNdjson(backfillArchive(home)).length, 1, 'signed once');
  } finally {
    await relay.close();
  }
});

test('more than 5 heights need --many', async () => {
  const esplora = await startEsplora({ tip: 20 });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  const sk = generatePrivateKey();
  writeArchive(home, [1, 2, 3, 4, 5, 6].map((h) => archivedAnchor(h, sk)));
  try {
    const refused = await run(['1,2,3,4,5,6'], { home, relay: relay.url, esplora: esplora.url, privateKey: sk });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /Refusing 6 heights without --many/);
    const allowed = await run(['--many', '1,2,3,4,5,6'], { home, relay: relay.url, esplora: esplora.url, privateKey: sk });
    assert.equal(allowed.code, 0, allowed.out);
    assert.equal(printedEvents(allowed.out).length, 6);
  } finally {
    await relay.close();
    await esplora.close();
  }
});

test('--from-missing takes the heights the publisher signed without a header', async () => {
  const esplora = await startEsplora({ tip: 20 });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  const sk = generatePrivateKey();
  writeArchive(home, [archivedAnchor(11, sk), archivedAnchor(13, sk)]);
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(
    join(home, 'state', 'tip.header-missing.ndjson'),
    [11, 13, 11].map((height) => JSON.stringify({ at: 1, height, blockHash: blockHash(height), attempts: 5, reason: 'HTTP 503' })).join('\n') + '\n',
  );
  try {
    const { code, out } = await run(['--from-missing'], { home, relay: relay.url, esplora: esplora.url, privateKey: sk });
    assert.equal(code, 0, out);
    assert.match(out, /Heights: {2}11, 13/);
    assert.deepEqual(printedEvents(out).map((e) => tagOf(e, 'B')), ['11', '13']);
  } finally {
    await relay.close();
    await esplora.close();
  }
});

test('--from-missing skips heights already backfilled, so they do not count toward --many', async () => {
  const esplora = await startEsplora({ tip: 20 });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  const sk = generatePrivateKey();
  const all = [1, 2, 3, 4, 5, 6, 7];
  writeArchive(home, all.map((h) => archivedAnchor(h, sk)));
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(
    join(home, 'state', 'tip.header-missing.ndjson'),
    all.map((height) => JSON.stringify({ at: 1, height, blockHash: blockHash(height), attempts: 5, reason: 'x' })).join('\n') + '\n',
  );
  const opts = { home, relay: relay.url, esplora: esplora.url, privateKey: sk };
  try {
    const first = await run(['--publish', '1,2'], opts);
    assert.equal(first.code, 0, first.out);
    const { code, out } = await run(['--from-missing'], opts);
    assert.equal(code, 0, out);
    assert.match(out, /skipping 2 height\(s\) already backfilled \(1, 2\)/);
    assert.deepEqual(printedEvents(out).map((e) => tagOf(e, 'B')), ['3', '4', '5', '6', '7'], 'five left: no --many needed');
  } finally {
    await relay.close();
    await esplora.close();
  }
});

test('--publish refuses to run while another run holds the backfill-header lock', async () => {
  const esplora = await startEsplora({ tip: 20 });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  const sk = generatePrivateKey();
  writeArchive(home, [archivedAnchor(15, sk)]);
  const RUNTIME = resolve(dirname(SCRIPT), '../dist/lib/runtime.js');
  const holder = spawn(
    process.execPath,
    ['--input-type=module', '-e', `const { acquireToolLock } = await import(${JSON.stringify(RUNTIME)}); await acquireToolLock('backfill-header'); console.log('held'); setInterval(() => {}, 1000);`],
    { env: { PATH: process.env.PATH, NTH_HOME: home } },
  );
  try {
    await new Promise((r, j) => {
      holder.stdout.on('data', (d) => String(d).includes('held') && r());
      holder.on('exit', (c) => j(new Error(`lock holder exited ${c}`)));
    });
    const { code, out } = await run(['--publish', '15'], { home, relay: relay.url, esplora: esplora.url, privateKey: sk });
    assert.equal(code, 1);
    assert.match(out, /Another backfill-header run holds the lock/);
    assert.equal(relay.eventsReceived.length, 0);
    assert.equal(existsSync(backfillArchive(home)), false);
  } finally {
    holder.kill();
    await relay.close();
    await esplora.close();
  }
});

test('refuses heights it cannot prove, and exits 1', async () => {
  const esplora = await startEsplora({
    tip: 20,
    header: (h, real) => (h === 16 ? blockHeader(3) : real), // a real header, of another block
  });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  const sk = generatePrivateKey();
  const stranger = generatePrivateKey();
  writeArchive(home, [
    archivedAnchor(10, sk, [['header', blockHeader(10)]]),
    archivedAnchor(11, stranger),
    archivedAnchor(16, sk),
  ]);

  try {
    const { code, out } = await run(['--publish', '10', '11', '16', '17', '25'], {
      home,
      relay: relay.url,
      esplora: esplora.url,
      privateKey: sk,
    });
    assert.equal(code, 1);
    assert.match(out, /10: SKIPPED: .*already carries a header tag/);
    assert.match(out, /11: SKIPPED: .*not by the loaded key/);
    assert.match(out, /16: SKIPPED: .*header .* does not match the anchor \(it hashes to/);
    assert.match(out, /17: SKIPPED: no anchor for height 17/);
    assert.match(out, /25: SKIPPED: no anchor for height 25/);
    assert.equal(relay.eventsReceived.length, 0);
  } finally {
    await relay.close();
    await esplora.close();
  }
});
