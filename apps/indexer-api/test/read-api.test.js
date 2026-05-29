import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPublicIndexerConfig } from "../src/config.js";
import { validateOperatorMetadataDocument } from "../src/operator-metadata.js";
import { createReadOnlyApi } from "../src/read-api.js";
import { normalizeSelfCheckUrl } from "../src/registry-check-policy.js";
import { createPublicIndexerRuntime, startServer } from "../src/server.js";
import {
  normalizeProtocolSnapshotForComparison,
  snapshotDigest
} from "../src/snapshot-compare.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("config loader reads local env files without overriding explicit environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pearlscriptions-env-test-"));
  const envFilePath = join(dir, ".env");
  await writeFile(
    envFilePath,
    [
      "HOST=0.0.0.0",
      "PORT=3911",
      "PRL20_CHAIN=pearl-simnet",
      "PRL20_INDEXER_BACKGROUND_SYNC_MS=0",
      "PEARL_RPC_URL="
    ].join("\n")
  );

  const config = loadPublicIndexerConfig(undefined, { envFilePath });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 3911);
  assert.equal(config.chain, "pearl-simnet");
  assert.equal(config.backgroundSyncMs, 0);

  const explicit = loadPublicIndexerConfig(
    {
      HOST: "127.0.0.1",
      PORT: "3001",
      PRL20_CHAIN: "pearl-simnet"
    },
    { envFilePath }
  );
  assert.equal(explicit.host, "127.0.0.1");
  assert.equal(explicit.port, 3001);
});

test("config loader resolves the root release manifest from workspace scripts", () => {
  const config = loadPublicIndexerConfig({});

  assert.equal(config.chain, "pearl-mainnet");
  assert.equal(
    config.mintFeePolicy.address,
    "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea"
  );
  assert.equal(
    config.mintFeePolicy.scriptPubKey,
    "51200effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa"
  );
});

test("operator metadata config validates and normalizes optional public fields", () => {
  const config = loadPublicIndexerConfig(
    {
      PRL20_CHAIN: "pearl-simnet",
      PRL20_OPERATOR_NAME: "Example Operator",
      PRL20_OPERATOR_PUBLIC_URL: "https://indexer.example/",
      PRL20_OPERATOR_REWARD_ADDRESS: "PRL1PPMLA838YFLFCSM5VR6LFGVFCLF4FGN3PUJA70CKE4WQQKL6VFLAQ3CN7EA",
      PRL20_OPERATOR_REGION: "EU",
      PRL20_OPERATOR_CONTACT_URL: "https://example.com/operator"
    },
    { loadEnvFile: false }
  );

  assert.equal(config.operator.configured, true);
  assert.equal(config.operator.name, "Example Operator");
  assert.equal(config.operator.publicUrl, "https://indexer.example");
  assert.equal(
    config.operator.rewardAddress,
    "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea"
  );
  assert.equal(config.operator.contactUrl, "https://example.com/operator");
});

test("operator metadata config rejects unsafe values", () => {
  assert.throws(
    () =>
      loadPublicIndexerConfig(
        {
          PRL20_CHAIN: "pearl-simnet",
          PRL20_OPERATOR_NAME: "<script>",
          PRL20_OPERATOR_PUBLIC_URL: "https://indexer.example"
        },
        { loadEnvFile: false }
      ),
    /plain text/
  );
  assert.throws(
    () =>
      loadPublicIndexerConfig(
        {
          PRL20_CHAIN: "pearl-simnet",
          PRL20_OPERATOR_REWARD_ADDRESS: "not-a-pearl-address"
        },
        { loadEnvFile: false }
      ),
    /Pearl bech32/
  );
});

test("remote operator metadata validation rejects script-like public fields", () => {
  const validDocument = {
    schema: "pearlscriptions-indexer-operator-v1",
    service: "pearlscriptions-indexer",
    readOnly: true,
    configured: true,
    chain: "pearl-simnet",
    version: "1.1.1",
    endpoints: {
      health: "/health",
      status: "/indexer/status",
      digest: "/indexer/digest",
      operator: "/operator",
      wellKnown: "/.well-known/pearlscriptions-indexer.json"
    },
    operator: {
      name: "Example Operator",
      publicUrl: "https://indexer.example",
      rewardAddress: "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea",
      region: "EU",
      contactUrl: "https://example.com/operator"
    },
    registry: {
      urlProof: "challenge-present",
      rewardAddressProof: "wallet-selected-deferred",
      challenge: "registry-nonce"
    }
  };

  assert.deepEqual(validateOperatorMetadataDocument(validDocument), []);
  assert.ok(
    validateOperatorMetadataDocument({
      ...validDocument,
      operator: { ...validDocument.operator, name: "<script>" }
    }).includes("OPERATOR_NAME_INVALID")
  );
  assert.ok(
    validateOperatorMetadataDocument({
      ...validDocument,
      operator: { ...validDocument.operator, region: "<script>" }
    }).includes("OPERATOR_REGION_INVALID")
  );
  assert.ok(
    validateOperatorMetadataDocument({
      ...validDocument,
      registry: { ...validDocument.registry, rewardAddressProof: "verified" }
    }).includes("OPERATOR_REGISTRY_REWARD_ADDRESS_PROOF_INVALID")
  );
  assert.ok(
    validateOperatorMetadataDocument({
      ...validDocument,
      endpoints: { ...validDocument.endpoints, digest: "/wrong" }
    }).includes("OPERATOR_ENDPOINTS_INVALID")
  );
});

