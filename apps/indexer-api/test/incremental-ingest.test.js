import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createPersistentPrl20Indexer } from "../src/persistent-indexer.js";
import { normalizeProtocolSnapshotForComparison, snapshotDigest } from "../src/snapshot-compare.js";
import { createIndexerStorage } from "../src/storage.js";

// --- Local copies of the persistent-indexer.test.js fixture helpers (kept in
// sync with that file's block/tx/hash/makeRpc shapes) ---

function makeRpc(blocks, calls = []) {
  const byHeight = new Map(blocks.map((item) => [item.height, item]));
  const byHash = new Map(blocks.map((item) => [item.hash, item]));
  return async (method, params = []) => {
    calls.push([method, params]);
    if (method === "getblockcount") {
      return Math.max(...blocks.map((item) => item.height));
    }
    if (method === "getblockhash") {
      const found = byHeight.get(params[0]);
      assert.ok(found, `missing block at height ${params[0]}`);
      return found.hash;
    }
    if (method === "getblock") {
      const found = byHash.get(params[0]);
      assert.ok(found, `missing block hash ${params[0]}`);
      return found;
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}

function block(height, hashValue, previousblockhash, transactions) {
  return { height, hash: hashValue, previousblockhash, time: 1779053537 + height, transactions };
}

function tx(txid, address, scriptPubKey, body, includeFee = false) {
  return {
    txid,
    inputs: [
      {
        witness: ["OP_FALSE", "OP_IF", "prl-20", "application/json", "0x00", body, "OP_ENDIF"]
      }
    ],
    outputs: [
      { address, scriptPubKey, valuePrl: "0.00000546" },
      ...(includeFee
        ? [
            {
              address: "rprl1pjza054vjtj6zd7j3k5ps2q2wtus3vr8jp0m265a8atyggkrrrmeqehah68",
              scriptPubKey: "512090bafa55925cb426fa51b50305014e5f21160cf20bf6ad53a7eac88458631ef2",
              valuePrl: "1.00000000"
            }
          ]
        : [])
    ]
  };
}

function hash(seed) {
  return seed.padStart(64, "0");
}

const DEPLOY_BODY =
  "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}";
const MINT_BODY = "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}";
const OWNER = "rprl1ptestowner00000000000000000000000000000000000";

function protocolDigest(snapshot) {
  return snapshotDigest(normalizeProtocolSnapshotForComparison(snapshot));
}

// A storage wrapper that records the size of every readBlocks() call so a test
// can assert the chunked rebuild never loads more than rebuildChunkSize blocks
// in a single slice.
function instrumentReadBlocks(storage) {
  const readBlockSizes = [];
  const originalReadBlocks = storage.readBlocks.bind(storage);
  storage.readBlocks = async (blockRefs) => {
    readBlockSizes.push(blockRefs.length);
    return originalReadBlocks(blockRefs);
  };
  return readBlockSizes;
}

function buildChain(length) {
  const blocks = [];
  let previous = null;
  for (let height = 1; height <= length; height += 1) {
    const transactions =
      height === 1
        ? [tx("tx-deploy", OWNER, "5120owner", DEPLOY_BODY)]
        : [tx(`tx-mint-${height}`, `prl1m${height}`, `5120m${height}`, MINT_BODY, true)];
    const current = block(height, hash(`c${height}`), previous, transactions);
    blocks.push(current);
    previous = current.hash;
  }
  return blocks;
}

// Test 3a: a full sync followed by a one-block append must take the incremental
// ingest path and stay digest-identical to a from-scratch sync of the same chain.
test("append after full sync uses the incremental path and stays digest-identical", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-incremental-"));
  const deployBlock = block(1, hash("a1"), null, [tx("tx-deploy", OWNER, "5120owner", DEPLOY_BODY)]);
  const mintBlock = block(2, hash("a2"), deployBlock.hash, [
    tx("tx-mint", OWNER, "5120owner", MINT_BODY, true)
  ]);

  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock]),
    storeDir,
    startHeight: 1
  });
  const first = await indexer.syncToTip();
  assert.equal(indexer.lastIngestPath, "full-rebuild");
  assert.equal(first.snapshot.token.deployed, true);

  // Append one block; same live indexer instance keeps its ingest session alive.
  indexer.pearlRpc = makeRpc([deployBlock, mintBlock]);
  const second = await indexer.syncToTip();
  assert.equal(indexer.lastIngestPath, "incremental");
  assert.equal(second.blockCount, 1);
  assert.equal(second.blocks.length, 1);
  assert.equal(second.snapshot.token.mintedSupply, "100000");

  // A from-scratch indexer over the full chain must produce the same protocol
  // digest as the incrementally-synced one.
  const scratchDir = await mkdtemp(join(tmpdir(), "prl20-scratch-"));
  const scratch = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, mintBlock]),
    storeDir: scratchDir,
    startHeight: 1
  });
  const scratchResult = await scratch.syncToTip();
  assert.equal(scratch.lastIngestPath, "full-rebuild");
  assert.equal(protocolDigest(second.snapshot), protocolDigest(scratchResult.snapshot));
});

