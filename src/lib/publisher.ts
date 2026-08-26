/**
 * publisher.ts: the authenticated publish path.
 *
 * cyberspace.nostr1.com (strfry v315) now advertises `auth_required` in its
 * NIP-11 document, and that flag covers REQ as well as EVENT. Without a NIP-42
 * handshake the relay answers every read with `auth-required: you must auth`
 * and rejects every write the same way. NTH published ~450 anchors into that
 * void because nothing here ever looked at the relay's OK.
 *
 * This module owns both halves of the fix: it completes the handshake, and it
 * treats "published" as something only the relay gets to say.
 */
import type { Event, EventTemplate, Relay, SimplePool } from 'nostr-tools';
import { finishEvent, nip42 } from 'nostr-tools';

/**
 * How long to wait for the relay's NIP-42 challenge.
 *
 * A relay that does not require auth never sends one, so this is a wait for
 * absence as much as for presence: long enough to cover a slow relay, short
 * enough that an open relay is not stalled behind it on every publish.
 */
const AUTH_CHALLENGE_WAIT_MS = 5_000;

/**
 * How long to wait for an OK before calling a publish failed.
 *
 * nostr-tools 1.x parks a listener keyed by event id and settles it only when a
 * matching OK arrives, and its `trySend` drops the frame outright when the
 * socket is down. An unbounded await therefore hangs the publisher forever
 * rather than erroring, which is exactly the silence this module exists to end.
 */
const OK_TIMEOUT_MS = 15_000;

/** NIP-01 machine-readable prefixes that mean "authenticate and try again". */
const AUTH_REQUIRED = /^\s*(auth-required|restricted)\b/i;

/** A publish the relay did not accept, carrying the relay's own words. */
export class RelayPublishError extends Error {
  eventId: string;
  reason: string;

  constructor(eventId: string, reason: string) {
    super(`Relay did not accept event ${eventId}: ${reason}`);
    this.name = 'RelayPublishError';
    this.eventId = eventId;
    this.reason = reason;
  }
}

export type Publisher = {
  /** Resolve only once the relay has answered OK true; throw otherwise. */
  publish: (event: Event) => Promise<void>;
};

/**
 * Describe a thrown value.
 *
 * relayInit rejects its connection promise with no argument at all on a socket
 * error, so `undefined` is a real case here and "undefined" is a useless thing
 * to put in a log line an operator has to act on.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === undefined || error === null) return 'connection closed without a reason';
  return String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Connect to `url` through `pool` and complete the NIP-42 handshake.
 *
 * Call this before any read. The pool hands out one Relay per URL and keeps its
 * listeners across reconnects, so authenticating here also authenticates every
 * later `pool.list` on the same URL -- but the challenge arrives once per
 * socket, so whoever opens the socket first has to be the one listening for it.
 */
export async function connectPublisher(opts: {
  pool: SimplePool;
  url: string;
  privateKey: string;
}): Promise<Publisher> {
  const { pool, url, privateKey } = opts;

  // The key signs the kind 22242 auth event here and nowhere else. It is never
  // logged, never put in an error message and never sent anywhere but as a
  // signature.
  const sign = <K extends number>(template: EventTemplate<K>): Event<K> => finishEvent(template, privateKey);

  let challenge: string | null = null;
  let authenticated = false;
  let challengeWaiters: Array<() => void> = [];

  let relay: Relay;
  try {
    relay = await pool.ensureRelay(url);
  } catch (error) {
    throw new Error(`Could not connect to relay ${url}: ${describe(error)}`);
  }

  // Attaching after connect is safe: relayInit queues incoming frames and drains
  // them from a timer, so no AUTH can be dispatched until the microtasks that
  // resolve ensureRelay have already run.
  relay.on('auth', (received: string) => {
    challenge = received;
    authenticated = false;
    for (const wake of challengeWaiters.splice(0)) wake();
  });

  // A new socket means a new challenge; whatever we authenticated with is dead.
  relay.on('disconnect', () => {
    challenge = null;
    authenticated = false;
  });

  function waitForChallenge(timeoutMs: number): Promise<string | null> {
    if (challenge) return Promise.resolve(challenge);

    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(challenge);
      };

      const timer = setTimeout(() => {
        challengeWaiters = challengeWaiters.filter((waiter) => waiter !== wake);
        resolve(null);
      }, timeoutMs);

      challengeWaiters.push(wake);
    });
  }

  async function ensureAuthenticated(): Promise<void> {
    if (authenticated) return;

    const current = await waitForChallenge(AUTH_CHALLENGE_WAIT_MS);
    if (!current) return; // no challenge: this relay does not require auth

    await withTimeout(nip42.authenticate({ relay, sign, challenge: current }), OK_TIMEOUT_MS, `AUTH OK from ${url}`);

    authenticated = true;
    console.log(`NIP-42: authenticated to ${url}`);
  }

  async function publishOnce(event: Event): Promise<void> {
    // Reconnects if the socket dropped; the pool reuses this same Relay object,
    // so the listeners above survive.
    await pool.ensureRelay(url);
    await ensureAuthenticated();
    await withTimeout(relay.publish(event), OK_TIMEOUT_MS, `OK for event ${event.id}`);
  }

  const publish = async (event: Event): Promise<void> => {
    try {
      await publishOnce(event);
      return;
    } catch (error) {
      const reason = describe(error);
      if (!AUTH_REQUIRED.test(reason)) throw new RelayPublishError(event.id, reason);

      // Some relays only reveal that they want auth at rejection time, and a
      // reconnect invalidates the challenge we authenticated with. Re-handshake
      // once, then let a second failure through so it is reported, not hidden.
      console.error(`NIP-42: ${url} asked for authentication (${reason}); re-authenticating`);
      authenticated = false;
    }

    try {
      await publishOnce(event);
    } catch (error) {
      throw new RelayPublishError(event.id, describe(error));
    }
  };

  await ensureAuthenticated();

  return { publish };
}
