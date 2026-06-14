import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPrl20IngestSession,
  ingestPearlBlocksFixture,
  loadFixture,
  PRLS_MINT_FEE_POLICY
} from "../src/indexer.js";
import { normalizeSnapshotForComparison, snapshotDigest } from "../src/snapshot-compare.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const fixtureFiles = readdirSync(fixturesDir).filter((file) => file.endsWith(".json"));

function fullDigest(snapshot) {
  return snapshotDigest(normalizeSnapshotForComparison(snapshot));
}

function mintFeePolicyFor(fixture) {
  return fixture.prl20MintFee ?? fixture.network?.prl20MintFee ?? PRLS_MINT_FEE_POLICY;
}

function sortedBlocks(fixture) {
  return [...(fixture.blocks ?? [])].sort((a, b) => a.height - b.height);
}

function sessionSnapshot(fixture, blocks) {
  const session = createPrl20IngestSession({ mintFeePolicy: mintFeePolicyFor(fixture) });
  for (const block of blocks) {
    session.applyBlock(block);
  }
  return session.buildSnapshot({
    network: fixture.network ?? { chain: "pearl-mock" },
    prlBalances: fixture.prlBalances ?? {},
    utxos: fixture.utxos ?? null
  });
}

// Test 1: a block-by-block ingest session must be digest-identical to a single
// full ingestPearlBlocksFixture fold for EVERY fixture in fixtures/*.json.
for (const file of fixtureFiles) {
  test(`session block-by-block digest matches full fold: ${file}`, () => {
    const fixture = loadFixture(join(fixturesDir, file));
    const full = ingestPearlBlocksFixture(fixture);
    const incremental = sessionSnapshot(fixture, sortedBlocks(fixture));
    assert.equal(
      fullDigest(incremental),
      fullDigest(full),
      `incremental session digest must equal full-fold digest for ${file}`
    );
  });
}

// Test 2 (split-publish, catches the publish-time mutation trap): apply half the
// blocks, buildSnapshot, apply the rest, buildSnapshot. The final snapshot must
// be digest-identical to a one-shot fold, proving buildSnapshot does not mutate
// the live accumulators (applyCurrentInscriptionLocations mutates location /
// firstMove fields on inscription records, so the records must be cloned at
// publish).
for (const file of fixtureFiles) {
  test(`split-publish digest matches one-shot fold: ${file}`, () => {
    const fixture = loadFixture(join(fixturesDir, file));
    const blocks = sortedBlocks(fixture);
    const session = createPrl20IngestSession({ mintFeePolicy: mintFeePolicyFor(fixture) });
    const half = Math.floor(blocks.length / 2);

    for (let index = 0; index < half; index += 1) {
      session.applyBlock(blocks[index]);
    }
    // First publish on a partially-applied session. Its return value is
    // discarded, but it exercises the publish-time mutators so a non-cloning
    // implementation would corrupt the accumulator records here.
    const firstPublish = session.buildSnapshot({ network: fixture.network ?? { chain: "pearl-mock" } });
    assert.ok(firstPublish, "first publish should produce a snapshot");

    for (let index = half; index < blocks.length; index += 1) {
      session.applyBlock(blocks[index]);
    }
    const finalSnapshot = session.buildSnapshot({
      network: fixture.network ?? { chain: "pearl-mock" },
      prlBalances: fixture.prlBalances ?? {},
      utxos: fixture.utxos ?? null
    });

    const oneShot = ingestPearlBlocksFixture(fixture);
    assert.equal(
      fullDigest(finalSnapshot),
      fullDigest(oneShot),
      `split-publish final digest must equal one-shot digest for ${file}`
    );
  });
}

// Constructed cross-publish-with-move scenario: mint an inscription in block 1,
// publish, then move it in block 2 and publish again. The move sets firstMove /
// location fields that the publish-time mutators write onto the inscription
// records. The public projection re-derives location state from scratch on every
// publish (and records are cloned at publish as a defensive guard mirroring the
// private reference), so the final publish — taken AFTER an intermediate publish
// on the same live session — must equal a clean fold of both blocks.
test("publish between mint and move stays digest-identical to a clean fold", () => {
  const owner = "rprl1ptestowner00000000000000000000000000000000000";
  const ownerScript = "5120owner";
  const deployBlock = {
    height: 1,
    hash: "01".padStart(64, "0"),
    transactions: [
      {
        txid: "tx-deploy",
        inputs: [
          {
            witness: [
              "OP_FALSE",
              "OP_IF",
              "prl-20",
              "application/json",
              "0x00",
              "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}",
              "OP_ENDIF"
            ]
          }
        ],
        outputs: [{ address: owner, scriptPubKey: ownerScript, valuePrl: "0.00000546" }]
      }
    ]
  };
  const moveBlock = {
    height: 2,
    hash: "02".padStart(64, "0"),
    transactions: [
      {
        txid: "tx-move",
        inscriptionTransferOutputIndex: 0,
        inputs: [{ previousTxid: "tx-deploy", previousVout: 0, witness: [] }],
        outputs: [
          { address: "prl1buyer", scriptPubKey: "5120buyer", valuePrl: "0.00000546" },
          { address: owner, scriptPubKey: ownerScript, valuePrl: "1.00000000" }
        ]
      }
    ]
  };

  const meta = { network: { chain: "pearl-mock" } };
  const session = createPrl20IngestSession({ mintFeePolicy: PRLS_MINT_FEE_POLICY });
  session.applyBlock(deployBlock);
  const beforeMove = session.buildSnapshot(meta);
  assert.equal(beforeMove.inscriptions[0].currentOutpoint, "tx-deploy:0");
  assert.equal(beforeMove.inscriptions[0].firstMove ?? null, null);

  session.applyBlock(moveBlock);
  const afterMove = session.buildSnapshot(meta);

  const cleanFold = ingestPearlBlocksFixture({
    network: { chain: "pearl-mock" },
    blocks: [deployBlock, moveBlock]
  });
  assert.equal(fullDigest(afterMove), fullDigest(cleanFold));
  // The move must be reflected after the second publish (proves the mid-stream
  // publish did not freeze the record's location at its block-1 value).
  assert.equal(afterMove.inscriptions[0].currentOutpoint, "tx-move:0");
});

// Repeated buildSnapshot calls on the same fully-applied session must be stable
// (a second publish must equal the first), which is the core determinism
// guarantee the record cloning provides.
for (const file of fixtureFiles) {
  test(`repeated publish is deterministic: ${file}`, () => {
    const fixture = loadFixture(join(fixturesDir, file));
    const session = createPrl20IngestSession({ mintFeePolicy: mintFeePolicyFor(fixture) });
    for (const block of sortedBlocks(fixture)) {
      session.applyBlock(block);
    }
    const meta = {
      network: fixture.network ?? { chain: "pearl-mock" },
      prlBalances: fixture.prlBalances ?? {},
      utxos: fixture.utxos ?? null
    };
    const first = session.buildSnapshot(meta);
    const second = session.buildSnapshot(meta);
    assert.equal(fullDigest(second), fullDigest(first));
  });
}
