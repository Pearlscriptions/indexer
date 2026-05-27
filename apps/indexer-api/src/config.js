import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PRLS } from "../../../packages/prl20-core/src/index.js";

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
  const chain = env.PRL20_CHAIN ?? manifest.network ?? "pearl-mainnet";
  const mintFeePolicy = mintFeePolicyFromManifest(manifest);

  assertSafeMainnetConfig({ chain, manifest, mintFeePolicy });

  return {
    port: parseInteger(env.PORT, 3000, { min: 1, max: 65_535 }),
    host: env.HOST ?? "127.0.0.1",
    chain,
    manifestPath,
    manifest,
    manifestDigest: sha256Json(manifest),
    mintFeePolicy,
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

function assertSafeMainnetConfig({ chain, mintFeePolicy }) {
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
