# Changelog

## v1.3.1 - 2026-06-28

Realtime worker hardening release. No PRL-20 consensus or protocol change: the
derived snapshot digest stays byte-identical for the same chain.

Performance / stability:

- Added optional warm-session micro-batching via
  `PRL20_INDEXER_MAX_BLOCKS_PER_SYNC`. The default `0` preserves the existing
  catch-up behavior. When set to a positive value, only append-only warm
  backlogs are published in small slices; cold starts and rollback recovery
  still catch up fully.
- Added `PRL20_INDEXER_PARITY_MODE=post-publish` so optional protocol parity can
  run after an incremental publish lands. On mismatch, the worker immediately
  writes the trusted full rebuild.
- Avoided needless full re-folds when a live session is already in sync with the
  stored canonical chain.
- CLI `sync` and `worker` output now include `targetHeight`,
  `maxBlocksPerSync`, `remainingLag`, `timings`, and process memory summary.
- Aligned the Docker image with the package runtime requirement (`node >=22`).
- Trimmed future registry mutation-planning documentation from the public
  package so the repo stays focused on the read-only indexer surface.

Operator notes:

- Recommended low-latency worker profile:
  `PRL20_INDEXER_READ_MODEL_MODE=incremental`,
  `PRL20_INDEXER_MAX_BLOCKS_PER_SYNC=1`,
  `PRL20_INDEXER_PARITY_MODE=post-publish`.
- Keep public API processes read-only (`PRL20_INDEXER_ROLE=api`) and enable the
  realtime flags only on the private sync worker.
- Rollback is immediate: unset the new flags, or set
  `PRL20_INDEXER_MAX_BLOCKS_PER_SYNC=0` and `PRL20_INDEXER_PARITY_MODE=inline`,
  then restart the worker.

Security boundary:

This release keeps the public indexer read-only and does not add wallet signing,
transaction broadcast, marketplace settlement, registry backend mutation, or
rewards logic. The new flags affect only sync-worker scheduling, parity timing,
and operator telemetry.

## v1.3.0 - 2026-06-25

Postgres read-model performance release. No PRL-20 consensus or protocol
change: the derived snapshot digest stays byte-identical for the same chain.

Performance / stability:

- Added optional incremental Postgres read-model publishing via
  `PRL20_INDEXER_READ_MODEL_MODE=incremental`.
- The default remains `full`, so existing operators keep the v1.2.1
  `DELETE + INSERT` publish path until they explicitly opt in.
- On pure append syncs with a live ingest session, the worker now publishes only
  touched UTXO rows plus the small public inscription projection instead of
  rebuilding and rewriting the full `indexer_read_utxos` table.
- Reorgs, cold starts, stale snapshots, and parity fallback still use the full
  publish path.
- UTXO confirmations are derived at read time, and coinbase spendability is
  updated incrementally as outputs mature.
- CLI `sync` and `worker` output now include `readModelMode`, `readModelMs`, and
  `touchedRows` so operators can verify whether incremental publishing is active.

Operator notes:

- Existing schemas continue to work. Run `npm run db:migrate` after upgrading
  to add the optional partial index used by incremental coinbase maturity
  updates.
- Recommended rollout: upgrade, run with the default `full` mode once, then set
  `PRL20_INDEXER_READ_MODEL_MODE=incremental` on the private sync worker.
- Rollback is immediate: unset `PRL20_INDEXER_READ_MODEL_MODE` or set it to
  `full`, then restart the worker.

Security boundary:

This release keeps the public indexer read-only and does not add wallet signing,
transaction broadcast, marketplace settlement, registry backend mutation, or
rewards logic. The new flag affects only Postgres read-model publication, not
Pearlscriptions or PRL-20 consensus state.

## v1.2.1 - 2026-06-14

Performance/stability + Pearl MoE hard-fork compatibility release. No PRL-20
consensus or protocol change: the derived snapshot digest stays byte-identical
for the same chain.

Performance / stability:

- API/worker process split via `PRL20_INDEXER_ROLE` (`all` default keeps the
  current single-process behavior byte-identical; `api` serves read-only from
  stored state and never runs chain sync in the request/event loop; `worker` is
  a dedicated sync loop, see `indexer:api` / `indexer:worker` scripts).
- Incremental ingest: each new block is applied O(block) instead of re-folding
  PRL-20 state from genesis on every sync. Proven digest-identical to a full
  re-fold (full fold, split-publish, reorg, and chunked rebuild all match).
- Bounded-memory cold-start rebuild: the canonical chain is read and folded in
  chunks (`PRL20_INDEXER_REBUILD_CHUNK_SIZE`, default 250) instead of loading
  the entire raw-block history into RAM at once.

MoE hard-fork node compatibility (advisory only — never alters PRL-20 state):

- Requires `pearld >= v1.1.0` (MoE hard fork activated 2026-06-12). Operators on
  a stale/non-canonical chain are detected and surfaced, not silently indexed.
- `canonicalCheckpoints` (+ `forkEra: "moe-v2"`) in the release manifest;
  pearl-mainnet fails fast at startup until a real post-fork `{height, hash}` is
  filled in (ships with a `FILL_...` placeholder).
- New advisory status fields on `/health`, `/indexer/status`, `/indexer/digest`
  and a static `forkEra` on `/operator`: `indexerVersion`, `pearlNodeVersion`,
  `checkpoint` (`status` ∈ match|mismatch|unknown), `forkEra`, `nodeSchema`, and
  a human `message`/`warning`. `/health.ok` stays `true` on mismatch.
- `registry:check` reference states `CANONICAL_CHECKPOINT_MISMATCH`,
  `NEEDS_UPDATE`, `NODE_VERSION_TOO_OLD` (distinct from generic chain mismatch).
- `getblock` schema safety net flags `nodeSchema: incompatible` instead of
  indexing empty blocks if a future node changes the consumed fields.

Security boundary:

This release keeps the public indexer read-only and does not add wallet signing,
transaction broadcast, marketplace settlement, registry backend mutation, or
rewards logic. All new fields are additive, advisory, and excluded from the
protocol snapshot digest.

## v1.1.2 - 2026-05-29

Operator worker split hardening release.

What changed:

- Refreshed persistent status reads from durable storage so operators can run
  a public read API process separately from a private sync worker without
  serving stale height/status after the worker advances.
- Added an operator worker split runbook documenting the recommended public API
  and private sync worker deployment shape.
- Added coverage for status refreshes after an external sync worker advances
  the shared Postgres manifest.

Security boundary:

This release keeps the public indexer read-only and does not add wallet signing,
transaction broadcast, marketplace settlement, registry backend mutation, or
rewards logic.

## v1.1.1 - 2026-05-29

Operator registry hardening release.

What changed:

- Made `/indexer/digest` registry-critical and served it with `no-store`
  semantics.
- Added published snapshot digest metadata so `/indexer/digest` can avoid
  hashing the full snapshot on every registry check.
- Made Postgres-backed status follow the published snapshot/read model, reducing
  transient status/digest mismatches during background sync.
- Added stricter fast-path validation so stale snapshots are rebuilt instead of
  being retagged to a newer manifest tip.
- Added narrow Postgres metadata-only snapshot updates and a sync advisory lock
  to reduce concurrent writer races.
- Hardened `registry:check` with well-known proof validation, anti-cache remote
  checks, and stricter status/digest/operator metadata comparisons.

Security boundary:

This release stays read-only and does not add wallet signing, transaction
broadcast, marketplace settlement, registry backend mutation, or rewards logic.

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
