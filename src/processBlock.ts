import axios from 'axios';
import type { UnsignedEvent, Event } from 'nostr-tools';
import { getPublicKey, getEventHash, getSignature } from 'nostr-tools';
import { getSectorIdFromCoordinate, getSectorId } from './lib/util.js';

export async function processBlock(blockHeight: number, pb, relayUrl, pool, maxRetries = 5): Promise<void> {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      // Fetch block hash by height
      const blockHashResponse = await axios.get(`https://blockstream.info/api/block-height/${blockHeight}`);
      const blockHash = blockHashResponse.data;

      if (blockHash === 'Invalid number') {
        console.log(`Block ${blockHeight} not mined yet. Retrying in 5 minutes.`);
        await new Promise(resolve => setTimeout(resolve, 300000));
        continue;
      }

      /// ...

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
        console.log(`Block ${blockHeight+1} not mined yet. Retrying in 5 minutes.`);
        await new Promise(resolve => setTimeout(resolve, 300000));
        continue;
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
          ['C', merkleRoot], // cyberspace coordinate of the block
          ['S', getSectorId(getSectorIdFromCoordinate(merkleRoot))], // sector id of the block
          ['H', blockHash], // block hash
          ['P', prevBlockHash], // previous block hash
          ['N', nextBlockHash], // next block hash
          ['B', blockHeight.toString()], // block height
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
      return; // Success, exit the function
    } catch (error) {
      console.error(`Error processing block ${blockHeight} (attempt ${retries + 1}):`, error);
      retries++;
      if (retries < maxRetries) {
        const delay = Math.pow(2, retries) * 1000; // Exponential backoff
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error(`Failed to process block ${blockHeight} after ${maxRetries} attempts`);
}
     
function extractMerkleRoot(blockHeader: string) {
  if (!/^[0-9a-fA-F]+$/.test(blockHeader) || blockHeader.length !== 160) {
    throw new Error('Invalid block header format');
  }
  return blockHeader.substring(72, 136);
}

function extractPrevBlockHash(blockHeader: string): string {
  if (!/^[0-9a-fA-F]+$/.test(blockHeader) || blockHeader.length !== 160) {
    throw new Error('Invalid block header format');
  }
  
  // Extract the previous block hash (32 bytes, 64 characters)
  const prevBlockHashLE = blockHeader.substring(8, 72);
  
  // Reverse the byte order (not the individual bytes)
  const prevBlockHashBE = prevBlockHashLE.match(/.{2}/g)!.reverse().join('');
  
  return prevBlockHashBE;
}
