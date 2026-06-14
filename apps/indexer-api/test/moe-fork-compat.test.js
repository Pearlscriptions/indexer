import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { loadPublicIndexerConfig, parseCanonicalCheckpoints } from "../src/config.js";
import { ingestPearlBlocksFixture, loadFixture } from "../src/indexer.js";
import { operatorMetadataDocument, validateOperatorMetadataDocument } from "../src/operator-metadata.js";
import { createReadOnlyApi } from "../src/read-api.js";
import {
  compareSemver,
  createPersistentPrl20Indexer,
  isCompatibleGetblockSchema,
  parsePearldSemver
} from "../src/persistent-indexer.js";
import {
  normalizeProtocolSnapshotForComparison,
  publicProtocolSnapshot,
  snapshotDigest,
  summarizeSnapshot
} from "../src/snapshot-compare.js";

// A real pre-fork mainnet checkpoint (public on-chain data, safe to hardcode).
const REAL_CHECKPOINT_HEIGHT = 1000;
const REAL_CHECKPOINT_HASH =
  "cffc301695c9844aa1fd218bcc5064230025ed885cfa163ab953af86d678b610";

// ---------------------------------------------------------------------------
// TEST 1: checkpoint verification (match / mismatch / unknown)
// ---------------------------------------------------------------------------

test("checkpoint verify reports match when the pin equals the stored hash", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-checkpoint-match-"));
  const deployBlock = block(1, hash("01"), null, []);
  const mintBlock = block(2, hash("02"), deployBlock.hash, []);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, mintBlock]),
    storeDir,
    startHeight: 1,
    // Pin height 2 -> the stored hash; both applicable and equal.
    canonicalCheckpoints: [{ height: 2, hash: hash("02"), placeholder: false }]
  });

  const result = await indexer.syncToTip();

  assert.equal(result.status.checkpoint.status, "match");
  assert.equal(result.status.checkpoint.height, 2);
  assert.equal(result.status.checkpoint.expectedHash, hash("02"));
  assert.equal(result.status.checkpoint.observedHash, hash("02"));
  assert.equal(result.status.message, null);
});

test("checkpoint verify reports mismatch when the pin differs from the stored hash", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-checkpoint-mismatch-"));
  const deployBlock = block(1, hash("01"), null, []);
  const mintBlock = block(2, hash("02"), deployBlock.hash, []);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, mintBlock]),
    storeDir,
    startHeight: 1,
    // Pin height 2 to a DIFFERENT hash than the stored block -> mismatch.
    canonicalCheckpoints: [{ height: 2, hash: hash("ff"), placeholder: false }]
  });

  const result = await indexer.syncToTip();

  assert.equal(result.status.checkpoint.status, "mismatch");
  assert.equal(result.status.checkpoint.height, 2);
  assert.equal(result.status.checkpoint.expectedHash, hash("ff"));
  assert.equal(result.status.checkpoint.observedHash, hash("02"));
  assert.equal(
    result.status.message,
    "Indexer is on a non-canonical chain (checkpoint mismatch at height 2). Re-sync against a Pearl node >= v1.1.0 with the MoE hard fork."
  );
});

test("checkpoint verify reports unknown with no pins, with only a placeholder, or below the pin height", async () => {
  // (a) No pins configured.
  const noneDir = await mkdtemp(join(tmpdir(), "moe-checkpoint-none-"));
  const deployBlock = block(1, hash("01"), null, []);
  const noneIndexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir: noneDir,
    startHeight: 1,
    canonicalCheckpoints: []
  });
  const none = await noneIndexer.syncToTip();
  assert.equal(none.status.checkpoint.status, "unknown");
  assert.equal(none.status.checkpoint.height, null);

  // (b) Only a placeholder pin -> treated as unconfigured.
  const placeholderDir = await mkdtemp(join(tmpdir(), "moe-checkpoint-placeholder-"));
  const placeholderIndexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir: placeholderDir,
    startHeight: 1,
    canonicalCheckpoints: [
      { height: 0, hash: "FILL_POST_FORK_BLOCKHASH_FROM_PEARLD_V1_1_0", placeholder: true }
    ]
  });
  const placeholder = await placeholderIndexer.syncToTip();
  assert.equal(placeholder.status.checkpoint.status, "unknown");

  // (c) Pin height is above indexedHeight -> not applicable yet.
  const belowDir = await mkdtemp(join(tmpdir(), "moe-checkpoint-below-"));
  const belowIndexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir: belowDir,
    startHeight: 1,
    canonicalCheckpoints: [{ height: 999, hash: hash("aa"), placeholder: false }]
  });
  const below = await belowIndexer.syncToTip();
  assert.equal(below.status.checkpoint.status, "unknown");
});

