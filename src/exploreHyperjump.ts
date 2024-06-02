// use this script to explore random hyperjump objects from the relay. Just change the filter.
import dotenv from 'dotenv';
import { SimplePool } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import WebSocket from 'ws';

if (!global.WebSocket) {
  global.WebSocket = WebSocket as any
}

dotenv.config();

function exploreEvents(event: Event) {
  console.log('event', event)
  // console.log(JSON.stringify(event))
}

const relayUrl = 'wss://cyberspace.nostr1.com';

const pool = new SimplePool();

const hyperjumps = pool.sub([relayUrl], [{kinds: [321], "#B": ["0"]}]);

hyperjumps.on('event', exploreEvents)

hyperjumps.on('eose', () => {
  console.log('exploration complete!')
})
