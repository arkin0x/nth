import dotenv from 'dotenv';
import axios from 'axios';
import PocketBase from 'pocketbase';
import type { UnsignedEvent, Event } from 'nostr-tools';
import { generatePrivateKey, getPublicKey, getEventHash, getSignature, SimplePool } from 'nostr-tools';
import { getSectorIdFromCoordinate, getSectorId } from './lib/util.js';
import { writeFileSync } from 'fs';
import WebSocket from 'ws';

if (!global.WebSocket) {
  global.WebSocket = WebSocket as any
}

// Initialize PocketBase client
const pb = new PocketBase('http://127.0.0.1:8090');

async function authPB() {
  await pb.admins.authWithPassword(process.env.POCKETBASE_USER, process.env.POCKETBASE_PASS);
}

console.log(pb)

// Nostr relay URL
const relayUrl = 'wss://cyberspace.nostr1.com';

// Nostr private key for signing events (replace with your own)
dotenv.config();

if (!process.env.PRIVATE_KEY) {
  const privateKey = generatePrivateKey();
  console.log(`Generated new private key: ${privateKey}`);
  process.env.PRIVATE_KEY = privateKey;
  writeFileSync('.env', `PRIVATE_KEY=${privateKey}\n`);
}

const pool = new SimplePool();

async function processBlock(blockHeight: number) {
  try {
    // Fetch block hash by height
    const blockHashResponse = await axios.get(`https://blockstream.info/api/block-height/${blockHeight}`);
    const blockHash = blockHashResponse.data;

    // check if the response is valid
    // the API will respond with Invalid number if the block height is invalid.
    if (blockHash === 'Invalid number') {
      // try again in 5 minutes
      setTimeout(() => {
        processBlock(blockHeight);
      }, 300000);
      return;
    }

    // Fetch block header
    const blockHeaderResponse = await axios.get(`https://blockstream.info/api/block/${blockHash}/header`);
    const blockHeader = blockHeaderResponse.data;

    // Extract merkle root from block header
    const merkleRoot = extractMerkleRoot(blockHeader);

    // Extract previous block hash from block header
    const prevBlockHash = extractPrevBlockHash(blockHeader);

    // Fetch next block hash
    const nextBlockHashResponse = await axios.get(`https://blockstream.info/api/block-height/${blockHeight + 1}`);
    const nextBlockHash = nextBlockHashResponse.data;

    if (nextBlockHash === 'Invalid number') {
      // next block hasn't been mined yet. try again in 5 minutes
      setTimeout(() => {
        processBlock(blockHeight);
      }, 300000);
      return;
    }

    // Store block data in PocketBase
    const blockData = {
      blockHeight,
      blockHash,
      prevBlockHash,
      nextBlockHash,
      merkleRoot,
    };

    const record = await pb.collection('hyperjumps').create(blockData);

    console.log('pb db record:', record)

    // Publish nostr event
    const event = {
      kind: 321,
      pubkey: getPublicKey(process.env.PRIVATE_KEY as string),
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['C', merkleRoot],
        ['S', getSectorId(getSectorIdFromCoordinate(merkleRoot))],
        ['H', blockHash],
        ['P', prevBlockHash],
        ['N', nextBlockHash],
        ['B', blockHeight.toString()],
      ],
      content: `Block ${blockHeight}`,
    } as UnsignedEvent;
    const id = getEventHash(event);
    const signedEvent = { ...event, id } as Event;
    const sig = getSignature(event, process.env.PRIVATE_KEY as string);
    signedEvent.sig = sig
    pool.publish([relayUrl], signedEvent)

    // update record in pocketbase with event id (column eventId)
    await pb.collection('hyperjumps').update(record.id, { eventId: id });

    console.log(`Processed block ${blockHeight}`);
  } catch (error) {
    console.error(`Error processing block ${blockHeight}:`, error);
  }
}

function extractMerkleRoot(blockHeader: string) {
  if (!/^[0-9a-fA-F]+$/.test(blockHeader) || blockHeader.length !== 160) {
    throw new Error('Invalid block header format');
  }
  return blockHeader.substring(72, 136);
}

function extractPrevBlockHash(blockHeader: string) {
  if (!/^[0-9a-fA-F]+$/.test(blockHeader) || blockHeader.length !== 160) {
    throw new Error('Invalid block header format');
  }
  const prevBlockHashLE = blockHeader.substring(4, 68);
  return prevBlockHashLE.match(/.{2}/g)!.reverse().join('');
}

async function main() {
  await authPB();
  let blockHeight = 0;
  while (true) {
    await processBlock(blockHeight);
    blockHeight++;
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});