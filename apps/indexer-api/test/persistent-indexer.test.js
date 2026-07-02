import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createPersistentPrl20Indexer } from "../src/persistent-indexer.js";
import { compareSnapshots, normalizeSnapshotForComparison } from "../src/snapshot-compare.js";
import {
  PostgresIndexerStorage,
  blockFileName,
  createIndexerStorage,
  readModelParityDigestFromSnapshot
} from "../src/storage.js";

test("persistent indexer backfills once, stores blocks, and reloads from disk", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-indexer-test-"));
  const deployBlock = block(1, hash("01"), null, [
    tx(
      "tx-deploy",
      "rprl1ptestowner00000000000000000000000000000000000",
      "5120owner",
      "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
    )
  ]);
  const mintBlock = block(2, hash("02"), deployBlock.hash, [
    tx(
      "tx-mint",
      "rprl1ptestowner00000000000000000000000000000000000",
      "5120owner",
      "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}",
      true
    )
  ]);
  const calls = [];
  const rpc = makeRpc([deployBlock, mintBlock], calls);

  const indexer = createPersistentPrl20Indexer({
    pearlRpc: rpc,
    storeDir,
    startHeight: 1,
    batchSize: 1,
    now: () => "2026-05-18T00:00:00.000Z"
  });
  const first = await indexer.syncToTip();

  assert.equal(first.status.mode, "persistent");
  assert.equal(first.status.storage.backend, "json-file");
  assert.equal(first.status.storage.productionReady, false);
  assert.equal(first.status.synced, true);
  assert.equal(first.status.blocksStored, 2);
  assert.equal(first.snapshot.token.deployed, true);
  assert.equal(first.snapshot.token.mintedSupply, "100000");
  assert.equal(first.snapshot.token.mintCount, 1);

  const reloadedCalls = [];
  const reloaded = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, mintBlock], reloadedCalls),
    storeDir,
    startHeight: 1
  });
  const second = await reloaded.syncToTip();

  assert.equal(second.snapshot.token.mintCount, 1);
  assert.equal(second.status.blocksStored, 2);
  assert.deepEqual(
    // getnetworkinfo is the advisory MoE node-version probe run every sync.
    reloadedCalls.map((call) => call[0]),
    ["getblockcount", "getblockhash", "getnetworkinfo"]
  );
  assert.ok(calls.some((call) => call[0] === "getblock"));
});

test("json storage abstraction writes manifest, blocks, and snapshot atomically", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-storage-test-"));
  const storage = createIndexerStorage({ storeDir });
  await storage.init();

  const hashValue = hash("31");
  const manifest = {
    schemaVersion: 1,
    chain: "pearl-simnet",
    startHeight: 1,
    indexedHeight: 1,
    indexedHash: hashValue,
    blocks: [
      {
        height: 1,
        hash: hashValue,
        previousHash: null,
        time: null,
        txCount: 0,
        file: blockFileName(1, hashValue)
      }
    ],
    reorgCount: 0,
    createdAt: "2026-05-18T00:00:00.000Z",
    lastSyncedAt: "2026-05-18T00:00:00.000Z"
  };
  const blockJson = block(1, hashValue, null, []);
  await storage.writeManifest(manifest);
  await storage.writeBlock({ height: 1, hash: hashValue, block: blockJson });
  await storage.writeSnapshot({ ok: true });

  assert.deepEqual(await storage.readManifest(), manifest);
  assert.deepEqual(await storage.readBlocks(manifest.blocks), [blockJson]);
  assert.deepEqual(await storage.readSnapshot(), { ok: true });
  assert.equal(JSON.parse(await readFile(join(storeDir, "snapshot.json"), "utf8")).ok, true);
});

test("persistent indexer fails closed when stored chain differs from configured chain", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-chain-mismatch-test-"));
  await mkdir(storeDir, { recursive: true });
  await writeFile(
    join(storeDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      chain: "pearl-simnet",
      startHeight: 0,
      indexedHeight: null,
      indexedHash: null,
      blocks: [],
      reorgCount: 0,
      createdAt: "2026-05-19T00:00:00.000Z",
      lastSyncedAt: null
    })
  );

  const indexer = createPersistentPrl20Indexer({
    pearlRpc: async () => 0,
    storeDir,
    chain: "pearl-mainnet"
  });

  await assert.rejects(() => indexer.status(), /manifest chain mismatch/);
});

test("postgres storage adapter persists manifest, blocks, and snapshots through queries", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "simnet-test" });
  await storage.init();

  assert.equal(storage.publicStatus().backend, "postgres");
  assert.equal(storage.publicStatus().productionReady, true);
  assert.equal(await storage.readManifest(), null);

  const hashValue = hash("61");
  const manifest = {
    schemaVersion: 1,
    chain: "pearl-simnet",
    startHeight: 1,
    indexedHeight: 1,
    indexedHash: hashValue,
    blocks: [
      {
        height: 1,
        hash: hashValue,
        previousHash: null,
        time: null,
        txCount: 0,
        file: `pg:1:${hashValue}`
      }
    ],
    reorgCount: 0,
    createdAt: "2026-05-18T00:00:00.000Z",
    lastSyncedAt: "2026-05-18T00:00:00.000Z"
  };
  const blockJson = block(1, hashValue, null, []);

  await storage.writeManifest(manifest);
  const blockRef = await storage.writeBlock({ height: 1, hash: hashValue, block: blockJson });
  await storage.writeSnapshot({ ok: true });

  assert.equal(blockRef.file, `pg:1:${hashValue}`);
  assert.deepEqual(await storage.readManifest(), manifest);
  assert.deepEqual(await storage.readBlocks(manifest.blocks), [blockJson]);
  assert.deepEqual(await storage.readSnapshot(), { ok: true });
  assert.deepEqual(pool.snapshots.get("simnet-test"), { ok: true });

  await storage.deleteBlock(blockRef.file);
  await assert.rejects(() => storage.readBlock(blockRef.file), /stored block not found/);
});

