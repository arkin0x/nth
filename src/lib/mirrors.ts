/**
 * mirrors.ts: best-effort copies of each anchor on extra relays.
 *
 * Roles are deliberately unequal. NTH_RELAY is the primary: only its OK
 * advances the state file, and the frontier probe only ever asks it. Mirrors
 * (NTH_MIRROR_RELAYS) get the SAME signed event, after the primary accepted
 * it, from a background queue per mirror. Nothing a mirror does can reach the
 * publish loop:
 *
 *   - enqueue() is synchronous and never throws, so the chain never waits;
 *   - a mirror never causes a re-sign (it only ever sees already-signed events);
 *   - a mirror that cannot connect or authenticate is retried in the background
 *     with backoff, while its queue holds the heights it has not taken yet;
 *   - every outcome is logged per height (accepted, duplicate, refused with the
 *     relay's reason), and every height a mirror did not take is appended to
 *     state/<role>.mirror-missed.ndjson for an exact catch-up from the archive.
 */
import type { Event } from 'nostr-tools';

import { RelayClient, describeError, type RelayClientOptions } from './relayClient.js';
import type { MirrorMiss } from './runtime.js';

export type MirrorOptions = RelayClientOptions & {
  /** Minimum gap between two publishes to one mirror (its rate limit). */
  minIntervalMs: number;
  /** Backoff for reconnects and retryable failures: base doubling up to max. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** Heights held per mirror while it is behind; beyond this the oldest waiting one is dropped and recorded. */
  queueMax: number;
  /** Attempts per height for retryable failures (rate-limited, no OK in time) before it is recorded as missed. */
  maxAttempts: number;
  onMiss: (miss: MirrorMiss) => void;
};

type Item = { height: number; event: Event; attempts: number };

const DUPLICATE = /^\s*duplicate:/i;
const RATE_LIMITED = /^\s*rate-limited:/i;

function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const ms = Math.min(baseMs * Math.pow(2, Math.min(Math.max(attempt - 1, 0), 30)), maxMs);
  return Math.floor(ms * (0.8 + Math.random() * 0.4));
}

