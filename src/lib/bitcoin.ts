import axios from 'axios';

import { logBitcoinApiError } from './apiErrorLog.js';

export class BitcoinApiError extends Error {
  url: string;
  status?: number;
  body?: string;

  constructor(message: string, opts: { url: string; status?: number; body?: string }) {
    super(message);
    this.name = 'BitcoinApiError';
    this.url = opts.url;
    this.status = opts.status;
    this.body = opts.body;
  }
}

export type BitcoinApi = {
  baseUrl: string;
  getTipHeight(): Promise<number>;
  getBlockHashByHeight(height: number): Promise<string | null>; // null => 404 only
  getBlockByHash(hash: string, opts?: { heightHint?: number }): Promise<{
    hash: string;
    height: number;
    merkleRoot: string;
    prevBlockHash: string | null;
  }>;
};

export function createBitcoinApi(baseUrl: string): BitcoinApi {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  async function getText(url: string): Promise<{ status: number; data: string }> {
    try {
      const res = await axios.get(url, {
        responseType: 'text',
        validateStatus: () => true,
      });

      return { status: res.status, data: String(res.data ?? '').trim() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BitcoinApiError(`Network error calling bitcoin API: ${message}`, { url });
    }
  }

  async function getJsonRaw(url: string): Promise<{ status: number; rawBody: string; data: unknown | null }> {
    try {
      const res = await axios.get(url, {
        responseType: 'text',
        transformResponse: (r) => r,
        validateStatus: () => true,
      });

      const rawBody = String(res.data ?? '');
      if (res.status < 200 || res.status >= 300) {
        return { status: res.status, rawBody, data: null };
      }

      try {
        return { status: res.status, rawBody, data: JSON.parse(rawBody) };
      } catch {
        return { status: res.status, rawBody, data: null };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BitcoinApiError(`Network error calling bitcoin API: ${message}`, { url });
    }
  }

  return {
    baseUrl: normalizedBaseUrl,

    async getTipHeight(): Promise<number> {
      const url = `${normalizedBaseUrl}/blocks/tip/height`;
      const { status, data } = await getText(url);

      if (status < 200 || status >= 300 || !/^\d+$/.test(data)) {
        logBitcoinApiError({
          op: 'tip-height',
          url,
          status,
          message: 'Unexpected response for blocks/tip/height',
          bodySnippet: data,
        });
        throw new BitcoinApiError(`Bitcoin API returned HTTP ${status} for blocks/tip/height`, {
          url,
          status,
          body: data,
        });
      }

      return Number.parseInt(data, 10);
    },

    async getBlockHashByHeight(height: number): Promise<string | null> {
      const url = `${normalizedBaseUrl}/block-height/${height}`;
      let status: number;
      let data: string;

      try {
        ({ status, data } = await getText(url));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logBitcoinApiError({
          op: 'block-height',
          url,
          height,
          message: `Request failed: ${message}`,
        });
        throw err;
      }

      if (status === 404) {
        // Only 404 is treated as “not mined / unknown height”.
        return null;
      }

      if (status < 200 || status >= 300) {
        logBitcoinApiError({
          op: 'block-height',
          url,
          status,
          height,
          message: `Non-success response for block-height/${height}`,
          bodySnippet: data,
        });
        throw new BitcoinApiError(`Bitcoin API returned HTTP ${status} for block-height/${height}`, {
          url,
          status,
          body: data,
        });
      }

      if (!/^[0-9a-fA-F]{64}$/.test(data)) {
        logBitcoinApiError({
          op: 'block-height',
          url,
          status,
          height,
          message: `Unexpected body for block-height/${height} (expected 64-hex)`,
          bodySnippet: data,
        });
        throw new BitcoinApiError(`Bitcoin API returned unexpected body for block-height/${height}`, {
          url,
          status,
          body: data,
        });
      }

      return data;
    },

    async getBlockByHash(hash: string, opts?: { heightHint?: number }) {
      const url = `${normalizedBaseUrl}/block/${hash}`;

      type EsploraBlock = {
        id?: string;
        hash?: string;
        height?: number;
        merkle_root?: string;
        merkleRoot?: string;
        previousblockhash?: string;
        prev_block?: string;
        prevBlockHash?: string;
      };

      let status: number;
      let rawBody: string;
      let data: unknown | null;

      try {
        ({ status, rawBody, data } = await getJsonRaw(url));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logBitcoinApiError({
          op: 'block',
          url,
          height: opts?.heightHint,
          hash,
          message: `Request failed: ${message}`,
        });
        throw err;
      }

      if (status === 404) {
        logBitcoinApiError({
          op: 'block',
          url,
          status,
          height: opts?.heightHint,
          hash,
          message: `Block not found`,
          bodySnippet: rawBody,
        });
        throw new BitcoinApiError(`Block not found in bitcoin API: ${hash}`, { url, status, body: rawBody });
      }

      if (status < 200 || status >= 300 || !data) {
        logBitcoinApiError({
          op: 'block',
          url,
          status,
          height: opts?.heightHint,
          hash,
          message: `Non-success response for block/${hash}`,
          bodySnippet: rawBody,
        });
        throw new BitcoinApiError(`Bitcoin API returned HTTP ${status} for block/${hash}`, {
          url,
          status,
          body: rawBody,
        });
      }

      const b = data as EsploraBlock;

      const blockHash = (b.id || b.hash || hash).toString();
      const height = Number(b.height);
      const merkleRoot = (b.merkle_root || b.merkleRoot || '').toString();
      const prevBlockHash = (b.previousblockhash || b.prev_block || b.prevBlockHash || null)?.toString() ?? null;

      if (!Number.isFinite(height)) {
        logBitcoinApiError({
          op: 'block',
          url,
          status,
          height: opts?.heightHint,
          hash,
          message: `Invalid height in response`,
          bodySnippet: rawBody,
        });
        throw new BitcoinApiError(`Bitcoin API returned invalid height for block ${hash}`, {
          url,
          status,
          body: rawBody,
        });
      }

      if (!/^[0-9a-fA-F]{64}$/.test(merkleRoot)) {
        logBitcoinApiError({
          op: 'block',
          url,
          status,
          height,
          hash,
          message: `Invalid merkle_root in response`,
          bodySnippet: rawBody,
        });
        throw new BitcoinApiError(`Bitcoin API returned invalid merkle_root for block ${hash}`, {
          url,
          status,
          body: rawBody,
        });
      }

      if (prevBlockHash !== null && !/^[0-9a-fA-F]{64}$/.test(prevBlockHash)) {
        logBitcoinApiError({
          op: 'block',
          url,
          status,
          height,
          hash,
          message: `Invalid previous block hash in response`,
          bodySnippet: rawBody,
        });
        throw new BitcoinApiError(`Bitcoin API returned invalid previous block hash for block ${hash}`, {
          url,
          status,
          body: rawBody,
        });
      }

      return { hash: blockHash, height, merkleRoot, prevBlockHash };
    },
  };
}

export function getBitcoinApiBaseUrlFromEnv(): string {
  // mempool.space runs Esplora endpoints at /api
  return (
    process.env.NTH_BITCOIN_API_BASE_URL ||
    process.env.NTH_BITCOIN_API_BASE ||
    'https://mempool.space/api'
  ).trim();
}
