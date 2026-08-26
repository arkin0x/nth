import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { generatePrivateKey } from 'nostr-tools';
import { resolve } from 'path';

export type KeySource =
  | { type: 'env'; key: string }
  | { type: 'file'; key: string; path: string }
  | { type: 'generated'; key: string; path: string };

const DEFAULT_KEY_PATH = resolve('.nth/private_key');

/** Where the key would live, given the environment. */
export function privateKeyPath(): string {
  return process.env.NTH_PRIVATE_KEY_PATH ? resolve(process.env.NTH_PRIVATE_KEY_PATH) : DEFAULT_KEY_PATH;
}

/**
 * Load the configured key, or null if there is none yet.
 *
 * Tools that only rebroadcast an existing corpus must never mint an identity:
 * a fresh key would sign anchors under a pubkey nobody follows, and would leave
 * a stray key file behind. They call this and abort on null.
 */
export function loadPrivateKey(): KeySource | null {
  const envKey = (process.env.NTH_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (envKey) {
    return { type: 'env', key: envKey };
  }

  const keyPath = privateKeyPath();
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath, 'utf8').trim();
    if (!key) {
      throw new Error(`Private key file exists but is empty: ${keyPath}`);
    }
    return { type: 'file', key, path: keyPath };
  }

  return null;
}

export function loadOrCreatePrivateKey(): KeySource {
  const existing = loadPrivateKey();
  if (existing) return existing;

  const keyPath = privateKeyPath();

  mkdirSync(resolve('.nth'), { recursive: true });

  const key = generatePrivateKey();
  writeFileSync(keyPath, key + '\n', { encoding: 'utf8', flag: 'wx' });

  // best-effort permissions hardening (POSIX)
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // ignore
  }

  return { type: 'generated', key, path: keyPath };
}
