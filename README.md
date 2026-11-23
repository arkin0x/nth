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

## Disclaimer

This software is experimental. It is provided "as is", without warranty of any kind. Use it at your own risk.

- **Your keys, funds and agents are your responsibility.** Anyone who has your private key, your signer or your wallet connection string can act as you or spend from your wallet. Keep them safe and keep backups. Nobody can recover them for you.
- **Lightning payments are final.** A payment that has been sent cannot be reversed, and nobody has to refund it.
- **Not financial advice.** Nothing in this software or its documentation is financial, investment, legal or tax advice.
- **Other people's services can fail.** This software relies on things the author does not run: nostr relays, Lightning wallets and nodes, ecash mints, hosting and other services. They can go down, lose data, refuse service or change without notice.
- **Nostr is public.** What you publish can be copied by anyone and may never be fully deleted.
- **AI agents make mistakes.** If you connect an AI agent to this software, you are responsible for everything it does, including what it publishes, signs and pays for.
- **No liability.** To the fullest extent the law allows, the author (arkinox) and the contributors are not liable for any loss or damage of any kind that comes from using this software, including lost funds, keys, data or work, whether it is caused by a bug, a relay, a mint, a wallet, another service, an AI agent or anything else.

This is a plain-language summary. The license in this repository governs, and its disclaimer of warranties and limitation of liability apply in full.

## License
© 2024-2026 arkinox, licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). The full legal code is in `LICENSE`.
