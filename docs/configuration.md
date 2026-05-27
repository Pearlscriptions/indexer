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
| `PRL20_RELEASE_MANIFEST` | `./release-manifest.example.json` | Manifest that pins PRLS launch policy and fee recipient. |

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

## Safety Defaults

- Mainnet mode requires a non-placeholder PRLS fee recipient and scriptPubKey in
  the release manifest.
- The public API is read-only.
- Non-GET requests return `405 METHOD_NOT_ALLOWED`.
- Status output removes local storage paths.
