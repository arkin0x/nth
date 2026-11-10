// The raw 80-byte header on every anchor, checked against H before signing.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { finishEvent, generatePrivateKey, getEventHash, verifySignature } from 'nostr-tools';

import {
  HANG,
  archive,
  blockHash,
  blockHeader,
  makeHome,
  readNdjson,
  startEsplora,
  startRelay,
  startWorker,
  stateNext,
  tagOf,
  waitFor,
  writeStateFile,
  sleep,
} from './helpers/fakes.mjs';

const { blockHashOfHeader, createHeaderFallback, headerFields, headerMismatch, HEADER_TAG } = await import('../dist/lib/blockHeader.js');
const { signAnchor } = await import('../dist/processBlock.js');

// Mainnet block 973,727, the last block of retarget window 482
// (482 * 2016 + 2015), fetched from mempool.space GET /api/block/<hash>/header.
const REAL = {
  height: 973727,
  hash: '0000000000000000000132b722697381ee70f3c565ed8c2168ef68d54e3b4f04',
  header:
    '00a04b20f3f9aa1aaa2bb91f5d8acd5112a3c428814c3e4087ff0100000000000000000042ab8f9c176bd1993227e826305521f4c23f96b9dfb66354b08bab9f8a004d309297e36a9300021765ed2b3c',
  prev: '00000000000000000001ff87403e4c8128c4a31251cd8a5d1fb92baa1aaaf9f3',
  merkle: '304d008a9fab8bb05463b6dfb9963fc2f421553026e8273299d16b179c8fab42',
  time: 1793300370,
  bits: 0x17020093,
  nonce: 1009511781,
  version: 541827072,
};

const GENESIS = {
  hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  header:
    '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c',
};

/** Flip one byte of a header hex string. */
const corrupt = (hex, byteIndex) => {
  const b = Buffer.from(hex, 'hex');
  b[byteIndex] ^= 0x01;
  return b.toString('hex');
};

test('a real mainnet header hashes to its block hash, byte-reversed', () => {
  assert.equal(HEADER_TAG, 'header');
  assert.equal(blockHashOfHeader(REAL.header), REAL.hash);
  assert.equal(blockHashOfHeader(GENESIS.header), GENESIS.hash);
});

test('header fields read back in display order', () => {
  assert.deepEqual(headerFields(REAL.header), {
    version: REAL.version,
    prevBlockHash: REAL.prev,
    merkleRoot: REAL.merkle,
    time: REAL.time,
    bits: REAL.bits,
    nonce: REAL.nonce,
  });
  assert.equal(headerFields(GENESIS.header).prevBlockHash, '0'.repeat(64));
  assert.equal(headerFields(GENESIS.header).time, 1231006505);
});

test('headerMismatch accepts the real header and names every way it can be wrong', () => {
  const expect = { blockHash: REAL.hash, merkleRoot: REAL.merkle, prevBlockHash: REAL.prev };
  assert.equal(headerMismatch(REAL.header, expect), null);
  assert.equal(headerMismatch(REAL.header, { ...expect, blockHash: REAL.hash.toUpperCase() }), null);
  assert.equal(headerMismatch(GENESIS.header, { blockHash: GENESIS.hash, merkleRoot: headerFields(GENESIS.header).merkleRoot, prevBlockHash: null }), null);

  // Any changed byte breaks the hash: the time (bytes 68..71) cannot be edited.
  assert.match(headerMismatch(corrupt(REAL.header, 68), expect), /hashes to [0-9a-f]{64}, not to the block hash/);
  assert.match(headerMismatch(corrupt(REAL.header, 79), expect), /hashes to/);
  // Another block's genuine header is still the wrong header.
  assert.match(headerMismatch(GENESIS.header, expect), /hashes to 000000000019d668/);
  // Shape.
  assert.match(headerMismatch(REAL.header.slice(2), expect), /not 160 lowercase hex characters \(got 158\)/);
  assert.match(headerMismatch(REAL.header.toUpperCase(), expect), /not 160 lowercase hex/);
  assert.match(headerMismatch(REAL.header + '00', expect), /got 162/);
  // A header that hashes right but disagrees with the anchor's M or P.
  assert.match(headerMismatch(REAL.header, { ...expect, merkleRoot: 'a'.repeat(64) }), /merkle root/);
  assert.match(headerMismatch(REAL.header, { ...expect, prevBlockHash: 'b'.repeat(64) }), /previous block hash/);
  assert.match(headerMismatch(REAL.header, { ...expect, prevBlockHash: null }), /previous block hash/);
});

