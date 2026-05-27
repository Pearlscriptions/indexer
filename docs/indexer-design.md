# Indexer Design

This document describes the public read-only indexer shape. It is a companion to
the higher-level [architecture](architecture.md) and [API contract](api-contract.md).

## Responsibilities

The indexer has two deterministic layers:

1. Pearlscriptions base layer: discover generic Pearl Taproot witness
   inscriptions, preserve marker/content metadata, assign canonical numbers, and
   track current ownership where the owner output is known.
2. PRL-20 derived layer: parse `prl-20` JSON inscriptions and derive token
   deploy, mint, transfer-lot, and balance state.

Pearl consensus validates blocks and transactions. Pearlscriptions and PRL-20
validity are metaprotocol rules derived from confirmed chain data.

## Canonical Ordering

Confirmed Pearlscriptions are ordered by:

1. block height
2. transaction index in the block
3. input/reveal order
4. envelope order inside the executed tapscript leaf

The first indexed Pearlscription is `#0`.

Mempool observations are provisional and must not create final numbering.

## Witness Extraction

The parser inspects only the executed Taproot script-path leaf immediately before
a plausible Taproot control block. It ignores envelope-like bytes in signatures,
annex-like data, or unrelated witness stack items.

The envelope shape is:

```text
OP_FALSE
OP_IF
  <marker>
  <content-type>
  0x00
  <body-bytes, possibly split across <=520 byte pushes>
OP_ENDIF
```

Body chunks are concatenated into one logical payload.

## Persistence

The public runtime can use:

- PostgreSQL for production operation
- JSON-file storage for local development and fixture checks

Stored state includes:

- indexer manifest and chain identity
- canonical raw blocks
- latest derived snapshot
- Postgres read models for paginated inscription, address, UTXO, token, and
  transfer-lot routes

Startup fails closed when stored chain metadata does not match the configured
chain.

## Public API

The HTTP server serves read-only `GET` routes. Non-GET requests return
`405 METHOD_NOT_ALLOWED`.

Core surfaces:

```text
GET /health
GET /indexer/status
GET /indexer/digest
GET /network
GET /tokens
GET /tokens/:ticker
GET /operations
GET /tx/:txid/status
GET /inscriptions
GET /inscriptions/:id
GET /inscriptions/:id/content
GET /inscriptions/:id/location
GET /addresses/:address/inscriptions
GET /addresses/:address/balances
GET /addresses/:address/transfer-lots
GET /addresses/:address/utxos
```

The official Pearlscriptions marketplace is an application layer built on top of
transfer lots. It is not part of this public indexer release.

## Reorg Handling

The persistent scanner compares stored tip hashes with Pearl RPC. When a
disconnect is detected, it rolls back to the common ancestor and rebuilds the
derived snapshot from canonical stored blocks.

Indexers should compare `/indexer/digest` only at the same chain, height, block
hash, and release manifest digest.

## Safety Boundary

The public indexer does not:

- create wallets
- hold seeds or private keys
- sign transactions
- mine blocks
- expose transaction broadcast routes
- expose marketplace, orderbook, seller-package, or trading routes
- run settlement mutation endpoints
- require operator-specific infrastructure details in the repository
