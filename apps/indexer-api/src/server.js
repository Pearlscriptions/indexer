import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestPearlBlocksFixture, loadFixture } from "./indexer.js";
import { loadPublicIndexerConfig } from "./config.js";
import { createPearlRpcClient } from "./pearl-rpc.js";
import { createPersistentPrl20Indexer } from "./persistent-indexer.js";
import { createIndexerStorage } from "./storage.js";
import { createReadOnlyApi } from "./read-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = resolve(__dirname, "..", "fixtures", "prls-mock-blocks.json");

export async function createPublicIndexerRuntime(config = loadPublicIndexerConfig(), options = {}) {
  let fixture = null;
  let indexer = null;
  let storage = null;
  // The 'api' role never writes: a separate worker process is the sole writer,
  // so the api process must not sync on start nor fall back to syncToTip on a
  // cache miss (that would make a read-only replica a competing writer).
  const role = config.role ?? "all";
  const readOnlyRole = role === "api";

  // Test seam: callers may inject a pre-built indexer + storage instead of
  // constructing one from a live RPC URL. Production code never passes these.
  if (options.indexer) {
    indexer = options.indexer;
    storage = options.storage ?? indexer.storage ?? null;
    if (config.syncOnStart && !readOnlyRole) {
      await indexer.syncToTip();
    } else if (typeof indexer.load === "function") {
      await indexer.load();
    }
  } else if (config.pearlRpc.url) {
    const pearlRpc = createPearlRpcClient(config.pearlRpc);
    storage = createIndexerStorage({
      backend: config.storage.backend,
      storeDir: config.storage.storeDir,
      databaseUrl: config.storage.databaseUrl,
      manifestName: config.storage.manifestName
    });
    indexer = createPersistentPrl20Indexer({
      pearlRpc,
      storage,
      chain: config.chain,
      startHeight: config.startHeight,
      batchSize: config.batchSize,
      mintFeePolicy: config.mintFeePolicy,
      // MoE hard fork advisory inputs (additive). Surfaced in status/health and
      // used for the anti-old-chain checkpoint check; never alter PRL-20 state.
      canonicalCheckpoints: config.canonicalCheckpoints,
      forkEra: config.forkEra,
      indexerVersion: config.version
    });
    if (config.syncOnStart && !readOnlyRole) {
      await indexer.syncToTip();
    } else {
      await indexer.load();
    }
  } else {
    const fixturePath = config.fixturePath ?? defaultFixturePath;
    fixture = loadFixture(fixturePath);
  }

  async function getSnapshot() {
    if (indexer) {
      const stored = await storage.readSnapshot();
      if (stored) {
        return stored;
      }
      if (readOnlyRole) {
        // No worker has published a snapshot yet. Return a clear, read-only
        // "not yet published" snapshot instead of triggering an in-process sync.
        return unpublishedSnapshot(config);
      }
      return (await indexer.syncToTip()).snapshot;
    }
    return ingestPearlBlocksFixture(fixture ?? loadFixture(config.fixturePath ?? defaultFixturePath));
  }

  async function getStatus() {
    if (indexer) {
      return indexer.status();
    }
    return {
      enabled: false,
      mode: "fixture",
      chain: fixture?.network?.chain ?? "fixture",
      synced: null,
      storage: {
        backend: "fixture",
        productionReady: false
      }
    };
  }

  return {
    config,
    indexer,
    storage,
    getSnapshot,
    getStatus
  };
}

export async function startServer(config = loadPublicIndexerConfig(), options = {}) {
  const runtime = await createPublicIndexerRuntime(config, { indexer: options.indexer, storage: options.storage });
  const handler = createReadOnlyApi({
    getSnapshot: runtime.getSnapshot,
    getStatus: runtime.getStatus,
    storage: runtime.storage,
    chain: config.chain,
    manifestDigest: config.manifestDigest,
    version: config.version,
    operatorMetadata: config.operator,
    forkEra: config.forkEra
  });
  const server = createServer(handler);
  let listening = false;
  if (options.listen !== false) {
    await new Promise((resolveStart, rejectStart) => {
      server.once("error", rejectStart);
      server.listen(config.port, config.host, () => {
        server.off("error", rejectStart);
        listening = true;
        resolveStart();
      });
    });
  }

  // Only the default 'all' role arms an in-process background sync. The 'api'
  // role never syncs in-process; the 'worker' role drives the loop from
  // `cli.js worker` rather than from inside the HTTP server.
  let syncTimer = null;
  if ((config.role ?? "all") === "all" && runtime.indexer && config.backgroundSyncMs > 0) {
    syncTimer = setInterval(() => {
      runtime.indexer.syncToTip().catch((error) => {
        process.stderr.write(
          `[pearlscriptions-indexer] background sync failed: ${safeErrorMessage(error)}\n`
        );
      });
    }, config.backgroundSyncMs);
  }

  return {
    config,
    server,
    runtime,
    close() {
      if (syncTimer) {
        clearInterval(syncTimer);
      }
      if (!listening) {
        return Promise.resolve();
      }
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  };
}

// Read-only 'api' role response when no worker has published a snapshot yet.
// Folds zero blocks so the snapshot is fully shaped (empty inscriptions/tokens/
// indexes) and every read route resolves without an in-process sync, while the
// network block flags that the snapshot is not yet published.
function unpublishedSnapshot(config) {
  const snapshot = ingestPearlBlocksFixture({
    network: {
      chain: config.chain,
      source: "api-role-awaiting-worker",
      published: false
    },
    prl20MintFee: config.mintFeePolicy,
    blocks: []
  });
  snapshot.network = {
    ...snapshot.network,
    published: false,
    indexedHeight: null,
    indexedHash: null,
    message:
      "Snapshot not yet published. This API process is read-only (PRL20_INDEXER_ROLE=api); a separate worker publishes the snapshot."
  };
  return snapshot;
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "unknown error").replace(/postgres:\/\/[^@\s]+@/gi, "postgres://<redacted>@");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer()
    .then(({ config }) => {
      process.stdout.write(`Pearlscriptions read-only indexer listening on ${config.host}:${config.port}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
