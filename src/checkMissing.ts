import PocketBase from 'pocketbase';
import { SimplePool } from 'nostr-tools';
import { processBlock } from './processBlock.js'; // Import the processBlock function

const pb = new PocketBase('http://127.0.0.1:8090');

// Nostr relay URL
const relayUrl = 'wss://cyberspace.nostr1.com';
const pool = new SimplePool();

async function checkMissingBlocks() {
  await pb.admins.authWithPassword(process.env.POCKETBASE_USER, process.env.POCKETBASE_PASS);

  const allBlocks = await pb.collection('hyperjumps').getFullList({ sort: 'blockHeight' });
  
  let previousHeight = -1;
  for (const block of allBlocks) {
    const currentHeight = parseInt(block.blockHeight);
    
    if (currentHeight !== previousHeight + 1) {
      // We found a gap
      for (let missingHeight = previousHeight + 1; missingHeight < currentHeight; missingHeight++) {
        console.log(`Processing missing block ${missingHeight}`);
        await processBlock(missingHeight, pb, relayUrl, pool);
      }
    }
    
    previousHeight = currentHeight;
  }
  
  console.log('Finished checking for missing blocks');
}

checkMissingBlocks().catch(console.error);