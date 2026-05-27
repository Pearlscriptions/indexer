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

export async function createPublicIndexerRuntime(config = loadPublicIndexerConfig()) {
  let fixture = null;
  let indexer = null;
  let storage = null;

  if (config.pearlRpc.url) {
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
      mintFeePolicy: config.mintFeePolicy
    });
    if (config.syncOnStart) {
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

export async function startServer(config = loadPublicIndexerConfig()) {
  const runtime = await createPublicIndexerRuntime(config);
  const handler = createReadOnlyApi({
    getSnapshot: runtime.getSnapshot,
    getStatus: runtime.getStatus,
    storage: runtime.storage,
    chain: config.chain,
    manifestDigest: config.manifestDigest
  });
  const server = createServer(handler);
  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(config.port, config.host, () => {
      server.off("error", rejectStart);
      resolveStart();
    });
  });

  let syncTimer = null;
  if (runtime.indexer && config.backgroundSyncMs > 0) {
    syncTimer = setInterval(() => {
      runtime.indexer.syncToTip().catch(() => {});
    }, config.backgroundSyncMs);
  }

  return {
    server,
    runtime,
    close() {
      if (syncTimer) {
        clearInterval(syncTimer);
      }
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  };
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
