#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadPublicIndexerConfig } from "./config.js";
import { operatorMetadataDocument, validateOperatorMetadataDocument } from "./operator-metadata.js";
import { createReadOnlyApi } from "./read-api.js";
import { normalizeSelfCheckUrl } from "./registry-check-policy.js";
import {
  normalizeProtocolSnapshotForComparison,
  snapshotDigest,
  summarizeSnapshot
} from "./snapshot-compare.js";
import { createPublicIndexerRuntime, startServer } from "./server.js";

const REGISTRY_CHECK_PATHS = [
  "/health",
  "/indexer/status",
  "/indexer/digest",
  "/operator",
  "/.well-known/pearlscriptions-indexer.json"
];

export async function runCli(argv = process.argv) {
  const command = argv[2] ?? "help";
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
      summary: summarizeSnapshot(result.snapshot),
      readModelMode: result.readModelMode ?? null,
      readModelMs: result.readModelMs ?? null,
      touchedRows: result.touchedRows ?? null
    });
  } else if (command === "worker") {
    await runWorker();
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
    const normalized = normalizeProtocolSnapshotForComparison(snapshot);
    writeJson({
      chain: snapshot?.network?.chain ?? runtime.config.chain,
      snapshotDigest: snapshotDigest(normalized),
      releaseManifestDigest: runtime.config.manifestDigest,
      summary: summarizeSnapshot(normalized)
    });
  } else if (command === "registry:check") {
    writeJson(await registryCheck(loadPublicIndexerConfig(), parseCliOptions(argv.slice(3))));
  } else {
    process.stdout.write(
      `Usage: node src/cli.js <serve|sync|worker|status|digest|registry:check>\n`
    );
  }
}

// Dedicated background-sync worker process (Fix A: API/worker split).
//
// Loads the runtime, then drives the sync loop via runWorkerLoop. The worker is
// intended to be the SOLE snapshot writer; api-role HTTP processes only read
// storage.readSnapshot().
async function runWorker(options = {}) {
  const config = loadPublicIndexerConfig();
  const runtime = await createPublicIndexerRuntime({ ...config, syncOnStart: false });
  if (!runtime.indexer) {
    throw new Error("worker requires PEARL_RPC_URL");
  }
  return runWorkerLoop(runtime.indexer, config, options);
}

// Testable worker loop core: loops syncToTip() every config.backgroundSyncMs,
// reusing the same one-shot sync body as the `sync` command.
//
// Cross-process safety relies on storage.withSyncLock (a Postgres advisory lock,
// applied inside syncToTip via withStorageSyncLock). SYNC_LOCK_BUSY means another
// sync holds the lock, so this tick is skipped as benign. NOTE: the json-file
// storage backend has no withSyncLock, so a multi-process split needs Postgres
// (or exactly one writer); running two json-file workers/writers is unsafe.
export async function runWorkerLoop(indexer, config, options = {}) {
  const intervalMs = config.backgroundSyncMs > 0 ? config.backgroundSyncMs : 30_000;
  const maxIterations = options.maxIterations ?? Infinity;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const onTick = options.onTick ?? writeJson;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  if (options.registerSignals !== false) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  process.stdout.write(
    `Pearlscriptions indexer worker syncing ${config.chain} every ${intervalMs}ms\n`
  );

  let iterations = 0;
  for (let iteration = 0; iteration < maxIterations && !stopped; iteration += 1) {
    iterations += 1;
    try {
      const result = await indexer.syncToTip();
      onTick({
        ok: true,
        evt: "indexer-worker-sync",
        ingestPath: indexer.lastIngestPath,
        readModelMode: result.readModelMode ?? null,
        readModelMs: result.readModelMs ?? null,
        touchedRows: result.touchedRows ?? null,
        status: sanitize(result.status)
      });
    } catch (error) {
      if (error?.code === "SYNC_LOCK_BUSY") {
        // Another sync (or another worker) holds the advisory lock; skip this
        // tick. This is benign under the single-writer contract.
        onTick({ ok: true, evt: "indexer-worker-skip", reason: "SYNC_LOCK_BUSY" });
      } else {
        process.stderr.write(
          `[pearlscriptions-indexer] worker sync failed: ${safeErrorMessage(error)}\n`
        );
      }
    }
    if (iteration + 1 < maxIterations && !stopped) {
      await sleep(intervalMs);
    }
  }
  return { stopped, iterations };
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "unknown error").replace(
    /postgres:\/\/[^@\s]+@/gi,
    "postgres://<redacted>@"
  );
}