/** An in-process BitcoinApi serving the real block 973,727. */
function realBlockApi({ header = REAL.header } = {}) {
  return {
    baseUrl: 'test://',
    getTipHeight: async () => REAL.height + 10,
    getBlockHashByHeight: async () => REAL.hash,
    getBlockByHash: async () => ({ hash: REAL.hash, height: REAL.height, merkleRoot: REAL.merkle, prevBlockHash: REAL.prev }),
    getBlockHeader: async () => header,
  };
}

test('signAnchor puts the verified header on the anchor', async () => {
  const event = await signAnchor({
    blockHeight: REAL.height,
    blockHash: REAL.hash,
    nextBlockHash: 'c'.repeat(64),
    bitcoin: realBlockApi(),
    privateKey: generatePrivateKey(),
  });
  assert.equal(event.tags.filter((t) => t[0] === 'header').length, 1, 'exactly one header tag');
  assert.equal(tagOf(event, 'header'), REAL.header);
  assert.equal(blockHashOfHeader(tagOf(event, 'header')), tagOf(event, 'H'));
  assert.equal(tagOf(event, 'M'), REAL.merkle);
  assert.equal(tagOf(event, 'P'), REAL.prev);
  assert.equal(getEventHash(event), event.id);
  assert.ok(verifySignature(event));
});

test('signAnchor lowercases an uppercase header from the API and still checks it', async () => {
  const event = await signAnchor({
    blockHeight: REAL.height,
    blockHash: REAL.hash,
    nextBlockHash: 'c'.repeat(64),
    bitcoin: realBlockApi({ header: REAL.header.toUpperCase() }),
    privateKey: generatePrivateKey(),
  });
  assert.equal(tagOf(event, 'header'), REAL.header);
});

test('signAnchor refuses to sign when the header does not hash to the block hash', async () => {
  for (const header of [corrupt(REAL.header, 70), GENESIS.header]) {
    await assert.rejects(
      signAnchor({
        blockHeight: REAL.height,
        blockHash: REAL.hash,
        nextBlockHash: 'c'.repeat(64),
        bitcoin: realBlockApi({ header }),
        privateKey: generatePrivateKey(),
      }),
      /Refusing to sign block 973727: the Bitcoin API's header does not match the block \(it hashes to/,
    );
  }
});

test('the fake chain is made of real linked headers', () => {
  for (let h = 0; h < 5; h++) {
    assert.equal(blockHashOfHeader(blockHeader(h)), blockHash(h));
    assert.equal(headerFields(blockHeader(h)).prevBlockHash, h === 0 ? '0'.repeat(64) : blockHash(h - 1));
  }
});

test('the worker publishes every anchor with a header that hashes to its H', async () => {
  const esplora = await startEsplora({ tip: 104 });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  writeStateFile(home, 100);

  const w = startWorker({ home, relay: relay.url, esplora: esplora.url, privateKey: generatePrivateKey() });
  try {
    await waitFor(() => stateNext(home) === 104, { what: 'state to reach 104' });
  } finally {
    await w.stop();
    await relay.close();
    await esplora.close();
  }

  const stored = [...relay.stored.values()];
  assert.equal(stored.length, 4);
  for (const ev of stored) {
    const h = Number(tagOf(ev, 'B'));
    assert.equal(tagOf(ev, 'header'), blockHeader(h));
    assert.equal(blockHashOfHeader(tagOf(ev, 'header')), tagOf(ev, 'H'));
  }
});

test('a lying header stops the worker at that height: nothing is signed or published for it', async () => {
  const esplora = await startEsplora({ tip: 104, header: (h, real) => (h === 101 ? corrupt(real, 68) : real) });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  writeStateFile(home, 100);

  // A fallback limit of one attempt proves a mismatch never falls back.
  const w = startWorker({
    home,
    relay: relay.url,
    esplora: esplora.url,
    privateKey: generatePrivateKey(),
    env: { NTH_HEADER_MAX_ATTEMPTS: '1', NTH_HEADER_MAX_WAIT_MS: '0' },
  });
  try {
    await waitFor(() => stateNext(home) === 101, { what: 'state to reach 101' });
    await waitFor(() => (w.out.match(/Refusing to sign block 101/g) || []).length >= 2, {
      what: 'two refusals for block 101',
    });
    await sleep(100);
    assert.equal(stateNext(home), 101, 'the state never moves past the bad block');
  } finally {
    await w.stop();
    await relay.close();
    await esplora.close();
  }

  const heights = [...relay.eventsReceived].map((ev) => tagOf(ev, 'B'));
  assert.deepEqual([...new Set(heights)], ['100'], 'only block 100 was ever sent');
  assert.equal(readNdjson(join(home, 'state', 'tip.header-missing.ndjson')).length, 0, 'a mismatch is never recorded as missing');
});

