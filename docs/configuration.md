# Configuration Reference

Configuration is read from environment variables. Copy `.env.example` to `.env`
for local use, then replace placeholders before syncing.

Do not commit `.env`.

The CLI and server load a local `.env` file automatically when one is present.
Values exported in the shell still take precedence over the file.

## Core

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime mode. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind a firewall or reverse proxy. |
| `PORT` | `3000` | HTTP API port. |
| `PRL20_CHAIN` | manifest network | Use `pearl-mainnet` for mainnet. |
| `PRL20_RELEASE_MANIFEST` | `./release-manifest.example.json` | Manifest that pins PRLS launch policy and fee recipient. Use `/app/release-manifest.example.json` when running from a container mounted at `/app`. |

## Pearl RPC

| Variable | Default | Notes |
| --- | --- | --- |
| `PEARL_RPC_URL` | empty | Required for live sync, usually `http://127.0.0.1:44107` on mainnet. |
| `PEARL_RPC_USER` | empty | Pearl RPC username. |
| `PEARL_RPC_PASSWORD` | empty | Pearl RPC password. |
| `PEARL_RPC_TIMEOUT_MS` | `30000` | RPC request timeout. |
| `PEARL_RPC_RETRIES` | `3` | Retry count for transient RPC failures such as 503, 429, network resets, or timeouts. |
| `PEARL_RPC_RETRY_DELAY_MS` | `750` | Base retry delay. Attempts use a small linear backoff. |

If `PEARL_RPC_URL` is empty, the API uses bundled fixtures. This is useful for
tests and smoke checks, not for a live operator endpoint.

## Storage

| Variable | Default | Notes |
| --- | --- | --- |
| `PRL20_INDEXER_STORAGE_BACKEND` | `json-file` | Use `postgres` for production. |
| `PRL20_DATABASE_URL` | empty | PostgreSQL connection string. `DATABASE_URL` is also accepted. |
| `PRL20_INDEXER_STORE_DIR` | `./indexer-store` | JSON-file store path for local/dev mode. |
| `PRL20_INDEXER_MANIFEST_NAME` | chain | Names the stored canonical indexer manifest. |

## Sync

| Variable | Default | Notes |
| --- | --- | --- |
| `PRL20_INDEXER_START_HEIGHT` | `0` | First block height to scan. |
| `PRL20_INDEXER_BATCH_SIZE` | `100` | Blocks fetched per sync batch, clamped to `1-1000`. |
| `PRL20_INDEXER_BACKGROUND_SYNC_MS` | `30000` | Background sync interval while serving. Set `0` to disable. |
| `PRL20_INDEXER_SYNC_ON_START` | `1` | Set `0` to load stored state without syncing on boot. |
| `PRL20_INDEXER_REBUILD_CHUNK_SIZE` | `250` | Blocks folded per chunk during cold-start/full rebuild, clamped to `1-5000`. |
| `PRL20_INDEXER_READ_MODEL_MODE` | `full` | Set `incremental` on a Postgres sync worker to publish only touched read-model UTXOs on pure append syncs. Reorgs and cold starts still publish full read models. |
| `PRL20_INDEXER_PARITY_CHECK_EVERY_N_BLOCKS` | `0` | Optional safety cadence for protocol/read-model parity checks. `0` disables the extra check. |

`PRL20_INDEXER_READ_MODEL_MODE=incremental` is an operator performance flag, not
a protocol flag. It does not change Pearlscriptions numbering, PRL-20 balances,
token validity, or `/indexer/digest`. Existing deployments keep the conservative
full read-model publish path unless they explicitly opt in.

Recommended production rollout:

1. Upgrade and run `npm run db:migrate` to add the optional v1.3.0 read-model
   performance index.
2. Let the worker complete one normal full publish.
3. Set `PRL20_INDEXER_READ_MODEL_MODE=incremental` only on the private sync
   worker.
4. Restart the worker and watch `readModelMode`, `readModelMs`, `touchedRows`,
   lag, RSS memory, and API status.
5. Roll back by unsetting the flag or setting it to `full`, then restarting the
   worker. No data deletion is required.

## Optional Operator Registry Metadata

These fields are optional and empty by default. They only affect the read-only
`GET /operator` and `GET /.well-known/pearlscriptions-indexer.json` metadata
documents plus the local `npm run registry:check` command. They do not register
with the official Pearlscriptions registry and do not prove reward eligibility
by themselves.

For future public registry listing, `PRL20_OPERATOR_PUBLIC_URL` should be a
public HTTPS origin reachable by the official checker. A custom domain is not
required: a stable provider hostname, HTTPS tunnel, dynamic DNS hostname, or
custom domain can all work if they serve this indexer over HTTPS. Local HTTP
URLs are accepted only for local self-checks.

If a value contains spaces, quote it in `.env`, for example
`PRL20_OPERATOR_NAME="Pearl Operator"`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PRL20_OPERATOR_NAME` | empty | Public display name, max 80 plain-text characters. |
| `PRL20_OPERATOR_PUBLIC_URL` | empty | Public HTTPS origin for this indexer. No path, query string, fragment, or credentials. |
| `PRL20_OPERATOR_REWARD_ADDRESS` | empty | Optional Pearl reward address selected in the future official website flow. It is never required for running an indexer. |
| `PRL20_OPERATOR_REGION` | empty | Optional public region label, max 40 plain-text characters. |
| `PRL20_OPERATOR_CONTACT_URL` | empty | Optional HTTPS contact/profile URL. |
| `PRL20_OPERATOR_REGISTRY_CHALLENGE` | empty | Optional short-lived registry URL-proof challenge value. |

Reward-address proof is wallet-selected but cryptographically deferred for
v1.1. The future official registry may bind the selected reward address to the
URL challenge, but this indexer never receives wallet seeds, private keys, WIFs,
wallet exports, or signing material.

## Safety Defaults

- Mainnet mode requires a non-placeholder PRLS fee recipient and scriptPubKey in
  the release manifest.
- The public API is read-only.
- Non-GET requests return `405 METHOD_NOT_ALLOWED`.
- Status output removes local storage paths.
