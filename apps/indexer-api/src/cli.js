#!/usr/bin/env node
import { loadPublicIndexerConfig } from "./config.js";
import { snapshotDigest, summarizeSnapshot } from "./snapshot-compare.js";
import { createPublicIndexerRuntime, startServer } from "./server.js";

const command = process.argv[2] ?? "help";

try {
  if (command === "serve") {
    const { config } = await startServer(loadPublicIndexerConfig());
    process.stdout.write(`Pearlscriptions read-only indexer listening on ${config.host}:${config.port}\n`);
  } else if (command === "sync") {
    const runtime = await createPublicIndexerRuntime({
      ...loadPublicIndexerConfig(),
      syncOnStart: false
    });
    if (!runtime.indexer) {
      throw new Error("sync requires PEARL_RPC_URL");
    }
    const result = await runtime.indexer.syncToTip();
    writeJson({
      ok: true,
      status: sanitize(result.status),
      summary: summarizeSnapshot(result.snapshot)
    });
  } else if (command === "status") {
    const runtime = await createPublicIndexerRuntime({
      ...loadPublicIndexerConfig(),
      syncOnStart: false
    });
    writeJson(sanitize(await runtime.getStatus()));
  } else if (command === "digest") {
    const runtime = await createPublicIndexerRuntime({
      ...loadPublicIndexerConfig(),
      syncOnStart: false
    });
    const snapshot = await runtime.getSnapshot();
    writeJson({
      chain: snapshot?.network?.chain ?? runtime.config.chain,
      snapshotDigest: snapshotDigest(snapshot),
      releaseManifestDigest: runtime.config.manifestDigest,
      summary: summarizeSnapshot(snapshot)
    });
  } else {
    process.stdout.write(`Usage: node src/cli.js <serve|sync|status|digest>\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sanitize(status) {
  const cleaned = structuredClone(status ?? {});
  delete cleaned.storeDir;
  if (cleaned.storage) {
    delete cleaned.storage.storeDir;
  }
  return cleaned;
}