test("postgres storage keeps raw chain indexes out of the persisted snapshot", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "compact-snapshot-test" });
  await storage.init();

  await storage.writeSnapshot({
    network: { chain: "pearl-mainnet", indexedHeight: 10 },
    state: {
      balances: { "5120alice-inscription": { prls: "100000" } },
      tokens: {},
      operations: [],
      transferLots: {}
    },
    token: { ticker: "prls" },
    tokens: [{ ticker: "prls" }],
    operations: [],
    addressToScriptPubKey: {
      prl1alice: "5120alice-inscription",
      prl1unrelated: "5120unrelated"
    },
    prlBalances: { prl1alice: "100000000" },
    inscriptions: [readInscription("alice-inscription", 1, "prl1alice")],
    transferLots: [],
    utxos: { prl1alice: [readUtxo("alice-funding:0", "prl1alice", "100000000", false)] },
    transactions: [{ txid: "raw-tx" }],
    outputsByOutpoint: { "raw-tx:0": { txid: "raw-tx", vout: 0 } },
    spendsByOutpoint: { "old-tx:0": { txid: "raw-tx" } },
    txStatus: { "raw-tx": { status: "confirmed" } }
  });

  const stored = pool.snapshots.get("compact-snapshot-test");
  assert.equal(stored.transactions, undefined);
  assert.equal(stored.outputsByOutpoint, undefined);
  assert.equal(stored.spendsByOutpoint, undefined);
  assert.equal(stored.txStatus, undefined);
  assert.equal(stored.utxos, undefined);
  assert.deepEqual(stored.prlBalances, {});
  assert.deepEqual(stored.addressToScriptPubKey, {
    prl1alice: "5120alice-inscription"
  });
  assert.equal(pool.readUtxos.length, 1);
  assert.equal(pool.readUtxos[0].outpoint, "alice-funding:0");
});

test("postgres persistent indexer reuses stored snapshots when already synced", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "fast-path-test" });
  const deployBlock = block(1, hash("81"), null, [
    tx(
      "tx-deploy",
      "prl1alice",
      "5120alice",
      "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
    )
  ]);
  const calls = [];
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock], calls),
    storage,
    startHeight: 1
  });

  const first = await indexer.syncToTip();
  // Full rebuilds no longer return the whole raw-block history (bounded-memory
  // chunked rebuild); they report a blockCount instead. The appended-blocks fast
  // path still returns its small slice in .blocks.
  assert.equal(first.blockCount, 1);
  assert.equal(first.blocks.length, 0);
  assert.equal(first.snapshot.token.deployed, true);

  pool.queries = [];
  calls.length = 0;
  const second = await indexer.syncToTip();

  assert.equal(second.blocks.length, 0);
  assert.equal(second.snapshot.token.deployed, true);
  assert.equal(second.snapshot.network.indexedHeight, 1);
  assert.deepEqual(
    // getnetworkinfo is the advisory MoE node-version probe run every sync.
    calls.map((call) => call[0]),
    ["getblockcount", "getblockhash", "getnetworkinfo"]
  );
  assert.equal(
    pool.queries.some((query) => query.startsWith("SELECT raw_json FROM chain_blocks")),
    false
  );
  assert.match(pool.snapshots.get("fast-path-test").network.protocolSnapshotDigest, /^[0-9a-f]{64}$/);
});

test("postgres persistent indexer rebuilds instead of retagging stale snapshots", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "stale-snapshot-test" });
  const firstBlock = block(1, hash("a1"), null, []);
  const secondBlock = block(2, hash("a2"), firstBlock.hash, []);

  await storage.init();
  await storage.writeManifest({
    schemaVersion: 1,
    chain: "pearl-simnet",
    startHeight: 1,
    indexedHeight: 2,
    indexedHash: secondBlock.hash,
    blocks: [
      {
        height: 1,
        hash: firstBlock.hash,
        previousHash: null,
        time: null,
        txCount: 0,
        file: `pg:1:${firstBlock.hash}`
      },
      {
        height: 2,
        hash: secondBlock.hash,
        previousHash: firstBlock.hash,
        time: null,
        txCount: 0,
        file: `pg:2:${secondBlock.hash}`
      }
    ],
    reorgCount: 0,
    createdAt: "2026-05-18T00:00:00.000Z",
    lastSyncedAt: "2026-05-18T00:02:00.000Z"
  });
  await storage.writeBlock({ height: 1, hash: firstBlock.hash, block: firstBlock });
  await storage.writeBlock({ height: 2, hash: secondBlock.hash, block: secondBlock });
  await storage.writeSnapshot({
    network: {
      chain: "pearl-simnet",
      startHeight: 1,
      indexedHeight: 1,
      indexedHash: firstBlock.hash
    },
    inscriptions: [],
    utxos: {}
  });

  pool.queries = [];
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([firstBlock, secondBlock]),
    storage,
    chain: "pearl-simnet",
    startHeight: 1
  });

  const result = await indexer.syncToTip();

  assert.equal(result.snapshot.network.indexedHeight, 2);
  assert.equal(pool.snapshots.get("stale-snapshot-test").network.indexedHash, secondBlock.hash);
  assert.ok(pool.queries.some((query) => query.startsWith("SELECT raw_json FROM chain_blocks")));
});

test("postgres storage metadata refresh only updates snapshot network", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "metadata-refresh-test" });
  await storage.init();
  await storage.writeSnapshot({
    network: { chain: "pearl-simnet", indexedHeight: 1, indexedHash: hash("b1") },
    inscriptions: [readInscription("inscription-stays", 1, "prl1alice")],
    utxos: {}
  });

  await storage.writeSnapshotNetworkMetadata({
    network: {
      chain: "pearl-simnet",
      indexedHeight: 2,
      indexedHash: hash("b2"),
      protocolSnapshotDigest: "c".repeat(64),
      protocolSummary: { chain: "pearl-simnet", indexedHeight: 2 }
    },
    inscriptions: []
  });

  const stored = pool.snapshots.get("metadata-refresh-test");
  assert.equal(stored.network.indexedHeight, 2);
  assert.equal(stored.inscriptions.length, 1);
  assert.equal(stored.inscriptions[0].id, "inscription-stays");
  assert.deepEqual(await storage.readSnapshotNetworkMetadata(), stored.network);
});

test("snapshot comparison ignores volatile runtime metadata but catches derived-state drift", () => {
  const base = {
    network: {
      chain: "pearl-simnet",
      source: "json",
      indexedHeight: 10,
      lastSyncedAt: "2026-05-18T00:00:00.000Z",
      storageBackend: "json-file",
      warning: "local"
    },
    token: { deployed: true, mintCount: 1, mintedSupply: "100000" },
    inscriptions: [{ id: "i0", inscriptionNumber: 0 }]
  };
  const sameDerivedState = {
    ...base,
    network: {
      ...base.network,
      source: "postgres",
      lastSyncedAt: "2026-05-18T00:05:00.000Z",
      storageBackend: "postgres",
      warning: "db"
    }
  };
  const drifted = {
    ...sameDerivedState,
    token: { ...sameDerivedState.token, mintCount: 2 }
  };

  assert.equal(compareSnapshots(base, sameDerivedState).ok, true);
  const comparison = compareSnapshots(base, drifted);
  assert.equal(comparison.ok, false);
  assert.equal(comparison.diff.path, "$.token.mintCount");
  assert.equal(normalizeSnapshotForComparison(base).network.source, undefined);
});