async function registryCheck(config, options) {
  const checks = [];
  const warnings = [];
  let readiness = null;
  const metadataDocument = operatorMetadataDocument(config.operator, {
    chain: config.chain,
    version: config.version,
    forkEra: config.forkEra
  });
  const metadataErrors = validateOperatorMetadataDocument(metadataDocument);
  checks.push({
    name: "operator-metadata",
    ok: metadataErrors.length === 0,
    errors: metadataErrors
  });

  if (!config.operator.publicUrl) {
    warnings.push("PRL20_OPERATOR_PUBLIC_URL is not configured; registry URL proof cannot be prepared yet.");
  }
  if (!config.operator.rewardAddress) {
    warnings.push(
      "PRL20_OPERATOR_REWARD_ADDRESS is not configured; reward-address proof is wallet-selected and deferred."
    );
  }
  if (!config.operator.registryChallenge) {
    warnings.push("PRL20_OPERATOR_REGISTRY_CHALLENGE is not configured; URL proof is not ready for registry review.");
  }

  if (options.url) {
    const remote = await checkRemoteRegistryTarget(options.url);
    checks.push(...remote.checks);
    readiness = buildRegistryReadiness(remote.results, config, options.url);
    return summarizeRegistryCheck("remote", options.url, checks, warnings, readiness);
  }

  const runtime = await createPublicIndexerRuntime({
    ...config,
    syncOnStart: false
  });
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
  const results = new Map();
  for (const path of REGISTRY_CHECK_PATHS) {
    const result = await invokeHandlerJson(handler, path);
    results.set(path, result);
    checks.push(validateRegistryPath(path, result));
  }

  readiness = buildRegistryReadiness(results, config);
  return summarizeRegistryCheck("local", null, checks, warnings, readiness);
}

async function checkRemoteRegistryTarget(rawUrl) {
  const baseUrl = normalizeSelfCheckUrl(rawUrl);
  const checks = [];
  const results = new Map();
  for (let index = 0; index < REGISTRY_CHECK_PATHS.length; index += 1) {
    const path = REGISTRY_CHECK_PATHS[index];
    const url = new URL(path, baseUrl);
    url.searchParams.set("_prlRegistryCheck", `${Date.now()}-${index}`);
    const result = await fetchJsonWithLimit(url);
    results.set(path, result);
    checks.push(validateRegistryPath(path, result));
  }
  return { checks, results };
}

function validateRegistryPath(path, result) {
  const check = {
    name: path,
    ok: false,
    status: result.status,
    errors: []
  };
  if (result.error) {
    check.errors.push(result.error);
    return check;
  }
  if (result.status !== 200) {
    check.errors.push(`HTTP_${result.status}`);
    return check;
  }
  if (path === "/health") {
    if (result.body?.readOnly !== true) check.errors.push("HEALTH_READ_ONLY_NOT_TRUE");
    if (result.body?.service !== "pearlscriptions-indexer") check.errors.push("HEALTH_SERVICE_INVALID");
  }
  if (path === "/indexer/digest") {
    if (!/^[0-9a-f]{64}$/.test(result.body?.snapshotDigest ?? "")) {
      check.errors.push("DIGEST_SNAPSHOT_DIGEST_INVALID");
    }
    if (!/^[0-9a-f]{64}$/.test(result.body?.releaseManifestDigest ?? "")) {
      check.errors.push("DIGEST_RELEASE_MANIFEST_DIGEST_INVALID");
    }
  }
  if (path === "/operator" || path === "/.well-known/pearlscriptions-indexer.json") {
    check.errors.push(...validateOperatorMetadataDocument(result.body));
  }
  check.ok = check.errors.length === 0;
  return check;
}

function summarizeRegistryCheck(mode, targetUrl, checks, warnings, readiness = null) {
  return {
    ok: checks.every((check) => check.ok),
    mode,
    targetUrl,
    warnings,
    readiness,
    checks
  };
}

