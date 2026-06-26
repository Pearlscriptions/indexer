# Operator Guide

This guide is for running an independent Pearlscriptions and PRL-20 indexer.

The goal is simple: scan your own Pearl node, serve read-only state, and compare
your digest with other operators.

## Requirements

- Node.js `22` or newer
- PostgreSQL `15` or newer
- A synced Pearl full node with RPC enabled
- Disk space for indexed raw blocks and Postgres read models

Pearl mainnet defaults:

```text
P2P: 44108
RPC: 44107
```

The current operator-tested Pearl node path is the Pearl source branch
`node/presync3` at commit `d5e5de77c3d48951ddb0d0c25a861d7627b9cab4`.
If upstream Pearl publishes a newer operator release, prefer that release and
record the exact commit you run.

## Install

```bash
git clone https://github.com/Pearlscriptions/indexer.git
cd indexer
npm install
npm run verify
cp .env.example .env
```

Edit `.env` before syncing. At minimum:

```text
PEARL_RPC_URL=http://127.0.0.1:44107
PEARL_RPC_USER=...
PEARL_RPC_PASSWORD=...
PRL20_DATABASE_URL=postgres://...
```

Never put wallet seeds, private keys, WIFs, or hot wallet material on the
indexer host.

## Database

For local evaluation:

```bash
docker compose up -d postgres
npm run db:migrate
```

Some hosts install the legacy Compose binary as `docker-compose` instead of the
newer `docker compose` plugin. Either command is fine as long as it starts the
`postgres` service from this repository.

For production, use a managed or supervised Postgres instance and apply the same
schema with `npm run db:migrate`.

When running the indexer inside a container mounted at `/app`, set:

```text
PRL20_RELEASE_MANIFEST=/app/release-manifest.example.json
```

## Sync

```bash
npm run indexer:sync
npm run indexer:status
npm run indexer:digest
```

The digest is the main comparison tool between independent operators. Compare it
only when indexers report the same Pearl tip height and hash.

## v1.3.0 Read-Model Mode

v1.3.0 adds optional incremental Postgres read-model publishing for the private
sync worker:

```text
PRL20_INDEXER_READ_MODEL_MODE=incremental
```

Leave the variable unset, or set it to `full`, to keep the older conservative
full publish behavior. Incremental mode is intended for production Postgres
operators after the first full publish has completed. It affects only
materialized read-model tables such as `indexer_read_utxos`; it does not alter
Pearlscriptions parsing, PRL-20 state, or `/indexer/digest`.

Recommended rollout:

1. Upgrade to v1.3.0.
2. Run `npm run verify`.
3. Run `npm run db:migrate` to add the optional v1.3.0 read-model performance
   index.
4. Start the worker once in default `full` mode and let it publish a complete
   snapshot.
5. Enable `PRL20_INDEXER_READ_MODEL_MODE=incremental` on the private sync
   worker, not on public API-only processes.
6. Watch worker output for `readModelMode: "incremental"`, lower `readModelMs`,
   small `touchedRows.utxos`, no lag growth, and stable memory.

Rollback is immediate: unset `PRL20_INDEXER_READ_MODEL_MODE` or set it to
`full`, then restart the worker. No data deletion is required for either
direction.

## Serve

```bash
npm run indexer:serve
```

The API binds to `127.0.0.1:3000` by default. Put nginx, Caddy, or another
reverse proxy in front of it before exposing it publicly.

The public package is read-only. Non-GET requests return
`405 METHOD_NOT_ALLOWED`.

The official Pearlscriptions marketplace is an application layer built on top of
transfer lots. It is not part of this public indexer release, and this package
does not expose orderbook, trading, seller-package, or settlement APIs.

## Operational Checks

Useful routes:

```text
GET /health
GET /operator
GET /indexer/status
GET /indexer/digest
GET /tokens/prls
GET /inscriptions?page=1&limit=48
```

Monitor:

- Pearl node height versus indexer height
- current indexed block hash
- `/indexer/digest` at known tips
- worker `readModelMode`, `readModelMs`, and `touchedRows`
- Postgres disk usage
- API error rate
- reorg count

## Registry Readiness

v1.1 adds local compatibility helpers for the official Pearlscriptions operator
registry. The registry backend, website registration flow, wallet proof, and
rewards are not part of this public indexer package.

To appear in the public operator list at
[pearlscriptions.com/indexers](https://www.pearlscriptions.com/indexers), an
indexer needs a public HTTPS URL that the official checker can reach. Operators
do not need to buy a custom domain. Acceptable public HTTPS origins can come
from a VPS/app provider hostname, an HTTPS tunnel, dynamic DNS, an `sslip.io` or
`nip.io` style hostname, or a custom domain. `http://localhost`,
`http://127.0.0.1`, and `http://[::1]` are only for local self-checks and are not
public registry URLs.

Use a stable public indexer URL for registration. Cloudflare quick tunnels are
useful for a short beta test, but they can change or disappear; they are not a
great long-term registry identity unless you pin them behind a stable hostname.

Optional public metadata can be configured in `.env`:

```text
PRL20_OPERATOR_NAME="Example Operator"
PRL20_OPERATOR_PUBLIC_URL=https://indexer.example
PRL20_OPERATOR_REWARD_ADDRESS=prl1...
PRL20_OPERATOR_REGION=EU
PRL20_OPERATOR_CONTACT_URL=https://example.com
PRL20_OPERATOR_REGISTRY_CHALLENGE=registry-challenge-from-official-site
```

`PRL20_OPERATOR_PUBLIC_URL` is the public HTTPS origin that other machines can
reach. Do not put a local API URL there. Local URLs such as
`http://127.0.0.1:3000` are only for `registry:check -- --url` on your own
machine.

The metadata is served read-only at:

```text
GET /operator
GET /.well-known/pearlscriptions-indexer.json
```

Run a local readiness check without contacting any official registry:

```bash
npm run registry:check
```

To check an explicitly provided running endpoint, pass a URL:

```bash
npm run registry:check -- --url https://indexer.example
```

The self-check only fetches fixed read-only paths from the URL you provide:
`/health`, `/indexer/status`, `/indexer/digest`, and `/operator`.
The JSON output includes a `readiness` section so operators can see whether the
public URL, reward address, challenge, and status/digest alignment are ready for
manual registry review.

The official registry beta flow works like this:

1. Run the indexer and expose it through a public HTTPS URL.
2. Open [pearlscriptions.com/indexers](https://www.pearlscriptions.com/indexers).
3. Select the Pearl reward address in the official website wallet flow.
4. Submit the public indexer URL.
5. Copy the generated registry challenge into
   `PRL20_OPERATOR_REGISTRY_CHALLENGE`.
6. Restart the indexer.
7. Run `npm run registry:check -- --url https://your-indexer.example`.
8. Let the official backend checker verify
   `/.well-known/pearlscriptions-indexer.json`, `/health`,
   `/indexer/status`, and `/indexer/digest`.

The website must not fetch arbitrary operator URLs from the browser. Only the
official backend/checker should perform remote checks.

Reward-address proof is wallet-selected but cryptographically deferred for
v1.1. Operators should use an address they control, but this public indexer
never signs wallet messages, creates wallets, broadcasts transactions, or pays
rewards. Genesis Oyster reward selection remains manual and outside this
repository.

## Backup

Back up PostgreSQL. If using the JSON-file store for development, back up the
store directory too.

The indexer can rescan from Pearl RPC, but backups reduce recovery time and make
operator comparisons easier during incidents.
