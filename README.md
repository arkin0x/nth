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
- `NTH_RELAY` (default: `wss://cyberspace.nostr1.com`): the primary relay. Only its OK advances the resume state, and the cold-start frontier probe asks only this relay.
- `NTH_MIRROR_RELAYS` (default: none): comma-separated mirror relays. Best effort: each gets the same signed event after the primary accepted it, from a background queue, with NIP-42 auth like the primary. A mirror refusing, timing out or being down never stalls the chain and never causes a re-sign. Outcomes are logged per height (accepted, duplicate, REFUSED with the relay's reason), and every height a mirror did not take is appended to `$NTH_HOME/state/<role>.mirror-missed.ndjson` for catch-up from the archive.
- Mirror tuning (rarely needed): `NTH_MIRROR_MIN_INTERVAL_MS` (default `1000`, the gap between two publishes to one mirror), `NTH_MIRROR_RETRY_BASE_MS` / `NTH_MIRROR_RETRY_MAX_MS` (default `5000` / `300000`, reconnect and retry backoff), `NTH_MIRROR_MAX_ATTEMPTS` (default `5`, for rate-limited or unanswered publishes), `NTH_MIRROR_QUEUE_MAX` (default `10000`), `NTH_MIRROR_OK_TIMEOUT_MS`, `NTH_MIRROR_CONNECT_TIMEOUT_MS` (default `15000`), `NTH_MIRROR_AUTH_WAIT_MS` (default `5000`).
- `NTH_BITCOIN_API_BASE_URL` / `NTH_BITCOIN_API_BASE` (default: `https://mempool.space/api`)
- `NTH_START_HEIGHT` (override start height; otherwise resumes from last published height + 1)
- `NTH_PUBLISH_DELAY_MS` (default: `200`)
- `NTH_NOT_MINED_DELAY_MS` (default: `300000`)
- `NTH_ERROR_BACKOFF_BASE_MS` (default: `1000`)
- `NTH_ERROR_BACKOFF_MAX_MS` (default: `300000`)
- `NTH_OK_TIMEOUT_MS` (default: `15000`): how long to wait for the primary's OK before retrying (the retry resends the same event).
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

Under `NTH_HOME` (default `/data/projects/nth`):
- `state/<role>.json`: the resume point, advanced only after the primary's OK.
- `state/<role>.pending.json`: the anchor signed for the height in progress. Each height is signed once; retries and restarts publish this same event again, so a relay only ever sees one event id per height. It is cleared once the height is past.
- `state/<role>.mirror-missed.ndjson`: heights a mirror did not take.
- `archive/published.<role>.ndjson`: every signed anchor, written once per signing.
- `run/<role>.pid`: the worker pid. The single-instance lock itself is a Linux abstract unix socket named from `NTH_HOME` and the role, which the kernel grants to exactly one process and releases when it dies.

## Tests
`npm test` builds and runs the tests against fake relays and a fake Esplora API on 127.0.0.1, each in a throwaway `NTH_HOME`.

## License
Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). See `package.json`.