test("postgres storage materializes paginated inscription and UTXO read models", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "read-model-test" });
  await storage.init();
  await storage.writeSnapshot({
    inscriptions: [
      readInscription("inscription-0", 0, "prl1alice"),
      readInscription("inscription-1", 1, "prl1bob"),
      readInscription("inscription-2", 2, "prl1alice")
    ],
    utxos: {
      prl1alice: [
        readUtxo("alice-funding:0", "prl1alice", "200000000", false),
        readUtxo("alice-inscription:0", "prl1alice", "546", true, {
          inscriptionId: "inscription-0",
          inscriptionNumber: 0
        })
      ],
      prl1bob: [readUtxo("bob-funding:0", "prl1bob", "100000000", false)]
    }
  });

  const firstPage = await storage.listInscriptionsPage(new URLSearchParams("limit=1&page=2"));
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.page, 2);
  assert.equal(firstPage.inscriptions[0].inscriptionNumber, 1);

  const alice = await storage.listAddressInscriptionsPage(
    "prl1alice",
    new URLSearchParams("limit=10")
  );
  assert.deepEqual(
    alice.inscriptions.map((inscription) => inscription.id),
    ["inscription-0", "inscription-2"]
  );

  const aliceUtxos = await storage.listAddressUtxos(
    "prl1alice",
    new URLSearchParams("limit=10")
  );
  assert.equal(aliceUtxos.total, 2);
  assert.equal(aliceUtxos.spendableTotal, 1);
  assert.equal(aliceUtxos.protectedTotal, 1);
  assert.equal(aliceUtxos.totalValueGrain, "200000546");
  assert.deepEqual(
    aliceUtxos.utxos.map((utxo) => utxo.outpoint),
    ["alice-funding:0", "alice-inscription:0"]
  );
  assert.equal(aliceUtxos.utxos[1].protectionReason, "INSCRIPTION_UTXO");
});

test("postgres storage chunks read-model inserts to stay under jsonb parameter limits", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "chunked-read-model-test" });
  await storage.init();

  const inscriptions = Array.from({ length: 1201 }, (_, index) =>
    readInscription(`inscription-${index}`, index, "prl1alice")
  );

  await storage.writeSnapshot({ inscriptions, utxos: {} });

  const insertQueries = pool.queries.filter((query) =>
    query.startsWith("INSERT INTO indexer_read_inscriptions")
  );
  assert.equal(insertQueries.length, 3);
  assert.equal(pool.readInscriptions.length, 1201);
});

test("postgres storage applies incremental read-model delta without full UTXO rewrite", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "incremental-read-model-test" });
  await storage.init();

  await storage.writeSnapshot({
    network: { chain: "pearl-simnet", indexedHeight: 1, indexedHash: hash("d1") },
    inscriptions: [readInscription("inscription-0", 0, "prl1alice")],
    transferLots: [],
    utxos: {
      prl1alice: [readUtxo("alice-old:0", "prl1alice", "200000000", true)],
      prl1bob: [
        readUtxo("bob-untouched:0", "prl1bob", "100000000", false, {
          scriptPubKey: "5120bob",
          valuePrl: "1.00000000",
          source: "snapshot-utxo-read-model"
        })
      ]
    }
  });

  pool.queries = [];
  const incrementalSnapshot = {
    network: { chain: "pearl-simnet", indexedHeight: 2, indexedHash: hash("d2") },
    inscriptions: [
      {
        ...readInscription("inscription-0", 0, "prl1alice"),
        currentOutpoint: "alice-new:0",
        currentOutputIndex: 0
      }
    ],
    transferLots: [],
    outputsByOutpoint: {
      "alice-new:0": {
        txid: "alice-new",
        vout: 0,
        address: "prl1alice",
        scriptPubKey: "5120alice",
        valueGrain: "199999000",
        blockHeight: 2,
        coinbase: false
      },
      "bob-untouched:0": {
        txid: "bob-untouched",
        vout: 0,
        address: "prl1bob",
        scriptPubKey: "5120bob",
        valueGrain: "100000000",
        blockHeight: 1,
        coinbase: false
      }
    },
    spendsByOutpoint: {
      "alice-old:0": { txid: "alice-new", inputIndex: 0, blockHeight: 2 }
    },
    utxos: Symbol.for("prl20.skipUtxoMap")
  };

  const result = await storage.writeSnapshot(incrementalSnapshot, {
    readModelMode: "incremental",
    readModelDelta: {
      utxos: ["alice-old:0", "alice-new:0"],
      previousBestHeight: 1,
      bestHeight: 2
    }
  });

  assert.equal(result.readModels.mode, "incremental");
  assert.equal(pool.readUtxos.some((row) => row.outpoint === "alice-old:0"), false);
  assert.equal(pool.readUtxos.some((row) => row.outpoint === "alice-new:0"), true);
  assert.equal(pool.readUtxos.some((row) => row.outpoint === "bob-untouched:0"), true);
  assert.equal(
    pool.queries.some((query) => query === "DELETE FROM indexer_read_utxos WHERE manifest_name = $1"),
    false
  );
  assert.equal(await storage.readModelParityDigest(), readModelParityDigestFromSnapshot(incrementalSnapshot));
});

test("postgres incremental read model matures coinbase spendability without touching every UTXO", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "coinbase-maturity-test" });
  await storage.init();

  await storage.writeSnapshot({
    network: { chain: "pearl-simnet", indexedHeight: 99, indexedHash: hash("e1") },
    inscriptions: [],
    transferLots: [],
    utxos: {
      prl1miner: [
        readUtxo("coinbase-old:0", "prl1miner", "5000000000", false, {
          blockHeight: 1,
          confirmations: 99,
          coinbase: true,
          spendable: false
        })
      ]
    }
  });

  await storage.writeSnapshot(
    {
      network: { chain: "pearl-simnet", indexedHeight: 100, indexedHash: hash("e2") },
      inscriptions: [],
      transferLots: [],
      outputsByOutpoint: {},
      spendsByOutpoint: {},
      utxos: Symbol.for("prl20.skipUtxoMap")
    },
    {
      readModelMode: "incremental",
      readModelDelta: { utxos: [], previousBestHeight: 99, bestHeight: 100 }
    }
  );

  const page = await storage.listAddressUtxos("prl1miner", new URLSearchParams("limit=10"));
  assert.equal(page.spendableTotal, 1);
  assert.equal(page.utxos[0].confirmations, 100);
  assert.equal(page.utxos[0].spendable, true);
});