test('createHeaderFallback gives up after maxAttempts or maxWaitMs, whichever first, and resets per height', () => {
  let t = 0;
  const missing = [];
  const fb = createHeaderFallback({ maxAttempts: 3, maxWaitMs: 1000, now: () => t, onMissing: (m) => missing.push(m) });
  const err = new Error('HTTP 500');
  assert.equal(fb.giveUp(7, 'aa', err), false);
  assert.equal(fb.giveUp(7, 'aa', err), false);
  assert.equal(fb.giveUp(7, 'aa', err), true, 'third failure at one height');
  assert.deepEqual(missing, [{ height: 7, blockHash: 'aa', attempts: 3, reason: 'HTTP 500' }]);

  // A new height starts over; time alone also gives up.
  assert.equal(fb.giveUp(8, 'bb', err), false);
  t = 999;
  assert.equal(fb.giveUp(8, 'bb', err), false);
  // Moving on to 9 and back to 8 is a fresh start for 8.
  assert.equal(fb.giveUp(9, 'cc', err), false);
  t = 5000;
  assert.equal(fb.giveUp(9, 'cc', err), true, 'maxWaitMs since the first failure at 9');
  assert.equal(missing.length, 2);
  assert.equal(missing[1].height, 9);
});

const headerMissing = (home) => readNdjson(join(home, 'state', 'tip.header-missing.ndjson'));
const signingsOf = (home, h) => archive(home).filter((e) => tagOf(e, 'B') === String(h));

test('createHeaderFallback: after a mismatch at a height, it never gives up there again', () => {
  const missing = [];
  const fb = createHeaderFallback({ maxAttempts: 2, maxWaitMs: 0, onMissing: (m) => missing.push(m) });
  const err = new Error('HTTP 500');
  // maxWaitMs 0 would give up on the very first failure, were it not for the mismatch.
  fb.mismatched(7);
  for (let i = 0; i < 10; i++) assert.equal(fb.giveUp(7, 'aa', err), false, `failure ${i + 1} after the mismatch`);
  assert.deepEqual(missing, []);
  // Other heights are unaffected.
  assert.equal(fb.giveUp(8, 'bb', err), true);
  assert.equal(missing[0].height, 8);
  assert.equal(fb.giveUp(7, 'aa', err), false, 'still poisoned after moving on and back');
});

test('fail, mismatch, then fails: the block is never signed without the tag', async () => {
  let n = 0;
  const esplora = await startEsplora({
    tip: 104,
    header: (h, real) => {
      if (h !== 101) return real;
      n++;
      return n === 2 ? corrupt(real, 68) : { status: 500, body: 'oops' };
    },
  });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  writeStateFile(home, 100);
  const w = startWorker({
    home,
    relay: relay.url,
    esplora: esplora.url,
    privateKey: generatePrivateKey(),
    env: { NTH_HEADER_MAX_ATTEMPTS: '3' },
  });
  try {
    // 1 fail, 1 mismatch, then well past the 3-attempt limit in failures.
    await waitFor(() => (esplora.headerRequests.get(101) || 0) >= 8, { what: 'eight header requests for 101' });
    assert.equal(stateNext(home), 101, 'never moved past 101');
  } finally {
    await w.stop();
    await relay.close();
    await esplora.close();
  }
  assert.match(w.out, /Refusing to sign block 101/);
  assert.doesNotMatch(w.out, /Signing block 101 WITHOUT the header tag/);
  assert.deepEqual([...new Set(relay.eventsReceived.map((e) => tagOf(e, 'B')))], ['100'], 'nothing sent for 101');
  assert.equal(signingsOf(home, 101).length, 0, 'nothing signed for 101');
  assert.equal(headerMissing(home).length, 0);
});

/** Run the worker from 100 until the state reaches `until`, then stop everything. */
async function runWorker({ header, env = {}, until = 104, pendingEvent = null, privateKey = generatePrivateKey() }) {
  const esplora = await startEsplora({ tip: until, header });
  const relay = await startRelay({ requireAuth: true });
  const home = makeHome();
  writeStateFile(home, 100);
  if (pendingEvent) {
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(join(home, 'state', 'tip.pending.json'), JSON.stringify({ height: 100, archived: false, event: pendingEvent(privateKey) }));
  }
  const w = startWorker({ home, relay: relay.url, esplora: esplora.url, privateKey, env });
  try {
    await waitFor(() => stateNext(home) === until, { what: `state to reach ${until}` });
  } finally {
    await w.stop();
    await relay.close();
    await esplora.close();
  }
  const byHeight = (h) => [...relay.stored.values()].filter((e) => tagOf(e, 'B') === String(h));
  return { home, out: w.out, esplora, byHeight };
}

