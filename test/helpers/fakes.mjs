// Test doubles: an in-memory nostr relay (with optional NIP-42), an Esplora
// HTTP API, and a spawner that runs the real worker against them in a
// throwaway NTH_HOME. Nothing here talks to the network beyond 127.0.0.1.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';
import { matchFilters, validateEvent, verifySignature } from 'nostr-tools';

const here = dirname(fileURLToPath(import.meta.url));
export const WORKER = resolve(here, '../../dist/index.js');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A free localhost port with nothing listening on it (a "down" relay). */
export async function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

/**
 * Fake relay.
 *   requireAuth: send an AUTH challenge on connect; refuse EVENT and REQ until authed.
 *   policy(event, ctx): return [ok, message] or null for the default (store; duplicate if seen).
 */
export async function startRelay({ requireAuth = false, policy = null, port = 0 } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise((r) => wss.once('listening', r));
  const url = `ws://127.0.0.1:${wss.address().port}`;

  const relay = {
    url,
    stored: new Map(), // id -> event
    eventsReceived: [], // every EVENT frame, in order
    reqs: [], // every REQ's filters
    authsAccepted: [], // pubkeys
    policy,
    connections: 0,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(r));
    },
    seed(events) {
      for (const e of events) relay.stored.set(e.id, e);
    },
  };

  wss.on('connection', (ws) => {
    relay.connections++;
    const challenge = createHash('sha256').update(String(Math.random())).digest('hex');
    let authed = null;
    if (requireAuth) ws.send(JSON.stringify(['AUTH', challenge]));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const [verb] = msg;

      if (verb === 'AUTH') {
        const ev = msg[1];
        const tag = (n) => ev.tags.find((t) => t[0] === n)?.[1];
        const ok = validateEvent(ev) && verifySignature(ev) && ev.kind === 22242 && tag('challenge') === challenge;
        if (ok) {
          authed = ev.pubkey;
          relay.authsAccepted.push(ev.pubkey);
        }
        ws.send(JSON.stringify(['OK', ev.id, ok, ok ? '' : 'invalid: bad auth']));
        return;
      }

      if (verb === 'EVENT') {
        const ev = msg[1];
        relay.eventsReceived.push(ev);
        if (requireAuth && !authed) {
          ws.send(JSON.stringify(['OK', ev.id, false, 'auth-required: you must auth']));
          return;
        }
        const custom = relay.policy ? relay.policy(ev, relay) : null;
        if (custom) {
          if (custom === 'silence') return; // never answer
          const [ok, message] = custom;
          if (ok) relay.stored.set(ev.id, ev);
          ws.send(JSON.stringify(['OK', ev.id, ok, message]));
          return;
        }
        if (!verifySignature(ev)) {
          ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: bad signature']));
          return;
        }
        if (relay.stored.has(ev.id)) {
          ws.send(JSON.stringify(['OK', ev.id, true, 'duplicate: already have this event']));
          return;
        }
        relay.stored.set(ev.id, ev);
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        return;
      }

      if (verb === 'REQ') {
        const [, subId, ...filters] = msg;
        relay.reqs.push(filters);
        if (requireAuth && !authed) {
          ws.send(JSON.stringify(['CLOSED', subId, 'auth-required: you must auth']));
          return;
        }
        let n = 0;
        const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
        for (const ev of relay.stored.values()) {
          if (n >= limit) break;
          if (matchFilters(filters, ev)) {
            ws.send(JSON.stringify(['EVENT', subId, ev]));
            n++;
          }
        }
        ws.send(JSON.stringify(['EOSE', subId]));
      }
    });
  });

  return relay;
}

const h64 = (s) => createHash('sha256').update(s).digest('hex');
export const blockHash = (h) => h64(`block:${h}`);
const merkle = (h) => h64(`merkle:${h}`);

