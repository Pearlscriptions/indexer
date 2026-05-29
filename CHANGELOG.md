# Changelog

## v1.1.0 - 2026-05-29

Operator registry compatibility release.

What changed:

- Added optional read-only operator metadata endpoints:
  `GET /operator` and `GET /.well-known/pearlscriptions-indexer.json`.
- Added optional `PRL20_OPERATOR_*` environment variables for public operator
  name, public HTTPS URL, reward address, region, contact URL, and registry
  challenge.
- Added `npm run registry:check` as a local/self-check helper for operator
  registry readiness. It does not register with any official service.
- Added public metadata validation for plain-text fields, public HTTPS URL
  origins, HTTPS contact URLs, optional Pearl reward addresses, endpoint shape,
  and registry proof status.
- Documented the official registry flow based on a Public HTTPS Indexer
  URL, URL-control challenge, wallet-selected reward address, health checks,
  digest comparison, uptime scoring, and manual Genesis Oyster reward review.

Security boundary:

The public indexer remains read-only, deterministic, non-custodial, and free of
wallet creation, private keys, message signing, transaction broadcast,
marketplace orderbook, registry backend, and reward distribution logic.

## v1.0.0 - 2026-05-26

First operator-ready Pearlscriptions indexer release.

What is included:

- Deterministic Pearlscriptions witness parsing and canonical inscription numbering.
- PRL-20 deploy, mint, transfer-lot, balance, holder, and supply indexing.
- PRLS launch policy through a release manifest, including the required `1 PRL` per credited PRLS mint.
- PostgreSQL-backed persistent storage and read models.
- Read-only HTTP API for health, indexer status, digests, tokens, operations, inscriptions, balances, UTXOs, and transfer lots.
- CLI commands for sync, serve, status, digest, verification, and database migration.
- Golden fixtures from real Pearl simnet Taproot witness inscription proofs.
- Operator documentation, API contract, consensus notes, and configuration reference.

Security boundary:

This release does not create wallets, hold keys, sign transactions, broadcast transactions, expose the official marketplace, or settle trades. It is intentionally read-only infrastructure for independent state verification.

Final public release cleanup:

- Removed marketplace implementation surfaces: routes, parser state, example fixtures, snapshot summary fields, and read-model tables.
- Kept PRL-20 transfer lots, transfer-lot ownership movement, UTXO protection, and balance crediting when transfer-lot UTXOs move.
- Fixed the Postgres schema so manifest-scoped block storage can migrate cleanly without invalid single-column block-height foreign keys.
- Fixed workspace script config loading so root release-manifest defaults are resolved consistently.
- Added the documented `GET /operations` API and strengthened GET-only route tests.