// ---------------------------------------------------------------------------
// TEST 2: node-version parsing (meetsMinimum true/false, missing -> null)
// ---------------------------------------------------------------------------

test("node version parses pearld semver and flags a pre-fork build below v1.1.0", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-node-old-"));
  const deployBlock = block(1, hash("01"), null, []);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock], [], {
      networkInfo: { subversion: "/pearlwire:0.5.0/pearld:1.0.6/", version: 1000600 }
    }),
    storeDir,
    startHeight: 1
  });

  const result = await indexer.syncToTip();

  assert.equal(result.status.pearlNodeVersion.raw, "/pearlwire:0.5.0/pearld:1.0.6/");
  assert.deepEqual(result.status.pearlNodeVersion.semver, { major: 1, minor: 0, patch: 6 });
  assert.equal(result.status.pearlNodeVersion.meetsMinimum, false);
  assert.equal(result.status.pearlNodeVersion.minimum, "1.1.0");
  assert.equal(
    result.status.message,
    "Pearl node predates the MoE hard fork; update pearld to >= v1.1.0."
  );
});

test("node version accepts pearld 1.1.0 and tolerates a version suffix", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-node-new-"));
  const deployBlock = block(1, hash("01"), null, []);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock], [], {
      networkInfo: { subversion: "/pearld:1.1.0-presync/", version: 1010000 }
    }),
    storeDir,
    startHeight: 1
  });

  const result = await indexer.syncToTip();
  assert.deepEqual(result.status.pearlNodeVersion.semver, { major: 1, minor: 1, patch: 0 });
  assert.equal(result.status.pearlNodeVersion.meetsMinimum, true);

  // Pure parsing helpers.
  assert.deepEqual(parsePearldSemver("/pearlwire:0.5.0/pearld:1.0.6/"), {
    major: 1,
    minor: 0,
    patch: 6
  });
  assert.equal(parsePearldSemver("no-pearld-token-here"), null);
  assert.ok(compareSemver({ major: 1, minor: 1, patch: 0 }, "1.1.0") === 0);
  assert.ok(compareSemver({ major: 1, minor: 0, patch: 6 }, "1.1.0") < 0);
  assert.ok(compareSemver({ major: 1, minor: 2, patch: 0 }, "1.1.0") > 0);
});

test("node version falls back to the integer version field when subversion lacks pearld", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-node-intfallback-"));
  const deployBlock = block(1, hash("01"), null, []);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock], [], {
      networkInfo: { subversion: "/btcwire:0.5.0/", version: 1010000 }
    }),
    storeDir,
    startHeight: 1
  });

  const result = await indexer.syncToTip();
  assert.equal(result.status.pearlNodeVersion.semver, null);
  assert.equal(result.status.pearlNodeVersion.meetsMinimum, true);
});

test("missing getnetworkinfo degrades to null version and does not crash sync", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-node-missing-"));
  const deployBlock = block(1, hash("01"), null, []);
  const calls = [];
  const indexer = createPersistentPrl20Indexer({
    // networkInfo:null makes getnetworkinfo throw "Method not found".
    pearlRpc: makeRpc([deployBlock], calls, { networkInfo: null }),
    storeDir,
    startHeight: 1
  });

  const result = await indexer.syncToTip();

  // Sync completed despite the RPC error.
  assert.equal(result.status.blocksStored, 1);
  assert.equal(result.status.pearlNodeVersion.raw, null);
  assert.equal(result.status.pearlNodeVersion.semver, null);
  assert.equal(result.status.pearlNodeVersion.meetsMinimum, null);
  // The probe was attempted (and swallowed).
  assert.ok(calls.some((call) => call[0] === "getnetworkinfo"));
});