test('header fetch failures (500, 404, malformed) then recovery: signed once, with the header', async () => {
  const failures = [{ status: 500, body: 'oops' }, { status: 404, body: 'Block not found' }, 'not-a-header'];
  let n = 0;
  const r = await runWorker({
    header: (h, real) => (h === 101 && n < failures.length ? failures[n++] : real),
    env: { NTH_HEADER_MAX_ATTEMPTS: '10' },
  });
  assert.equal(r.esplora.headerRequests.get(101), 4, 'three failures, then the real header');
  assert.equal(signingsOf(r.home, 101).length, 1, 'block 101 signed exactly once');
  assert.equal(r.byHeight(101).length, 1);
  assert.equal(tagOf(r.byHeight(101)[0], 'header'), blockHeader(101));
  assert.equal(headerMissing(r.home).length, 0);
});

test('a header that cannot be fetched N times is signed without the tag and recorded as missing', async () => {
  const r = await runWorker({
    header: (h, real) => (h === 101 ? { status: 503, body: 'down' } : real),
    env: { NTH_HEADER_MAX_ATTEMPTS: '3' },
  });
  assert.equal(r.esplora.headerRequests.get(101), 3);
  assert.equal(signingsOf(r.home, 101).length, 1, 'signed once, after the third failure');
  const [ev] = r.byHeight(101);
  assert.equal(tagOf(ev, 'header'), undefined, 'no header tag');
  assert.equal(tagOf(ev, 'H'), blockHash(101));
  for (const h of [100, 102, 103]) assert.equal(tagOf(r.byHeight(h)[0], 'header'), blockHeader(h));
  const missing = headerMissing(r.home);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].height, 101);
  assert.equal(missing[0].blockHash, blockHash(101));
  assert.equal(missing[0].attempts, 3);
  assert.match(missing[0].reason, /HTTP 503/);
  assert.match(r.out, /Signing block 101 WITHOUT the header tag/);
});

test('the fallback also fires on time alone (NTH_HEADER_MAX_WAIT_MS)', async () => {
  const r = await runWorker({
    header: (h, real) => (h === 101 ? { status: 500, body: '' } : real),
    env: { NTH_HEADER_MAX_ATTEMPTS: '100000', NTH_HEADER_MAX_WAIT_MS: '150' },
  });
  assert.equal(tagOf(r.byHeight(101)[0], 'header'), undefined);
  assert.equal(signingsOf(r.home, 101).length, 1);
  assert.equal(headerMissing(r.home)[0].height, 101);
  assert.ok(headerMissing(r.home)[0].attempts >= 2);
});

test('a hung header request times out (NTH_BITCOIN_API_TIMEOUT_MS) into the retry loop and recovers', async () => {
  let hangs = 0;
  const r = await runWorker({
    header: (h, real) => (h === 101 && hangs < 2 ? (hangs++, HANG) : real),
    env: { NTH_BITCOIN_API_TIMEOUT_MS: '200', NTH_HEADER_MAX_ATTEMPTS: '10' },
  });
  assert.match(r.out, /timeout of 200ms exceeded/);
  assert.equal(r.esplora.headerRequests.get(101), 3);
  assert.equal(tagOf(r.byHeight(101)[0], 'header'), blockHeader(101));
  assert.equal(signingsOf(r.home, 101).length, 1);
});

test('upgrade path: a pending anchor signed before the deploy (no header) is reused as is', async () => {
  // What the old code left in state/tip.pending.json for height 100.
  const oldAnchor = (sk) => {
    const f = headerFields(blockHeader(100));
    return finishEvent(
      {
        kind: 321,
        created_at: Math.floor(Date.now() / 1000) - 60,
        content: 'Block 100',
        tags: [
          ['C', f.merkleRoot],
          ['M', f.merkleRoot],
          ['H', blockHash(100)],
          ['P', f.prevBlockHash],
          ['N', blockHash(101)],
          ['B', '100'],
          ['net', 'mainnet'],
        ],
      },
      sk,
    );
  };
  let pendingId = null;
  const r = await runWorker({
    until: 102,
    pendingEvent: (sk) => {
      const ev = oldAnchor(sk);
      pendingId = ev.id;
      return ev;
    },
  });
  assert.match(r.out, /Reusing the anchor already signed for block 100/);
  const [ev100] = r.byHeight(100);
  assert.equal(ev100.id, pendingId, 'the pre-deploy event, not a new signing');
  assert.equal(tagOf(ev100, 'header'), undefined);
  assert.equal(r.esplora.headerRequests.get(100) ?? 0, 0, 'no header fetched for a reused anchor');
  assert.equal(tagOf(r.byHeight(101)[0], 'header'), blockHeader(101), 'the next block has the header');
});
