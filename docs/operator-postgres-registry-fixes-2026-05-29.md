# Operator Postgres and Registry Fixes - 2026-05-29

## Context

This package is based on the public Pearlscriptions indexer repository at:

- Repository: `Pearlscriptions/indexer`
- Base commit tested: `a3ac7be8b20d51f30aec7fae27d421c634f52bdc`
- Version: `1.1.0`
- Network: Pearl mainnet
- Storage backend used for the operator test: Postgres
- Public exposure used for the operator test: Cloudflare quick tunnel

The operator was tested against the beta registry flow using:

- `/health`
- `/indexer/status`
- `/indexer/digest`
- `/operator`
- `/.well-known/pearlscriptions-indexer.json`
- `npm run registry:check -- --url <public-url>`

The public GitHub code already contains the main registry and digest normalization work, but two Postgres/runtime issues still prevented a clean operator registration test from being stable.

## Fix 1: Chunk Postgres Read-Model Inserts

### Problem

Starting the public repository from a clean Postgres database on Pearl mainnet failed during initial bootstrap with:

```text
total size of jsonb array elements exceeds the maximum of 268435455 bytes
```

The failure happened after blocks had been ingested, while materializing the read-model tables from a large snapshot. The API never reached the listening state, so the public tunnel returned 502 and the registry saw the operator as unreachable.

### Root Cause

`materializeReadModelTable()` passed the full read-model row set as one JSONB array parameter to `jsonb_to_recordset($2::jsonb)`.

On mainnet-sized snapshots, that single JSONB array can exceed Postgres' per-array/jsonb element limit.

### Change

`apps/indexer-api/src/storage.js`

- Added `READ_MODEL_INSERT_CHUNK_SIZE = 500`.
- Split read-model rows into chunks before calling `jsonb_to_recordset`.
- Kept the existing table delete-before-rebuild behavior.
- Did not change PRL-20 parsing or derived state semantics.

### Result

The clean Postgres bootstrap completed and the server reached:

```text
Pearlscriptions read-only indexer listening on 0.0.0.0:3000
```

## Fix 2: Persist Refreshed Snapshot Network Metadata

### Problem

After the indexer was already synced, the manifest could advance to a newer tip while the stored snapshot still reported the previous height/hash. This produced registry states such as `DIFFERENT`, `NEEDS UPDATE`, or digest mismatch even though the operator was reachable and indexing.

Observed example:

- `/indexer/status`: height `63712`
- `/indexer/digest`: height `63711`

### Root Cause

The fast path refreshed snapshot network metadata in memory, but did not persist the refreshed metadata back to `indexer_snapshots`.

That meant `/indexer/digest`, which is snapshot-backed, could lag behind manifest-backed status responses.

### Change

`apps/indexer-api/src/storage.js`

- Added `writeSnapshotNetworkMetadata(snapshot)` for Postgres storage.
- This updates only the stored compact snapshot metadata without rebuilding read models.

`apps/indexer-api/src/persistent-indexer.js`

- When fast-path snapshot reuse refreshes network metadata, persist the refreshed snapshot metadata.
- Added a small `snapshotNetworkChanged()` helper to avoid unnecessary writes.

### Result

Fast-path status/digest checks now converge after background sync without rebuilding the whole read model.

## Fix 3: Report Status from the Published Snapshot for Postgres Read Models

### Problem

There is still a race while a new block is being appended:

1. The manifest can be persisted at the new height.
2. The public snapshot/read model is still being rebuilt.
3. `/indexer/status` can report the new manifest height.
4. `/indexer/digest` still reports the previous published snapshot height.

That is a short-lived but real registry mismatch window.

### Root Cause

For Postgres read-model mode, public digest data is snapshot-backed, while status was manifest-backed. During background sync, those two public surfaces could briefly point to different published states.

### Change

`apps/indexer-api/src/persistent-indexer.js`

- `status()` now prefers the published Postgres snapshot when read models are enabled.
- If no published snapshot exists yet, it falls back to manifest-backed status.

This makes `/indexer/status` and `/indexer/digest` describe the same published state. The status endpoint may report one block behind during a write, but it will no longer report a state that the digest endpoint cannot yet prove.

### Result

`registry:check` returned:

```json
{
  "ok": true,
  "readiness": {
    "registryReady": true,
    "endpointOk": true,
    "operatorDocReady": true,
    "operatorPublicUrl": true,
    "rewardAddress": true,
    "challenge": true,
    "digestMatchesStatus": true,
    "errors": []
  }
}
```

## Tests Added

`apps/indexer-api/test/persistent-indexer.test.js`

Added coverage for:

1. Read-model chunking:
   - verifies a large inscription read model is inserted in multiple chunks.
   - catches regressions that would reintroduce one huge JSONB array parameter.

2. Snapshot-backed status:
   - simulates the manifest being ahead of the published snapshot.
   - verifies public status follows the published snapshot height/hash in Postgres read-model mode.

Validation run:

```text
npm test --workspace @pearlscriptions/indexer-api
```

Result:

```text
tests 62
pass 62
fail 0
```

## Files Changed

- `apps/indexer-api/src/storage.js`
- `apps/indexer-api/src/persistent-indexer.js`
- `apps/indexer-api/test/persistent-indexer.test.js`
- `docs/operator-postgres-registry-fixes-2026-05-29.md`

## Recommendation

These fixes should be treated as part of the operator registration hardening path for v1.1.x or v1.2.

They are intentionally narrow:

- no protocol-state changes
- no PRL-20 parser changes
- no digest normalization changes
- no operator metadata schema changes

They only make the Postgres-backed public operator API able to:

- finish mainnet bootstrap,
- keep status and digest consistent,
- avoid transient false registry mismatches during background sync.