// ---------------------------------------------------------------------------
// TEST 3: API fields on /health, /indexer/status, /operator, and both builders
// ---------------------------------------------------------------------------

test("advisory fields appear on /health (ok:true with warning on mismatch) and /indexer/status", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-api-mismatch-"));
  const deployBlock = block(1, hash("01"), null, []);
  const mintBlock = block(2, hash("02"), deployBlock.hash, []);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, mintBlock], [], {
      networkInfo: { subversion: "/pearld:1.1.0/", version: 1010000 }
    }),
    storeDir,
    startHeight: 1,
    canonicalCheckpoints: [{ height: 2, hash: hash("ff"), placeholder: false }],
    forkEra: "moe-v2",
    indexerVersion: "1.2.1"
  });
  await indexer.syncToTip();

  const handler = createReadOnlyApi({
    getSnapshot: async () => ({ network: { chain: "pearl-simnet" } }),
    getStatus: () => indexer.status(),
    chain: "pearl-simnet",
    manifestDigest: "a".repeat(64),
    version: "1.2.1",
    forkEra: "moe-v2"
  });

  const health = await invoke(handler, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true); // never flipped to false
  assert.equal(health.body.forkEra, "moe-v2");
  assert.equal(health.body.indexerVersion, "1.2.1");
  assert.equal(health.body.checkpoint.status, "mismatch");
  assert.equal(health.body.pearlNodeVersion.meetsMinimum, true);
  assert.equal(
    health.body.warning,
    "Indexer is on a non-canonical chain (checkpoint mismatch at height 2). Re-sync against a Pearl node >= v1.1.0 with the MoE hard fork."
  );

  const status = await invoke(handler, "GET", "/indexer/status");
  assert.equal(status.status, 200);
  // Additive keys live inside the status object, not wrapped.
  assert.equal(status.body.checkpoint.status, "mismatch");
  assert.equal(status.body.forkEra, "moe-v2");
  assert.equal(status.body.indexerVersion, "1.2.1");
  assert.equal(status.body.pearlNodeVersion.meetsMinimum, true);
  assert.equal(status.body.nodeSchema, "compatible");
  // pearlNodeVersion carries only a version string, no host/path.
  const serialized = JSON.stringify(status.body.pearlNodeVersion);
  assert.equal(serialized.includes("/"), true); // raw subversion has slashes
  assert.equal(serialized.includes("127.0.0.1"), false);
  assert.equal(serialized.includes("http"), false);
});

test("/operator exposes only a static forkEra and older operator docs still validate", () => {
  const withFork = operatorMetadataDocument(
    { configured: false },
    { chain: "pearl-simnet", version: "1.2.1", forkEra: "moe-v2" }
  );
  assert.equal(withFork.forkEra, "moe-v2");
  // forkEra is additive and OPTIONAL: the doc still validates clean.
  assert.deepEqual(validateOperatorMetadataDocument(withFork), []);
  // Endpoints are unchanged (no new endpoint keys -> hasExpectedEndpoints holds).
  assert.deepEqual(Object.keys(withFork.endpoints).sort(), [
    "digest",
    "health",
    "operator",
    "status",
    "wellKnown"
  ]);

  // A document WITHOUT forkEra (older operator) is still valid.
  const withoutFork = operatorMetadataDocument({ configured: false }, { chain: "pearl-simnet" });
  assert.equal(Object.hasOwn(withoutFork, "forkEra"), false);
  assert.deepEqual(validateOperatorMetadataDocument(withoutFork), []);
});