// Exported for tests: this readiness derivation is the reference spec the
// private registry repo mirrors (including the MoE reference states below).
export function buildRegistryReadiness(results, config, targetUrl = null) {
  const health = results.get("/health")?.body ?? null;
  const status = results.get("/indexer/status")?.body ?? null;
  const digest = results.get("/indexer/digest")?.body ?? null;
  const operator = results.get("/operator")?.body ?? null;
  const wellKnown = results.get("/.well-known/pearlscriptions-indexer.json")?.body ?? null;
  const errors = [];

  const endpointOk = REGISTRY_CHECK_PATHS.every((path) => results.get(path)?.status === 200 && !results.get(path)?.error);
  const operatorErrors = validateOperatorMetadataDocument(operator);
  const operatorDocReady = operatorErrors.length === 0;
  const operatorPublicUrl = operator?.operator?.publicUrl ?? null;
  const rewardAddress = operator?.operator?.rewardAddress ?? null;
  const challenge = operator?.registry?.challenge ?? null;
  const targetOrigin = targetUrl ? normalizeSelfCheckUrl(targetUrl).origin : null;

  if (!operatorPublicUrl) {
    errors.push("OPERATOR_PUBLIC_URL_MISSING");
  }
  if (!rewardAddress) {
    errors.push("OPERATOR_REWARD_ADDRESS_MISSING");
  }
  if (!challenge) {
    errors.push("OPERATOR_REGISTRY_CHALLENGE_MISSING");
  }
  if (targetOrigin && operatorPublicUrl && operatorPublicUrl !== targetOrigin) {
    errors.push("OPERATOR_PUBLIC_URL_TARGET_MISMATCH");
  }
  if (config.operator.publicUrl && operatorPublicUrl && config.operator.publicUrl !== operatorPublicUrl) {
    errors.push("OPERATOR_PUBLIC_URL_CONFIG_MISMATCH");
  }
  if (config.operator.rewardAddress && rewardAddress && config.operator.rewardAddress !== rewardAddress) {
    errors.push("OPERATOR_REWARD_ADDRESS_MISMATCH");
  }
  if (config.operator.registryChallenge && challenge && config.operator.registryChallenge !== challenge) {
    errors.push("OPERATOR_REGISTRY_CHALLENGE_MISMATCH");
  }
  if (wellKnown && JSON.stringify(wellKnown) !== JSON.stringify(operator)) {
    errors.push("OPERATOR_WELL_KNOWN_MISMATCH");
  }

  const statusHeight = numberOrNull(status?.indexedHeight);
  const digestHeight = numberOrNull(digest?.indexedHeight ?? digest?.summary?.indexedHeight);
  const statusHash = status?.indexedHash ?? null;
  const digestHash = digest?.indexedHash ?? null;
  const statusChain = status?.chain ?? health?.chain ?? null;
  const digestChain = digest?.chain ?? digest?.summary?.chain ?? null;
  const fixtureMode = status?.mode === "fixture" || health?.indexer?.mode === "fixture";

  if (!fixtureMode && config.chain && statusChain && statusChain !== config.chain) {
    errors.push("STATUS_CHAIN_MISMATCH");
  }
  if (!fixtureMode && config.chain && digestChain && digestChain !== config.chain) {
    errors.push("DIGEST_CHAIN_MISMATCH");
  }
  if (statusChain && digestChain && statusChain !== digestChain) {
    errors.push("STATUS_DIGEST_CHAIN_MISMATCH");
  }
  if (statusHeight !== null && digestHeight !== null && statusHeight !== digestHeight) {
    errors.push("STATUS_DIGEST_HEIGHT_MISMATCH");
  }
  if (statusHash && digestHash && statusHash !== digestHash) {
    errors.push("STATUS_DIGEST_HASH_MISMATCH");
  }
  if (!fixtureMode) {
    if (statusHeight === null) errors.push("STATUS_HEIGHT_MISSING");
    if (digestHeight === null) errors.push("DIGEST_HEIGHT_MISSING");
    if (!statusHash) errors.push("STATUS_HASH_MISSING");
    if (!digestHash) errors.push("DIGEST_HASH_MISSING");
    if (!statusChain) errors.push("STATUS_CHAIN_MISSING");
    if (!digestChain) errors.push("DIGEST_CHAIN_MISSING");
  }
  if (config.manifestDigest && digest?.releaseManifestDigest && digest.releaseManifestDigest !== config.manifestDigest) {
    errors.push("RELEASE_MANIFEST_DIGEST_MISMATCH");
  }
  const digestMatchesStatus =
    statusHeight !== null &&
    digestHeight !== null &&
    statusHeight === digestHeight &&
    (!statusHash || !digestHash || statusHash === digestHash);
  if (!fixtureMode && !digestMatchesStatus) {
    errors.push("STATUS_DIGEST_NOT_MATCHING");
  }

  // MoE hard fork reference states (this file is the spec the private registry
  // checker mirrors). Derived from the new advisory status/digest fields and kept
  // DISTINCT from the generic STATUS_/DIGEST_CHAIN_MISMATCH states above:
  //   CANONICAL_CHECKPOINT_MISMATCH - checkpoint.status === 'mismatch' (the
  //       indexer is provably on a non-canonical chain).
  //   NEEDS_UPDATE - checkpoint.status === 'unknown' AND indexedHeight is still
  //       below the lowest configured post-fork checkpoint height (not yet caught
  //       up far enough to confirm the canonical chain).
  //   NODE_VERSION_TOO_OLD - the pearld node reports a version below v1.1.0.
  const checkpoint = status?.checkpoint ?? digest?.checkpoint ?? null;
  const nodeVersion = status?.pearlNodeVersion ?? health?.pearlNodeVersion ?? null;
  const forkCheckpointHeight = lowestConfiguredCheckpointHeight(config.canonicalCheckpoints);
  const forkStates = [];
  if (checkpoint?.status === "mismatch") {
    forkStates.push("CANONICAL_CHECKPOINT_MISMATCH");
  }
  if (
    !fixtureMode &&
    checkpoint?.status === "unknown" &&
    forkCheckpointHeight !== null &&
    statusHeight !== null &&
    statusHeight < forkCheckpointHeight
  ) {
    forkStates.push("NEEDS_UPDATE");
  }
  if (nodeVersion && nodeVersion.meetsMinimum === false) {
    forkStates.push("NODE_VERSION_TOO_OLD");
  }
  errors.push(...forkStates);

  return {
    registryReady: endpointOk && operatorDocReady && errors.length === 0,
    endpointOk,
    operatorDocReady,
    operatorPublicUrl: Boolean(operatorPublicUrl),
    rewardAddress: Boolean(rewardAddress),
    challenge: Boolean(challenge),
    chain: digestChain ?? statusChain ?? config.chain,
    statusHeight,
    digestHeight,
    synced: status?.synced ?? null,
    digestMatchesStatus,
    // MoE hard fork advisory summary for the private classifier.
    forkEra: status?.forkEra ?? digest?.forkEra ?? operator?.forkEra ?? config.forkEra ?? null,
    checkpointStatus: checkpoint?.status ?? null,
    nodeVersionMeetsMinimum: nodeVersion?.meetsMinimum ?? null,
    forkStates,
    errors
  };
}

