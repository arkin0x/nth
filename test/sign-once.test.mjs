// Sign once per height: retries and restarts publish the SAME signed event.
import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePrivateKey } from 'nostr-tools';

import {
  archive,
  makeHome,
  pending,
  startEsplora,
  startRelay,
  startWorker,
  stateNext,
  tagOf,
  waitFor,
  writeStateFile,
} from './helpers/fakes.mjs';

const idsForHeight = (events, h) => events.filter((e) => tagOf(e, 'B') === String(h)).map((e) => e.id);

test('a primary refusal is retried with the same event id, and the archive gets it once', async () => {
  const esplora = await startEsplora({ tip: 103 });
  let refusals = 0;
  const primary = await startRelay({
    requireAuth: true,
    policy: (ev) => {
      if (tagOf(ev, 'B') === '100' && refusals < 3) {
        refusals++;
        return [false, 'error: temporarily unavailable'];
      }
      return null;
    },
  });
  const home = makeHome();
  writeStateFile(home, 100);

  const w = startWorker({ home, relay: primary.url, esplora: esplora.url, privateKey: generatePrivateKey() });
  try {
    await waitFor(() => stateNext(home) === 103, { what: 'state to reach 103' });
  } finally {
    await w.stop();
    await primary.close();
    await esplora.close();
  }

  const sent100 = idsForHeight(primary.eventsReceived, 100);
  assert.equal(sent100.length, 4, 'three refusals then one accept');
  assert.equal(new Set(sent100).size, 1, 'every attempt for height 100 carried the same event id');

  for (const h of [100, 101, 102]) {
    assert.equal(new Set(idsForHeight(primary.eventsReceived, h)).size, 1, `one id ever sent for height ${h}`);
    assert.equal(idsForHeight(archive(home), h).length, 1, `height ${h} archived exactly once`);
  }
  assert.equal(archive(home).length, 3);
  assert.equal(idsForHeight([...primary.stored.values()], 100)[0], sent100[0]);
  assert.equal((w.out.match(/Reusing the anchor already signed for block 100/g) || []).length, 3);
  assert.equal(pending(home), null, 'pending anchor cleared once the height is past');
});

test('a restart in the middle of a retry reuses the persisted signed event', async () => {
  const esplora = await startEsplora({ tip: 103 });
  let refuse = true;
  const primary = await startRelay({
    requireAuth: true,
    policy: (ev) => (refuse && tagOf(ev, 'B') === '100' ? [false, 'error: relay is sulking'] : null),
  });
  const home = makeHome();
  writeStateFile(home, 100);
  const privateKey = generatePrivateKey();
  let first;
  let second;
  let signedId;
  try {
    first = startWorker({ home, relay: primary.url, esplora: esplora.url, privateKey });
    try {
      await waitFor(() => idsForHeight(primary.eventsReceived, 100).length >= 2, { what: 'two refused attempts' });
    } finally {
      await first.stop();
    }

    const p = pending(home);
    assert.ok(p, 'pending anchor survives the restart');
    assert.equal(p.height, 100);
    assert.equal(p.archived, true);
    signedId = p.event.id;
    assert.deepEqual([...new Set(idsForHeight(primary.eventsReceived, 100))], [signedId]);
    assert.equal(stateNext(home), 100, 'state did not advance on refusals');

    refuse = false;
    second = startWorker({ home, relay: primary.url, esplora: esplora.url, privateKey });
    await waitFor(() => stateNext(home) === 103, { what: 'state to reach 103 after restart' });
  } finally {
    await first?.stop();
    await second?.stop();
    await primary.close();
    await esplora.close();
  }

  assert.match(second.out, /Reusing the anchor already signed for block 100/);
  assert.deepEqual(
    [...new Set(idsForHeight(primary.eventsReceived, 100))],
    [signedId],
    'no new signature after restart',
  );
  assert.equal(idsForHeight([...primary.stored.values()], 100)[0], signedId);
  assert.equal(idsForHeight(archive(home), 100).length, 1, 'archive line not duplicated by the restart');
});

test('a pending anchor that no longer matches the chain is discarded and re-signed', async () => {
  const esplora = await startEsplora({ tip: 102 });
  const primary = await startRelay({ requireAuth: true });
  const home = makeHome();
  writeStateFile(home, 100);
  const privateKey = generatePrivateKey();

  // Sign height 100 once with a refusing relay, so a pending anchor exists.
  const refusing = await startRelay({ requireAuth: true, policy: () => [false, 'error: no'] });
  const first = startWorker({ home, relay: refusing.url, esplora: esplora.url, privateKey });
  try {
    await waitFor(() => pending(home)?.height === 100, { what: 'pending anchor' });
  } finally {
    await first.stop();
    await refusing.close();
  }
  const stale = pending(home);

  // Tamper with it: a pending event whose signature no longer verifies must not be published.
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const tampered = { ...stale, event: { ...stale.event, content: 'Block 999' } };
  writeFileSync(join(home, 'state', 'tip.pending.json'), JSON.stringify(tampered));

  const second = startWorker({ home, relay: primary.url, esplora: esplora.url, privateKey });
  try {
    await waitFor(() => stateNext(home) === 101, { what: 'height 100 published' });
  } finally {
    await second.stop();
    await primary.close();
    await esplora.close();
  }
  assert.match(second.out, /Discarding the pending anchor for block 100 .*does not verify/);
  const published = [...primary.stored.values()].filter((e) => tagOf(e, 'B') === '100');
  assert.equal(published.length, 1);
  // The relay verifies signatures, so what it stored is a valid, freshly signed anchor, not the tampered one.
  assert.equal(published[0].content, 'Block 100');
  assert.equal(primary.eventsReceived.filter((e) => e.content === 'Block 999').length, 0, 'tampered event never sent');
});

test('the primary stored the event but its OK was lost: the retry resends the same id and advances', async () => {
  const esplora = await startEsplora({ tip: 102 });
  let lost = 0;
  const primary = await startRelay({
    requireAuth: true,
    policy: (ev) => (tagOf(ev, 'B') === '100' && lost++ === 0 ? 'store-silently' : null),
  });
  const home = makeHome();
  writeStateFile(home, 100);
  // Set through .env in the worker's cwd (the temp home), as production does.
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(home, '.env'), 'NTH_OK_TIMEOUT_MS=500\n');

  const w = startWorker({
    home,
    relay: primary.url,
    esplora: esplora.url,
    privateKey: generatePrivateKey(),
  });
  try {
    await waitFor(() => stateNext(home) === 102, { what: 'state to reach 102' });
  } finally {
    await w.stop();
    await primary.close();
    await esplora.close();
  }

  const sent = idsForHeight(primary.eventsReceived, 100);
  assert.equal(sent.length, 2, 'one lost OK, one resend');
  assert.equal(new Set(sent).size, 1, 'the resend carried the same id');
  assert.equal(idsForHeight([...primary.stored.values()], 100).length, 1, 'one anchor for height 100 on the primary');
  assert.match(w.out, /timed out after 500ms waiting for OK/);
  assert.equal(idsForHeight(archive(home), 100).length, 1);
});