test("both buildStatus and buildStatusFromSnapshot include the advisory fields", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-both-builders-"));
  const deployBlock = block(1, hash("01"), null, []);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir,
    startHeight: 1,
    canonicalCheckpoints: [{ height: 1, hash: hash("01"), placeholder: false }],
    forkEra: "moe-v2",
    indexerVersion: "1.2.1"
  });
  // A real sync populates the manifest blocks and runs both advisory checks.
  await indexer.syncToTip();

  const direct = indexer.buildStatus(1);
  for (const key of ["indexerVersion", "pearlNodeVersion", "checkpoint", "forkEra", "nodeSchema", "message"]) {
    assert.ok(Object.hasOwn(direct, key), `buildStatus missing ${key}`);
  }
  assert.equal(direct.checkpoint.status, "match");
  assert.equal(direct.forkEra, "moe-v2");

  const fromSnapshot = indexer.buildStatusFromSnapshot(
    { network: { chain: "pearl-simnet", indexedHeight: 1, indexedHash: hash("01") } },
    1
  );
  for (const key of ["indexerVersion", "pearlNodeVersion", "checkpoint", "forkEra", "nodeSchema", "message"]) {
    assert.ok(Object.hasOwn(fromSnapshot, key), `buildStatusFromSnapshot missing ${key}`);
  }
  assert.equal(fromSnapshot.checkpoint.status, "match");
  assert.equal(fromSnapshot.forkEra, "moe-v2");
});

test("/indexer/digest exposes checkpoint and forkEra as siblings without changing the digest", async () => {
  const snapshot = loadFixtureSnapshot();
  const normalized = normalizeProtocolSnapshotForComparison(snapshot);
  const expectedDigest = snapshotDigest(normalized);

  const handler = createReadOnlyApi({
    getSnapshot: async () => snapshot,
    getStatus: async () => ({
      checkpoint: { status: "mismatch", height: 2, expectedHash: "f".repeat(64), observedHash: "0".repeat(64) },
      forkEra: "moe-v2",
      pearlNodeVersion: { raw: "/pearld:1.0.6/", semver: { major: 1, minor: 0, patch: 6 }, meetsMinimum: false, minimum: "1.1.0" }
    }),
    chain: "pearl-mainnet",
    manifestDigest: "b".repeat(64),
    version: "1.2.1",
    forkEra: "moe-v2"
  });

  const digest = await invoke(handler, "GET", "/indexer/digest");
  assert.equal(digest.status, 200);
  // The protocol digest is unaffected by the advisory siblings.
  assert.equal(digest.body.snapshotDigest, expectedDigest);
  // Siblings are present for the private checker.
  assert.equal(digest.body.checkpoint.status, "mismatch");
  assert.equal(digest.body.forkEra, "moe-v2");
  assert.equal(digest.body.pearlNodeVersion.meetsMinimum, false);
});

// ---------------------------------------------------------------------------
// TEST 4: registry buildRegistryReadiness reference states (real function)
// ---------------------------------------------------------------------------

test("buildRegistryReadiness emits CANONICAL_CHECKPOINT_MISMATCH on a checkpoint mismatch", async () => {
  const { buildRegistryReadiness } = await import("../src/cli.js");
  const readiness = buildRegistryReadiness(
    makeRegistryResults({ checkpoint: { status: "mismatch", height: 1000 } }),
    registryConfig()
  );
  assert.ok(readiness.errors.includes("CANONICAL_CHECKPOINT_MISMATCH"));
  assert.ok(readiness.forkStates.includes("CANONICAL_CHECKPOINT_MISMATCH"));
  assert.equal(readiness.checkpointStatus, "mismatch");
  // Distinct from the generic chain-mismatch states.
  assert.equal(readiness.errors.includes("STATUS_CHAIN_MISMATCH"), false);
  assert.equal(readiness.errors.includes("DIGEST_CHAIN_MISMATCH"), false);
});

test("buildRegistryReadiness emits NEEDS_UPDATE when unknown and below the post-fork checkpoint height", async () => {
  const { buildRegistryReadiness } = await import("../src/cli.js");
  const readiness = buildRegistryReadiness(
    makeRegistryResults({
      indexedHeight: 500,
      synced: false,
      checkpoint: { status: "unknown", height: null }
    }),
    registryConfig({
      canonicalCheckpoints: [{ height: 1000, hash: REAL_CHECKPOINT_HASH, placeholder: false }]
    })
  );
  assert.ok(readiness.errors.includes("NEEDS_UPDATE"));
  assert.ok(readiness.forkStates.includes("NEEDS_UPDATE"));
});

