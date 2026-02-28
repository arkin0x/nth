import { appendFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

export type BitcoinApiErrorLogEntry = {
  ts: string; // ISO
  op: string;
  url: string;
  status?: number;
  height?: number;
  hash?: string;
  message: string;
  bodySnippet?: string;
};

function getLogPath(): string {
  return resolve(process.env.NTH_BITCOIN_API_ERROR_LOG || '.nth/bitcoin_api_errors.jsonl');
}

function snippet(s: string, maxLen = 2000): string {
  const trimmed = (s ?? '').toString();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + `…(truncated, ${trimmed.length} chars)`;
}

export function logBitcoinApiError(entry: Omit<BitcoinApiErrorLogEntry, 'ts'>): void {
  const path = getLogPath();
  mkdirSync(dirname(path), { recursive: true });

  const full: BitcoinApiErrorLogEntry = {
    ts: new Date().toISOString(),
    ...entry,
  };

  if (full.bodySnippet) {
    full.bodySnippet = snippet(full.bodySnippet);
  }

  appendFileSync(path, JSON.stringify(full) + '\n', { encoding: 'utf8' });
}
