import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PRLS } from "../../../packages/prl20-core/src/index.js";
import { loadOperatorMetadata } from "./operator-metadata.js";
import { assertHash } from "./storage.js";

// MoE hard fork (advisory node-compat). The placeholder hash is shipped in the
// example manifest so operators can see the shape; it is treated as
// "unconfigured" everywhere and rejected on pearl-mainnet (see
// assertSafeMainnetConfig), mirroring the mint-fee FILL_ placeholder pattern.
const CANONICAL_CHECKPOINT_PLACEHOLDER = "FILL_POST_FORK_BLOCKHASH_FROM_PEARLD_V1_1_0";
export const DEFAULT_FORK_ERA = "moe-v2";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "../../..");
const DEFAULT_RELEASE_MANIFEST_PATH = resolve(REPO_ROOT, "release-manifest.example.json");

export function loadPublicIndexerConfig(env = undefined, options = {}) {
  const shouldLoadEnvFile = options.loadEnvFile ?? env === undefined;
  env = shouldLoadEnvFile
    ? mergeDotEnv(env ?? process.env, options.envFilePath ?? defaultEnvFilePath())
    : (env ?? process.env);

  const manifestPath = env.PRL20_RELEASE_MANIFEST
    ? resolve(env.PRL20_RELEASE_MANIFEST)
    : DEFAULT_RELEASE_MANIFEST_PATH;
  const manifest = readJsonFile(manifestPath, defaultReleaseManifest());
  const packageJson = readJsonFile(resolve(REPO_ROOT, "package.json"), {});
  const chain = env.PRL20_CHAIN ?? manifest.network ?? "pearl-mainnet";
  const mintFeePolicy = mintFeePolicyFromManifest(manifest);
  const canonicalCheckpoints = parseCanonicalCheckpoints(manifest.canonicalCheckpoints);
  const forkEra = parseForkEra(manifest.forkEra);

  assertSafeMainnetConfig({ chain, manifest, mintFeePolicy, canonicalCheckpoints });

  return {
    port: parseInteger(env.PORT, 3000, { min: 1, max: 65_535 }),
    host: env.HOST ?? "127.0.0.1",
    // Process role for the API/worker split:
    //   all    (default) - this process both serves the HTTP API and runs the
    //                      background sync loop. Byte-identical to pre-split
    //                      behavior for existing single-process operators.
    //   api             - serve reads only; never sync in-process (no interval,
    //                      no syncOnStart, no sync-on-cache-miss). Reads the
    //                      snapshot a separate worker publishes.
    //   worker          - run only the sync loop (see `cli.js worker`); do not
    //                      serve HTTP. The sole snapshot writer.
    role: parseRole(env.PRL20_INDEXER_ROLE),
    chain,
    manifestPath,
    manifest,
    manifestDigest: sha256Json(manifest),
    version: packageJson.version ?? null,
    mintFeePolicy,
    // MoE hard fork advisory node-compat (cross-repo frozen contract).
    // canonicalCheckpoints are part of the hashed manifest above, so they also
    // shift manifestDigest (a second signal for operator registry checkers).
    canonicalCheckpoints,
    forkEra,
    operator: loadOperatorMetadata(env),
    fixturePath: env.PRL20_FIXTURE_PATH ? resolve(env.PRL20_FIXTURE_PATH) : null,
    pearlRpc: {
      url: env.PEARL_RPC_URL ?? "",
      user: env.PEARL_RPC_USER ?? "",
      password: env.PEARL_RPC_PASSWORD ?? "",
      timeoutMs: parseInteger(env.PEARL_RPC_TIMEOUT_MS, 30_000, {
        min: 1_000,
        max: 300_000
      }),
      retries: parseInteger(env.PEARL_RPC_RETRIES, 3, {
        min: 0,
        max: 20
      }),
      retryDelayMs: parseInteger(env.PEARL_RPC_RETRY_DELAY_MS, 750, {
        min: 0,
        max: 60_000
      })
    },
    storage: {
      backend: env.PRL20_INDEXER_STORAGE_BACKEND ?? "json-file",
      storeDir: env.PRL20_INDEXER_STORE_DIR ?? "./indexer-store",
      databaseUrl: env.PRL20_DATABASE_URL ?? env.DATABASE_URL ?? "",
      manifestName: env.PRL20_INDEXER_MANIFEST_NAME ?? chain
    },
    startHeight: parseInteger(env.PRL20_INDEXER_START_HEIGHT, 0, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER
    }),
    batchSize: parseInteger(env.PRL20_INDEXER_BATCH_SIZE, 100, {
      min: 1,
      max: 1000
    }),
    maxBlocksPerSync: parseInteger(env.PRL20_INDEXER_MAX_BLOCKS_PER_SYNC, 0, {
      min: 0,
      max: 1000
    }),
    parityMode: parseParityMode(env.PRL20_INDEXER_PARITY_MODE),
    backgroundSyncMs: parseInteger(env.PRL20_INDEXER_BACKGROUND_SYNC_MS, 30_000, {
      min: 0,
      max: 24 * 60 * 60 * 1000
    }),
    syncOnStart: env.PRL20_INDEXER_SYNC_ON_START !== "0",
    readOnly: true
  };
}

