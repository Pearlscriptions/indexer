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

For production, use a managed or supervised Postgres instance and apply the same
schema with `npm run db:migrate`.

## Sync

```bash
npm run indexer:sync
npm run indexer:status
npm run indexer:digest
```

The digest is the main comparison tool between independent operators. Compare it
only when indexers report the same Pearl tip height and hash.

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
GET /indexer/status
GET /indexer/digest
GET /tokens/prls
GET /inscriptions?page=1&limit=48
```

Monitor:

- Pearl node height versus indexer height
- current indexed block hash
- `/indexer/digest` at known tips
- Postgres disk usage
- API error rate
- reorg count

## Backup

Back up PostgreSQL. If using the JSON-file store for development, back up the
store directory too.

The indexer can rescan from Pearl RPC, but backups reduce recovery time and make
operator comparisons easier during incidents.
