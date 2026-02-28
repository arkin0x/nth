import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { generatePrivateKey } from 'nostr-tools';
import { resolve } from 'path';

export type KeySource =
  | { type: 'env'; key: string }
  | { type: 'file'; key: string; path: string }
  | { type: 'generated'; key: string; path: string };

const DEFAULT_KEY_PATH = resolve('.nth/private_key');

export function loadOrCreatePrivateKey(): KeySource {
  const envKey = (process.env.NTH_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
  if (envKey) {
    return { type: 'env', key: envKey };
  }

  const keyPath = process.env.NTH_PRIVATE_KEY_PATH
    ? resolve(process.env.NTH_PRIVATE_KEY_PATH)
    : DEFAULT_KEY_PATH;

  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath, 'utf8').trim();
    if (!key) {
      throw new Error(`Private key file exists but is empty: ${keyPath}`);
    }
    return { type: 'file', key, path: keyPath };
  }

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
