# Public API Contract

This repository ships a read-only Pearlscriptions and PRL-20 indexer API. It is meant for independent operators who want to reproduce canonical inscription numbers, PRL-20 state, transfer lots, and public indexed metadata without running the official wallet, marketplace, or any settlement stack.

The official Pearlscriptions marketplace is an application layer built on top of transfer lots. It is not part of this public indexer release.

The server accepts `GET` requests only. Any `POST`, `PUT`, `PATCH`, or `DELETE` request returns `405 METHOD_NOT_ALLOWED`. It never accepts wallet seeds, private keys, WIFs, mnemonics, RPC passwords, or signing material.

## Health

### `GET /health`

Returns public service health and sanitized indexer status.

Important fields:

- `ok`
- `service`
- `chain`
- `readOnly`
- `indexer`

### `GET /indexer/status`

Returns sanitized sync status.

Important fields:

- `enabled`
- `mode`
- `chain`
- `indexedHeight`
- `bestHeight`
- `synced`
- `blocksStored`
- `reorgCount`

### `GET /indexer/digest`

Returns the normalized snapshot digest operators can compare across independent indexers.

Important fields:

- `chain`
- `indexedHeight`
- `indexedHash`
- `snapshotDigest`
- `releaseManifestDigest`
- `summary`

## PRL-20

### `GET /network`

Returns chain metadata for the active snapshot.

### `GET /tokens`

Returns deployed PRL-20 token summaries.

### `GET /tokens/:ticker`

Returns deploy, mint, holder, and progress state for one ticker.

### `GET /operations`

Returns indexed PRL-20 operations.

Query parameters:

- `page`: 1-based page number
- `offset`: zero-based offset, ignored when `page` is present
- `limit`: default `48`, max `100`

### `GET /tx/:txid/status`

Returns the indexed confirmation status for one transaction when it is known,
or `status: "unknown"` when the transaction is not present in the current
snapshot.

## Pearlscriptions

### `GET /inscriptions`

Returns ordered Pearlscriptions. Numbering is canonical and zero-based.

Query parameters:

- `page`: 1-based page number
- `offset`: zero-based offset, ignored when `page` is present
- `limit`: default `48`, max `100`
- `order`: `asc` or `desc`

### `GET /inscriptions/:id`

Returns public inscription metadata.

### `GET /inscriptions/:id/content`

Returns safe content metadata and preview payloads.

### `GET /inscriptions/:id/location`

Returns current and historical location details.

### `GET /addresses/:address/inscriptions`

Returns inscriptions currently owned by an address where ownership is known. Supports the same pagination fields as `/inscriptions`.

## Wallet Public Data

### `GET /addresses/:address/balances`

Returns indexed public PRL-20 balances and, when available, PRL UTXO balance.

### `GET /addresses/:address/transfer-lots`

Returns transferable PRL-20 lots currently owned by the address, plus ticker-level totals for confirmed and pending transferable amounts.

### `GET /addresses/:address/utxos`

Returns public UTXO data. Inscription-bearing or PRL-20 transfer-lot outputs are marked with:

- `protected`
- `protectionReason`
- `inscriptionId`
- `inscriptionNumber`
- `transferLotId`
- `spendable`

Wallets should avoid spending protected outputs by default.

## Not Included

This public release does not expose `/market/*` routes, orderbook state, seller
packages, listing events, trade execution, or settlement APIs.

## Caching

Live health/status responses should use `no-store`. Snapshot read routes may use short public caching and ETags if the operator proxy supports them.
