import { createHash } from 'node:crypto';

/**
 * The raw 80-byte Bitcoin block header carried on a kind 321 anchor as
 * `["header", "<160 lowercase hex>"]`.
 *
 * The header is what makes an anchor's timestamp trustless: a reader hashes
 * it (sha256d), reverses the bytes into display order, and compares the result
 * with the anchor's `H` tag. If they agree, every field inside the header
 * (time, bits, merkle root, previous hash) is the block's own, whoever signed
 * the anchor. The publisher runs the same check before signing, so it never
 * puts its name to a header that does not belong to the block it names.
 *
 * Wire layout (all integers little-endian, hashes in internal byte order,
 * which is the REVERSE of the display hex explorers show):
 *
 *   bytes  0..3   version
 *   bytes  4..35  previous block hash
 *   bytes 36..67  merkle root
 *   bytes 68..71  time (uint32, Unix seconds)
 *   bytes 72..75  bits (compact difficulty target)
 *   bytes 76..79  nonce
 */

export const HEADER_TAG = 'header';
export const HEADER_BYTES = 80;
export const HEADER_HEX_LENGTH = HEADER_BYTES * 2;

const HEADER_HEX = /^[0-9a-f]{160}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;

export type HeaderFields = {
  version: number;
  /** Display hex, as in an anchor's `P` tag. */
  prevBlockHash: string;
  /** Display hex, as in an anchor's `M` tag. */
  merkleRoot: string;
  time: number;
  bits: number;
  nonce: number;
};

function sha256d(data: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(data).digest()).digest();
}

function headerBytes(headerHex: string): Buffer {
  if (!HEADER_HEX.test(headerHex)) {
    throw new Error(`A block header must be ${HEADER_HEX_LENGTH} lowercase hex characters, got ${headerHex.length} characters`);
  }
  return Buffer.from(headerHex, 'hex');
}

/** The block hash this header commits to, in display hex (as in an anchor's `H` tag). */
export function blockHashOfHeader(headerHex: string): string {
  return Buffer.from(sha256d(headerBytes(headerHex))).reverse().toString('hex');
}

/** Read the six header fields, with hashes converted to display hex. */
export function headerFields(headerHex: string): HeaderFields {
  const b = headerBytes(headerHex);
  return {
    version: b.readInt32LE(0),
    prevBlockHash: Buffer.from(b.subarray(4, 36)).reverse().toString('hex'),
    merkleRoot: Buffer.from(b.subarray(36, 68)).reverse().toString('hex'),
    time: b.readUInt32LE(68),
    bits: b.readUInt32LE(72),
    nonce: b.readUInt32LE(76),
  };
}

/**
 * Does this header belong to the block the anchor is about to name?
 *
 * Returns null when it does, otherwise the reason it does not. The hash check
 * is the one that matters: it alone proves the header is the block's. The
 * merkle root and previous hash checks then make sure the anchor's own `M` and
 * `P` tags agree with the header they ship beside, so an API that returns a
 * consistent header but inconsistent JSON cannot produce a self-contradicting
 * anchor.
 */
export function headerMismatch(
  headerHex: string,
  expect: { blockHash: string; merkleRoot: string; prevBlockHash: string | null },
): string | null {
  if (!HEADER_HEX.test(headerHex)) {
    return `it is not ${HEADER_HEX_LENGTH} lowercase hex characters (got ${headerHex.length})`;
  }
  const blockHash = expect.blockHash.toLowerCase();
  if (!HASH_HEX.test(blockHash)) return `the expected block hash "${expect.blockHash}" is not 64 hex characters`;

  const hashed = blockHashOfHeader(headerHex);
  if (hashed !== blockHash) return `it hashes to ${hashed}, not to the block hash ${blockHash}`;

  const fields = headerFields(headerHex);
  if (fields.merkleRoot !== expect.merkleRoot.toLowerCase()) {
    return `its merkle root ${fields.merkleRoot} is not the block's merkle root ${expect.merkleRoot.toLowerCase()}`;
  }
  const prev = (expect.prevBlockHash ?? '0'.repeat(64)).toLowerCase();
  if (fields.prevBlockHash !== prev) {
    return `its previous block hash ${fields.prevBlockHash} is not the block's previous hash ${prev}`;
  }
  return null;
}