// Lowest non-placeholder checkpoint height from config (the post-fork checkpoint
// the NEEDS_UPDATE state compares against). Returns null when none configured.
function lowestConfiguredCheckpointHeight(canonicalCheckpoints) {
  const heights = (canonicalCheckpoints ?? [])
    .filter((checkpoint) => checkpoint && !checkpoint.placeholder)
    .map((checkpoint) => Number(checkpoint.height))
    .filter((height) => Number.isInteger(height));
  return heights.length > 0 ? Math.min(...heights) : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCliOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--url") {
      options.url = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown registry:check option ${arg}`);
  }
  return options;
}

async function fetchJsonWithLimit(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "x-pearlscriptions-registry-check": "1"
      }
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 512 * 1024) {
      return { status: response.status, error: "RESPONSE_TOO_LARGE" };
    }
    return { status: response.status, body: JSON.parse(text) };
  } catch (error) {
    return { status: null, error: error.name === "AbortError" ? "REQUEST_TIMEOUT" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function invokeHandlerJson(handler, path) {
  return new Promise((resolve) => {
    const response = {
      status: null,
      chunks: [],
      writeHead(status) {
        this.status = status;
      },
      end(chunk = "") {
        if (chunk) {
          this.chunks.push(Buffer.from(chunk));
        }
        try {
          resolve({
            status: this.status,
            body: JSON.parse(Buffer.concat(this.chunks).toString("utf8"))
          });
        } catch (error) {
          resolve({ status: this.status, error: error.message });
        }
      }
    };
    Promise.resolve(handler({ method: "GET", url: path }, response)).catch((error) => {
      resolve({ status: null, error: error.message });
    });
  });
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

// Only dispatch when invoked directly (node src/cli.js <command>). Guarding on
// the main-module check keeps importing this file for tests side-effect free
// while preserving the spawn-as-subprocess CLI behavior.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
