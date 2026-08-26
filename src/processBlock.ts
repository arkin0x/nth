import type { Event, UnsignedEvent } from 'nostr-tools';
import { getEventHash, getPublicKey, getSignature } from 'nostr-tools';

import type { BitcoinApi } from './lib/bitcoin.js';
import { coordHexToSector, sectorToTags } from './lib/cyberspace.js';
import { landfallCoordHex, planeOfMerkleRoot } from './lib/landfall.js';

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

export async function processBlock(opts: {
  blockHeight: number;
  blockHash: string;
  nextBlockHash: string;
  bitcoin: BitcoinApi;
  /** Resolves only when the relay accepted the event; throws with its reason otherwise. */
  publish: (event: Event) => Promise<void>;
  privateKey: string;
  network?: string;
  onSigned?: (event: Event) => void;
}): Promise<string> {
  const { blockHeight, blockHash, nextBlockHash, bitcoin, publish, privateKey, onSigned } = opts;
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
  const signedEvent: Event = { ...event, id, sig };

  // Archive before publishing. The local corpus is the durable artifact; a relay
  // that drops or rejects the event must not cost us the signed copy.
  onSigned?.(signedEvent);

  // Only the relay's OK counts as published. The previous version awaited a
  // Promise.allSettled and then logged success unconditionally, so ~450 blocks
  // were reported published while the relay rejected every one of them for
  // missing NIP-42 auth. A rejection now throws into the caller's retry loop.
  await publish(signedEvent);

  console.log(`Published block ${blockHeight} (event ${id})`);
  return id;
}
