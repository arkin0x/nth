// Unit checks on what makes a pending anchor reusable, and on reading it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { finishEvent, generatePrivateKey, getPublicKey } from 'nostr-tools';

import { makeHome } from './helpers/fakes.mjs';

const home = makeHome();
process.env.NTH_HOME = home;
const { readPending, writePending, clearPending } = await import('../dist/lib/runtime.js');
const { pendingMismatch } = await import('../dist/processBlock.js');

const H = 'a'.repeat(64);
const N = 'b'.repeat(64);
const sk = generatePrivateKey();
const pubkey = getPublicKey(sk);
// JSON round trip, as the pending file gives it back (drops nostr-tools' cached verify flag).
const ev = (tags, key = sk) =>
  JSON.parse(JSON.stringify(finishEvent({ kind: 321, created_at: 1, tags, content: 'Block 7' }, key)));
const good = ev([
  ['H', H],
  ['N', N],
  ['B', '7'],
]);
const expect = { blockHeight: 7, blockHash: H, nextBlockHash: N, pubkey };

test('a matching pending anchor is reusable', () => {
  assert.equal(pendingMismatch({ height: 7, archived: true, event: good }, expect), null);
  // Hashes are compared lowercase, as signed.
  assert.equal(
    pendingMismatch({ height: 7, archived: true, event: good }, { ...expect, blockHash: H.toUpperCase() }),
    null,
  );
});

test('mismatches are refused with a reason', () => {
  const cases = [
    [{ height: 8, archived: true, event: good }, expect, /height 8/],
    [{ height: 7, archived: true, event: { ...good, content: 'x' } }, expect, /does not verify/],
    // A tampered copy that still carries nostr-tools' cached "verified" flag must not pass either.
    [
      {
        height: 7,
        archived: true,
        event: {
          ...finishEvent(
            {
              kind: 321,
              created_at: 1,
              tags: [
                ['H', H],
                ['N', N],
                ['B', '7'],
              ],
              content: 'Block 7',
            },
            sk,
          ),
          content: 'y',
        },
      },
      expect,
      /does not verify/,
    ],
    [
      {
        height: 7,
        archived: true,
        event: ev(
          [
            ['H', H],
            ['N', N],
            ['B', '7'],
          ],
          generatePrivateKey(),
        ),
      },
      expect,
      /different key/,
    ],
    [
      {
        height: 7,
        archived: true,
        event: ev([
          ['H', H],
          ['N', N],
          ['B', '6'],
        ]),
      },
      expect,
      /B tag/,
    ],
    [{ height: 7, archived: true, event: good }, { ...expect, blockHash: 'c'.repeat(64) }, /H tag/],
    [{ height: 7, archived: true, event: good }, { ...expect, nextBlockHash: 'c'.repeat(64) }, /N tag/],
  ];
  for (const [p, e, re] of cases) assert.match(pendingMismatch(p, e), re);
});

test('pending file round trip, and corrupt or missing files read as none', () => {
  assert.equal(readPending('tip'), null);
  writePending('tip', { height: 7, archived: false, event: good });
  assert.deepEqual(readPending('tip'), { height: 7, archived: false, event: good });
  clearPending('tip');
  assert.equal(readPending('tip'), null);
  clearPending('tip'); // clearing twice is fine

  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'tip.pending.json'), '{"height":7,"archived":tr');
  assert.equal(readPending('tip'), null);
  writeFileSync(join(home, 'state', 'tip.pending.json'), '{"height":7}');
  assert.equal(readPending('tip'), null);
});
