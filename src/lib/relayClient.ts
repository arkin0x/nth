/**
 * relayClient.ts: a small publish-only relay connection for mirror relays.
 *
 * The primary relay goes through nostr-tools (publisher.ts). Mirrors use this
 * instead for one reason: nostr-tools 1.17 resolves an `OK true` with nothing,
 * dropping the relay's message, so it cannot tell a fresh accept from
 * `duplicate:`. Mirror logs need that distinction per height. This client also
 * owns its socket outright, so a mirror that is down, slow or refusing can
 * never touch the primary's connection pool.
 *
 * It speaks exactly what a mirror needs: EVENT and its OK, and the NIP-42
 * AUTH handshake. Every failure is an error or a reply; nothing here throws
 * asynchronously or leaves an unhandled 'error' event on the socket.
 */
import WebSocket from 'ws';

import type { Event } from 'nostr-tools';
import { finishEvent } from 'nostr-tools';

export type OkReply = { accepted: boolean; message: string };

export type RelayClientOptions = {
  connectTimeoutMs: number;
  okTimeoutMs: number;
  /** How long to wait for a NIP-42 challenge after connecting before assuming the relay needs none. */
  authWaitMs: number;
};

/** NIP-01 machine-readable prefixes that mean "authenticate and try again". */
const AUTH_REQUIRED = /^\s*(auth-required|restricted)\b/i;

type OkWaiter = {
  resolve: (reply: OkReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error === undefined || error === null) return 'connection closed without a reason';
  return String(error);
}

export class RelayClient {
  readonly url: string;
  private readonly privateKey: string;
  private readonly opts: RelayClientOptions;

  private ws: WebSocket | null = null;
  private challenge: string | null = null;
  private authenticated = false;
  /** This socket already waited once for a challenge and none came. */
  private challengeWaited = false;
  private okWaiters = new Map<string, OkWaiter>();
  private challengeWaiters: Array<() => void> = [];

  constructor(url: string, privateKey: string, opts: RelayClientOptions) {
    this.url = url;
    this.privateKey = privateKey;
    this.opts = opts;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** True once this socket completed NIP-42 (false for a relay that never asked). */
  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Open the socket if it is not open. Rejects on refusal, error or timeout. */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.close();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url, { handshakeTimeout: this.opts.connectTimeoutMs });
      } catch (error) {
        settle(new Error(`cannot open ${this.url}: ${describeError(error)}`));
        return;
      }
      this.ws = ws;

      const timer = setTimeout(() => {
        settle(new Error(`timed out after ${this.opts.connectTimeoutMs}ms connecting`));
        ws.terminate();
      }, this.opts.connectTimeoutMs);

      // This listener stays for the socket's whole life: an 'error' with no
      // listener would crash the process, and a mirror must never do that.
      ws.on('error', (error) => settle(new Error(describeError(error))));
      ws.on('open', () => settle());
      ws.on('close', () => {
        settle(new Error('connection closed before it opened'));
        if (this.ws === ws) this.dropSocket('connection closed');
      });
      ws.on('message', (data) => {
        if (this.ws === ws) this.onMessage(data.toString());
      });
    });
  }

  /**
   * Complete NIP-42 if the relay asks for it. A relay that sends no challenge
   * within `authWaitMs` is taken to need none, and that wait happens once per
   * socket, not before every publish (`force` waits again, for a relay that
   * only asks at rejection time). Rejects if the relay refuses the AUTH event.
   */
  async ensureAuthenticated(force = false): Promise<void> {
    if (this.authenticated) return;
    if (!this.challenge && this.challengeWaited && !force) return;

    const challenge = await this.waitForChallenge(this.opts.authWaitMs);
    this.challengeWaited = true;
    if (!challenge) return;

    const auth = finishEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['relay', this.url],
          ['challenge', challenge],
        ],
        content: '',
      },
      this.privateKey,
    );

    const reply = await this.send('AUTH', auth);
    if (!reply.accepted) throw new Error(`NIP-42 auth refused: ${reply.message || 'no reason given'}`);
    this.authenticated = true;
  }

  /**
   * Publish one event and return the relay's verdict. Rejects only for
   * transport failures (not connected, closed, no OK in time); a refusal is a
   * reply with `accepted: false` and the relay's reason.
   */
  async publish(event: Event): Promise<OkReply> {
    await this.connect();
    await this.ensureAuthenticated();

    const reply = await this.send('EVENT', event);
    if (reply.accepted || !AUTH_REQUIRED.test(reply.message)) return reply;

    // Some relays only reveal that they want auth at rejection time.
    // Re-handshake once, then report whatever the second answer is.
    this.authenticated = false;
    await this.ensureAuthenticated(true);
    return this.send('EVENT', event);
  }

  /** Drop the socket. Anything waiting on it fails with "connection closed". */
  close(): void {
    const ws = this.ws;
    this.dropSocket('connection closed by client');
    if (ws) {
      try {
        ws.terminate();
      } catch {
        // already gone
      }
    }
  }

  private dropSocket(reason: string): void {
    this.ws = null;
    this.challenge = null;
    this.authenticated = false;
    this.challengeWaited = false;
    for (const [id, waiter] of this.okWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${reason} before OK for ${id}`));
    }
    this.okWaiters.clear();
    for (const wake of this.challengeWaiters.splice(0)) wake();
  }

  private onMessage(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;

    if (data[0] === 'AUTH' && typeof data[1] === 'string') {
      this.challenge = data[1];
      this.authenticated = false;
      for (const wake of this.challengeWaiters.splice(0)) wake();
      return;
    }

    if (data[0] === 'OK' && typeof data[1] === 'string') {
      const waiter = this.okWaiters.get(data[1]);
      if (!waiter) return;
      this.okWaiters.delete(data[1]);
      clearTimeout(waiter.timer);
      waiter.resolve({ accepted: data[2] === true, message: typeof data[3] === 'string' ? data[3] : '' });
    }
  }

  private waitForChallenge(timeoutMs: number): Promise<string | null> {
    if (this.challenge) return Promise.resolve(this.challenge);
    if (!this.connected) return Promise.resolve(null);

    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(this.challenge);
      };
      const timer = setTimeout(() => {
        this.challengeWaiters = this.challengeWaiters.filter((w) => w !== wake);
        resolve(null);
      }, timeoutMs);
      this.challengeWaiters.push(wake);
    });
  }

  private send(verb: 'EVENT' | 'AUTH', event: Event): Promise<OkReply> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'));
    }

    return new Promise<OkReply>((resolve, reject) => {
      const previous = this.okWaiters.get(event.id);
      if (previous) {
        clearTimeout(previous.timer);
        previous.reject(new Error(`superseded by a resend of ${event.id}`));
      }

      const timer = setTimeout(() => {
        this.okWaiters.delete(event.id);
        reject(new Error(`timed out after ${this.opts.okTimeoutMs}ms waiting for OK for ${event.id}`));
      }, this.opts.okTimeoutMs);

      this.okWaiters.set(event.id, { resolve, reject, timer });

      ws.send(JSON.stringify([verb, event]), (error) => {
        if (!error) return;
        const waiter = this.okWaiters.get(event.id);
        if (waiter) {
          this.okWaiters.delete(event.id);
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`send failed: ${describeError(error)}`));
        }
      });
    });
  }
}