test("registry check URL policy requires HTTPS except local HTTP", () => {
  assert.equal(normalizeSelfCheckUrl("http://localhost:3911").origin, "http://localhost:3911");
  assert.equal(normalizeSelfCheckUrl("http://127.0.0.1:3911").origin, "http://127.0.0.1:3911");
  assert.equal(normalizeSelfCheckUrl("http://[::1]:3911").origin, "http://[::1]:3911");
  assert.throws(() => normalizeSelfCheckUrl("http://public.example"), /must use https/);
  assert.equal(normalizeSelfCheckUrl("https://public.example").origin, "https://public.example");
  assert.throws(() => normalizeSelfCheckUrl("https://localhost"), /public hostname/);
  assert.throws(() => normalizeSelfCheckUrl("https://127.0.0.1"), /public hostname/);
  assert.throws(() => normalizeSelfCheckUrl("https://[::1]"), /public hostname/);
  assert.throws(() => normalizeSelfCheckUrl("https://server.local"), /public hostname/);
  assert.throws(() => normalizeSelfCheckUrl("https://192.168.1.10"), /public hostname/);
  assert.throws(() => normalizeSelfCheckUrl("https://internal"), /public hostname/);
});

test("public read API exposes health and digest without opening mutation methods", async () => {
  const config = loadPublicIndexerConfig({
    PRL20_CHAIN: "pearl-simnet",
    PRL20_INDEXER_SYNC_ON_START: "0"
  });
  const runtime = await createPublicIndexerRuntime(config);
  const handler = createReadOnlyApi({
    getSnapshot: runtime.getSnapshot,
    getStatus: runtime.getStatus,
    storage: runtime.storage,
    chain: config.chain,
    manifestDigest: config.manifestDigest,
    version: config.version
  });

  const health = await invoke(handler, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.version, "1.1.1");
  assert.equal(health.body.readOnly, true);
  assert.equal(health.body.indexer.mode, "fixture");
  assert.equal(health.body.indexer.storeDir, undefined);

  const discovery = await invoke(handler, "GET", "/");
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.service, "pearlscriptions-indexer");
  assert.equal(discovery.body.readOnly, true);
  assert.equal(discovery.body.endpoints.digest, "/indexer/digest");
  assert.equal(discovery.body.endpoints.operator, "/operator");

  const head = await invoke(handler, "HEAD", "/");
  assert.equal(head.status, 200);
  assert.equal(head.body, null);

  const digest = await invoke(handler, "GET", "/indexer/digest");
  assert.equal(digest.status, 200);
  assert.match(digest.body.snapshotDigest, /^[0-9a-f]{64}$/);
  assert.equal(digest.body.summary.mintCount, 2);
  assert.equal(Object.hasOwn(digest.body.summary, "marketListings"), false);
  assert.equal(Object.hasOwn(digest.body.summary, "activeMarketListings"), false);
  assert.equal(Object.hasOwn(digest.body.summary, "marketEvents"), false);

  const market = await invoke(handler, "GET", "/market/listings");
  assert.equal(market.status, 404);
  assert.equal(market.body.error, "NOT_FOUND");

  for (const [method, url] of [
    ["POST", "/health"],
    ["POST", "/operator"],
    ["PUT", "/indexer/digest"],
    ["PATCH", "/addresses/prl1alice/balances"],
    ["DELETE", "/operations"]
  ]) {
    const blocked = await invoke(handler, method, url);
    assert.equal(blocked.status, 405);
    assert.equal(blocked.body.error, "METHOD_NOT_ALLOWED");
  }
});

test("startServer returns config for CLI startup logging", async () => {
  const config = loadPublicIndexerConfig(
    {
      HOST: "127.0.0.1",
      PRL20_CHAIN: "pearl-simnet",
      PEARL_RPC_URL: "",
      PRL20_INDEXER_BACKGROUND_SYNC_MS: "0"
    },
    { loadEnvFile: false }
  );
  const started = await startServer({ ...config, port: 0 }, { listen: false });

  try {
    assert.equal(started.config.host, "127.0.0.1");
    assert.equal(started.config.port, 0);
    assert.equal(started.server.listening, false);
  } finally {
    await started.close();
  }
});