// Test 3b: a reorg must fall back to the full-rebuild path and still produce the
// correct digest (matching a clean sync of the new canonical chain).
test("reorg falls back to full rebuild and stays digest-correct", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "prl20-incremental-reorg-"));
  const deployBlock = block(1, hash("b1"), null, [tx("tx-deploy", OWNER, "5120owner", DEPLOY_BODY)]);
  const validMint = block(2, hash("b2"), deployBlock.hash, [
    tx("tx-mint-valid", OWNER, "5120owner", MINT_BODY, true)
  ]);
  const invalidMint = block(2, hash("b3"), deployBlock.hash, [
    tx("tx-mint-no-fee", OWNER, "5120owner", MINT_BODY, false)
  ]);

  const indexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, validMint]),
    storeDir,
    startHeight: 1
  });
  await indexer.syncToTip();
  // Append the next block incrementally first so the session is "warm".
  assert.ok(["full-rebuild", "incremental"].includes(indexer.lastIngestPath));

  // Now present a competing block at height 2: this is a reorg.
  indexer.pearlRpc = makeRpc([deployBlock, invalidMint]);
  const reorged = await indexer.syncToTip();
  assert.equal(indexer.lastIngestPath, "full-rebuild");
  assert.equal(reorged.status.reorgCount, 1);
  assert.equal(reorged.status.indexedHash, invalidMint.hash);
  assert.equal(reorged.snapshot.token.mintedSupply, "0");

  // Digest must match a clean from-scratch sync of the post-reorg canonical chain.
  const scratchDir = await mkdtemp(join(tmpdir(), "prl20-reorg-scratch-"));
  const scratch = createPersistentPrl20Indexer({
    pearlRpc: makeRpc([deployBlock, invalidMint]),
    storeDir: scratchDir,
    startHeight: 1
  });
  const scratchResult = await scratch.syncToTip();
  assert.equal(protocolDigest(reorged.snapshot), protocolDigest(scratchResult.snapshot));
});

// Test 4: a chunked rebuild (rebuildChunkSize = 2) must be digest-identical to a
// single-shot rebuild (rebuildChunkSize large enough for one slice), no single
// readBlocks slice may exceed the chunk size, and blockCount must be correct.
test("chunked rebuild is digest-identical to a single-shot rebuild and respects the chunk bound", async () => {
  const chain = buildChain(5);

  // Single-shot rebuild: a chunk size >= chain length means one readBlocks call.
  const singleDir = await mkdtemp(join(tmpdir(), "prl20-single-rebuild-"));
  const singleStorage = createIndexerStorage({ storeDir: singleDir });
  const singleReadSizes = instrumentReadBlocks(singleStorage);
  const singleIndexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc(chain),
    storage: singleStorage,
    startHeight: 1,
    rebuildChunkSize: 5000
  });
  const singleResult = await singleIndexer.syncToTip();
  assert.equal(singleIndexer.lastIngestPath, "full-rebuild");
  assert.equal(singleResult.blockCount, 5);
  assert.equal(singleResult.blocks.length, 0);

  // Chunked rebuild: chunk size 2 over a 5-block chain => slices of 2, 2, 1.
  const chunkedDir = await mkdtemp(join(tmpdir(), "prl20-chunked-rebuild-"));
  const chunkedStorage = createIndexerStorage({ storeDir: chunkedDir });
  const chunkedReadSizes = instrumentReadBlocks(chunkedStorage);
  const chunkedIndexer = createPersistentPrl20Indexer({
    pearlRpc: makeRpc(chain),
    storage: chunkedStorage,
    startHeight: 1,
    rebuildChunkSize: 2
  });
  const chunkedResult = await chunkedIndexer.syncToTip();
  assert.equal(chunkedIndexer.lastIngestPath, "full-rebuild");
  assert.equal(chunkedResult.blockCount, 5);
  assert.equal(chunkedResult.blocks.length, 0);

  // Digest parity between chunked and single-shot rebuilds.
  assert.equal(protocolDigest(chunkedResult.snapshot), protocolDigest(singleResult.snapshot));

  // No single readBlocks slice during the chunked rebuild may exceed the chunk
  // size of 2. (The single-shot rebuild loaded all 5 at once, by contrast.)
  assert.ok(
    chunkedReadSizes.every((size) => size <= 2),
    `chunked readBlocks slices must each be <= 2, saw ${JSON.stringify(chunkedReadSizes)}`
  );
  assert.deepEqual(chunkedReadSizes, [2, 2, 1]);
  assert.ok(
    singleReadSizes.some((size) => size === 5),
    `single-shot rebuild should load all blocks in one slice, saw ${JSON.stringify(singleReadSizes)}`
  );
});

// The rebuild chunk size must be clamped to the documented 1..5000 range.
test("rebuild chunk size is clamped to 1..5000", () => {
  const rpc = makeRpc([block(1, hash("d1"), null, [tx("tx-deploy", OWNER, "5120owner", DEPLOY_BODY)])]);
  const tooLow = createPersistentPrl20Indexer({ pearlRpc: rpc, storeDir: "/tmp/unused-1", rebuildChunkSize: 0 });
  const tooHigh = createPersistentPrl20Indexer({ pearlRpc: rpc, storeDir: "/tmp/unused-2", rebuildChunkSize: 99999 });
  const normal = createPersistentPrl20Indexer({ pearlRpc: rpc, storeDir: "/tmp/unused-3", rebuildChunkSize: 17 });
  assert.equal(tooLow.rebuildChunkSize, 250); // 0 is falsy -> default 250
  assert.equal(tooHigh.rebuildChunkSize, 5000);
  assert.equal(normal.rebuildChunkSize, 17);
});
