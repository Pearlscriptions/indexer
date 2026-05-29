#!/usr/bin/env node
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

const command = process.argv[2] ?? "help";
const REGISTRY_CHECK_PATHS = [
  "/health",
  "/indexer/status",
  "/indexer/digest",
  "/operator",
  "/.well-known/pearlscriptions-indexer.json"
];

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
    const normalized = normalizeProtocolSnapshotForComparison(snapshot);
    writeJson({
      chain: snapshot?.network?.chain ?? runtime.config.chain,
      snapshotDigest: snapshotDigest(normalized),
      releaseManifestDigest: runtime.config.manifestDigest,
      summary: summarizeSnapshot(normalized)
    });
  } else if (command === "registry:check") {
    writeJson(await registryCheck(loadPublicIndexerConfig(), parseCliOptions(process.argv.slice(3))));
  } else {
    process.stdout.write(`Usage: node src/cli.js <serve|sync|status|digest|registry:check>\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

async function registryCheck(config, options) {
  const checks = [];
  const warnings = [];
  let readiness = null;
  const metadataDocument = operatorMetadataDocument(config.operator, {
    chain: config.chain,
    version: config.version
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
    operatorMetadata: config.operator
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

function buildRegistryReadiness(results, config, targetUrl = null) {
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
    errors
  };
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