test("public digest ignores operator-local network telemetry", async () => {
  const snapshot = {
    network: {
      chain: "pearl-mainnet",
      bestHeight: 63123,
      indexedHeight: 63120,
      indexedHash: "000abc",
      blocksStored: 500,
      reorgCount: 7,
      source: "postgres",
      startHeight: 120,
      lastSyncedAt: "2026-05-29T00:00:00.000Z",
      persistenceReady: true,
      productionReady: true,
      storageBackend: "postgres",
      storageProductionReady: true,
      warning: "operator-specific"
    },
    state: {
      tokens: {},
      balances: {},
      transferLots: {},
      operations: []
    },
    token: { deployed: true, mintCount: 21000, mintedSupply: "2100000000" },
    tokens: [],
    inscriptions: [],
    operations: [],
    transferLots: [],
    addressToScriptPubKey: {
      prl1localoperator: "5120".padEnd(68, "0")
    },
    outputsByOutpoint: {
      "local-output:0": { valueGrain: "50000" }
    },
    prlBalances: {
      prl1localoperator: "0"
    },
    spendsByOutpoint: {
      "local-output:0": "local-spend:0"
    },
    transactions: {
      "local-tx": { txid: "local-tx" }
    },
    txStatus: {
      "local-tx": { txid: "local-tx", status: "confirmed" }
    },
    utxos: {
      prl1localoperator: []
    }
  };
  const handler = createReadOnlyApi({
    getSnapshot: async () => snapshot,
    getStatus: async () => ({ mode: "test" }),
    chain: "pearl-mainnet",
    manifestDigest: "b".repeat(64),
    version: "1.1.1"
  });

  const response = await invoke(handler, "GET", "/indexer/digest");
  const normalized = normalizeProtocolSnapshotForComparison(snapshot);

  assert.equal(response.status, 200);
  assert.equal(response.body.snapshotDigest, snapshotDigest(normalized));
  assert.equal(response.body.summary.chain, "pearl-mainnet");
  assert.equal(response.body.summary.indexedHeight, 63120);
  assert.equal(normalized.network.bestHeight, undefined);
  assert.equal(normalized.network.reorgCount, undefined);
  assert.equal(normalized.addressToScriptPubKey, undefined);
  assert.equal(normalized.outputsByOutpoint, undefined);
  assert.equal(normalized.transactions, undefined);
  assert.equal(normalized.txStatus, undefined);
  assert.equal(normalized.utxos, undefined);
});

test("public digest can use precomputed published metadata without loading full snapshot", async () => {
  let snapshotCalls = 0;
  const indexedHash = "a".repeat(64);
  const handler = createReadOnlyApi({
    getSnapshot: async () => {
      snapshotCalls += 1;
      throw new Error("full snapshot should not be loaded");
    },
    getStatus: async () => ({ mode: "test" }),
    storage: {
      async readSnapshotNetworkMetadata() {
        return {
          chain: "pearl-mainnet",
          indexedHeight: 63124,
          indexedHash,
          protocolSnapshotDigest: "c".repeat(64),
          protocolSummary: {
            chain: "pearl-mainnet",
            indexedHeight: 63124,
            indexedHash,
            mintCount: 21000
          }
        };
      }
    },
    chain: "pearl-mainnet",
    manifestDigest: "b".repeat(64),
    version: "1.1.1"
  });

  const response = await invoke(handler, "GET", "/indexer/digest");

  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.indexedHeight, 63124);
  assert.equal(response.body.indexedHash, indexedHash);
  assert.equal(response.body.snapshotDigest, "c".repeat(64));
  assert.equal(response.body.summary.mintCount, 21000);
  assert.equal(snapshotCalls, 0);
});

