import assert from "node:assert/strict";
import test from "node:test";
import { loadPublicIndexerConfig } from "../src/config.js";
import { runWorkerLoop } from "../src/cli.js";
import { createPublicIndexerRuntime, startServer } from "../src/server.js";

// Minimal in-memory fake of the persistent indexer surface the runtime/server
// and worker loop touch. Counts syncToTip calls so a test can prove which roles
// trigger a sync.
function makeFakeIndexer({ snapshot = null, failWith = null } = {}) {
  return {
    syncCalls: 0,
    storage: { async readSnapshot() { return snapshot; } },
    lastIngestPath: "incremental",
    async load() {},
    async status() {
      return { enabled: true, mode: "persistent", synced: true, storage: { backend: "json-file" } };
    },
    async syncToTip() {
      this.syncCalls += 1;
      if (failWith) {
        const error = new Error(failWith.message ?? "sync failed");
        if (failWith.code) error.code = failWith.code;
        throw error;
      }
      return { snapshot: snapshot ?? { network: { chain: "pearl-simnet" } }, blocks: [], blockCount: 0, status: {} };
    }
  };
}

function configForRole(role, overrides = {}) {
  return loadPublicIndexerConfig({
    PRL20_CHAIN: "pearl-simnet",
    PRL20_INDEXER_ROLE: role,
    PRL20_INDEXER_BACKGROUND_SYNC_MS: "10000",
    ...overrides
  });
}

// --- config-level role parsing ---

test("config role defaults to 'all' and validates the enum", () => {
  assert.equal(loadPublicIndexerConfig({ PRL20_CHAIN: "pearl-simnet" }).role, "all");
  assert.equal(configForRole("api").role, "api");
  assert.equal(configForRole("worker").role, "worker");
  assert.equal(configForRole("ALL").role, "all");
  assert.throws(
    () => configForRole("bogus"),
    /invalid PRL20_INDEXER_ROLE/
  );
});

// --- 'api' role never syncs in-process ---

test("api role getSnapshot returns an unpublished snapshot without calling syncToTip", async () => {
  const indexer = makeFakeIndexer({ snapshot: null });
  const runtime = await createPublicIndexerRuntime(configForRole("api"), { indexer });
  const snapshot = await runtime.getSnapshot();
  assert.equal(indexer.syncCalls, 0, "api role must not sync on a cache miss");
  assert.equal(snapshot.network.published, false);
  assert.match(snapshot.network.message, /not yet published/i);
  // Snapshot must be well-formed enough for read routes (empty projections).
  assert.deepEqual(snapshot.inscriptions, []);
  assert.deepEqual(snapshot.tokens, []);
});

test("api role does not sync on start", async () => {
  const indexer = makeFakeIndexer({ snapshot: null });
  await createPublicIndexerRuntime(configForRole("api", { PRL20_INDEXER_SYNC_ON_START: "1" }), { indexer });
  assert.equal(indexer.syncCalls, 0, "api role must not syncOnStart");
});

test("api role server never arms a background sync interval", async () => {
  const indexer = makeFakeIndexer({ snapshot: { network: { chain: "pearl-simnet" } } });
  const { close } = await startServer(configForRole("api"), { indexer, listen: false });
  // Give any (incorrectly armed) short interval a chance to fire.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(indexer.syncCalls, 0, "api role must never arm the in-process sync loop");
  await close();
});

// --- 'all' role still arms the loop (pre-split behavior preserved) ---

test("all role server arms the background sync interval", async () => {
  const indexer = makeFakeIndexer({ snapshot: { network: { chain: "pearl-simnet" } } });
  const { close } = await startServer(
    configForRole("all", { PRL20_INDEXER_BACKGROUND_SYNC_MS: "10", PRL20_INDEXER_SYNC_ON_START: "0" }),
    { indexer, listen: false }
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  await close();
  assert.ok(indexer.syncCalls >= 1, "all role must arm the in-process background sync loop");
});

// --- worker command runs the sync loop ---

test("worker loop runs syncToTip every iteration", async () => {
  const indexer = makeFakeIndexer({ snapshot: { network: { chain: "pearl-simnet" } } });
  const config = configForRole("worker");
  const ticks = [];
  const result = await runWorkerLoop(indexer, config, {
    maxIterations: 3,
    sleep: async () => {},
    registerSignals: false,
    onTick: (event) => ticks.push(event)
  });
  assert.equal(indexer.syncCalls, 3);
  assert.equal(result.iterations, 3);
  assert.equal(ticks.length, 3);
  assert.ok(ticks.every((event) => event.evt === "indexer-worker-sync"));
});

test("worker loop treats SYNC_LOCK_BUSY as a benign skip", async () => {
  const indexer = makeFakeIndexer({ failWith: { code: "SYNC_LOCK_BUSY", message: "busy" } });
  const config = configForRole("worker");
  const ticks = [];
  await runWorkerLoop(indexer, config, {
    maxIterations: 2,
    sleep: async () => {},
    registerSignals: false,
    onTick: (event) => ticks.push(event)
  });
  assert.equal(indexer.syncCalls, 2);
  assert.ok(ticks.every((event) => event.evt === "indexer-worker-skip" && event.reason === "SYNC_LOCK_BUSY"));
});