test("postgres status follows the published snapshot while manifest is ahead", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "published-status-test" });
  const firstBlock = block(1, hash("91"), null, []);
  const secondBlock = block(2, hash("92"), firstBlock.hash, []);

  await storage.init();
  await storage.writeManifest({
    schemaVersion: 1,
    chain: "pearl-simnet",
    startHeight: 1,
    indexedHeight: 2,
    indexedHash: secondBlock.hash,
    blocks: [
      {
        height: 1,
        hash: firstBlock.hash,
        previousHash: null,
        time: null,
        txCount: 0,
        file: `pg:1:${firstBlock.hash}`
      },
      {
        height: 2,
        hash: secondBlock.hash,
        previousHash: firstBlock.hash,
        time: null,
        txCount: 0,
        file: `pg:2:${secondBlock.hash}`
      }
    ],
    reorgCount: 0,
    createdAt: "2026-05-18T00:00:00.000Z",
    lastSyncedAt: "2026-05-18T00:02:00.000Z"
  });
  await storage.writeSnapshot({
    network: {
      chain: "pearl-simnet",
      startHeight: 1,
      indexedHeight: 1,
      indexedHash: firstBlock.hash,
      blocksStored: 1,
      reorgCount: 0,
      lastSyncedAt: "2026-05-18T00:01:00.000Z"
    }
  });

  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([firstBlock, secondBlock]),
    storage,
    chain: "pearl-simnet",
    startHeight: 1
  });

  const status = await indexer.status();

  assert.equal(status.indexedHeight, 1);
  assert.equal(status.indexedHash, firstBlock.hash);
  assert.equal(status.blocksStored, 1);
});

test("postgres status refreshes manifest written by an external sync worker", async () => {
  const pool = new FakePgPool();
  const storage = new PostgresIndexerStorage({ pool, manifestName: "external-worker-status-test" });
  const firstBlock = block(1, hash("c1"), null, []);
  const secondBlock = block(2, hash("c2"), firstBlock.hash, []);

  const initialSyncer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([firstBlock]),
    storage,
    chain: "pearl-simnet",
    startHeight: 1
  });
  await initialSyncer.syncToTip();

  const apiIndexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([firstBlock]),
    storage,
    chain: "pearl-simnet",
    startHeight: 1
  });
  assert.equal((await apiIndexer.status()).indexedHeight, 1);

  const externalSyncer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([firstBlock, secondBlock]),
    storage,
    chain: "pearl-simnet",
    startHeight: 1
  });
  await externalSyncer.syncToTip();

  const refreshed = await apiIndexer.status();
  assert.equal(refreshed.indexedHeight, 2);
  assert.equal(refreshed.indexedHash, secondBlock.hash);
});

test("postgres persistent indexer uses incremental read-model publish only when the flag is enabled", async () => {
  const previousMode = process.env.PRL20_INDEXER_READ_MODEL_MODE;
  process.env.PRL20_INDEXER_READ_MODEL_MODE = "incremental";
  try {
    const pool = new FakePgPool();
    const storage = new PostgresIndexerStorage({ pool, manifestName: "persistent-incremental-read-model-test" });
    const firstBlock = block(1, hash("f1"), null, [
      tx(
        "tx-deploy",
        "prl1alice",
        "5120alice",
        "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
      )
    ]);
    const secondBlock = block(2, hash("f2"), firstBlock.hash, [
      spendInscriptionTx(
        "tx-move-deploy",
        "tx-deploy",
        0,
        "prl1bob",
        "5120bob",
        "prl1alice",
        "5120alice",
        "1.00000000"
      )
    ]);
    const chainBlocks = [firstBlock];
    const calls = [];
    const rpc = makeMutableRpc(chainBlocks, calls);
    const indexer = createPersistentPrl20Indexer({
      pearlRpc: rpc,
      storage,
      chain: "pearl-simnet",
      startHeight: 1
    });

    const first = await indexer.syncToTip();
    assert.equal(first.readModelMode, "full");
    assert.notEqual(first.snapshot.utxos, Symbol.for("prl20.skipUtxoMap"));

    chainBlocks.push(secondBlock);
    pool.queries = [];
    const second = await indexer.syncToTip();

    assert.equal(second.readModelMode, "incremental");
    assert.equal(second.snapshot.utxos, Symbol.for("prl20.skipUtxoMap"));
    assert.equal(second.touchedRows.utxos, 3);
    assert.equal(pool.readUtxos.some((row) => row.outpoint === "tx-deploy:0"), false);
    assert.equal(pool.readUtxos.some((row) => row.outpoint === "tx-move-deploy:0"), true);
    assert.equal(pool.readUtxos.some((row) => row.outpoint === "tx-move-deploy:1"), true);
    assert.equal(
      pool.queries.some((query) => query === "DELETE FROM indexer_read_utxos WHERE manifest_name = $1"),
      false
    );
  } finally {
    if (previousMode === undefined) {
      delete process.env.PRL20_INDEXER_READ_MODEL_MODE;
    } else {
      process.env.PRL20_INDEXER_READ_MODEL_MODE = previousMode;
    }
  }
});

test("persistent indexer maxBlocksPerSync preserves full cold-start catch-up", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-indexer-cold-max-blocks-test-"));
  const firstBlock = block(1, hash("ab01"), null, []);
  const secondBlock = block(2, hash("ab02"), firstBlock.hash, []);
  const thirdBlock = block(3, hash("ab03"), secondBlock.hash, []);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([firstBlock, secondBlock, thirdBlock]),
    storeDir,
    startHeight: 1,
    maxBlocksPerSync: 1
  });

  const result = await indexer.syncToTip();

  assert.equal(result.bestHeight, 3);
  assert.equal(result.targetHeight, 3);
  assert.equal(result.indexedHeight, 3);
  assert.equal(result.remainingLag, 0);
  assert.equal(result.status.synced, true);
  assert.equal(result.blockCount, 3);
});

