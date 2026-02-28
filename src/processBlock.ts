import type { Event, UnsignedEvent } from 'nostr-tools';
import { getEventHash, getPublicKey, getSignature } from 'nostr-tools';

import type { BitcoinApi } from './lib/bitcoin.js';
import { coordHexToSector, sectorToTags } from './lib/cyberspace.js';

function findTag(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name) return tag[1];
  }
  return undefined;
}

export async function processBlock(opts: {
  blockHeight: number;
  blockHash: string;
  nextBlockHash: string;
  bitcoin: BitcoinApi;
  relay: string;
  pool: { publish: (relays: string[], event: Event) => unknown };
  privateKey: string;
}): Promise<string> {
  const { blockHeight, blockHash, nextBlockHash, bitcoin, relay, pool, privateKey } = opts;

  const block = await bitcoin.getBlockByHash(blockHash, { heightHint: blockHeight });

  // C tag is merkle root (32-byte hex) per your protocol.
  const merkleRoot = block.merkleRoot;

  const sector = coordHexToSector(merkleRoot);
  const sectorTags = sectorToTags(sector);

  const event: UnsignedEvent = {
    kind: 321,
    pubkey: getPublicKey(privateKey),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['C', merkleRoot],
      ...sectorTags,
      ['H', blockHash],
      ['P', block.prevBlockHash ?? '0'.repeat(64)],
      ['N', nextBlockHash],
      ['B', blockHeight.toString()],
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

  const pubs = pool.publish([relay], signedEvent) as unknown;
  if (Array.isArray(pubs)) {
    await Promise.allSettled(pubs);
  }

  console.log(`Published block ${blockHeight} (event ${id})`);
  return id;
}
