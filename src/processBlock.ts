import type { Event, UnsignedEvent } from 'nostr-tools';
import { getEventHash, getPublicKey, getSignature, validateEvent, verifySignature } from 'nostr-tools';

import type { BitcoinApi } from './lib/bitcoin.js';
import { coordHexToSector, sectorToTags } from './lib/cyberspace.js';
import { landfallCoordHex, planeOfMerkleRoot } from './lib/landfall.js';
import type { PendingAnchor } from './lib/runtime.js';

function findTag(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name) return tag[1];
  }
  return undefined;
}

/**
 * DECK-0001 specifies C/H/P/N as lowercase hex. Esplora implementations already
 * return lowercase, but normalizing here makes the corpus canonical regardless
 * of which backend produced it -- consumers compare these values as strings.
 */
function lc(hex: string): string {
  return hex.trim().toLowerCase();
}

/** Fetch the block and sign its kind 321 anchor. Signing happens here and nowhere else. */
export async function signAnchor(opts: {
  blockHeight: number;
  blockHash: string;
  nextBlockHash: string;
  bitcoin: BitcoinApi;
  privateKey: string;
  network?: string;
}): Promise<Event> {
  const { blockHeight, blockHash, nextBlockHash, bitcoin, privateKey } = opts;
  const network = opts.network || 'mainnet';

  const block = await bitcoin.getBlockByHash(blockHash, { heightHint: blockHeight });

  const merkleRoot = lc(block.merkleRoot);

  // DECK-0001 v3 §1: the merkle root's plane bit decides the stop kind.
  // Plane 1 is a port in ideaspace at the root coordinate; plane 0 is a
  // landfall on the WGS84 surface at a point the BLOCK HASH picks (the hash
  // cannot be steered by a miner; the root can). C is the stop coordinate,
  // M is always the merkle root.
  const stopCoord = planeOfMerkleRoot(merkleRoot) === 1 ? merkleRoot : landfallCoordHex(lc(blockHash));

  const sector = coordHexToSector(stopCoord);
  const sectorTags = sectorToTags(sector);

  const event: UnsignedEvent = {
    kind: 321,
    pubkey: getPublicKey(privateKey),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['C', stopCoord],
      ['M', merkleRoot],
      ...sectorTags,
      ['H', lc(blockHash)],
      ['P', block.prevBlockHash ? lc(block.prevBlockHash) : '0'.repeat(64)],
      ['N', lc(nextBlockHash)],
      ['B', blockHeight.toString()],
      // DECK-0001: anchor events SHOULD declare the Bitcoin network they bind to.
      // Absent this, verifiers must assume mainnet.
      ['net', network],
    ],
    content: `Block ${blockHeight}`,
  };

  if (!findTag(event.tags, 'C') || !findTag(event.tags, 'B') || !findTag(event.tags, 'H')) {
    throw new Error('Internal error: missing required tags');
  }

  if (!block.prevBlockHash && blockHeight !== 0) {
    throw new Error(`Bitcoin API did not return prevBlockHash for block ${blockHeight}`);
  }

  const id = getEventHash(event);
  const sig = getSignature(event, privateKey);
  return { ...event, id, sig };
}

/**
 * Can this pending anchor be published again for this height?
 *
 * Returns null when it can, otherwise the reason it cannot. The checks guard
 * against reusing an event that is not ours, not intact, or not about the
 * block the chain currently has at this height (a reorg below the
 * confirmation depth, or a Bitcoin API that disagrees with the one that
 * signed it). Re-signing in those cases is correct: the old event is wrong.
 */
export function pendingMismatch(
  pending: PendingAnchor,
  expect: { blockHeight: number; blockHash: string; nextBlockHash: string; pubkey: string },
): string | null {
  // Verify a plain JSON copy: nostr-tools caches a verify verdict on a symbol
  // property that object spread carries along, and a cached "true" must never
  // vouch for an event whose fields have changed since.
  const event = JSON.parse(JSON.stringify(pending.event)) as Event;
  if (pending.height !== expect.blockHeight) return `it is for height ${pending.height}`;
  if (!validateEvent(event) || getEventHash(event) !== event.id || !verifySignature(event)) {
    return 'its id or signature does not verify';
  }
  if (event.kind !== 321) return `it is kind ${event.kind}`;
  if (event.pubkey !== expect.pubkey) return 'it was signed by a different key';
  if (findTag(event.tags, 'B') !== String(expect.blockHeight)) return 'its B tag names another height';
  if (findTag(event.tags, 'H') !== lc(expect.blockHash)) return `its H tag ${findTag(event.tags, 'H')} is not the current block hash`;
  if (findTag(event.tags, 'N') !== lc(expect.nextBlockHash)) return `its N tag ${findTag(event.tags, 'N')} is not the current next-block hash`;
  return null;
}

/** Where the signed-but-unaccepted anchor lives between attempts and restarts. */
export type PendingStore = {
  read: () => PendingAnchor | null;
  write: (anchor: PendingAnchor) => void;
  archive: (event: Event) => void;
};

/**
 * Publish the anchor for one height, signing it at most once.
 *
 * Order matters and every step is durable before the next:
 *   1. reuse the pending anchor for this height if it checks out, else sign
 *      one and persist it as pending (atomic write) before anything else;
 *   2. append it to the local archive once, and record that it was archived;
 *   3. publish it to the primary relay.
 * A failure at any step throws into the caller's retry loop, and the retry (or
 * a restart) picks up the same signed event at step 1. Only the caller, after
 * this resolves, advances the state file and clears the pending anchor.
 */
export async function processBlock(opts: {
  blockHeight: number;
  blockHash: string;
  nextBlockHash: string;
  bitcoin: BitcoinApi;
  /** Resolves only when the relay accepted the event; throws with its reason otherwise. */
  publish: (event: Event) => Promise<void>;
  privateKey: string;
  network?: string;
  store: PendingStore;
}): Promise<Event> {
  const { blockHeight, blockHash, nextBlockHash, publish, privateKey, store } = opts;
  const pubkey = getPublicKey(privateKey);

  let pending = store.read();
  const mismatch = pending ? pendingMismatch(pending, { blockHeight, blockHash, nextBlockHash, pubkey }) : 'none';

  if (pending && mismatch === null) {
    console.log(`Reusing the anchor already signed for block ${blockHeight} (event ${pending.event.id}); not re-signing`);
  } else {
    // A pending anchor for another height is just left over from the height
    // before (state advanced, then the process stopped before clearing it).
    // One for THIS height that fails the checks is worth saying out loud.
    if (pending && pending.height === blockHeight) {
      console.error(`Discarding the pending anchor for block ${blockHeight} (event ${pending.event.id}): ${mismatch}`);
    }
    const event = await signAnchor(opts);
    pending = { height: blockHeight, archived: false, event };
    store.write(pending);
  }

  const { event } = pending;

  // Archive before publishing. The local corpus is the durable artifact; a relay
  // that drops or rejects the event must not cost us the signed copy.
  if (!pending.archived) {
    store.archive(event);
    pending = { ...pending, archived: true };
    store.write(pending);
  }

  // Only the relay's OK counts as published. The previous version awaited a
  // Promise.allSettled and then logged success unconditionally, so ~450 blocks
  // were reported published while the relay rejected every one of them for
  // missing NIP-42 auth. A rejection now throws into the caller's retry loop.
  await publish(event);

  console.log(`Published block ${blockHeight} (event ${event.id})`);
  return event;
}