test("persistent indexer maxBlocksPerSync micro-batches a warm append backlog", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-indexer-warm-max-blocks-test-"));
  const firstBlock = block(1, hash("ac01"), null, []);
  const secondBlock = block(2, hash("ac02"), firstBlock.hash, []);
  const thirdBlock = block(3, hash("ac03"), secondBlock.hash, []);
  const chainBlocks = [firstBlock];
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeMutableRpc(chainBlocks),
    storeDir,
    startHeight: 1,
    maxBlocksPerSync: 1
  });

  const first = await indexer.syncToTip();
  assert.equal(first.indexedHeight, 1);
  assert.equal(first.targetHeight, 1);

  chainBlocks.push(secondBlock, thirdBlock);
  const second = await indexer.syncToTip();

  assert.equal(second.bestHeight, 3);
  assert.equal(second.targetHeight, 2);
  assert.equal(second.indexedHeight, 2);
  assert.equal(second.remainingLag, 1);
  assert.equal(second.blockCount, 1);
  assert.equal(second.blocks.length, 1);
  assert.equal(second.blocks[0].height, 2);
  assert.equal(second.status.synced, false);

  const third = await indexer.syncToTip();

  assert.equal(third.bestHeight, 3);
  assert.equal(third.targetHeight, 3);
  assert.equal(third.indexedHeight, 3);
  assert.equal(third.remainingLag, 0);
  assert.equal(third.blockCount, 1);
  assert.equal(third.status.synced, true);
});

test("postgres incremental parity can run after the publish without forcing a full write first", async () => {
  const previousMode = process.env.PRL20_INDEXER_READ_MODEL_MODE;
  process.env.PRL20_INDEXER_READ_MODEL_MODE = "incremental";
  try {
    const pool = new FakePgPool();
    const storage = new PostgresIndexerStorage({ pool, manifestName: "post-publish-parity-test" });
    const firstBlock = block(1, hash("ad01"), null, [
      tx(
        "tx-deploy",
        "prl1alice",
        "5120alice",
        "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
      )
    ]);
    const secondBlock = block(2, hash("ad02"), firstBlock.hash, [
      spendInscriptionTx(
        "tx-move-deploy",
        "tx-deploy",
        0,
        "prl1bob",
        "5120bob",
        "prl1alice",
        "5120alice",
        "1.00000000"
      )
    ]);
    const chainBlocks = [firstBlock];
    const indexer = createPersistentPrl20Indexer({
      pearlRpc: makeMutableRpc(chainBlocks),
      storage,
      chain: "pearl-simnet",
      startHeight: 1,
      parityCheckEveryNBlocks: 1,
      parityMode: "post-publish"
    });

    await indexer.syncToTip();
    chainBlocks.push(secondBlock);
    pool.queries = [];
    const result = await indexer.syncToTip();

    assert.equal(result.readModelMode, "incremental");
    assert.equal(result.snapshot.network.indexedHeight, 2);
    assert.equal(result.timings.protocolParityMs >= 0, true);
    assert.equal(pool.readUtxos.some((row) => row.outpoint === "tx-move-deploy:0"), true);
    assert.equal(
      pool.queries.filter((query) => query === "DELETE FROM indexer_read_utxos WHERE manifest_name = $1").length,
      0
    );
  } finally {
    if (previousMode === undefined) {
      delete process.env.PRL20_INDEXER_READ_MODEL_MODE;
    } else {
      process.env.PRL20_INDEXER_READ_MODEL_MODE = previousMode;
    }
  }
});

test("persistent indexer fails closed when a stored block file is missing", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-indexer-missing-block-test-"));
  const deployBlock = block(1, hash("41"), null, [
    tx(
      "tx-deploy",
      "rprl1ptestowner00000000000000000000000000000000000",
      "5120owner",
      "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
    )
  ]);
  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir,
    startHeight: 1
  });
  await indexer.syncToTip();

  await unlink(join(storeDir, "blocks", blockFileName(1, deployBlock.hash)));
  const reloaded = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir,
    startHeight: 1
  });

  await assert.rejects(() => reloaded.syncToTip(), /ENOENT/);
});

test("persistent indexer rejects corrupt non-contiguous manifests before syncing", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-indexer-corrupt-manifest-test-"));
  const blocksDir = join(storeDir, "blocks");
  await mkdir(blocksDir, { recursive: true });
  await writeFile(
    join(storeDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      chain: "pearl-simnet",
      startHeight: 1,
      indexedHeight: 3,
      indexedHash: hash("53"),
      blocks: [
        {
          height: 1,
          hash: hash("51"),
          previousHash: null,
          txCount: 0,
          file: blockFileName(1, hash("51"))
        },
        {
          height: 3,
          hash: hash("53"),
          previousHash: hash("52"),
          txCount: 0,
          file: blockFileName(3, hash("53"))
        }
      ],
      reorgCount: 0,
      createdAt: "2026-05-18T00:00:00.000Z",
      lastSyncedAt: null
    }),
    "utf8"
  );

  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([block(1, hash("51"), null, [])]),
    storeDir,
    startHeight: 1
  });

  await assert.rejects(() => indexer.syncToTip(), /non-contiguous height 3 after 1/);
});

test("persistent indexer rejects reusing an existing store across chains", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-indexer-chain-test-"));
  const deployBlock = block(1, hash("21"), null, [
    tx(
      "tx-deploy",
      "rprl1ptestowner00000000000000000000000000000000000",
      "5120owner",
      "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
    )
  ]);

  const first = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir,
    chain: "pearl-simnet",
    startHeight: 1
  });
  await first.syncToTip();

  const reconfigured = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir,
    chain: "pearl-mainnet",
    startHeight: 1
  });

  await assert.rejects(
    () => reconfigured.syncToTip(),
    /manifest chain mismatch: stored pearl-simnet, configured pearl-mainnet/
  );
});