export function mintFeePolicyFromManifest(manifest) {
  const prls = manifest?.prls ?? {};
  return {
    required: true,
    valueGrain: String(prls.mintFeeGrain ?? PRLS.mintFeeGrain),
    valuePrl: prls.mintFeePrl ?? PRLS.mintFeePrl,
    address: emptyToNull(prls.mintFeeRecipient ?? prls.mintFeeAddress),
    scriptPubKey: emptyToNull(prls.mintFeeScriptPubKey)
  };
}

// Parse + validate manifest.canonicalCheckpoints into a normalized array of
// { height, hash, placeholder } pins. height must be a non-negative int; hash is
// validated as 64-hex via storage.assertHash, EXCEPT the shipped FILL_
// placeholder which is accepted and flagged placeholder:true (treated as
// "unconfigured" by the mainnet fail-fast and by checkpoint verification).
// Defaults to []. Lowercases real hashes so downstream comparisons are uniform.
export function parseCanonicalCheckpoints(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("canonicalCheckpoints must be an array in PRL20_RELEASE_MANIFEST");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`canonicalCheckpoints[${index}] must be an object`);
    }
    const height = Number(entry.height);
    if (!Number.isInteger(height) || height < 0 || !Number.isSafeInteger(height)) {
      throw new Error(`canonicalCheckpoints[${index}].height must be a safe non-negative integer`);
    }
    const rawHash = String(entry.hash ?? "");
    if (rawHash === CANONICAL_CHECKPOINT_PLACEHOLDER || rawHash.includes("FILL_")) {
      return { height, hash: rawHash, placeholder: true };
    }
    return { height, hash: assertHash(rawHash, `canonicalCheckpoints[${index}].hash`), placeholder: false };
  });
}

function parseForkEra(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_FORK_ERA;
  }
  return String(value);
}

function assertSafeMainnetConfig({ chain, mintFeePolicy, canonicalCheckpoints }) {
  if (chain !== "pearl-mainnet") {
    return;
  }
  const address = mintFeePolicy.address ?? "";
  const script = mintFeePolicy.scriptPubKey ?? "";
  if (!address || address.includes("FILL_") || !script || script.includes("FILL_")) {
    throw new Error(
      "pearl-mainnet requires final PRLS mint fee recipient and scriptPubKey in PRL20_RELEASE_MANIFEST"
    );
  }
  // MoE hard fork: pearl-mainnet must ship at least one real post-fork
  // checkpoint so the indexer can detect a stale/non-canonical chain. Mirror the
  // mint-fee FILL_ rejection above: empty or any placeholder hash fails fast.
  const configuredCheckpoints = (canonicalCheckpoints ?? []).filter(
    (checkpoint) => !checkpoint.placeholder
  );
  if (configuredCheckpoints.length === 0) {
    throw new Error(
      "pearl-mainnet requires at least one real canonicalCheckpoints entry (post-fork blockhash from pearld >= v1.1.0) in PRL20_RELEASE_MANIFEST"
    );
  }
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

function defaultReleaseManifest() {
  return {
    schema: "pearlscriptions-release-manifest-v1",
    network: "pearl-mainnet",
    protocol: "prl-20-v0",
    prls: {
      tick: "prls",
      max: PRLS.maxSupply.toString(),
      lim: PRLS.mintAmount.toString(),
      dec: PRLS.decimals,
      mintFeeGrain: PRLS.mintFeeGrain.toString(),
      mintFeeRecipient: "FILL_FINAL_PUBLIC_ADDRESS_BEFORE_MAINNET",
      mintFeeScriptPubKey: "FILL_FINAL_SCRIPT_PUBKEY_BEFORE_MAINNET"
    }
  };
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortJson(value[key]);
  }
  return output;
}

function parseInteger(value, fallback, { min, max }) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

const INDEXER_ROLES = new Set(["all", "api", "worker"]);

function parseRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  if (role === "") {
    return "all";
  }
  if (!INDEXER_ROLES.has(role)) {
    throw new Error(
      `invalid PRL20_INDEXER_ROLE "${value}"; expected one of all, api, worker`
    );
  }
  return role;
}

const PARITY_MODES = new Set(["inline", "post-publish", "off"]);

function parseParityMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "") {
    return "inline";
  }
  if (!PARITY_MODES.has(mode)) {
    throw new Error(
      `invalid PRL20_INDEXER_PARITY_MODE "${value}"; expected one of inline, post-publish, off`
    );
  }
  return mode;
}

function emptyToNull(value) {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

function mergeDotEnv(baseEnv, envFilePath) {
  const resolvedPath = resolve(envFilePath);
  if (!existsSync(resolvedPath)) {
    return baseEnv;
  }
  return {
    ...parseDotEnv(readFileSync(resolvedPath, "utf8")),
    ...baseEnv
  };
}

function defaultEnvFilePath() {
  const cwdEnv = resolve(".env");
  return existsSync(cwdEnv) ? cwdEnv : resolve(REPO_ROOT, ".env");
}

function parseDotEnv(text) {
  const output = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    output[key] = unquoteEnvValue(value);
  }
  return output;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
