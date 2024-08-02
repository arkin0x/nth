import dotenv from 'dotenv';
import PocketBase from 'pocketbase';
import { generatePrivateKey, SimplePool } from 'nostr-tools';
import { writeFileSync } from 'fs';
import WebSocket from 'ws';
import { processBlock } from './processBlock.js';

if (!global.WebSocket) {
  global.WebSocket = WebSocket as any
}

// Initialize PocketBase client
const pb = new PocketBase('http://127.0.0.1:8090');

async function authPB() {
  await pb.admins.authWithPassword(process.env.POCKETBASE_USER, process.env.POCKETBASE_PASS);
}

// console.log(pb)

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

async function getHighestBlockHeight(): Promise<number> {
  try {
    const records = await pb.collection('hyperjumps').getList(1, 5, {
      sort: '-blockHeight',
    });

    if (records.items.length === 0) {
      console.log('No blocks found. Returning -1 (next block to fetch: 0)');
      return -1;
    }

    // Log the top 5 block heights for debugging
    console.log('Top 5 block heights:');
    records.items.forEach((item, index) => {
      console.log(`${index + 1}: ${item.blockHeight}`);
    });

    // Get the maximum block height
    const highest = Math.max(...records.items.map(item => {
      const height = Number(item.blockHeight);
      if (isNaN(height)) {
        console.warn(`Invalid block height found: ${item.blockHeight}`);
        return -1; // Use -1 for invalid heights
      }
      return height;
    }));

    if (highest === -1) {
      console.warn('No valid block heights found in existing records');
      return -1; // Return -1 if all existing records are invalid
    }

    console.log(`Highest block in database: ${highest}, returning ${highest} (next block to fetch: ${highest + 1})`);
    return highest;
  } catch (error) {
    console.error('Error fetching highest block height:', error);
    // In case of any error, we'll return -1
    console.log('Returning -1 due to error (next block to fetch: 0)');
    return -1;
  }
}

async function main() {
  await authPB();
  let blockHeight = await getHighestBlockHeight();
  while (true) {
    await processBlock(blockHeight+1, pb, relayUrl, pool, 8); // 8 retries with exponential backoff is 4.2 minutes
    blockHeight++;
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});