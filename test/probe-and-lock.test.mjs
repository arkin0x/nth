// The frontier probe asks only the primary; the instance lock is atomic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { finishEvent, generatePrivateKey } from 'nostr-tools';

import { makeHome, sleep, startEsplora, startRelay, startWorker, waitFor } from './helpers/fakes.mjs';

const anchor = (h, sk) =>
  finishEvent({ kind: 321, created_at: 1_700_000_000 + h, tags: [['B', String(h)]], content: `Block ${h}` }, sk);

test('with no state file the frontier comes from the primary only, never from a mirror', async () => {
  const sk = generatePrivateKey();
  const esplora = await startEsplora({ tip: 9 });
  const primary = await startRelay({ requireAuth: true });
  const mirror = await startRelay();
  primary.seed([0, 1, 2, 3, 4, 5].map((h) => anchor(h, sk)));
  // A mirror that is AHEAD of the primary must not move the start either.
  mirror.seed(Array.from({ length: 51 }, (_, h) => anchor(h, sk)));

  const home = makeHome();
  const w = startWorker({ home, relay: primary.url, mirrors: [mirror.url], esplora: esplora.url, privateKey: sk });
  try {
    await waitFor(() => /Start height \d+/.test(w.out), { what: 'start height line' });
  } finally {
    await w.stop();
    await primary.close();
    await mirror.close();
    await esplora.close();
  }

  assert.match(w.out, /No local state; probing the primary relay ws:\/\/127\.0\.0\.1:\d+ for the published frontier/);
  assert.match(w.out, /Start height 6 \(relay frontier 5\)/);
  assert.ok(primary.reqs.length > 0, 'primary was probed');
  assert.equal(mirror.reqs.length, 0, 'mirror was never queried');
});

test('two workers started at the same instant: exactly one runs (repeated)', async () => {
  const esplora = await startEsplora({ tip: 5 });
  const primary = await startRelay({ requireAuth: true });
  try {
    for (let round = 0; round < 6; round++) {
      const home = makeHome();
      mkdirSync(join(home, 'state'), { recursive: true });
      writeFileSync(join(home, 'state', 'tip.json'), JSON.stringify({ nextHeight: 5, updatedAt: 0 }));
      const sk = generatePrivateKey();
      const workers = [0, 1, 2].map(() =>
        startWorker({ home, relay: primary.url, esplora: esplora.url, privateKey: sk }),
      );
      try {
        await waitFor(() => workers.filter((w) => w.exited).length >= 2, { what: `round ${round}: losers to exit` });
        await sleep(400);
        const running = workers.filter((w) => !w.exited);
        const losers = workers.filter((w) => w.exited);
        assert.equal(running.length, 1, `round ${round}: one survivor`);
        for (const l of losers) {
          assert.equal(l.exited.code, 1);
          assert.match(l.out, /already running/);
        }
        assert.match(running[0].out, /Start height 5/);
      } finally {
        for (const w of workers) await w.stop();
      }
    }
  } finally {
    await primary.close();
    await esplora.close();
  }
});

test('a rival started inside the lock window is refused (deterministic race)', async () => {
  const esplora = await startEsplora({ tip: 5 });
  const primary = await startRelay({ requireAuth: true });
  const home = makeHome();
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'tip.json'), JSON.stringify({ nextHeight: 5, updatedAt: 0 }));
  const sk = generatePrivateKey();
  const env = { NTH_TEST_LOCK_HOLD_MS: '2000' };
  const a = startWorker({ home, relay: primary.url, esplora: esplora.url, privateKey: sk, env });
  let b;
  try {
    await waitFor(() => /Instance lock taken; holding/.test(a.out), { what: 'first worker inside its lock window' });
    // The pidfile is not written yet: a check-then-write lock would let b through here.
    b = startWorker({ home, relay: primary.url, esplora: esplora.url, privateKey: sk, env });
    // Bounded: with a check-then-write lock the rival would run, not exit.
    await waitFor(() => b.exited, { what: 'the rival worker to be refused', timeoutMs: 8_000 });
    assert.equal(b.exited.code, 1);
    assert.match(b.out, /already running \(instance lock/);
    assert.equal(a.exited, null, 'the first worker is still running');
    await waitFor(() => /Start height 5/.test(a.out), { what: 'first worker to start' });
  } finally {
    await a.stop();
    await b?.stop();
    await primary.close();
    await esplora.close();
  }
});

test('a live worker known only by the pidfile (the pre-upgrade lock) still keeps a new one out', async () => {
  const esplora = await startEsplora({ tip: 5 });
  const primary = await startRelay({ requireAuth: true });
  const home = makeHome();
  mkdirSync(join(home, 'run'), { recursive: true });
  mkdirSync(join(home, 'old'), { recursive: true });
  // Stand-in for the old worker: a live process whose command line names index.js.
  const fakeOldScript = join(home, 'old', 'index.js');
  writeFileSync(fakeOldScript, 'setTimeout(() => {}, 60_000);\n');
  const old = spawn(process.execPath, [fakeOldScript], { stdio: 'ignore' });
  writeFileSync(join(home, 'run', 'tip.pid'), `${old.pid}\n`);

  try {
    const w = startWorker({ home, relay: primary.url, esplora: esplora.url, privateKey: generatePrivateKey() });
    const { code } = await w.exit;
    assert.equal(code, 1);
    assert.match(w.out, new RegExp(`already running as pid ${old.pid}`));
  } finally {
    process.kill(old.pid, 'SIGTERM'); // exact pid this test spawned
    await primary.close();
    await esplora.close();
  }
});
