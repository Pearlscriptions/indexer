# @pearlscriptions/indexer-api

Read-only HTTP API and CLI runtime for the Pearlscriptions indexer.

## Commands

```bash
npm run test --workspace @pearlscriptions/indexer-api
npm run sync --workspace @pearlscriptions/indexer-api
npm run status --workspace @pearlscriptions/indexer-api
npm run digest --workspace @pearlscriptions/indexer-api
npm run serve --workspace @pearlscriptions/indexer-api
npm run registry:check --workspace @pearlscriptions/indexer-api
```

## Runtime Shape

- `src/server.js` builds the public runtime.
- `src/read-api.js` exposes GET-only API routes.
- `src/persistent-indexer.js` performs Pearl RPC sync and reorg handling.
- `src/indexer.js` extracts Pearlscriptions and derives PRL-20 state.
- `src/storage.js` contains JSON-file and PostgreSQL storage adapters.
- `src/operator-metadata.js` validates optional read-only registry metadata.
- `src/registry-check-policy.js` restricts remote self-check URLs to public
  HTTPS or loopback-only HTTP.

This package must not accept wallet seeds, private keys, or unsigned signing
requests. It serves indexed public state only.

`registry:check` is a readiness helper only. It never registers an operator,
contacts an official registry, signs wallet messages, or broadcasts
transactions. Its JSON output includes a `readiness` section for public URL,
reward-address, challenge, and status/digest alignment diagnostics.
