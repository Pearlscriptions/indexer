# Operator Registry Hardening Audit - 2026-05-29

## Scope

This package builds on the public `Pearlscriptions/indexer` repository and includes the earlier Postgres bootstrap fixes plus a second hardening pass focused on intermittent registry states such as `unknown`, `different`, or `needs update`.

Base repository tested:

- `Pearlscriptions/indexer`
- Base commit: `a3ac7be8b20d51f30aec7fae27d421c634f52bdc`
- Version: `1.1.0`

Runtime tested:

- Pearl mainnet
- Postgres storage
- Cloudflare quick tunnel
- Registry endpoint set:
  - `/health`
  - `/indexer/status`
  - `/indexer/digest`
  - `/operator`
  - `/.well-known/pearlscriptions-indexer.json`

## Symptoms Observed

After the first set of fixes, the operator was generally healthy and the official registry often reported `match`. However, the UI could still occasionally show `unknown` before returning to `matching` on refresh.

The likely contributing factors were:

- `/indexer/digest` still read and digest-hashed the full snapshot on every request.
- `/indexer/digest` used short public cache headers while `/status` used no-store, allowing stale digest/fresh status combinations through proxies.
- `registry:check` did not include the well-known proof URL.
- `registry:check` did not send anti-cache headers or cache-busting query params.
- The fast path could accidentally refresh metadata on a snapshot that was not actually at the manifest tip.
- Metadata-only snapshot updates replaced the whole snapshot JSON instead of atomically updating only `network`.
- Background sync errors were swallowed silently.

## Fixes Included

### 1. Registry-Critical Digest Uses No-Store

File:

- `apps/indexer-api/src/read-api.js`

Change:

- `/indexer/digest` now uses `cache-control: no-store`.

Reason:

- The registry compares `/indexer/status` and `/indexer/digest`.
- Status was already live/no-store.
- Digest had a short public cache, which could expose a stale digest next to a fresh status.

### 2. Precomputed Digest Metadata

Files:

- `apps/indexer-api/src/persistent-indexer.js`
- `apps/indexer-api/src/read-api.js`
- `apps/indexer-api/src/storage.js`

Change:

- The persistent indexer now stores `network.protocolSnapshotDigest` and `network.protocolSummary` when writing or refreshing a snapshot.
- `/indexer/digest` can serve from this small published metadata instead of reading and hashing the full snapshot JSONB.
- Postgres storage exposes `readSnapshotNetworkMetadata()`.

Result:

- Before hardening, public endpoint profiling showed approximately:
  - `/health`: ~0.86-1.09s
  - `/indexer/status`: ~0.84-0.94s
  - `/indexer/digest`: ~1.39-1.50s

- After hardening:
  - `/health`: ~0.29-0.34s
  - `/indexer/status`: usually ~0.31-0.35s
  - `/indexer/digest`: ~0.29-0.41s

This gives the registry much more headroom before timeout.

### 3. Status Reads Published Snapshot Metadata

Files:

- `apps/indexer-api/src/persistent-indexer.js`
- `apps/indexer-api/src/storage.js`

Change:

- In Postgres read-model mode, public status uses the published snapshot network metadata when available.
- It validates that the published snapshot chain/start height/hash are compatible with the manifest.

Reason:

- Digest is snapshot-backed.
- Status should describe the same published state as digest, especially during background sync.

### 4. Fast Path Refuses Stale Snapshots

File:

- `apps/indexer-api/src/persistent-indexer.js`

Change:

- The fast path now reuses a stored snapshot only if:
  - `snapshot.network.indexedHeight === manifest.indexedHeight`
  - `snapshot.network.indexedHash === manifest.indexedHash`
  - the snapshot hash exists in the manifest at that height

Reason:

- If a previous process crashed after manifest write but before snapshot write, the manifest can be ahead of the snapshot.
- Retagging the old snapshot to the new height/hash would create a hybrid state.
- The correct behavior is to rebuild from canonical stored blocks.

### 5. Metadata-Only Snapshot Update Is Atomic and Narrow

File:

- `apps/indexer-api/src/storage.js`

Change:

- `writeSnapshotNetworkMetadata()` now updates only the `network` key:

```sql
snapshot_json = snapshot_json || jsonb_build_object('network', $network::jsonb)
```

Reason:

- The prior version wrote the whole compact snapshot during a metadata refresh.
- In a race, that could overwrite a newer full snapshot with older state plus refreshed network metadata.

### 6. Postgres Sync Advisory Lock

Files:

- `apps/indexer-api/src/persistent-indexer.js`
- `apps/indexer-api/src/storage.js`

Change:

- Postgres storage now exposes `withSyncLock()`.
- `syncToTip()` uses a Postgres advisory lock keyed by manifest name.

Reason:

- `syncPromise` only serializes work inside one Node.js process.
- CLI commands, multiple containers, or deploy overlap can otherwise write the same manifest/snapshot concurrently.

### 7. Registry Self-Check Is Stricter

File:

- `apps/indexer-api/src/cli.js`

Changes:

- Adds `/.well-known/pearlscriptions-indexer.json` to `registry:check`.
- Validates the well-known document with the same schema as `/operator`.
- Compares `/operator` and well-known content.
- Adds cache-busting query params to remote checks.
- Sends anti-cache headers:
  - `cache-control: no-cache`
  - `pragma: no-cache`
  - `x-pearlscriptions-registry-check: 1`
- Fails readiness when:
  - status/digest height mismatch
  - status/digest hash mismatch
  - status or digest height/hash/chain missing in non-fixture mode
  - remote operator URL does not match target URL
  - remote reward address or challenge do not match local config

Reason:

- The local checker should catch the same problems the official registry can see.

### 8. Background Sync Errors Are Logged

File:

- `apps/indexer-api/src/server.js`

Change:

- Background sync failures are now logged to stderr with secrets redacted from Postgres URLs.

Reason:

- Previously, `syncToTip().catch(() => {})` swallowed errors.
- An operator could remain apparently alive while sync silently failed.

## Tests Added

Files:

- `apps/indexer-api/test/persistent-indexer.test.js`
- `apps/indexer-api/test/read-api.test.js`

New coverage includes:

- chunked read-model inserts
- metadata-only snapshot updates preserving existing snapshot state
- stale snapshot fast-path rebuild instead of retagging
- status following published snapshot metadata
- digest served from precomputed metadata without loading the full snapshot
- stricter registry check path list including well-known

Validation:

```text
npm run verify
```

Result:

```text
@pearlscriptions/prl20-core: 12/12 passing
@pearlscriptions/indexer-api: 65/65 passing
```

## Live Operator Verification

After applying the hardening package and rebuilding the Docker image:

```text
registryReady: true
digestMatchesStatus: true
errors: []
```

The public endpoint set returned:

- `/health`: 200
- `/indexer/status`: 200
- `/indexer/digest`: 200
- `/operator`: 200
- `/.well-known/pearlscriptions-indexer.json`: 200

The official registry API showed the operator as:

```text
status: online
lag: 0
digestStatus: match
reviewStatus: pending
```

## Remaining Notes

This hardening package intentionally avoids protocol changes:

- no PRL-20 parser changes
- no mint/transfer/indexing rules changes
- no digest normalization rule changes
- no operator schema changes

The changes are operational and registry-readiness focused.

For production v1.2, recommended follow-ups:

- expose a first-class Docker operator stack
- add a startup readiness endpoint that returns `starting` instead of connection refused during bootstrap
- add named Cloudflare tunnel or deployment guidance instead of quick tunnel for long-running operators
- add registry-check timing output per endpoint
- consider storing digest metadata in dedicated SQL columns in a future migration

