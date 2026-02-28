import type { Event } from 'nostr-tools';
import { SimplePool } from 'nostr-tools';

export const DEFAULT_RELAY = 'wss://cyberspace.nostr1.com';

export function getRelaysFromEnv(): string[] {
  const raw = (process.env.NTH_RELAYS || '').trim();
  if (!raw) return [DEFAULT_RELAY];

  const relays = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return relays.length > 0 ? relays : [DEFAULT_RELAY];
}

export function getTagValue(event: Event, tagName: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === tagName && typeof tag[1] === 'string') {
      return tag[1];
    }
  }
  return null;
}

export async function getLatestPublishedHeight(opts: {
  pool: SimplePool;
  relays: string[];
  pubkey: string;
}): Promise<number> {
  const { pool, relays, pubkey } = opts;

  // NIP-01: events SHOULD be returned in reverse chronological order, so limit=1 is enough.
  const events = await pool.list(relays, [
    {
      kinds: [321],
      authors: [pubkey],
      limit: 1,
    },
  ]);

  if (events.length === 0) return -1;

  const b = getTagValue(events[0], 'B');
  if (!b) return -1;

  const height = Number.parseInt(b, 10);
  return Number.isFinite(height) ? height : -1;
}

export function getWebSocketImpl() {
  // Node doesn't have WebSocket globally.
  return global.WebSocket;
}
