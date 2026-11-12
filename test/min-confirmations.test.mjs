// NTH_CONFIRMATIONS has a floor of 6: ONOSENDAI's Seeds clock reads NTH's
// newest anchor as the DECK-0008 section 4.1 clock height ("tip minus 6").
import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePrivateKey } from 'nostr-tools';

import { MIN_CONFIRMATIONS, resolveConfirmations } from '../dist/lib/confirmations.js';
import { freePort, makeHome, startEsplora, startRelay, startWorker, waitFor } from './helpers/fakes.mjs';

test('the floor is 6', () => {
  assert.equal(MIN_CONFIRMATIONS, 6);
});

test('unset, blank or non-numeric NTH_CONFIRMATIONS gives the default of 6', () => {
  for (const env of [{}, { NTH_CONFIRMATIONS: '' }, { NTH_CONFIRMATIONS: '  ' }, { NTH_CONFIRMATIONS: 'six' }]) {
    assert.deepEqual(resolveConfirmations(env), { confirmations: 6, warning: null }, JSON.stringify(env));
  }
});

test('6 or more is accepted as is, with no warning', () => {
  assert.deepEqual(resolveConfirmations({ NTH_CONFIRMATIONS: '6' }), { confirmations: 6, warning: null });
  assert.deepEqual(resolveConfirmations({ NTH_CONFIRMATIONS: '10' }), { confirmations: 10, warning: null });
});

test('below 6 throws, naming the Seeds clock and DECK-0008', () => {
  for (const v of ['5', '1', '0', '-3']) {
    assert.throws(
      () => resolveConfirmations({ NTH_CONFIRMATIONS: v }),
      (err) => {
        assert.match(err.message, /^Refusing to start: /);
        assert.match(err.message, new RegExp(`NTH_CONFIRMATIONS=${v} is below the minimum of 6`));
        assert.match(err.message, /Seeds clock/);
        assert.match(err.message, /DECK-0008 section 4\.1/);
        return true;
      },
      `NTH_CONFIRMATIONS=${v}`,
    );
  }
});

test('the override must be exactly "1"', () => {
  for (const v of ['', '0', 'true', 'yes', '2']) {
    assert.throws(
      () => resolveConfirmations({ NTH_CONFIRMATIONS: '3', NTH_ALLOW_SHALLOW_CONFIRMATIONS: v }),
      /Refusing to start/,
      `override=${JSON.stringify(v)}`,
    );
  }
});

test('with the override, a shallow depth is allowed but comes with a loud warning', () => {
  const r = resolveConfirmations({ NTH_CONFIRMATIONS: '2', NTH_ALLOW_SHALLOW_CONFIRMATIONS: '1' });
  assert.equal(r.confirmations, 2);
  assert.match(r.warning, /NTH_ALLOW_SHALLOW_CONFIRMATIONS=1 is set: publishing with only 2 confirmation/);
  assert.match(r.warning, /tests only/);
  // NTH needs block h+1 for the N tag, so even the override never goes below 1.
  assert.equal(resolveConfirmations({ NTH_CONFIRMATIONS: '0', NTH_ALLOW_SHALLOW_CONFIRMATIONS: '1' }).confirmations, 1);
});

test('the real worker refuses to start below 6 and exits 1 before doing anything', async () => {
  const home = makeHome();
  // Nothing listens here: the worker must exit before it ever tries a relay or the Bitcoin API.
  const port = await freePort();
  const w = startWorker({
    home,
    relay: `ws://127.0.0.1:${port}`,
    esplora: `http://127.0.0.1:${port}`,
    privateKey: generatePrivateKey(),
    env: { NTH_CONFIRMATIONS: '3', NTH_ALLOW_SHALLOW_CONFIRMATIONS: '' },
  });
  const exited = await w.exit;
  assert.equal(exited.code, 1);
  assert.match(w.out, /Refusing to start: NTH_CONFIRMATIONS=3 is below the minimum of 6/);
  assert.doesNotMatch(w.out, /Role: tip/, 'refused before startup proceeded');
});

test('the real worker starts normally at 6', async () => {
  const esplora = await startEsplora({ tip: 20 });
  const primary = await startRelay({ requireAuth: true });
  const home = makeHome();
  const w = startWorker({
    home,
    relay: primary.url,
    esplora: esplora.url,
    privateKey: generatePrivateKey(),
    env: { NTH_CONFIRMATIONS: '6', NTH_ALLOW_SHALLOW_CONFIRMATIONS: '', NTH_START_HEIGHT: '0' },
  });
  try {
    await waitFor(() => /Confirmation depth: 6/.test(w.out), { what: 'confirmation depth line' });
  } finally {
    await w.stop();
    await primary.close();
    await esplora.close();
  }
  assert.doesNotMatch(w.out, /Refusing to start/);
  assert.doesNotMatch(w.out, /NTH_ALLOW_SHALLOW_CONFIRMATIONS=1 is set/);
});