test("buildRegistryReadiness does NOT emit NEEDS_UPDATE once indexedHeight reaches the checkpoint", async () => {
  const { buildRegistryReadiness } = await import("../src/cli.js");
  const readiness = buildRegistryReadiness(
    makeRegistryResults({
      indexedHeight: 1500,
      checkpoint: { status: "unknown", height: null }
    }),
    registryConfig({
      canonicalCheckpoints: [{ height: 1000, hash: REAL_CHECKPOINT_HASH, placeholder: false }]
    })
  );
  assert.equal(readiness.forkStates.includes("NEEDS_UPDATE"), false);
});

test("buildRegistryReadiness emits NODE_VERSION_TOO_OLD when the node is below v1.1.0", async () => {
  const { buildRegistryReadiness } = await import("../src/cli.js");
  const readiness = buildRegistryReadiness(
    makeRegistryResults({ pearlNodeVersion: { meetsMinimum: false } }),
    registryConfig()
  );
  assert.ok(readiness.errors.includes("NODE_VERSION_TOO_OLD"));
  assert.ok(readiness.forkStates.includes("NODE_VERSION_TOO_OLD"));
  assert.equal(readiness.nodeVersionMeetsMinimum, false);
});

test("buildRegistryReadiness emits none of the MoE states on a healthy canonical chain", async () => {
  const { buildRegistryReadiness } = await import("../src/cli.js");
  const readiness = buildRegistryReadiness(
    makeRegistryResults({ checkpoint: { status: "match", height: 1000 }, pearlNodeVersion: { meetsMinimum: true } }),
    registryConfig({
      canonicalCheckpoints: [{ height: 1000, hash: REAL_CHECKPOINT_HASH, placeholder: false }]
    })
  );
  assert.deepEqual(readiness.forkStates, []);
  assert.equal(readiness.forkEra, "moe-v2");
  assert.equal(readiness.checkpointStatus, "match");
  assert.equal(readiness.nodeVersionMeetsMinimum, true);
});

// ---------------------------------------------------------------------------
// TEST 5: digest invariance (existing fixture digest unchanged)
// ---------------------------------------------------------------------------

test("snapshotDigest of the existing fixture is unchanged after MoE fields exist", () => {
  const snapshot = loadFixtureSnapshot();
  const normalized = normalizeProtocolSnapshotForComparison(snapshot);
  // Known-good digest captured before adding MoE advisory fields.
  assert.equal(
    snapshotDigest(normalized),
    "7f27c5b505185c90e63e230a5d42450de6985aef1786ea7d2009f14f2bdcf58f"
  );
});

test("MoE advisory fields stay out of the protocol snapshot allowlist and the digest", () => {
  const base = loadFixtureSnapshot();
  const baselineDigest = snapshotDigest(normalizeProtocolSnapshotForComparison(base));

  // Inject every advisory field into the snapshot in the places they could leak
  // (top-level and under network) and prove the digest does not move.
  const polluted = {
    ...base,
    checkpoint: { status: "mismatch", height: 2, expectedHash: "f".repeat(64), observedHash: "0".repeat(64) },
    forkEra: "moe-v2",
    pearlNodeVersion: { raw: "/pearld:1.0.6/", meetsMinimum: false },
    indexerVersion: "1.2.1",
    nodeSchema: "incompatible",
    warning: "Indexer is on a non-canonical chain",
    network: {
      ...base.network,
      checkpoint: { status: "mismatch" },
      forkEra: "moe-v2",
      pearlNodeVersion: { raw: "/pearld:1.0.6/" },
      indexerVersion: "1.2.1",
      nodeSchema: "incompatible"
    }
  };
  const pollutedDigest = snapshotDigest(normalizeProtocolSnapshotForComparison(polluted));
  assert.equal(pollutedDigest, baselineDigest);

  // The protocol projection must not carry any advisory key.
  const projected = publicProtocolSnapshot(polluted);
  for (const key of ["checkpoint", "forkEra", "pearlNodeVersion", "indexerVersion", "nodeSchema", "warning"]) {
    assert.equal(Object.hasOwn(projected, key), false, `protocol snapshot leaked ${key}`);
    if (projected.network) {
      assert.equal(Object.hasOwn(projected.network, key), false, `protocol network leaked ${key}`);
    }
  }

  // summarizeSnapshot must not surface advisory keys either.
  const summary = summarizeSnapshot(polluted);
  for (const key of ["checkpoint", "forkEra", "pearlNodeVersion", "indexerVersion", "nodeSchema", "warning"]) {
    assert.equal(Object.hasOwn(summary, key), false, `summary leaked ${key}`);
  }
});