test("persistent indexer rolls back disconnected blocks and reindexes the new canonical tip", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-indexer-reorg-test-"));
  const deployBlock = block(1, hash("11"), null, [
    tx(
      "tx-deploy",
      "rprl1ptestowner00000000000000000000000000000000000",
      "5120owner",
      "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
    )
  ]);
  const validMintBlock = block(2, hash("12"), deployBlock.hash, [
    tx(
      "tx-mint-valid",
      "rprl1ptestowner00000000000000000000000000000000000",
      "5120owner",
      "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}",
      true
    )
  ]);
  const invalidMintBlock = block(2, hash("13"), deployBlock.hash, [
    tx(
      "tx-mint-no-fee",
      "rprl1ptestowner00000000000000000000000000000000000",
      "5120owner",
      "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}",
      false
    )
  ]);

  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, validMintBlock]),
    storeDir,
    startHeight: 1
  });
  const first = await indexer.syncToTip();
  assert.equal(first.snapshot.token.mintCount, 1);

  const reorged = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, invalidMintBlock]),
    storeDir,
    startHeight: 1
  });
  const second = await reorged.syncToTip();

  assert.equal(second.status.reorgCount, 1);
  assert.equal(second.status.indexedHash, invalidMintBlock.hash);
  assert.equal(second.snapshot.token.mintedSupply, "0");
  assert.equal(second.snapshot.token.mintCount, 0);
  assert.equal(second.snapshot.operations[1].invalidReason, "MISSING_REQUIRED_MINT_FEE");
});

test("persistent indexer rolls back PRL-20 transfer-lot fills and protected UTXOs on reorg", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-indexer-transfer-reorg-test-"));
  const transferLotId = "tx-transfer-prls:i0:n0";
  const deployAndTransferBlock = block(1, hash("71"), null, [
    tx(
      "tx-deploy",
      "prl1deployer",
      "5120deployer",
      "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
    ),
    tx(
      "tx-mint-alice",
      "prl1alice",
      "5120alice",
      "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}",
      true
    ),
    tx(
      "tx-transfer-prls",
      "prl1alice",
      "5120alice",
      "{\"p\":\"prl-20\",\"op\":\"transfer\",\"tick\":\"prls\",\"amt\":\"100000\"}"
    )
  ]);
  const moveBlock = block(2, hash("72"), deployAndTransferBlock.hash, [
    spendInscriptionTx(
      "tx-move-transfer",
      "tx-transfer-prls",
      0,
      "prl1buyer",
      "5120buyer",
      "prl1alice",
      "5120alice",
      "1.00000000"
    )
  ]);
  const replacementBlock = block(2, hash("73"), deployAndTransferBlock.hash, []);

  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployAndTransferBlock, moveBlock]),
    storeDir,
    startHeight: 1
  });
  const filled = await indexer.syncToTip();
  const filledLot = filled.snapshot.transferLots.find((lot) => lot.id === transferLotId);

  assert.equal(filledLot.status, "filled");
  assert.equal(filledLot.fillTxid, "tx-move-transfer");
  assert.equal(filled.snapshot.state.balances["5120buyer"]?.prls, "100000");

  const reorged = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployAndTransferBlock, replacementBlock]),
    storeDir,
    startHeight: 1
  });
  const restored = await reorged.syncToTip();
  const restoredLot = restored.snapshot.transferLots.find((lot) => lot.id === transferLotId);
  const aliceTransferUtxo = (restored.snapshot.utxos.prl1alice ?? []).find(
    (utxo) => utxo.outpoint === "tx-transfer-prls:0"
  );

  assert.equal(restored.status.reorgCount, 1);
  assert.equal(restored.status.indexedHash, replacementBlock.hash);
  assert.equal(restoredLot.status, "transferable");
  assert.equal(restoredLot.fillTxid, null);
  assert.equal(restored.snapshot.state.balances["5120buyer"]?.prls ?? "0", "0");
  assert.equal(aliceTransferUtxo?.protected, true);
  assert.equal(aliceTransferUtxo?.spendable, false);
  assert.equal(aliceTransferUtxo?.protectionReason, "PRL20_TRANSFER_LOT_UTXO");
  assert.equal(aliceTransferUtxo?.transferLotId, transferLotId);
});