/** Normalize a relay URL for comparison only (case and trailing slash). */
function sameRelay(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/**
 * Parse NTH_MIRROR_RELAYS: comma separated, trimmed, de-duplicated, and never
 * the primary (a mirror entry equal to the primary is dropped with a warning,
 * since it would only resend what the primary already took).
 */
export function parseMirrorRelays(raw: string | undefined, primary: string): string[] {
  const out: string[] = [];
  for (const part of (raw || '').split(',')) {
    const url = part.trim();
    if (!url) continue;
    if (sameRelay(url, primary)) {
      console.error(`NTH_MIRROR_RELAYS lists the primary relay ${url}; ignoring that entry`);
      continue;
    }
    if (out.some((existing) => sameRelay(existing, url))) continue;
    out.push(url);
  }
  return out;
}

export class Mirror {
  readonly url: string;
  private readonly opts: MirrorOptions;
  private readonly client: RelayClient;

  private queue: Item[] = [];
  private running = false;
  private stopped = false;
  private everConnected = false;
  private connectFailures = 0;
  private lastPublishAt = 0;
  private wakeSleep: (() => void) | null = null;

  constructor(url: string, privateKey: string, opts: MirrorOptions) {
    this.url = url;
    this.opts = opts;
    this.client = new RelayClient(url, privateKey, opts);
  }

  /** Connect in the background now, so the boot log shows each mirror's state. */
  start(): void {
    this.kick();
  }

  /** Hand this mirror one accepted anchor. Synchronous; never throws. */
  enqueue(height: number, event: Event): void {
    try {
      if (this.stopped) return;
      if (this.queue.length >= Math.max(2, this.opts.queueMax)) {
        // Index 0 may be in flight; drop the oldest one still waiting.
        const [dropped] = this.queue.splice(1, 1);
        if (dropped) this.miss(dropped, `mirror queue full (${this.opts.queueMax}); dropped before publishing`);
      }
      this.queue.push({ height, event, attempts: 0 });
      this.kick();
    } catch (error) {
      console.error(`Mirror ${this.url}: could not queue block ${height}:`, error);
    }
  }

  /** Heights queued but not yet taken (in order). */
  queuedHeights(): number[] {
    return this.queue.map((item) => item.height);
  }

  /**
   * Stop for good and record every height still queued as missed. Synchronous,
   * so it is safe from a process 'exit' handler.
   */
  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const item of this.queue.splice(0)) this.miss(item, reason);
    this.wakeSleep?.();
    this.client.close();
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.drain()
      .catch((error) => console.error(`Mirror ${this.url}: worker error (mirror only; primary unaffected):`, error))
      .finally(() => {
        this.running = false;
        // Something may have been queued after the loop decided to exit.
        if (!this.stopped && this.queue.length > 0) this.kick();
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wakeSleep === done) self.wakeSleep = null;
        resolve();
      }
      this.wakeSleep = done;
    });
  }

  private miss(item: Item, reason: string): void {
    this.opts.onMiss({ relay: this.url, height: item.height, id: item.event.id, reason });
  }

  /** Connect and authenticate if needed. False (after logging and backing off) if that failed. */
  private async ready(): Promise<boolean> {
    if (this.client.connected) return true;
    try {
      await this.client.connect();
      await this.client.ensureAuthenticated();
      this.connectFailures = 0;
      this.everConnected = true;
      console.log(
        `Mirror ${this.url}: connected${this.client.isAuthenticated ? ', NIP-42: authenticated' : ' (no NIP-42 challenge)'}`,
      );
      return true;
    } catch (error) {
      this.client.close();
      this.connectFailures++;
      const delay = backoffMs(this.connectFailures, this.opts.retryBaseMs, this.opts.retryMaxMs);
      console.error(
        `Mirror ${this.url}: cannot connect or authenticate (${describeError(error)}); ` +
          `${this.queue.length} queued, retrying in ${delay}ms (primary unaffected)`,
      );
      await this.sleep(delay);
      return false;
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopped && (this.queue.length > 0 || !this.everConnected)) {
      if (!(await this.ready())) continue;
      if (this.queue.length === 0) continue;

      const wait = this.lastPublishAt + this.opts.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      if (this.stopped) return;

      const item = this.queue[0];
      const { height, event } = item;

      let reply;
      try {
        reply = await this.client.publish(event);
      } catch (error) {
        // No verdict: closed, timed out, or auth failed mid-publish.
        this.client.close();
        if (this.stopped) return;
        this.retryOrMiss(item, `no OK (${describeError(error)})`);
        if (this.queue[0] === item)
          await this.sleep(backoffMs(item.attempts, this.opts.retryBaseMs, this.opts.retryMaxMs));
        continue;
      }
      this.lastPublishAt = Date.now();
      if (this.stopped) return;

      if (reply.accepted) {
        const kind = DUPLICATE.test(reply.message) ? 'duplicate' : 'accepted';
        console.log(
          `Mirror ${this.url}: block ${height} ${kind} (event ${event.id})${reply.message ? `: ${reply.message}` : ''}`,
        );
        this.queue.shift();
        continue;
      }

      const reason = reply.message || 'no reason given';
      if (RATE_LIMITED.test(reason)) {
        this.retryOrMiss(item, reason);
        if (this.queue[0] === item)
          await this.sleep(backoffMs(item.attempts, this.opts.retryBaseMs, this.opts.retryMaxMs));
        continue;
      }

      console.error(`Mirror ${this.url}: block ${height} REFUSED (event ${event.id}): ${reason}`);
      this.queue.shift();
      this.miss(item, reason);
    }
  }

  private retryOrMiss(item: Item, reason: string): void {
    item.attempts++;
    if (item.attempts >= this.opts.maxAttempts) {
      console.error(
        `Mirror ${this.url}: block ${item.height} not taken after ${item.attempts} attempts (event ${item.event.id}): ${reason}`,
      );
      if (this.queue[0] === item) this.queue.shift();
      this.miss(item, reason);
      return;
    }
    console.error(
      `Mirror ${this.url}: block ${item.height} not taken yet (event ${item.event.id}): ${reason}; ` +
        `attempt ${item.attempts}/${this.opts.maxAttempts}`,
    );
  }
}

export class MirrorSet {
  readonly mirrors: Mirror[];

  constructor(urls: string[], privateKey: string, opts: MirrorOptions) {
    this.mirrors = urls.map((url) => new Mirror(url, privateKey, opts));
  }

  start(): void {
    for (const mirror of this.mirrors) mirror.start();
  }

  /** Fan one primary-accepted anchor out to every mirror. Never throws. */
  enqueue(height: number, event: Event): void {
    for (const mirror of this.mirrors) mirror.enqueue(height, event);
  }

  stop(reason: string): void {
    for (const mirror of this.mirrors) mirror.stop(reason);
  }
}
