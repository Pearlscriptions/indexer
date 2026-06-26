# Public API Contract

This repository ships a read-only Pearlscriptions and PRL-20 indexer API. It is meant for independent operators who want to reproduce canonical inscription numbers, PRL-20 state, transfer lots, and public indexed metadata without running the official wallet, marketplace, or any settlement stack.

The official Pearlscriptions marketplace is an application layer built on top of transfer lots. It is not part of this public indexer release.

The server accepts `GET` requests only. Any `POST`, `PUT`, `PATCH`, or `DELETE` request returns `405 METHOD_NOT_ALLOWED`. It never accepts wallet seeds, private keys, WIFs, mnemonics, RPC passwords, or signing material.

## MoE Hard-Fork Advisory Fields (v1.2.1+)

Since the Pearl MoE hard fork (`pearld >= v1.1.0`, activated 2026-06-12) the API
exposes advisory chain-canonicality fields. They are **additive, optional, and
read-only**, never alter PRL-20 state, and are **excluded from the protocol
snapshot digest** (the digest stays byte-identical for the same chain). These
field names and enums are a frozen contract shared with the operator registry
checker.

On `/health` and `/indexer/status`:

- `indexerVersion`: string or `null`.
- `pearlNodeVersion`: `{ raw, semver: {major,minor,patch}|null, meetsMinimum: boolean|null, minimum: "1.1.0" }` or `null`. Best-effort from the node's `getnetworkinfo`; carries only a version string, never a host or path.
- `checkpoint`: `{ status, height, expectedHash, observedHash }` where `status ∈ { "match", "mismatch", "unknown" }`. `mismatch` means the node is on a stale/non-canonical chain; `unknown` means no applicable checkpoint yet (e.g. not synced past it, or unconfigured).
- `forkEra`: `"moe-v2"`.
- `nodeSchema`: `"compatible" | "incompatible" | "unknown"` (the `getblock` schema safety net).
- `message` (on `/indexer/status`) / `warning` (on `/health`, present only when non-null): a human advisory string. `/health.ok` stays `true` even on mismatch — it is advisory, not an availability failure.

On `/indexer/digest`: `checkpoint`, `forkEra`, and `pearlNodeVersion` are exposed
as **sibling** keys and are explicitly not part of the hashed snapshot digest.

On `/operator`: a static `forkEra: "moe-v2"` (optional; omitted when unset). No
other advisory field is added there, to keep operator-document validation
backward compatible.

Release manifest: `canonicalCheckpoints: [{ height, hash }]` and `forkEra`. On
`pearl-mainnet` at least one non-placeholder checkpoint is required and the
service fails fast at startup until a real post-fork `{height, hash}` from a
`pearld >= v1.1.0` node is provided.

## Health

### `GET /health`

Returns public service health and sanitized indexer status.

Important fields:

- `ok`
- `service`
- `chain`
- `version`
- `readOnly`
- `indexer`

### `GET /operator`

Returns optional public operator metadata for future registry compatibility. It
is read-only and may be empty by default.

Important fields:

- `schema`
- `service`
- `readOnly`
- `configured`
- `chain`
- `version`
- `endpoints`
- `operator`
- `registry`

The response must not include RPC credentials, database URLs, local paths,
private IPs, wallet material, or signing payloads.

`operator.publicUrl`, when configured, must be a public HTTPS origin with no
path, query string, fragment, or credentials. A custom domain is not required;
the URL can be any stable public HTTPS hostname that serves this indexer.

`registry.rewardAddressProof` is `wallet-selected-deferred` when a reward
address is configured and `not-configured` otherwise. It does not mean the
public indexer has verified wallet control. Any future wallet proof belongs to
the official registry application layer, not this API.

### `GET /.well-known/pearlscriptions-indexer.json`

Returns the same operator metadata document as `/operator`, suitable for future
URL-control challenge checks.

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
