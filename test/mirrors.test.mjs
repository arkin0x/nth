// Mirrors are best effort: the primary alone advances state, mirrors get the
// same event, and no mirror failure can stall the chain or cause a re-sign.
import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePrivateKey, getPublicKey } from 'nostr-tools';

import {
  archive,
  freePort,
  makeHome,
  misses,
  startEsplora,
  startRelay,
  startWorker,
  stateNext,
  tagOf,
  waitFor,
  writeStateFile,
} from './helpers/fakes.mjs';

const byHeight = (events) => new Map(events.map((e) => [tagOf(e, 'B'), e.id]));

test('a refusing mirror (NIP-42 authed) never stalls the chain; each refusal is logged and recorded', async () => {
  const esplora = await startEsplora({ tip: 103 });
  const primary = await startRelay({ requireAuth: true });
  const mirror = await startRelay({ requireAuth: true, policy: () => [false, 'blocked: kind 321 is not allowed'] });
  const home = makeHome();
  writeStateFile(home, 100);
  const privateKey = generatePrivateKey();

  const w = startWorker({ home, relay: primary.url, mirrors: [mirror.url], esplora: esplora.url, privateKey });
  try {
    await waitFor(() => stateNext(home) === 103, { what: 'primary to reach 103' });
    await waitFor(() => misses(home).length === 3, { what: 'three recorded misses' });
  } finally {
    await w.stop();
    await primary.close();
    await mirror.close();
    await esplora.close();
  }

  assert.ok(mirror.authsAccepted.includes(getPublicKey(privateKey)), 'mirror completed NIP-42');
  for (const h of [100, 101, 102]) {
    assert.match(
      w.out,
      new RegExp(`Mirror ${mirror.url}: block ${h} REFUSED \\(event [0-9a-f]{64}\\): blocked: kind 321 is not allowed`),
    );
  }
  const primaryIds = byHeight([...primary.stored.values()]);
  const mirrorIds = mirror.eventsReceived.filter((e) => e.kind === 321);
  assert.equal(mirrorIds.length, 3, 'refusals are not retried');
  for (const e of mirrorIds) assert.equal(e.id, primaryIds.get(tagOf(e, 'B')), 'mirror got the primary-accepted event');
  assert.equal(archive(home).length, 3, 'no re-sign');
  assert.deepEqual(
    misses(home).map((m) => [m.relay, m.height, m.reason]),
    [100, 101, 102].map((h) => [mirror.url, h, 'blocked: kind 321 is not allowed']),
  );
  assert.equal(primary.eventsReceived.length, 3, 'primary saw each event once');
});

test('a down mirror is retried in the background and catches up; one that stays down is recorded at exit', async () => {
  const esplora = await startEsplora({ tip: 103 });
  const primary = await startRelay({ requireAuth: true });
  const latePort = await freePort();
  const deadPort = await freePort();
  const late = `ws://127.0.0.1:${latePort}`;
  const dead = `ws://127.0.0.1:${deadPort}`;
  const home = makeHome();
  writeStateFile(home, 100);

  const w = startWorker({
    home,
    relay: primary.url,
    mirrors: [late, dead],
    esplora: esplora.url,
    privateKey: generatePrivateKey(),
  });
  let lateRelay;
  try {
    await waitFor(() => stateNext(home) === 103, { what: 'primary to reach 103 with both mirrors down' });
    assert.match(w.out, new RegExp(`Mirror ${late}: cannot connect or authenticate`));
    assert.equal(misses(home).length, 0, 'a down mirror holds its heights, it does not drop them');

    lateRelay = await startRelay({ requireAuth: true, port: latePort });
    await waitFor(() => lateRelay.stored.size === 3, { what: 'late mirror to catch up' });
  } finally {
    await w.stop();
    await primary.close();
    await lateRelay?.close();
    await esplora.close();
  }

  const primaryIds = byHeight([...primary.stored.values()]);
  for (const e of lateRelay.stored.values()) assert.equal(e.id, primaryIds.get(tagOf(e, 'B')));
  for (const h of [100, 101, 102]) assert.match(w.out, new RegExp(`Mirror ${late}: block ${h} accepted`));
  assert.match(w.out, new RegExp(`Mirror ${late}: connected, NIP-42: authenticated`));
  assert.equal(archive(home).length, 3, 'no re-sign');

  const recorded = misses(home);
  assert.deepEqual(
    recorded.map((m) => [m.relay, m.height]),
    [100, 101, 102].map((h) => [dead, h]),
    'heights still queued for the dead mirror are recorded when the worker exits',
  );
  assert.ok(recorded.every((m) => m.reason === 'process exited before the mirror took it'));
});