// ---------------------------------------------------------------------------
// TEST 6: mainnet fail-fast on empty / placeholder canonicalCheckpoints
// ---------------------------------------------------------------------------

test("assertSafeMainnetConfig (via config load) fails fast on a placeholder checkpoint on pearl-mainnet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moe-mainnet-placeholder-"));
  const manifestPath = join(dir, "release-manifest-placeholder.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema: "pearlscriptions-release-manifest-v1",
      network: "pearl-mainnet",
      protocol: "prl-20-v0",
      forkEra: "moe-v2",
      canonicalCheckpoints: [{ height: 0, hash: "FILL_POST_FORK_BLOCKHASH_FROM_PEARLD_V1_1_0" }],
      prls: {
        tick: "prls",
        max: "2100000000",
        lim: "100000",
        dec: 18,
        mintFeeGrain: "100000000",
        mintFeeRecipient: "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea",
        mintFeeScriptPubKey: "51200effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa"
      }
    })
  );
  assert.throws(
    () =>
      loadPublicIndexerConfig(
        { PRL20_CHAIN: "pearl-mainnet", PRL20_RELEASE_MANIFEST: manifestPath },
        { loadEnvFile: false }
      ),
    /at least one real canonicalCheckpoints entry/
  );
});

test("mainnet config passes once a real checkpoint is supplied; non-mainnet always passes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moe-mainnet-ok-"));
  const manifestPath = join(dir, "release-manifest.json");
  const baseManifest = {
    schema: "pearlscriptions-release-manifest-v1",
    network: "pearl-mainnet",
    protocol: "prl-20-v0",
    forkEra: "moe-v2",
    canonicalCheckpoints: [{ height: REAL_CHECKPOINT_HEIGHT, hash: REAL_CHECKPOINT_HASH }],
    prls: {
      tick: "prls",
      max: "2100000000",
      lim: "100000",
      dec: 18,
      mintFeeGrain: "100000000",
      mintFeeRecipient: "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea",
      mintFeeScriptPubKey: "51200effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa"
    }
  };
  await writeFile(manifestPath, JSON.stringify(baseManifest));

  const mainnet = loadPublicIndexerConfig(
    { PRL20_CHAIN: "pearl-mainnet", PRL20_RELEASE_MANIFEST: manifestPath },
    { loadEnvFile: false }
  );
  assert.equal(mainnet.canonicalCheckpoints[0].hash, REAL_CHECKPOINT_HASH);
  assert.equal(mainnet.canonicalCheckpoints[0].placeholder, false);

  // An empty checkpoints array also fails on mainnet.
  const emptyPath = join(dir, "release-manifest-empty.json");
  await writeFile(emptyPath, JSON.stringify({ ...baseManifest, canonicalCheckpoints: [] }));
  assert.throws(
    () =>
      loadPublicIndexerConfig(
        { PRL20_CHAIN: "pearl-mainnet", PRL20_RELEASE_MANIFEST: emptyPath },
        { loadEnvFile: false }
      ),
    /at least one real canonicalCheckpoints entry/
  );

  // Non-mainnet still accepts a placeholder checkpoint when an operator is
  // building a local fixture/simnet config.
  const placeholderPath = join(dir, "release-manifest-placeholder.json");
  await writeFile(
    placeholderPath,
    JSON.stringify({
      ...baseManifest,
      canonicalCheckpoints: [{ height: 0, hash: "FILL_POST_FORK_BLOCKHASH_FROM_PEARLD_V1_1_0" }]
    })
  );
  const simnet = loadPublicIndexerConfig(
    { PRL20_CHAIN: "pearl-simnet", PRL20_RELEASE_MANIFEST: placeholderPath },
    { loadEnvFile: false }
  );
  assert.equal(simnet.canonicalCheckpoints[0].placeholder, true);
});