function makeRpc(blocks, calls = [], options = {}) {
  const byHeight = new Map(blocks.map((item) => [item.height, item]));
  const byHash = new Map(blocks.map((item) => [item.hash, item]));
  // MoE node-version probe support. Defaults to a post-fork node so the advisory
  // probe succeeds; pass networkInfo:null to simulate getnetworkinfo being absent
  // (the sync must still complete), or a custom object to drive version parsing.
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
      const block = byHeight.get(params[0]);
      assert.ok(block, `missing block at height ${params[0]}`);
      return block.hash;
    }
    if (method === "getblock") {
      const block = byHash.get(params[0]);
      assert.ok(block, `missing block hash ${params[0]}`);
      return block;
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

function makeMutableRpc(blocks, calls = [], options = {}) {
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
      const block = blocks.find((item) => item.height === params[0]);
      assert.ok(block, `missing block at height ${params[0]}`);
      return block.hash;
    }
    if (method === "getblock") {
      const block = blocks.find((item) => item.hash === params[0]);
      assert.ok(block, `missing block hash ${params[0]}`);
      return block;
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

function tx(txid, address, scriptPubKey, body, includeFee = false) {
  return {
    txid,
    inputs: [
      {
        witness: [
          "OP_FALSE",
          "OP_IF",
          "prl-20",
          "application/json",
          "0x00",
          body,
          "OP_ENDIF"
        ]
      }
    ],
    outputs: [
      {
        address,
        scriptPubKey,
        valuePrl: "0.00000546"
      },
      ...(includeFee
        ? [
            {
              address: "rprl1pjza054vjtj6zd7j3k5ps2q2wtus3vr8jp0m265a8atyggkrrrmeqehah68",
              scriptPubKey:
                "512090bafa55925cb426fa51b50305014e5f21160cf20bf6ad53a7eac88458631ef2",
              valuePrl: "1.00000000"
            }
          ]
        : [])
    ]
  };
}

function genericTx(txid, address, scriptPubKey, marker, contentType, body) {
  return {
    txid,
    inputs: [
      {
        witness: ["OP_FALSE", "OP_IF", marker, contentType, "0x00", body, "OP_ENDIF"]
      }
    ],
    outputs: [
      {
        address,
        scriptPubKey,
        valuePrl: "0.00000546"
      }
    ]
  };
}

function spendInscriptionTx(
  txid,
  inputTxid,
  inputVout,
  recipientAddress,
  recipientScriptPubKey,
  changeAddress,
  changeScriptPubKey,
  changeValuePrl
) {
  return {
    txid,
    inscriptionTransferOutputIndex: 0,
    inputs: [
      {
        previousTxid: inputTxid,
        previousVout: inputVout,
        witness: []
      }
    ],
    outputs: [
      {
        address: recipientAddress,
        scriptPubKey: recipientScriptPubKey,
        valuePrl: "0.00000546"
      },
      {
        address: changeAddress,
        scriptPubKey: changeScriptPubKey,
        valuePrl: changeValuePrl
      }
    ]
  };
}

function hash(seed) {
  return seed.padStart(64, "0");
}

function readInscription(id, inscriptionNumber, ownerAddress) {
  return {
    id,
    inscriptionId: id,
    inscriptionNumber,
    txid: `${id}-tx`,
    inputIndex: 0,
    inscriptionIndex: 0,
    ownerOutputIndex: 0,
    ownerOutpoint: `${id}-tx:0`,
    currentOutpoint: `${id}-tx:0`,
    ownerAddress,
    currentOwnerAddress: ownerAddress,
    ownerScriptPubKey: `5120${id}`,
    currentOwnerScriptPubKey: `5120${id}`,
    contentType: "text/plain;charset=utf-8",
    byteLength: 5,
    bodyPreview: "hello",
    blockHeight: 1,
    txIndex: inscriptionNumber,
    source: "test",
    status: "confirmed"
  };
}

function readUtxo(outpoint, address, valueGrain, isProtected, overrides = {}) {
  const [txid, vout] = outpoint.split(":");
  return {
    key: outpoint,
    outpoint,
    txid,
    vout: Number(vout),
    address,
    scriptPubKey: `5120${address}`,
    valueGrain,
    valuePrl: "0.00000000",
    blockHeight: 1,
    confirmations: 6,
    coinbase: false,
    spendable: !isProtected,
    protected: isProtected,
    protectionReason: isProtected ? "INSCRIPTION_UTXO" : null,
    source: "test",
    ...overrides
  };
}

class FakePgPool {
  constructor() {
    this.manifests = new Map();
    this.blocks = new Map();
    this.snapshots = new Map();
    this.readInscriptions = [];
    this.readUtxos = [];
    this.queries = [];
  }

  async query(sql, params = []) {
    const compact = sql.replace(/\s+/g, " ").trim();
    this.queries.push(compact);
    if (compact === "SELECT 1 AS ok") {
      return { rows: [{ ok: 1 }] };
    }
    if (compact.startsWith("SELECT schema_version")) {
      const row = this.manifests.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (compact.startsWith("INSERT INTO indexer_manifests")) {
      const [
        name,
        schemaVersion,
        chain,
        startHeight,
        indexedHeight,
        indexedHash,
        blocksJson,
        reorgCount,
        createdAt,
        lastSyncedAt
      ] = params;
      this.manifests.set(name, {
        schema_version: schemaVersion,
        chain,
        start_height: startHeight,
        indexed_height: indexedHeight,
        indexed_hash: indexedHash,
        blocks_json: JSON.parse(blocksJson),
        reorg_count: reorgCount,
        created_at: createdAt,
        last_synced_at: lastSyncedAt
      });
      return { rows: [] };
    }
    if (compact.startsWith("INSERT INTO chain_blocks")) {
      const [manifestName, height, hashValue, previousHash, blockTime, rawJson] = params;
      this.blocks.set(`${manifestName}:${height}:${hashValue}`, {
        manifest_name: manifestName,
        height,
        hash: hashValue,
        previous_hash: previousHash,
        block_time: blockTime,
        raw_json: JSON.parse(rawJson),
        canonical: true
      });
      return { rows: [] };
    }
    if (compact.startsWith("UPDATE chain_blocks SET canonical = FALSE")) {
      const [manifestName, height, hashValue] = params;
      const row = this.blocks.get(`${manifestName}:${height}:${hashValue}`);
      if (row) row.canonical = false;
      return { rows: [] };
    }
    if (compact.startsWith("SELECT raw_json FROM chain_blocks")) {
      const [manifestName, height, hashValue] = params;
      const row = this.blocks.get(`${manifestName}:${height}:${hashValue}`);
      return { rows: row?.canonical ? [{ raw_json: row.raw_json }] : [] };
    }
    if (compact.startsWith("INSERT INTO indexer_snapshots")) {
      const [name, snapshotJson] = params;
      if (!compact.includes("DO NOTHING") || !this.snapshots.has(name)) {
        this.snapshots.set(name, JSON.parse(snapshotJson));
      }
      return { rows: [] };
    }
    if (compact.startsWith("UPDATE indexer_snapshots SET snapshot_json")) {
      const [name, networkJson] = params;
      const snapshot = this.snapshots.get(name);
      if (!snapshot) {
        return { rows: [], rowCount: 0 };
      }
      this.snapshots.set(name, {
        ...snapshot,
        network: JSON.parse(networkJson)
      });
      return { rows: [], rowCount: 1 };
    }
    if (compact.startsWith("SELECT snapshot_json -> 'network'")) {
      const snapshot = this.snapshots.get(params[0]);
      return { rows: snapshot ? [{ network_json: snapshot.network ?? null }] : [] };
    }
    if (compact.startsWith("SELECT snapshot_json FROM indexer_snapshots")) {
      const snapshot = this.snapshots.get(params[0]);
      return { rows: snapshot ? [{ snapshot_json: snapshot }] : [] };
    }
    if (compact.startsWith("DELETE FROM indexer_read_inscriptions")) {
      this.readInscriptions = this.readInscriptions.filter((row) => row.manifest_name !== params[0]);
      return { rows: [] };
    }
    if (compact.startsWith("DELETE FROM indexer_read_utxos WHERE manifest_name = $1 AND outpoint = ANY")) {
      const [manifestName, outpoints] = params;
      const before = this.readUtxos.length;
      const set = new Set(outpoints);
      this.readUtxos = this.readUtxos.filter(
        (row) => row.manifest_name !== manifestName || !set.has(row.outpoint)
      );
      return { rows: [], rowCount: before - this.readUtxos.length };
    }
    if (compact.startsWith("DELETE FROM indexer_read_utxos")) {
      this.readUtxos = this.readUtxos.filter((row) => row.manifest_name !== params[0]);
      return { rows: [] };
    }
    if (compact.startsWith("INSERT INTO indexer_read_inscriptions")) {
      const [manifestName, rowsJson] = params;
      for (const row of JSON.parse(rowsJson)) {
        upsertRow(this.readInscriptions, { ...row, manifest_name: manifestName }, (candidate) =>
          candidate.manifest_name === manifestName && candidate.inscription_id === row.inscription_id
        );
      }
      return { rows: [] };
    }
    if (compact.startsWith("INSERT INTO indexer_read_utxos")) {
      const [manifestName, rowsJson] = params;
      for (const row of JSON.parse(rowsJson)) {
        upsertRow(this.readUtxos, { ...row, manifest_name: manifestName }, (candidate) =>
          candidate.manifest_name === manifestName && candidate.outpoint === row.outpoint
        );
      }
      return { rows: [] };
    }
    if (compact.startsWith("UPDATE indexer_read_utxos SET spendable = TRUE")) {
      const [manifestName, matureThrough, previousMatureThrough] = params;
      let rowCount = 0;
      for (const row of this.readUtxos) {
        if (row.manifest_name !== manifestName) continue;
        if (!row.coinbase || row.protected || row.spendable) continue;
        if (row.block_height === null || row.block_height === undefined) continue;
        if (Number(row.block_height) > Number(matureThrough)) continue;
        if (previousMatureThrough !== undefined && Number(row.block_height) <= Number(previousMatureThrough)) continue;
        row.spendable = true;
        row.record_json = { ...row.record_json, spendable: true };
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }
    if (compact.startsWith("SELECT COUNT(*)::bigint AS total, MIN(inscription_number)::bigint")) {
      const rows = filterReadInscriptions(this.readInscriptions, compact, params, false);
      return {
        rows: [{
          total: rows.length,
          first_inscription_number: rows.length ? Math.min(...rows.map((row) => row.inscription_number)) : null,
          latest_inscription_number: rows.length ? Math.max(...rows.map((row) => row.inscription_number)) : null
        }]
      };
    }
    if (
      compact.startsWith("SELECT record_json FROM indexer_read_inscriptions") &&
      compact.includes("ORDER BY inscription_number ASC, inscription_id ASC")
    ) {
      const rows = this.readInscriptions
        .filter((row) => row.manifest_name === params[0])
        .toSorted((left, right) => {
          const numberDiff = Number(left.inscription_number ?? 0) - Number(right.inscription_number ?? 0);
          return numberDiff || String(left.inscription_id).localeCompare(String(right.inscription_id));
        });
      return { rows: rows.map((row) => ({ record_json: row.record_json })) };
    }
    if (compact.startsWith("SELECT record_json FROM indexer_read_inscriptions")) {
      const rows = filterReadInscriptions(this.readInscriptions, compact, params, true);
      const descending = compact.includes("ORDER BY inscription_number DESC");
      rows.sort((left, right) =>
        descending
          ? right.inscription_number - left.inscription_number
          : left.inscription_number - right.inscription_number
      );
      const { limit, offset } = limitOffset(params);
      return { rows: rows.slice(offset, offset + limit).map((row) => ({ record_json: row.record_json })) };
    }
    if (compact.startsWith("SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE protected)::bigint")) {
      const rows = filterReadUtxos(this.readUtxos, compact, params, false);
      const totalValue = rows.reduce((sum, row) => sum + BigInt(row.value_grain ?? "0"), 0n);
      return {
        rows: [{
          total: rows.length,
          protected_total: rows.filter((row) => row.protected).length,
          spendable_total: rows.filter((row) => row.spendable).length,
          total_value_grain: totalValue.toString()
        }]
      };
    }
    if (
      compact.startsWith("SELECT record_json, block_height, coinbase, protected, spendable FROM indexer_read_utxos") &&
      compact.includes("ORDER BY outpoint ASC")
    ) {
      const rows = this.readUtxos
        .filter((row) => row.manifest_name === params[0])
        .toSorted((left, right) => String(left.outpoint).localeCompare(String(right.outpoint)));
      return {
        rows: rows.map((row) => ({
          record_json: row.record_json,
          block_height: row.block_height,
          coinbase: row.coinbase,
          protected: row.protected,
          spendable: row.spendable
        }))
      };
    }
    if (
      compact.startsWith("SELECT record_json FROM indexer_read_utxos") ||
      compact.startsWith("SELECT record_json, block_height, coinbase, protected, spendable FROM indexer_read_utxos")
    ) {
      const rows = filterReadUtxos(this.readUtxos, compact, params, true);
      sortReadUtxos(rows);
      const { limit, offset } = limitOffset(params);
      return {
        rows: rows.slice(offset, offset + limit).map((row) => ({
          record_json: row.record_json,
          block_height: row.block_height,
          coinbase: row.coinbase,
          protected: row.protected,
          spendable: row.spendable
        }))
      };
    }
    throw new Error(`unexpected SQL: ${compact}`);
  }
}

function upsertRow(rows, row, predicate) {
  const index = rows.findIndex(predicate);
  if (index >= 0) {
    rows[index] = row;
  } else {
    rows.push(row);
  }
}

function filterReadInscriptions(rows, compact, params, paged) {
  const filterParams = paged ? params.slice(0, -2) : params;
  return rows
    .filter((row) => row.manifest_name === filterParams[0])
    .filter((row) => {
      if (!compact.includes("current_owner_address")) return true;
      return row.current_owner_address === filterParams[1];
    });
}

function filterReadUtxos(rows, compact, params, paged) {
  const filterParams = paged ? params.slice(0, -2) : params;
  let index = 2;
  const filters = {};
  if (compact.includes("protected = $")) filters.protected = filterParams[index++];
  if (compact.includes("spendable = $")) filters.spendable = filterParams[index++];
  return rows
    .filter((row) => row.manifest_name === filterParams[0])
    .filter((row) => row.address === filterParams[1])
    .filter((row) => filters.protected === undefined || row.protected === filters.protected)
    .filter((row) => filters.spendable === undefined || row.spendable === filters.spendable);
}

function sortReadUtxos(rows) {
  rows.sort((left, right) => {
    if (left.protected !== right.protected) {
      return left.protected ? 1 : -1;
    }
    if (left.spendable !== right.spendable) {
      return left.spendable ? -1 : 1;
    }
    const valueDiff = BigInt(right.value_grain ?? "0") - BigInt(left.value_grain ?? "0");
    if (valueDiff !== 0n) {
      return valueDiff > 0n ? 1 : -1;
    }
    return String(left.outpoint).localeCompare(String(right.outpoint));
  });
}

function limitOffset(params) {
  return {
    limit: Number(params.at(-2)),
    offset: Number(params.at(-1))
  };
}
