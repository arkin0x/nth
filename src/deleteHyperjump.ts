// use this script to delete hyperjump objects from the relay

// I should delete all hyperjumps before timestamp 1717299665 

import dotenv from 'dotenv';
import { getPublicKey, getEventHash, getSignature, SimplePool } from 'nostr-tools';
import type { Event, UnsignedEvent } from 'nostr-tools';

dotenv.config();

console.log(getPublicKey(process.env.PRIVATE_KEY as string))

function deleteEvent(event: Event) {
  console.log('deleting', event.id)
  const pubkey = getPublicKey(process.env.PRIVATE_KEY as string)
  const deletion = {
    kind: 5,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["e", event.id],
    ],
    content: `Deleting test hyperjump`,
  } as UnsignedEvent;
  const id = getEventHash(deletion);
  const signedEvent = { ...deletion, id } as Event;
  const sig = getSignature(deletion, process.env.PRIVATE_KEY as string);
  signedEvent.sig = sig
  pool.publish([relayUrl], signedEvent)
}

const relayUrl = 'wss://cyberspace.nostr1.com';

const pool = new SimplePool();

const oldHyperjumps = pool.sub([relayUrl], [{kinds: [321], until: 1717299665}]);

oldHyperjumps.on('event', deleteEvent)

oldHyperjumps.on('eose', () => {
  console.log('deletion complete!')
})