test("parseCanonicalCheckpoints validates shape and accepts the placeholder as unconfigured", () => {
  assert.deepEqual(parseCanonicalCheckpoints(undefined), []);
  assert.deepEqual(parseCanonicalCheckpoints([{ height: 1000, hash: REAL_CHECKPOINT_HASH }]), [
    { height: 1000, hash: REAL_CHECKPOINT_HASH, placeholder: false }
  ]);
  const placeholder = parseCanonicalCheckpoints([
    { height: 0, hash: "FILL_POST_FORK_BLOCKHASH_FROM_PEARLD_V1_1_0" }
  ]);
  assert.equal(placeholder[0].placeholder, true);
  // Hex hashes are normalized to lowercase.
  assert.equal(
    parseCanonicalCheckpoints([{ height: 1, hash: REAL_CHECKPOINT_HASH.toUpperCase() }])[0].hash,
    REAL_CHECKPOINT_HASH
  );
  assert.throws(() => parseCanonicalCheckpoints("nope"), /must be an array/);
  assert.throws(() => parseCanonicalCheckpoints([{ height: -1, hash: REAL_CHECKPOINT_HASH }]), /height/);
  assert.throws(() => parseCanonicalCheckpoints([{ height: 1, hash: "tooshort" }]), /hash/);
});

// ---------------------------------------------------------------------------
// TEST 7: getblock-schema compat (missing rawtx/tx -> incompatible, no crash)
// ---------------------------------------------------------------------------

test("getblock missing a tx array surfaces nodeSchema 'incompatible' without crashing sync", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-schema-incompatible-"));
  // A block with height/hash/previousblockhash/time but NO rawtx/tx/transactions.
  const malformed = {
    height: 1,
    hash: hash("01"),
    previousblockhash: null,
    time: 1779053538
    // no tx array at all
  };
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([malformed]),
    storeDir,
    startHeight: 1
  });

  const result = await indexer.syncToTip();

  // Sync did not crash; the schema flag is surfaced.
  assert.equal(result.status.nodeSchema, "incompatible");
  assert.equal(
    result.status.message,
    "Pearl node getblock response is missing fields the indexer needs (rawtx/tx with hex or txid). Update pearld to a MoE-compatible build."
  );
  // Status route carries the flag too.
  assert.equal((await indexer.status()).nodeSchema, "incompatible");
});

test("a well-formed getblock marks nodeSchema 'compatible'; the schema predicate is exact", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "moe-schema-compatible-"));
  // A block whose tx entries carry a txid satisfies the schema predicate. The
  // `transactions` array is the test-fixture ingest form (no raw-hex decode), so
  // the ingest path stays clean while we assert the schema flag.
  const goodBlock = block(1, hash("01"), null, [{ txid: "tx-1", inputs: [], outputs: [] }]);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([goodBlock]),
    storeDir,
    startHeight: 1
  });
  const result = await indexer.syncToTip();
  assert.equal(result.status.nodeSchema, "compatible");

  // Predicate-level checks.
  assert.equal(isCompatibleGetblockSchema(goodBlock), true);
  // Empty block (empty tx array) is legitimate.
  assert.equal(
    isCompatibleGetblockSchema({ height: 1, hash: "h", previousblockhash: null, time: 1, rawtx: [] }),
    true
  );
  // Missing required field.
  assert.equal(isCompatibleGetblockSchema({ hash: "h", previousblockhash: null, time: 1, rawtx: [] }), false);
  assert.equal(isCompatibleGetblockSchema({ height: 1, previousblockhash: null, time: 1, rawtx: [] }), false);
  // No tx array.
  assert.equal(isCompatibleGetblockSchema({ height: 1, hash: "h", previousblockhash: null, time: 1 }), false);
  // Tx entry lacking both hex and txid.
  assert.equal(
    isCompatibleGetblockSchema({ height: 1, hash: "h", previousblockhash: null, time: 1, tx: [{ foo: 1 }] }),
    false
  );
  // verbose `tx` array with txid is accepted.
  assert.equal(
    isCompatibleGetblockSchema({ height: 1, hash: "h", previousblockhash: null, time: 1, tx: [{ txid: "t" }] }),
    true
  );
});

