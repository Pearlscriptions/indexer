# Operator API / Sync Worker Split

Date: 2026-05-29

## Summary

During beta operator testing, the public registry sometimes displayed `unknown`
even when the operator eventually returned matching `/indexer/status` and
`/indexer/digest` responses.

The root cause was not a digest mismatch. The read-only API process was also
running background sync. When a new block arrived, the same Node.js event loop
that served `/health` and `/indexer/status` could spend several seconds
rebuilding and materializing the PRL-20 snapshot. During that window, registry
checks saw slow responses or request timeouts.

## Observed Symptoms

- `/operator`, `/.well-known/pearlscriptions-indexer.json`, and
  `/indexer/digest` often responded.
- `/health` and `/indexer/status` sometimes timed out around sync windows.
- Public registry rows could move between `match`, `unknown`, and stale states
  without any operator configuration change.
- One sampled registry check showed roughly 10 seconds of latency for the
  operator, consistent with the API event loop being busy during snapshot work.

## Patch

The API can now refresh its manifest from durable storage on `status()` calls:

- `PersistentPrl20Indexer.status()` calls `load({ refresh: true })`.
- `syncToTipUnsafe()` also refreshes before syncing, so long-lived workers pick
  up state written by other processes.
- `load()` no longer rewrites an already-stored manifest on every refresh.

This allows deployments to run:

- one public API process with `PRL20_INDEXER_SYNC_ON_START=0` and
  `PRL20_INDEXER_BACKGROUND_SYNC_MS=0`
- one private sync worker process that repeatedly runs `npm run indexer:sync`

The public endpoints and response schemas remain unchanged, so this is backend
compatible with the existing registry checker.

## Recommended Deployment Shape

Keep the public API and sync loop as separate processes sharing the same
Postgres storage:

```yaml
indexer-api:
  command: ["npm", "run", "indexer:serve"]
  environment:
    PRL20_INDEXER_SYNC_ON_START: "0"
    PRL20_INDEXER_BACKGROUND_SYNC_MS: "0"

indexer-sync:
  command:
    - sh
    - -lc
    - |
      while true; do
        npm run indexer:sync || true
        sleep "${PRL20_INDEXER_WORKER_SYNC_SLEEP_SECONDS:-5}"
      done
  environment:
    PRL20_INDEXER_READ_MODEL_MODE: "incremental"
```

The sync worker can still rebuild snapshots, but any CPU-heavy work happens in a
separate process from the public HTTP server. During local testing after this
change, `/indexer/status` stayed around 0.34-0.49s and `/indexer/digest` around
0.20-0.32s over a multi-minute sample, with no timeout spikes.

For v1.3.0 and later, `PRL20_INDEXER_READ_MODEL_MODE=incremental` may be set on
the private sync worker after an initial full publish. It keeps pure append
cycles from rewriting the full Postgres UTXO read model. Keep the public API
process read-only (`PRL20_INDEXER_SYNC_ON_START=0`,
`PRL20_INDEXER_BACKGROUND_SYNC_MS=0`); it does not need the flag because it does
not publish snapshots. Roll back by removing the flag and restarting the worker.

## Tests Added

- `postgres status refreshes manifest written by an external sync worker`
- `postgres persistent indexer uses incremental read-model publish only when the flag is enabled`

Existing status/digest alignment tests continue to pass, including the case
where the manifest is ahead but the published snapshot is still the last
consistent public state.