test("operator metadata routes expose configured safe metadata", async () => {
  const config = loadPublicIndexerConfig(
    {
      PRL20_CHAIN: "pearl-simnet",
      PRL20_INDEXER_SYNC_ON_START: "0",
      PRL20_OPERATOR_NAME: "Pearl Node",
      PRL20_OPERATOR_PUBLIC_URL: "https://indexer.example",
      PRL20_OPERATOR_REWARD_ADDRESS: "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea",
      PRL20_OPERATOR_REGION: "EU",
      PRL20_OPERATOR_CONTACT_URL: "https://example.com",
      PRL20_OPERATOR_REGISTRY_CHALLENGE: "registry-nonce"
    },
    { loadEnvFile: false }
  );
  const runtime = await createPublicIndexerRuntime(config);
  const handler = createReadOnlyApi({
    getSnapshot: runtime.getSnapshot,
    getStatus: runtime.getStatus,
    storage: runtime.storage,
    chain: config.chain,
    manifestDigest: config.manifestDigest,
    version: config.version,
    operatorMetadata: config.operator
  });

  const operator = await invoke(handler, "GET", "/operator");
  assert.equal(operator.status, 200);
  assert.equal(operator.body.schema, "pearlscriptions-indexer-operator-v1");
  assert.equal(operator.body.readOnly, true);
  assert.equal(operator.body.configured, true);
  assert.equal(operator.body.version, "1.1.1");
  assert.deepEqual(operator.body.endpoints, {
    health: "/health",
    status: "/indexer/status",
    digest: "/indexer/digest",
    operator: "/operator",
    wellKnown: "/.well-known/pearlscriptions-indexer.json"
  });
  assert.equal(operator.body.operator.name, "Pearl Node");
  assert.equal(operator.body.operator.publicUrl, "https://indexer.example");
  assert.equal(operator.body.registry.urlProof, "challenge-present");
  assert.equal(operator.body.registry.rewardAddressProof, "wallet-selected-deferred");
  assert.equal(operator.body.registry.challenge, "registry-nonce");

  const wellKnown = await invoke(handler, "GET", "/.well-known/pearlscriptions-indexer.json");
  assert.deepEqual(wellKnown.body, operator.body);
});

test("default operator metadata does not leak local config", async () => {
  const config = loadPublicIndexerConfig(
    {
      PRL20_CHAIN: "pearl-simnet",
      PRL20_INDEXER_SYNC_ON_START: "0",
      PRL20_INDEXER_STORE_DIR: "/tmp/pearlscriptions-secret-store",
      PRL20_DATABASE_URL: "postgres://user:secret@127.0.0.1:5432/db",
      PEARL_RPC_PASSWORD: "secret"
    },
    { loadEnvFile: false }
  );
  const runtime = await createPublicIndexerRuntime(config);
  const handler = createReadOnlyApi({
    getSnapshot: runtime.getSnapshot,
    getStatus: runtime.getStatus,
    storage: runtime.storage,
    chain: config.chain,
    manifestDigest: config.manifestDigest,
    version: config.version,
    operatorMetadata: config.operator
  });

  const operator = await invoke(handler, "GET", "/operator");
  const serialized = JSON.stringify(operator.body);
  assert.equal(operator.status, 200);
  assert.equal(operator.body.configured, false);
  assert.equal(operator.body.registry.urlProof, "not-configured");
  assert.equal(operator.body.registry.rewardAddressProof, "not-configured");
  assert.equal(serialized.includes("/tmp/pearlscriptions-secret-store"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("postgres://"), false);
  assert.equal(serialized.includes("127.0.0.1"), false);
});

test("registry check command passes in local fixture mode", () => {
  const cliPath = join(__dirname, "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cliPath, "registry:check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PRL20_CHAIN: "pearl-simnet",
      PEARL_RPC_URL: "",
      PRL20_OPERATOR_NAME: "Local Fixture Operator",
      PRL20_OPERATOR_PUBLIC_URL: "",
      PRL20_OPERATOR_REWARD_ADDRESS: "",
      PRL20_OPERATOR_REGISTRY_CHALLENGE: ""
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "local");
  assert.equal(body.readiness.registryReady, false);
  assert.equal(body.readiness.endpointOk, true);
  assert.equal(body.readiness.operatorDocReady, true);
  assert.ok(body.readiness.errors.includes("OPERATOR_PUBLIC_URL_MISSING"));
  assert.ok(body.readiness.errors.includes("OPERATOR_REWARD_ADDRESS_MISSING"));
  assert.ok(body.readiness.errors.includes("OPERATOR_REGISTRY_CHALLENGE_MISSING"));
  assert.equal(body.readiness.errors.includes("STATUS_CHAIN_MISMATCH"), false);
  assert.equal(body.readiness.errors.includes("DIGEST_CHAIN_MISMATCH"), false);
  assert.deepEqual(
    body.checks.map((check) => [check.name, check.ok]),
    [
      ["operator-metadata", true],
      ["/health", true],
      ["/indexer/status", true],
      ["/indexer/digest", true],
      ["/operator", true],
      ["/.well-known/pearlscriptions-indexer.json", true]
    ]
  );
});

function invoke(handler, method, url) {
  return new Promise((resolve, reject) => {
    const response = {
      status: null,
      headers: null,
      chunks: [],
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(chunk = "") {
        if (chunk) {
          this.chunks.push(Buffer.from(chunk));
        }
        if (this.chunks.length === 0) {
          resolve({
            status: this.status,
            headers: this.headers,
            body: null
          });
          return;
        }
        try {
          resolve({
            status: this.status,
            headers: this.headers,
            body: JSON.parse(Buffer.concat(this.chunks).toString("utf8"))
          });
        } catch (error) {
          reject(error);
        }
      }
    };
    Promise.resolve(handler({ method, url }, response)).catch(reject);
  });
}
