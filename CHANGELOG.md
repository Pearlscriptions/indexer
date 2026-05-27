# Changelog

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