// ---------------------------------------------------------------------------
// Helpers (mirroring persistent-indexer.test.js patterns)
// ---------------------------------------------------------------------------

function loadFixtureSnapshot() {
  const fixture = loadFixture(join(__dirname, "..", "fixtures", "prls-mock-blocks.json"));
  return ingestPearlBlocksFixture(fixture);
}

// Config object shaped like the one buildRegistryReadiness reads.
function registryConfig(overrides = {}) {
  return {
    chain: "pearl-mainnet",
    manifestDigest: "m".repeat(64),
    forkEra: "moe-v2",
    canonicalCheckpoints: [],
    operator: { publicUrl: null, rewardAddress: null, registryChallenge: null },
    ...overrides
  };
}

// Builds the results Map (path -> { status, body }) the way cli.js populates it
// from the read API, with a clean baseline (operator doc valid, digest matching
// status, chain matching config) so only the MoE state under test fires. The
// operator/reward/challenge readiness errors are unrelated to the fork states and
// are simply not asserted on here.
function makeRegistryResults(overrides = {}) {
  const chain = overrides.chain ?? "pearl-mainnet";
  const indexedHeight = overrides.indexedHeight ?? 1500;
  const indexedHash = overrides.indexedHash ?? "a".repeat(64);
  const checkpoint = overrides.checkpoint ?? { status: "match", height: 1000 };
  const pearlNodeVersion = overrides.pearlNodeVersion ?? { meetsMinimum: true };
  const forkEra = overrides.forkEra ?? "moe-v2";

  const operatorDoc = operatorMetadataDocument(
    {
      configured: true,
      publicUrl: "https://indexer.example",
      rewardAddress: "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea",
      registryChallenge: "registry-nonce"
    },
    { chain, version: "1.2.1", forkEra }
  );

  const status = {
    mode: "persistent",
    chain,
    indexedHeight,
    indexedHash,
    synced: overrides.synced ?? true,
    checkpoint,
    forkEra,
    pearlNodeVersion
  };
  const digest = {
    chain,
    indexedHeight,
    indexedHash,
    snapshotDigest: "d".repeat(64),
    releaseManifestDigest: "m".repeat(64),
    summary: { chain, indexedHeight },
    checkpoint,
    forkEra,
    pearlNodeVersion
  };
  const health = { ok: true, service: "pearlscriptions-indexer", readOnly: true, chain };

  return new Map([
    ["/health", { status: 200, body: health }],
    ["/indexer/status", { status: 200, body: status }],
    ["/indexer/digest", { status: 200, body: digest }],
    ["/operator", { status: 200, body: operatorDoc }],
    ["/.well-known/pearlscriptions-indexer.json", { status: 200, body: operatorDoc }]
  ]);
}

function makeRpc(blocks, calls = [], options = {}) {
  const byHeight = new Map(blocks.map((item) => [item.height, item]));
  const byHash = new Map(blocks.map((item) => [item.hash, item]));
  const hasNetworkInfo = !("networkInfo" in options) || options.networkInfo !== undefined;
  const networkInfo =
    "networkInfo" in options
      ? options.networkInfo
      : { subversion: "/pearlwire:0.5.0/pearld:1.1.0/", version: 1010000 };
  return async (method, params = []) => {
    calls.push([method, params]);
    if (method === "getblockcount") {
      return Math.max(...blocks.map((item) => item.height));
    }
    if (method === "getblockhash") {
      const item = byHeight.get(params[0]);
      assert.ok(item, `missing block at height ${params[0]}`);
      return item.hash;
    }
    if (method === "getblock") {
      const item = byHash.get(params[0]);
      assert.ok(item, `missing block hash ${params[0]}`);
      return item;
    }
    if (method === "getnetworkinfo") {
      if (!hasNetworkInfo) {
        throw new Error("Method not found");
      }
      return networkInfo;
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}

function block(height, hashValue, previousblockhash, transactions) {
  return {
    height,
    hash: hashValue,
    previousblockhash,
    time: 1779053537 + height,
    transactions
  };
}

function hash(seed) {
  return seed.padStart(64, "0");
}

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
          resolve({ status: this.status, headers: this.headers, body: null });
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
