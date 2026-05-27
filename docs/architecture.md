# Architecture

The public indexer is intentionally narrow. It reads Pearl chain data,
reconstructs Pearlscriptions and PRL-20 state, and serves that state through a
read-only API.

It is not a wallet, broadcaster, operator console, marketplace, or settlement service.

The official Pearlscriptions marketplace is an application layer built on top of
transfer lots. It is not part of this public indexer release.

## Components

```text
Pearl full node
  -> Pearl RPC client
  -> persistent scanner
  -> Pearlscriptions witness extractor
  -> PRL-20 state machine
  -> PostgreSQL storage and read models
  -> read-only HTTP API
```

## Data Flow

1. The scanner reads canonical blocks from a Pearl full node over RPC.
2. Raw block data is persisted so reorgs and restarts can be handled safely.
3. The witness parser inspects executed Taproot script leaves and extracts
   Pearlscription envelopes.
4. The base ledger assigns canonical inscription numbers.
5. The PRL-20 state machine derives token deploy, mint, transfer-lot, and
   holder state from `prl-20` JSON inscriptions.
6. Storage materializes read models for paginated public API routes.
7. `/indexer/digest` returns a normalized digest for operator comparison.

## Included Surfaces

- block scanning from Pearl RPC
- reorg-aware persistent indexing
- generic Pearlscription extraction
- canonical inscription numbering
- PRL-20 state derivation
- PRLS mint-fee enforcement from a release manifest
- read-only API routes
- digest and status commands

## Excluded Surfaces

- browser wallet code
- seed generation
- private-key signing
- transaction broadcast routes
- faucet routes
- block generation tools
- maintainer operational tooling
- marketplace routes
- orderbook or trading APIs
- seller-package storage
- settlement mutation routes

## Trust Model

Users should not need to trust the official API for protocol state. They can run this indexer against a Pearl node and compare snapshot digests with other operators.

The indexer does not custody funds. It reads blocks, reconstructs state, and serves read-only data.