/** Fake Esplora: blocks 0..tip exist. */
export async function startEsplora({ tip }) {
  const api = { tip, url: '' };
  const server = createServer((req, res) => {
    const send = (status, body, type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    let m;
    if (req.url === '/blocks/tip/height') return send(200, String(api.tip));
    if ((m = req.url.match(/^\/block-height\/(\d+)$/))) {
      const h = Number(m[1]);
      return h <= api.tip ? send(200, blockHash(h)) : send(404, 'Block not found');
    }
    if ((m = req.url.match(/^\/block\/([0-9a-f]{64})$/))) {
      for (let h = 0; h <= api.tip; h++) {
        if (blockHash(h) === m[1]) {
          return send(
            200,
            JSON.stringify({
              id: m[1],
              height: h,
              merkle_root: merkle(h),
              previousblockhash: h === 0 ? undefined : blockHash(h - 1),
            }),
            'application/json',
          );
        }
      }
      return send(404, 'Block not found');
    }
    send(404, 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api.url = `http://127.0.0.1:${server.address().port}`;
  api.close = () => new Promise((r) => server.close(r));
  return api;
}

/** A fresh runtime home. Never the real one. */
export function makeHome(prefix = 'nth-test-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  if (resolve(home).startsWith('/data/projects/nth')) throw new Error('refusing to use the real NTH_HOME');
  return home;
}

export function writeStateFile(home, nextHeight, role = 'tip') {
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', `${role}.json`), JSON.stringify({ nextHeight, updatedAt: 0 }));
}

export function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function readNdjson(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export const tagOf = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1];

/**
 * Run the real worker. The environment is built from scratch (no inherited
 * NTH_*), cwd is the temp home (so no .env is loaded), and NTH_HOME is the
 * temp home. Returns a handle with the live output and exit promise.
 */
export function startWorker({ home, relay, mirrors = [], esplora, privateKey, env = {} }) {
  if (!home || resolve(home).startsWith('/data/projects/nth')) throw new Error('worker needs a temp NTH_HOME');
  const child = spawn(process.execPath, [WORKER], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      NTH_HOME: home,
      NTH_ROLE: 'tip',
      NTH_RELAY: relay,
      NTH_MIRROR_RELAYS: mirrors.join(','),
      NTH_BITCOIN_API_BASE_URL: esplora,
      NTH_BITCOIN_API_ERROR_LOG: join(home, 'bitcoin_api_errors.jsonl'),
      NTH_PRIVATE_KEY: privateKey,
      NTH_CONFIRMATIONS: '1',
      NTH_PUBLISH_DELAY_MS: '5',
      NTH_NOT_MINED_DELAY_MS: '100',
      NTH_ERROR_BACKOFF_BASE_MS: '30',
      NTH_ERROR_BACKOFF_MAX_MS: '120',
      NTH_MIRROR_MIN_INTERVAL_MS: '0',
      NTH_MIRROR_RETRY_BASE_MS: '50',
      NTH_MIRROR_RETRY_MAX_MS: '200',
      NTH_MIRROR_AUTH_WAIT_MS: '300',
      NTH_MIRROR_OK_TIMEOUT_MS: '1000',
      NTH_MIRROR_CONNECT_TIMEOUT_MS: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = {
    child,
    pid: child.pid,
    out: '',
    exited: null,
  };
  child.stdout.on('data', (d) => (handle.out += d.toString()));
  child.stderr.on('data', (d) => (handle.out += d.toString()));
  handle.exit = new Promise((r) =>
    child.on('exit', (code, signal) => {
      handle.exited = { code, signal };
      r(handle.exited);
    }),
  );
  handle.stop = async () => {
    if (!handle.exited) {
      process.kill(child.pid, 'SIGTERM'); // exact pid of a process this test spawned
    }
    return handle.exit;
  };
  return handle;
}

export function stateNext(home) {
  return readJson(join(home, 'state', 'tip.json'))?.nextHeight ?? null;
}

export function archive(home) {
  return readNdjson(join(home, 'archive', 'published.tip.ndjson'));
}

export function misses(home) {
  return readNdjson(join(home, 'state', 'tip.mirror-missed.ndjson'));
}

export function pending(home) {
  return readJson(join(home, 'state', 'tip.pending.json'));
}