test('a mirror that never answers OK and one that says duplicate: neither slows the primary', async () => {
  const esplora = await startEsplora({ tip: 103 });
  const primary = await startRelay({ requireAuth: true });
  const silent = await startRelay({ policy: () => 'silence' });
  const dup = await startRelay({ policy: () => [true, 'duplicate: already have it'] });
  const home = makeHome();
  writeStateFile(home, 100);

  const started = Date.now();
  const w = startWorker({
    home,
    relay: primary.url,
    mirrors: [silent.url, dup.url],
    esplora: esplora.url,
    privateKey: generatePrivateKey(),
    env: { NTH_MIRROR_OK_TIMEOUT_MS: '300', NTH_MIRROR_MAX_ATTEMPTS: '2' },
  });
  let primaryDoneMs;
  try {
    await waitFor(() => stateNext(home) === 103, { what: 'primary to reach 103' });
    primaryDoneMs = Date.now() - started;
    await waitFor(() => misses(home).filter((m) => m.relay === silent.url).length === 3, {
      what: 'silent mirror heights given up',
      timeoutMs: 20_000,
    });
  } finally {
    await w.stop();
    await primary.close();
    await silent.close();
    await dup.close();
    await esplora.close();
  }

  // 3 heights x 2 attempts x 300 ms OK timeout is 1.8 s on the silent mirror alone.
  assert.ok(primaryDoneMs < 1800 + 2000, `primary was not held up by the silent mirror (${primaryDoneMs} ms)`);
  for (const h of [100, 101, 102]) {
    assert.match(
      w.out,
      new RegExp(`Mirror ${dup.url}: block ${h} duplicate \\(event [0-9a-f]{64}\\): duplicate: already have it`),
    );
  }
  assert.ok(
    misses(home)
      .filter((m) => m.relay === silent.url)
      .every((m) => /^no OK \(timed out/.test(m.reason)),
  );
  assert.equal(misses(home).filter((m) => m.relay === dup.url).length, 0, 'a duplicate counts as taken');
  assert.equal(archive(home).length, 3);
});

test('a malformed mirror URL is dropped at boot with a clear error; the primary runs normally', async () => {
  const esplora = await startEsplora({ tip: 101 });
  const primary = await startRelay({ requireAuth: true });
  const good = await startRelay({ policy: () => [false, 'duplicate: have it already'] });
  const home = makeHome();
  writeStateFile(home, 100);

  const w = startWorker({
    home,
    relay: primary.url,
    mirrors: ['onosendai.feeds.relay.tools', 'wss://', 'ws://127.0.0.1:1/#frag', good.url],
    esplora: esplora.url,
    privateKey: generatePrivateKey(),
  });
  try {
    await waitFor(() => stateNext(home) === 101, { what: 'primary to reach 101' });
    await waitFor(() => /block 100 duplicate/.test(w.out), { what: 'false-duplicate counted as taken' });
  } finally {
    await w.stop();
    await primary.close();
    await good.close();
    await esplora.close();
  }

  assert.match(
    w.out,
    /NTH_MIRROR_RELAYS entry "onosendai\.feeds\.relay\.tools" is not a ws:\/\/ or wss:\/\/ relay URL/,
  );
  assert.match(w.out, /NTH_MIRROR_RELAYS entry "wss:\/\/" is not a ws:\/\/ or wss:\/\/ relay URL/);
  assert.match(w.out, new RegExp(`Mirror relays: ${good.url} \\(best effort\\)`));
  assert.match(w.out, /NTH_MIRROR_RELAYS entry "ws:\/\/127\.0\.0\.1:1\/#frag" is not a ws:\/\/ or wss:\/\/ relay URL/);
  assert.equal(misses(home).length, 0, 'OK false "duplicate:" is not a miss');
});

test('RelayClient reports a URL the ws library rejects synchronously as that error', async () => {
  const { RelayClient } = await import('../dist/lib/relayClient.js');
  const client = new RelayClient('ws://127.0.0.1:1/#frag', generatePrivateKey(), {
    connectTimeoutMs: 500,
    okTimeoutMs: 500,
    authWaitMs: 100,
  });
  await assert.rejects(client.connect(), (error) => {
    assert.doesNotMatch(error.message, /before initialization/);
    assert.match(error.message, /cannot open ws:\/\/127\.0\.0\.1:1\/#frag: .*fragment/i);
    return true;
  });
  client.close();
});
