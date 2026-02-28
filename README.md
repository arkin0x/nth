# nth
`nth` is a Node/TypeScript publisher that turns Bitcoin blocks into Nostr-based “hyperjump” objects for the Nakamoto Thermodynamic Hypertransit (NTH) in [cyberspace](https://github.com/arkin0x/cyberspace).

For each block height, it:
- Fetches block data from an Esplora-compatible Bitcoin API (default: mempool.space)
- Derives a sector coordinate from the block merkle root
- Publishes a Nostr event (kind `321`) to a relay

## Requirements
- Node.js (recent LTS recommended)
- npm

## Install
```bash path=null start=null
npm install
```

## Run
```bash path=null start=null
npm start
```

This runs:
- `npm run build` (TypeScript → `dist/`)
- `npm run run` (executes `node ./dist/index.js`)

## Configuration
The app loads environment variables via `dotenv`, so you can create a local `.env` file.

### Private key
You can provide a Nostr private key via environment variable:
- `NTH_PRIVATE_KEY` (or `PRIVATE_KEY`)

If no key is provided, a new key is generated and written to:
- `.nth/private_key`

### Other options
- `NTH_RELAY` (default: `wss://cyberspace.nostr1.com`)
- `NTH_BITCOIN_API_BASE_URL` / `NTH_BITCOIN_API_BASE` (default: `https://mempool.space/api`)
- `NTH_START_HEIGHT` (override start height; otherwise resumes from last published height + 1)
- `NTH_PUBLISH_DELAY_MS` (default: `200`)
- `NTH_NOT_MINED_DELAY_MS` (default: `300000`)
- `NTH_ERROR_BACKOFF_BASE_MS` (default: `1000`)
- `NTH_ERROR_BACKOFF_MAX_MS` (default: `300000`)
- `NTH_BITCOIN_API_ERROR_LOG` (default: `.nth/bitcoin_api_errors.jsonl`)

Example `.env`:
```dotenv path=null start=null
# Nostr
NTH_RELAY=wss://cyberspace.nostr1.com
# NTH_PRIVATE_KEY=<hex private key>

# Bitcoin API (Esplora)
NTH_BITCOIN_API_BASE_URL=https://mempool.space/api

# Optional start height override
# NTH_START_HEIGHT=0
```

## Event format
Publishes kind `321` with tags:
- `C`: merkle root (32-byte / 64-hex)
- `X`, `Y`, `Z`: sector coordinates derived from `C`
- `S`: `${X}-${Y}-${Z}`
- `H`: block hash
- `P`: previous block hash (or 64 zeros for height 0)
- `N`: next block hash
- `B`: block height

## Local state
`.nth/` contains local runtime state (generated private key, error logs) and is ignored by git.

## License
Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). See `package.json`.
