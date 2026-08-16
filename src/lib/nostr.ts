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

/** True if this author has already published an anchor for exactly this height. */
async function hasHeight(opts: {
  pool: SimplePool;
  relays: string[];
  pubkey: string;
  height: number;
}): Promise<boolean> {
  const { pool, relays, pubkey, height } = opts;

  const events = await pool.list(relays, [
    {
      kinds: [321],
      authors: [pubkey],
      '#B': [String(height)],
      limit: 1,
    },
  ]);

  return events.length > 0;
}

/**
 * Find the highest contiguous published height by probing the indexed `B` tag.
 *
 * Resuming from "the most recent event" is unsound for this corpus: a restart
 * that re-publishes low blocks makes the newest event by `created_at` the
 * *lowest* height, not the highest. In practice the relay's newest kind 321 is
 * block 43,989 while the actual frontier is 943,181. Single-letter tags are
 * indexed per NIP-01, so an exponential probe followed by a binary search finds
 * the true frontier in O(log n) queries regardless of publish order.
 *
 * Returns -1 when this author has published nothing at all.
 */
export async function findFrontierHeight(opts: {
  pool: SimplePool;
  relays: string[];
  pubkey: string;
}): Promise<number> {
  const probe = (height: number) => hasHeight({ ...opts, height });

  if (!(await probe(0))) return -1;

  // Exponential search for an absent height to bound the binary search.
  let lo = 0;
  let hi = 1;
  while (await probe(hi)) {
    lo = hi;
    hi *= 2;
    if (hi > 100_000_000) break; // far beyond any plausible block height
  }

  // Invariant: lo is present, hi is absent.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await probe(mid)) lo = mid;
    else hi = mid;
  }

  return lo;
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
