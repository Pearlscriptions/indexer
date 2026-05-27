import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  extractTaprootInscriptionsFromRawTxHex,
  ingestPearlBlocksFixture,
  loadFixture,
  routeSnapshot
} from "../src/indexer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "..", "fixtures", "prls-mock-blocks.json");
const schemaPath = join(__dirname, "..", "..", "..", "db", "schema-postgres-v0.sql");
const realSimnetFixturePath = join(
  __dirname,
  "..",
  "fixtures",
  "prls-real-pearl-simnet-mint.json"
);
const realDeployMintFixturePath = join(
  __dirname,
  "..",
  "fixtures",
  "prls-real-pearl-simnet-deploy-mint.json"
);
const legacyHalfPrlMintFixturePath = join(
  __dirname,
  "..",
  "fixtures",
  "prls-real-pearl-simnet-legacy-half-prl-mint.json"
);
const onePrlMintFixturePath = join(
  __dirname,
  "..",
  "fixtures",
  "prls-real-pearl-simnet-one-prl-mints.json"
);

test("mock Pearl blocks derive deterministic PRLS supply and balances", () => {
  const snapshot = ingestPearlBlocksFixture(loadFixture(fixturePath));

  assert.equal(snapshot.token.deployed, true);
  assert.equal(snapshot.token.mintedSupply, "200000");
  assert.equal(snapshot.token.mintCount, 2);
  assert.equal(snapshot.token.mintFeeGrain, "100000000");

  assert.equal(snapshot.operations.length, 6);
  assert.deepEqual(
    snapshot.operations.map((operation) => operation.valid),
    [true, true, true, false, false, false]
  );
  assert.equal(snapshot.operations[3].invalidReason, "DEPLOY_ALREADY_EXISTS");
  assert.equal(snapshot.operations[4].invalidReason, "INVALID_PRLS_MINT_AMOUNT");
  assert.equal(snapshot.operations[5].invalidReason, "MALFORMED_JSON");
});

test("address balance API surface combines mocked PRL and indexed PRLS balances", () => {
  const snapshot = ingestPearlBlocksFixture(loadFixture(fixturePath));

  const alice = routeSnapshot(snapshot, "GET", "/addresses/prl1alice/balances");
  assert.equal(alice.status, 200);
  assert.deepEqual(alice.body, {
    address: "prl1alice",
    prl: "1.75000000",
    prls: "100000",
    tokens: {
      prls: "100000"
    }
  });

  const bob = routeSnapshot(snapshot, "GET", "/addresses/prl1bob/balances");
  assert.equal(bob.body.prls, "100000");
});

test("token, health, tx status, and utxo routes are explicit", () => {
  const snapshot = ingestPearlBlocksFixture(loadFixture(fixturePath));

  assert.equal(routeSnapshot(snapshot, "GET", "/health").body.ok, true);
  assert.equal(routeSnapshot(snapshot, "GET", "/network").body.chain, "pearl-mock");
  assert.equal(routeSnapshot(snapshot, "GET", "/tokens/prls").body.maxSupply, "2100000000");
  assert.equal(routeSnapshot(snapshot, "GET", "/tokens").body.tokens[0].ticker, "prls");
  const operations = routeSnapshot(snapshot, "GET", "/operations?limit=2&page=2");
  assert.equal(operations.status, 200);
  assert.equal(operations.body.total, 6);
  assert.equal(operations.body.operations.length, 2);
  assert.equal(operations.body.operations[0].inscriptionNumber, 2);
  assert.equal(Object.hasOwn(operations.body.operations[0], "body"), false);
  assert.equal(
    routeSnapshot(snapshot, "GET", "/addresses/prl1alice/utxos").body.utxos[0].txid,
    "funding-alice"
  );
  assert.equal(
    routeSnapshot(snapshot, "GET", "/tx/tx-mint-alice/status").body.status,
    "confirmed"
  );
});

test("public indexer does not expose marketplace routes or snapshot fields", () => {
  const snapshot = ingestPearlBlocksFixture(loadFixture(fixturePath));

  assert.equal(Object.hasOwn(snapshot, "market"), false);
  assert.equal(routeSnapshot(snapshot, "GET", "/market/listings").status, 404);
  assert.equal(routeSnapshot(snapshot, "GET", "/market/events").status, 404);
  assert.equal(routeSnapshot(snapshot, "GET", "/market/stats").status, 404);
  assert.equal(routeSnapshot(snapshot, "GET", "/market/listings/abc").status, 404);
});

test("public Postgres schema does not contain marketplace tables", () => {
  const schema = readFileSync(schemaPath, "utf8");

  assert.doesNotMatch(schema, /\bmarket_events\b/);
  assert.doesNotMatch(schema, /\bmarket_listings\b/);
  assert.doesNotMatch(schema, /\bindexer_read_market_listings\b/);
  assert.doesNotMatch(schema, /\bindexer_read_market_events\b/);
});

test("generic PRL-20 token routes expose progress, holders, and generic balances", () => {
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-generic-token-block",
        transactions: [
          tx(
            "tx-deploy-pearl",
            "prl1deployer",
            "5120deployer",
            "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"pearl\",\"max\":\"21000000\",\"lim\":\"1000\",\"dec\":\"8\"}"
          ),
          tx(
            "tx-mint-pearl",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"PEARL\",\"amt\":\"1000\"}"
          )
        ]
      }
    ]
  };
  const snapshot = ingestPearlBlocksFixture(fixture);
  const tokens = routeSnapshot(snapshot, "GET", "/tokens");
  const detail = routeSnapshot(snapshot, "GET", "/tokens/pearl");
  const balances = routeSnapshot(snapshot, "GET", "/addresses/prl1alice/balances");

  assert.equal(tokens.status, 200);
  assert.equal(tokens.body.total, 1);
  assert.equal(tokens.body.tokens[0].ticker, "pearl");
  assert.equal(tokens.body.tokens[0].mintedSupply, "1000");
  assert.equal(tokens.body.tokens[0].holderCount, 1);
  assert.equal(tokens.body.tokens[0].mintProgress, 0);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.displayTicker, "PEARL");
  assert.equal(balances.body.tokens.pearl, "1000");
  assert.equal(snapshot.operations[1].mintFeeRequired, false);
});

test("generic Pearlscriptions index arbitrary content without changing PRLS balances", () => {
  const fixture = makeGenericPearlscriptionFixture();
  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.equal(snapshot.token.deployed, true);
  assert.equal(snapshot.token.mintedSupply, "0");
  assert.equal(snapshot.token.mintCount, 0);
  assert.equal(snapshot.operations.length, 1);
  assert.equal(snapshot.operations[0].op, "deploy");
  assert.equal(snapshot.operations[0].mintFeeRequired, false);
  assert.equal(snapshot.inscriptions.length, 4);

  const [deploy, text, png, metadata] = snapshot.inscriptions;
  assert.deepEqual(
    snapshot.inscriptions.map((inscription) => inscription.inscriptionNumber),
    [0, 1, 2, 3]
  );
  assert.equal(deploy.protocolMarker, "prl-20");
  assert.equal(snapshot.operations[0].inscriptionNumber, 0);
  assert.equal(text.protocolMarker, "pearlscription");
  assert.equal(text.contentType, "text/plain;charset=utf-8");
  assert.equal(text.byteLength, 23);
  assert.equal(text.bodyPreview, "hello from pearl simnet");
  assert.equal(png.contentType, "image/png");
  assert.equal(png.bodyPreview, null);
  assert.equal(png.bodyHex, "89504e470d0a1a0a");
  assert.equal(metadata.protocolMarker, "pearl-collection");
  assert.equal(metadata.bodyPreview, "{\"name\":\"Simnet collection\"}");

  const list = routeSnapshot(snapshot, "GET", "/inscriptions");
  assert.equal(list.status, 200);
  assert.equal(list.body.inscriptions.length, 4);
  assert.equal(list.body.total, 4);
  assert.equal(list.body.limit, 48);
  assert.equal(list.body.page, 1);
  assert.equal(list.body.pageCount, 1);
  assert.equal(list.body.firstInscriptionNumber, 0);
  assert.equal(list.body.latestInscriptionNumber, 3);
  assert.equal(list.body.inscriptions[1].bodyPreview, "hello from pearl simnet");

  const paged = routeSnapshot(snapshot, "GET", "/inscriptions?limit=2&page=2");
  assert.equal(paged.status, 200);
  assert.equal(paged.body.total, 4);
  assert.equal(paged.body.limit, 2);
  assert.equal(paged.body.page, 2);
  assert.equal(paged.body.pageCount, 2);
  assert.equal(paged.body.itemStart, 3);
  assert.equal(paged.body.itemEnd, 4);
  assert.deepEqual(
    paged.body.inscriptions.map((inscription) => inscription.inscriptionNumber),
    [2, 3]
  );

  const descending = routeSnapshot(snapshot, "GET", "/inscriptions?limit=2&order=desc&page=1");
  assert.deepEqual(
    descending.body.inscriptions.map((inscription) => inscription.inscriptionNumber),
    [3, 2]
  );

  const detail = routeSnapshot(snapshot, "GET", `/inscriptions/${encodeURIComponent(text.id)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, text.id);
  assert.equal(detail.body.inscriptionNumber, 1);

  const content = routeSnapshot(
    snapshot,
    "GET",
    `/inscriptions/${encodeURIComponent(png.id)}/content`
  );
  assert.equal(content.status, 200);
  assert.equal(content.body.inscriptionNumber, 2);
  assert.equal(content.body.contentType, "image/png");
  assert.equal(content.body.bodyBase64, "iVBORw0KGgo=");
  assert.equal(content.body.bodyText, null);

  const owned = routeSnapshot(snapshot, "GET", "/addresses/prl1artist/inscriptions");
  assert.equal(owned.status, 200);
  assert.equal(owned.body.inscriptions.length, 3);
  assert.equal(owned.body.total, 3);

  const ownedPaged = routeSnapshot(snapshot, "GET", "/addresses/prl1artist/inscriptions?limit=2&page=2");
  assert.equal(ownedPaged.body.total, 3);
  assert.equal(ownedPaged.body.pageCount, 2);
  assert.deepEqual(
    ownedPaged.body.inscriptions.map((inscription) => inscription.inscriptionNumber),
    [3]
  );
});

test("generic batch Pearlscriptions map each envelope to its matching output", () => {
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-generic-batch-output-block",
        transactions: [
          genericBatchTx("tx-batch-domains", "prl1artist", "5120artist", [
            {
              marker: "pearl-domain",
              contentType: "application/json",
              body: "{\"p\":\"pearl-domain\",\"op\":\"register\",\"name\":\"alpha.pearl\"}"
            },
            {
              marker: "pearl-domain",
              contentType: "application/json",
              body: "{\"p\":\"pearl-domain\",\"op\":\"register\",\"name\":\"beta.pearl\"}"
            },
            {
              marker: "pearlscription",
              contentType: "text/plain;charset=utf-8",
              body: "third generic inscription"
            }
          ])
        ]
      }
    ]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.equal(snapshot.inscriptions.length, 3);
  assert.deepEqual(
    snapshot.inscriptions.map((inscription) => [
      inscription.id,
      inscription.ownerOutputIndex,
      inscription.ownerOutpoint,
      inscription.currentOutpoint
    ]),
    [
      ["tx-batch-domains:i0:n0", 0, "tx-batch-domains:0", "tx-batch-domains:0"],
      ["tx-batch-domains:i0:n1", 1, "tx-batch-domains:1", "tx-batch-domains:1"],
      ["tx-batch-domains:i0:n2", 2, "tx-batch-domains:2", "tx-batch-domains:2"]
    ]
  );
  const protectedOutpoints = (snapshot.utxos.prl1artist ?? [])
    .filter((utxo) => utxo.protected)
    .map((utxo) => utxo.outpoint);
  assert.deepEqual(protectedOutpoints, [
    "tx-batch-domains:0",
    "tx-batch-domains:1",
    "tx-batch-domains:2"
  ]);
});

test("generic batch ownership uses global envelope order across reveal inputs", () => {
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-multi-input-generic-batch-output-block",
        transactions: [
          genericMultiInputBatchTx("tx-multi-input-generic", "prl1artist", "5120artist", [
            [
              {
                marker: "pearlscription",
                contentType: "text/plain;charset=utf-8",
                body: "first input first"
              },
              {
                marker: "pearlscription",
                contentType: "text/plain;charset=utf-8",
                body: "first input second"
              }
            ],
            [
              {
                marker: "pearl-domain",
                contentType: "application/json",
                body: "{\"p\":\"pearl-domain\",\"op\":\"register\",\"name\":\"gamma.pearl\"}"
              }
            ]
          ])
        ]
      }
    ]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.deepEqual(
    snapshot.inscriptions.map((inscription) => [
      inscription.id,
      inscription.inputIndex,
      inscription.inscriptionIndex,
      inscription.ownerOutputIndex,
      inscription.ownerOutpoint
    ]),
    [
      ["tx-multi-input-generic:i0:n0", 0, 0, 0, "tx-multi-input-generic:0"],
      ["tx-multi-input-generic:i0:n1", 0, 1, 1, "tx-multi-input-generic:1"],
      ["tx-multi-input-generic:i1:n0", 1, 0, 2, "tx-multi-input-generic:2"]
    ]
  );
});

test("PRL-20 batch envelopes remain assigned to one owner output", () => {
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-prl20-batch-shared-output-block",
        transactions: [
          multiMintSameLeafTx(
            "tx-batch-prl20",
            "prl1minter",
            "5120minter",
            [
              "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}",
              "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}",
              "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}"
            ],
            [mintFeeOutput("3.00000000")]
          )
        ]
      }
    ]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.deepEqual(
    snapshot.inscriptions.map((inscription) => [
      inscription.id,
      inscription.ownerOutputIndex,
      inscription.ownerOutpoint
    ]),
    [
      ["tx-batch-prl20:i0:n0", 0, "tx-batch-prl20:0"],
      ["tx-batch-prl20:i0:n1", 0, "tx-batch-prl20:0"],
      ["tx-batch-prl20:i0:n2", 0, "tx-batch-prl20:0"]
    ]
  );
});

test("mixed PRL-20 and generic batches use separate owner outputs", () => {
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-mixed-batch-output-block",
        transactions: [
          genericBatchTx("tx-mixed-batch", "prl1artist", "5120artist", [
            {
              marker: "prl-20",
              contentType: "application/json",
              body: "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}"
            },
            {
              marker: "pearlscription",
              contentType: "text/plain;charset=utf-8",
              body: "generic second"
            }
          ])
        ]
      }
    ]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.deepEqual(
    snapshot.inscriptions.map((inscription) => [
      inscription.id,
      inscription.ownerOutputIndex,
      inscription.ownerOutpoint
    ]),
    [
      ["tx-mixed-batch:i0:n0", 0, "tx-mixed-batch:0"],
      ["tx-mixed-batch:i0:n1", 1, "tx-mixed-batch:1"]
    ]
  );
});

test("inscription location tracking moves assets without marketplace state", () => {
  const snapshot = ingestPearlBlocksFixture(makeInscriptionMovementFixture());
  const assetId = "tx-text:i0:n0";

  const location = routeSnapshot(snapshot, "GET", `/inscriptions/${encodeURIComponent(assetId)}/location`);
  assert.equal(location.status, 200);
  assert.equal(location.body.ownerOutpoint, "tx-text:0");
  assert.equal(location.body.currentOutpoint, "tx-move-text:0");
  assert.equal(location.body.currentOwnerAddress, "prl1buyer");
});

test("PRL-20 transfer lots remain transferable or fill as whole blocks", () => {
  const snapshot = ingestPearlBlocksFixture(makePrl20TransferLotFillFixture());

  const buyer = routeSnapshot(snapshot, "GET", "/addresses/prl1buyer/balances");
  assert.equal(buyer.body.prls, "100000");

  const aliceBalance = routeSnapshot(snapshot, "GET", "/addresses/prl1alice/balances");
  assert.equal(aliceBalance.body.tokens.prls ?? "0", "0");

  const aliceLots = routeSnapshot(snapshot, "GET", "/addresses/prl1alice/transfer-lots");
  assert.equal(aliceLots.status, 200);
  assert.equal(aliceLots.body.total, 1);
  assert.deepEqual(aliceLots.body.tokens.prls, {
    ticker: "prls",
    displayTicker: "PRLS",
    transferable: "100000",
    confirmedTransferable: "100000",
    pendingTransferable: "0",
    lotCount: 1,
    confirmedLotCount: 1,
    pendingLotCount: 0
  });
  assert.deepEqual(
    aliceLots.body.transferLots.map((lot) => [lot.id, lot.amount, lot.currentOutpoint, lot.locationStatus]),
    [["tx-transfer-expensive:i0:n0", "100000", "tx-transfer-expensive:0", "confirmed"]]
  );

  const buyerLots = routeSnapshot(snapshot, "GET", "/addresses/prl1buyer/transfer-lots");
  assert.equal(buyerLots.status, 200);
  assert.equal(buyerLots.body.total, 0);
  assert.deepEqual(buyerLots.body.tokens, {});

  const lotLocation = routeSnapshot(
    snapshot,
    "GET",
    `/inscriptions/${encodeURIComponent("tx-transfer-cheap:i0:n0")}/location`
  );
  assert.equal(lotLocation.body.currentOutpoint, "tx-move-cheap:0");
  assert.equal(lotLocation.body.currentOwnerAddress, "prl1buyer");

  const aliceUtxos = snapshot.utxos.prl1alice ?? [];
  const activeTransferUtxo = aliceUtxos.find((utxo) => utxo.outpoint === "tx-transfer-expensive:0");
  assert.equal(activeTransferUtxo?.protected, true);
  assert.equal(activeTransferUtxo?.spendable, false);
  assert.equal(activeTransferUtxo?.protectionReason, "PRL20_TRANSFER_LOT_UTXO");
  assert.equal(activeTransferUtxo?.transferLotId, "tx-transfer-expensive:i0:n0");

  const buyerUtxos = snapshot.utxos.prl1buyer ?? [];
  const filledTransferUtxo = buyerUtxos.find((utxo) => utxo.outpoint === "tx-move-cheap:0");
  assert.equal(filledTransferUtxo?.protected, true);
  assert.equal(filledTransferUtxo?.protectionReason, "INSCRIPTION_UTXO");
});

test("PRL-20 filled transfer lots are credited before later transfer validation", () => {
  const fixture = makePrl20TransferLotFillFixture();
  fixture.network.bestHeight = 3;
  fixture.blocks.push({
    height: 3,
    hash: "mock-prl20-transfer-lot-block-3",
    previousHash: "mock-prl20-transfer-lot-block-2",
    transactions: [
      tx(
        "tx-buyer-transfer",
        "prl1buyer",
        "5120buyer",
        "{\"p\":\"prl-20\",\"op\":\"transfer\",\"tick\":\"prls\",\"amt\":\"100000\"}"
      )
    ]
  });

  const snapshot = ingestPearlBlocksFixture(fixture);
  const buyerTransfer = snapshot.operations.find((operation) => operation.txid === "tx-buyer-transfer");
  assert.equal(buyerTransfer.valid, true);
  assert.equal(buyerTransfer.invalidReason, null);

  const buyerBalance = routeSnapshot(snapshot, "GET", "/addresses/prl1buyer/balances");
  assert.equal(buyerBalance.body.tokens.prls ?? "0", "0");

  const buyerLots = routeSnapshot(snapshot, "GET", "/addresses/prl1buyer/transfer-lots");
  assert.equal(buyerLots.body.total, 1);
  assert.deepEqual(
    buyerLots.body.transferLots.map((lot) => [lot.id, lot.amount, lot.currentOutpoint, lot.locationStatus]),
    [["tx-buyer-transfer:i0:n0", "100000", "tx-buyer-transfer:0", "confirmed"]]
  );
});

test("PRL-20 multi-lot fills require explicit output mapping before balance credit", () => {
  const snapshot = ingestPearlBlocksFixture(makePrl20AmbiguousSweepFixture());

  const buyerA = routeSnapshot(snapshot, "GET", "/addresses/prl1buyerA/balances");
  const buyerB = routeSnapshot(snapshot, "GET", "/addresses/prl1buyerB/balances");
  assert.equal(buyerA.body.tokens.prls ?? "0", "0");
  assert.equal(buyerB.body.tokens.prls ?? "0", "0");

  const filledLots = snapshot.transferLots.filter((lot) => lot.status === "filled");
  assert.deepEqual(
    filledLots.map((lot) => [lot.id, lot.fillOwnerAddress, lot.fillInvalidReason]),
    [
      ["tx-transfer-a:i0:n0", null, "AMBIGUOUS_TRANSFER_OUTPUT"],
      ["tx-transfer-b:i0:n0", null, "AMBIGUOUS_TRANSFER_OUTPUT"]
    ]
  );
});

test("PRL-20 multi-lot fills credit mapped output owners for sweeps", () => {
  const snapshot = ingestPearlBlocksFixture(
    makePrl20AmbiguousSweepFixture({
      inscriptionTransfers: [
        { inputOutpoint: "tx-transfer-a:0", outputIndex: 0 },
        { inputOutpoint: "tx-transfer-b:0", outputIndex: 1 }
      ]
    })
  );

  const buyerA = routeSnapshot(snapshot, "GET", "/addresses/prl1buyerA/balances");
  const buyerB = routeSnapshot(snapshot, "GET", "/addresses/prl1buyerB/balances");
  assert.equal(buyerA.body.tokens.prls, "100000");
  assert.equal(buyerB.body.tokens.prls, "100000");

  const filledLots = snapshot.transferLots.filter((lot) => lot.status === "filled");
  assert.deepEqual(
    filledLots.map((lot) => [lot.id, lot.fillOwnerAddress, lot.fillInvalidReason]),
    [
      ["tx-transfer-a:i0:n0", "prl1buyerA", null],
      ["tx-transfer-b:i0:n0", "prl1buyerB", null]
    ]
  );
});

test("PRL-20 transfer-lot sweeps infer recipient outputs without fixture metadata", () => {
  const snapshot = ingestPearlBlocksFixture(
    makePrl20AmbiguousSweepFixture({ transferLotSweepStyle: true })
  );

  const buyer = routeSnapshot(snapshot, "GET", "/addresses/prl1buyer/balances");
  assert.equal(buyer.body.tokens.prls, "200000");

  const filledLots = snapshot.transferLots.filter((lot) => lot.status === "filled");
  assert.deepEqual(
    filledLots.map((lot) => [lot.id, lot.fillOwnerAddress, lot.fillOutputIndex, lot.fillInvalidReason]),
    [
      ["tx-transfer-a:i0:n0", "prl1buyer", 0, null],
      ["tx-transfer-b:i0:n0", "prl1buyer", 3, null]
    ]
  );

  const firstLocation = routeSnapshot(
    snapshot,
    "GET",
    `/inscriptions/${encodeURIComponent("tx-transfer-a:i0:n0")}/location`
  );
  const secondLocation = routeSnapshot(
    snapshot,
    "GET",
    `/inscriptions/${encodeURIComponent("tx-transfer-b:i0:n0")}/location`
  );
  assert.equal(firstLocation.body.currentOutpoint, "tx-sweep:0");
  assert.equal(secondLocation.body.currentOutpoint, "tx-sweep:3");
  assert.equal(firstLocation.body.currentOwnerAddress, "prl1buyer");
  assert.equal(secondLocation.body.currentOwnerAddress, "prl1buyer");
});

test("generated fixture confirms indexer propagates the PRLS total mint cap", () => {
  const fixture = makeSupplyCapFixture();
  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.equal(snapshot.token.mintedSupply, "2100000000");
  assert.equal(snapshot.token.mintCount, 21000);
  assert.equal(snapshot.operations.at(-1).valid, false);
  assert.equal(snapshot.operations.at(-1).invalidReason, "TOTAL_MINT_COUNT_REACHED");
});

test("real Pearl simnet reveal witness is parsed from raw transaction bytes", () => {
  const fixture = loadFixture(realSimnetFixturePath);
  const revealTx = fixture.blocks[1].transactions[0];
  const inscriptions = extractTaprootInscriptionsFromRawTxHex(revealTx.rawTxHex, revealTx);

  assert.equal(inscriptions.length, 1);
  assert.equal(inscriptions[0].source, "raw-pearl-witness");
  assert.equal(
    inscriptions[0].body,
    "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}"
  );

  const snapshot = ingestPearlBlocksFixture(fixture);
  assert.equal(snapshot.token.deployed, true);
  assert.equal(snapshot.token.mintedSupply, "0");
  assert.equal(snapshot.token.mintCount, 0);
  assert.equal(snapshot.operations[1].source, "raw-pearl-witness");
  assert.equal(snapshot.operations[1].valid, false);
  assert.equal(snapshot.operations[1].invalidReason, "MISSING_REQUIRED_MINT_FEE");
  assert.equal(
    snapshot.operations[1].txid,
    "4ce09eb37a2022e586b5a8a1ec764eba49313b9b5f2bc9f05f55541c7e82c9b0"
  );
  assert.equal(
    snapshot.operations[1].ownerScriptPubKey,
    "51209d331cd4b7407636134b328bc0bf4886d1d9006847bb0fa7e5b79b5abed2bae1"
  );
});

test("legacy 0.5 PRL Pearl raw blocks prove the witness but no longer index the mint", () => {
  const fixture = loadFixture(realDeployMintFixturePath);
  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.deepEqual(
    fixture.proof.operations.map((operation) => [
      operation.name,
      operation.commitAllowed,
      operation.revealAllowed
    ]),
    [
      ["deploy", true, true],
      ["mint", true, true]
    ]
  );
  assert.equal(snapshot.network.chain, "pearl-simnet");
  assert.equal(snapshot.token.deployed, true);
  assert.equal(snapshot.token.maxSupply, "2100000000");
  assert.equal(snapshot.token.mintLimit, "100000");
  assert.equal(snapshot.token.decimals, 18);
  assert.equal(snapshot.token.mintedSupply, "0");
  assert.equal(snapshot.token.mintCount, 0);

  assert.equal(snapshot.operations.length, 2);
  assert.deepEqual(
    snapshot.operations.map((operation) => [
      operation.op,
      operation.source,
      operation.valid,
      operation.invalidReason
    ]),
    [
      ["deploy", "raw-pearl-witness", true, null],
      ["mint", "raw-pearl-witness", false, "INSUFFICIENT_REQUIRED_MINT_FEE"]
    ]
  );
  assert.equal(
    snapshot.operations[0].txid,
    "d5604fce66a5b8198e414790580daef709c31b91c2c58d7b0975ec6e804c347c"
  );
  assert.equal(
    snapshot.operations[1].txid,
    "17087261b5412b1d74eb2afc04e8181d70a88142b8ae4130879e1744c5ee4507"
  );
  assert.equal(snapshot.operations[1].ownerAddress, fixture.proof.owner.address);
  assert.equal(snapshot.operations[1].ownerScriptPubKey, fixture.proof.owner.scriptPubKey);
  assert.equal(snapshot.operations[1].requiredMintFeeGrain, "100000000");
  assert.equal(snapshot.operations[1].paidMintFeeGrain, "50000000");

  const mintReveal = fixture.blocks[1].rawtx.find((tx) => tx.txid === snapshot.operations[1].txid);
  assert.equal(mintReveal.vout[1].scriptPubKey.address, fixture.proof.mintFee.address);
  assert.equal(mintReveal.vout[1].scriptPubKey.hex, "512090bafa55925cb426fa51b50305014e5f21160cf20bf6ad53a7eac88458631ef2");
  assert.equal(mintReveal.vout[1].value, 0.5);
});

test("legacy half-PRL fee mint fixture proves carrier bytes but rejects the 0.5 PRL mint fee", () => {
  const fixture = loadFixture(legacyHalfPrlMintFixturePath);
  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.deepEqual(
    fixture.proof.operations.map((operation) => [
      operation.name,
      operation.commitAllowed,
      operation.revealAllowed
    ]),
    [
      ["deploy", true, true],
      ["mint", true, true]
    ]
  );

  assert.equal(snapshot.network.source, "legacy-half-prl-browser-flow");
  assert.equal(snapshot.token.deployed, true);
  assert.equal(snapshot.token.mintedSupply, "0");
  assert.equal(snapshot.token.mintCount, 0);
  assert.deepEqual(
    snapshot.operations.map((operation) => [
      operation.op,
      operation.txid,
      operation.valid,
      operation.invalidReason
    ]),
    [
      [
        "deploy",
        "67eb87d66e6cba8ca2d6a11b8316fa279b23b025086ecf07111f79762aeec453",
        true,
        null
      ],
      [
        "mint",
        "54b0f234d6ca4adf6853bba426005f5529392ba6ea916079a168d478fa9ea051",
        false,
        "INSUFFICIENT_REQUIRED_MINT_FEE"
      ]
    ]
  );
  assert.equal(snapshot.operations[1].ownerAddress, fixture.proof.owner.address);
  assert.equal(snapshot.operations[1].ownerScriptPubKey, fixture.proof.owner.scriptPubKey);
  assert.equal(snapshot.operations[1].paidMintFeeGrain, "50000000");

  const mintReveal = fixture.blocks[1].rawtx.find((tx) => tx.txid === snapshot.operations[1].txid);
  assert.equal(mintReveal.vout[1].scriptPubKey.address, fixture.proof.mintFee.address);
  assert.equal(mintReveal.vout[1].value, 0.5);

  const inscriptions = extractTaprootInscriptionsFromRawTxHex(mintReveal.hex, mintReveal);
  assert.equal(inscriptions[0].body, "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}");
});

test("fresh browser mints with the required 1 PRL fee index as valid PRLS supply", () => {
  const deployFixture = loadFixture(legacyHalfPrlMintFixturePath);
  const mintFixture = loadFixture(onePrlMintFixturePath);
  const deployRevealTxid = "67eb87d66e6cba8ca2d6a11b8316fa279b23b025086ecf07111f79762aeec453";
  const deployBlock = {
    height: deployFixture.blocks[0].height,
    hash: deployFixture.blocks[0].hash,
    rawtx: deployFixture.blocks[0].rawtx.filter((tx) => tx.txid === deployRevealTxid)
  };
  const fixture = {
    ...mintFixture,
    blocks: [deployBlock, ...mintFixture.blocks]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.equal(snapshot.network.source, "one-prl-browser-mints");
  assert.equal(snapshot.token.deployed, true);
  assert.equal(snapshot.token.mintedSupply, "200000");
  assert.equal(snapshot.token.mintCount, 2);
  assert.deepEqual(
    snapshot.operations.map((operation) => [
      operation.op,
      operation.valid,
      operation.invalidReason,
      operation.paidMintFeeGrain
    ]),
    [
      ["deploy", true, null, "0"],
      ["mint", true, null, "100000000"],
      ["mint", true, null, "100000000"]
    ]
  );

  for (const mintOperation of snapshot.operations.slice(1)) {
    assert.equal(mintOperation.source, "raw-pearl-witness");
    assert.equal(mintOperation.ownerAddress, mintFixture.proof.owner.address);
    assert.equal(mintOperation.ownerScriptPubKey, mintFixture.proof.owner.scriptPubKey);
    assert.equal(mintOperation.mintFeePaid, true);
  }

  const firstMintReveal = mintFixture.blocks[0].rawtx[0];
  assert.equal(firstMintReveal.vout[1].scriptPubKey.address, mintFixture.proof.mintFee.address);
  assert.equal(firstMintReveal.vout[1].value, 1);

  const inscriptions = extractTaprootInscriptionsFromRawTxHex(firstMintReveal.hex, firstMintReveal);
  assert.equal(inscriptions.length, 1);
  assert.equal(inscriptions[0].body, "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}");
});

test("PRLS mint fee is consumed per mint inscription in a transaction", () => {
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-fee-block",
        transactions: [
          tx(
            "tx-deploy",
            "prl1deployer",
            "5120deployer",
            "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
          ),
          multiMintTx("tx-two-mints-one-fee", "prl1alice", "5120alice", 2, ["1.00000000"]),
          multiMintTx("tx-two-mints-two-fees", "prl1bob", "5120bob", 2, ["2.00000000"])
        ]
      }
    ]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.equal(snapshot.token.mintedSupply, "300000");
  assert.equal(snapshot.token.mintCount, 3);
  assert.deepEqual(
    snapshot.operations.map((operation) => [
      operation.txid,
      operation.op,
      operation.valid,
      operation.invalidReason,
      operation.paidMintFeeGrain
    ]),
    [
      ["tx-deploy", "deploy", true, null, "0"],
      ["tx-two-mints-one-fee", "mint", true, null, "100000000"],
      ["tx-two-mints-one-fee", "mint", false, "MISSING_REQUIRED_MINT_FEE", "0"],
      ["tx-two-mints-two-fees", "mint", true, null, "100000000"],
      ["tx-two-mints-two-fees", "mint", true, null, "100000000"]
    ]
  );
});

test("invalid PRLS mints do not consume fee budget for later valid mints", () => {
  const mint = "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}";
  const deploy =
    "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}";
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-invalid-mint-fee-block",
        transactions: [
          {
            txid: "tx-invalid-before-valid-one-fee",
            inputs: [
              { witness: prl20Witness(mint) },
              { witness: prl20Witness(deploy) },
              { witness: prl20Witness(mint) }
            ],
            outputs: [
              {
                address: "prl1alice",
                scriptPubKey: "5120alice",
                valuePrl: "0.00000546"
              },
              mintFeeOutput()
            ]
          }
        ]
      }
    ]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.equal(snapshot.token.mintedSupply, "100000");
  assert.equal(snapshot.token.mintCount, 1);
  assert.deepEqual(
    snapshot.operations.map((operation) => [
      operation.op,
      operation.valid,
      operation.invalidReason,
      operation.paidMintFeeGrain
    ]),
    [
      ["mint", false, "TOKEN_NOT_DEPLOYED", "0"],
      ["deploy", true, null, "0"],
      ["mint", true, null, "100000000"]
    ]
  );
});

test("raw same-leaf PRLS batch mints consume one required fee per envelope", () => {
  const deploy =
    "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}";
  const mint = "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}";
  const rawTxHex = rawTxWithWitness([
    Buffer.alloc(64, 1),
    Buffer.concat([envelopeScript(mint), envelopeScript(mint)]),
    taprootControlBlock()
  ]);
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-raw-same-leaf-fee-block",
        transactions: [
          tx("tx-deploy", "prl1deployer", "5120deployer", deploy),
          {
            txid: "tx-raw-two-mints-one-fee",
            rawTxHex,
            outputs: [
              {
                address: "prl1alice",
                scriptPubKey: "5120alice",
                valuePrl: "0.00000546"
              },
              mintFeeOutput()
            ]
          }
        ]
      }
    ]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.equal(snapshot.token.mintedSupply, "100000");
  assert.equal(snapshot.token.mintCount, 1);
  assert.deepEqual(
    snapshot.operations.map((operation) => [
      operation.txid,
      operation.op,
      operation.valid,
      operation.invalidReason,
      operation.paidMintFeeGrain,
      operation.inscriptionIndex
    ]),
    [
      ["tx-deploy", "deploy", true, null, "0", 0],
      ["tx-raw-two-mints-one-fee", "mint", true, null, "100000000", 0],
      ["tx-raw-two-mints-one-fee", "mint", false, "MISSING_REQUIRED_MINT_FEE", "0", 1]
    ]
  );
});

test("raw witness parser ignores envelope-like bytes outside the executed tapscript leaf", () => {
  const fakeEnvelope = envelopeScript("not the tapscript");
  const noEnvelopeScript = Buffer.from([0x51]);
  const rawTxHex = rawTxWithWitness([fakeEnvelope, noEnvelopeScript, taprootControlBlock()]);

  const inscriptions = extractTaprootInscriptionsFromRawTxHex(rawTxHex, {
    txid: "raw-non-script-envelope"
  });

  assert.equal(inscriptions.length, 0);
});

test("raw witness parser rejects fake taproot control blocks", () => {
  const rawTxHex = rawTxWithWitness([
    Buffer.alloc(64, 1),
    envelopeScript("{\"name\":\"fake control block\"}", "pearlscription", "application/json"),
    Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 3)])
  ]);

  const inscriptions = extractTaprootInscriptionsFromRawTxHex(rawTxHex, {
    txid: "raw-fake-control-block"
  });

  assert.equal(inscriptions.length, 0);
});

test("raw witness parser indexes all envelopes from the executed tapscript leaf in order", () => {
  const first = "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}";
  const second = "{\"name\":\"second envelope\"}";
  const rawTxHex = rawTxWithWitness([
    Buffer.alloc(64, 1),
    Buffer.concat([
      envelopeScript(first, "prl-20", "application/json"),
      envelopeScript(second, "pearlscription", "application/json")
    ]),
    taprootControlBlock()
  ]);

  const inscriptions = extractTaprootInscriptionsFromRawTxHex(rawTxHex, {
    txid: "raw-multi-envelope"
  });

  assert.equal(inscriptions.length, 2);
  assert.equal(inscriptions[0].body, first);
  assert.equal(inscriptions[0].inscriptionIndex, 0);
  assert.equal(inscriptions[1].body, second);
  assert.equal(inscriptions[1].protocolMarker, "pearlscription");
  assert.equal(inscriptions[1].inscriptionIndex, 1);
});

test("raw witness parser reconstructs chunked large inscription bodies", () => {
  const body = Buffer.alloc(18_853);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = index % 251;
  }
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += 520) {
    chunks.push(body.subarray(offset, offset + 520));
  }
  const rawTxHex = rawTxWithWitness([
    Buffer.alloc(64, 1),
    envelopeScriptFromChunks(chunks, "pearlscription", "image/png"),
    taprootControlBlock()
  ]);

  const inscriptions = extractTaprootInscriptionsFromRawTxHex(rawTxHex, {
    txid: "raw-chunked-image-body"
  });

  assert.equal(inscriptions.length, 1);
  assert.equal(inscriptions[0].protocolMarker, "pearlscription");
  assert.equal(inscriptions[0].contentType, "image/png");
  assert.equal(inscriptions[0].byteLength, body.length);
  assert.equal(inscriptions[0].bodyHex, body.toString("hex"));
});

test("raw witness parser uses input-local envelope indices", () => {
  const first = "{\"name\":\"input zero\"}";
  const second = "{\"name\":\"input one\"}";
  const rawTxHex = rawTxWithWitnessStacks([
    [
      Buffer.alloc(64, 1),
      envelopeScript(first, "pearlscription", "application/json"),
      taprootControlBlock()
    ],
    [
      Buffer.alloc(64, 2),
      envelopeScript(second, "pearlscription", "application/json"),
      taprootControlBlock()
    ]
  ]);

  const inscriptions = extractTaprootInscriptionsFromRawTxHex(rawTxHex, {
    txid: "raw-multi-input-local-index"
  });

  assert.equal(inscriptions.length, 2);
  assert.deepEqual(
    inscriptions.map((inscription) => [
      inscription.inputIndex,
      inscription.inscriptionIndex,
      inscription.body
    ]),
    [
      [0, 0, first],
      [1, 0, second]
    ]
  );
});

test("mock inscription ids use input-local indices while numbers remain canonical", () => {
  const fixture = {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-input-local-id-block",
        transactions: [
          {
            txid: "tx-multi-input-mock",
            inputs: [
              {
                witness: [
                  "OP_FALSE",
                  "OP_IF",
                  "pearlscription",
                  "application/json",
                  "0x00",
                  "{\"name\":\"input zero\"}",
                  "OP_ENDIF"
                ]
              },
              {
                witness: [
                  "OP_FALSE",
                  "OP_IF",
                  "pearlscription",
                  "application/json",
                  "0x00",
                  "{\"name\":\"input one\"}",
                  "OP_ENDIF"
                ]
              }
            ],
            outputs: [
              {
                address: "prl1alice",
                scriptPubKey: "5120alice",
                valuePrl: "0.00000546"
              }
            ]
          }
        ]
      }
    ]
  };

  const snapshot = ingestPearlBlocksFixture(fixture);

  assert.deepEqual(
    snapshot.inscriptions.map((inscription) => [
      inscription.id,
      inscription.inputIndex,
      inscription.inscriptionIndex,
      inscription.inscriptionNumber
    ]),
    [
      ["tx-multi-input-mock:i0:n0", 0, 0, 0],
      ["tx-multi-input-mock:i1:n0", 1, 0, 1]
    ]
  );
});

test("raw witness parser rejects empty marker or content type envelopes", () => {
  for (const script of [
    envelopeScript("{\"name\":\"bad marker\"}", "", "application/json"),
    envelopeScript("{\"name\":\"bad content type\"}", "pearlscription", "")
  ]) {
    const rawTxHex = rawTxWithWitness([
      Buffer.alloc(64, 1),
      script,
      taprootControlBlock()
    ]);

    const inscriptions = extractTaprootInscriptionsFromRawTxHex(rawTxHex, {
      txid: "raw-empty-envelope-field"
    });

    assert.equal(inscriptions.length, 0);
  }
});

test("raw witness parser rejects malformed marker and content-type bytes without dropping later valid envelopes", () => {
  const malformedMarker = envelopeScriptFromBytes(
    Buffer.from("{\"name\":\"bad marker\"}", "utf8"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("application/json", "utf8")
  );
  const controlCharMarker = envelopeScript("{\"name\":\"bad control\"}", "bad\nmarker", "application/json");
  const oversizedContentType = envelopeScriptFromBytes(
    Buffer.from("{\"name\":\"bad content type\"}", "utf8"),
    Buffer.from("pearlscription", "utf8"),
    Buffer.alloc(121, 0x61)
  );
  const validBody = "{\"name\":\"still valid\"}";
  const rawTxHex = rawTxWithWitness([
    Buffer.alloc(64, 1),
    Buffer.concat([
      malformedMarker,
      controlCharMarker,
      oversizedContentType,
      envelopeScript(validBody, "pearlscription", "application/json")
    ]),
    taprootControlBlock()
  ]);

  const inscriptions = extractTaprootInscriptionsFromRawTxHex(rawTxHex, {
    txid: "raw-malformed-envelope-text"
  });

  assert.equal(inscriptions.length, 1);
  assert.equal(inscriptions[0].body, validBody);
  assert.equal(inscriptions[0].inscriptionIndex, 0);
});

function makeSupplyCapFixture() {
  const transactions = [
    tx(
      "tx-deploy",
      "prl1deployer",
      "5120deployer",
      "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
    )
  ];

  for (let index = 0; index < 21001; index += 1) {
    transactions.push(
      tx(
        `tx-mint-${index}`,
        "prl1alice",
        "5120alice",
        "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}"
      )
    );
  }

  return {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-cap-block",
        previousHash: "mock-genesis",
        transactions
      }
    ]
  };
}

function makeGenericPearlscriptionFixture() {
  return {
    network: { chain: "pearl-mock" },
    blocks: [
      {
        height: 1,
        hash: "mock-generic-block",
        previousHash: "mock-genesis",
        transactions: [
          tx(
            "tx-deploy",
            "prl1deployer",
            "5120deployer",
            "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
          ),
          genericTx(
            "tx-text",
            "prl1artist",
            "5120artist",
            "pearlscription",
            "text/plain;charset=utf-8",
            "hello from pearl simnet"
          ),
          genericTx(
            "tx-png",
            "prl1artist",
            "5120artist",
            "pearlscription",
            "image/png",
            { hex: "89504e470d0a1a0a" }
          ),
          genericTx(
            "tx-json",
            "prl1artist",
            "5120artist",
            "pearl-collection",
            "application/json",
            "{\"name\":\"Simnet collection\"}"
          ),
          {
            txid: "tx-incomplete",
            inputs: [
              {
                witness: [
                  "OP_FALSE",
                  "OP_IF",
                  "pearlscription",
                  "image/png",
                  "0x00",
                  { hex: "89504e47" }
                ]
              }
            ],
            outputs: [
              {
                address: "prl1artist",
                scriptPubKey: "5120artist",
                valuePrl: "0.00000546"
              }
            ]
          }
        ]
      }
    ]
  };
}

function makeInscriptionMovementFixture() {
  return {
    network: { chain: "pearl-mock", bestHeight: 2 },
    blocks: [
      {
        height: 1,
        hash: "mock-inscription-move-block-1",
        previousHash: "mock-genesis",
        transactions: [
          genericTx(
            "tx-text",
            "prl1artist",
            "5120artist",
            "pearlscription",
            "text/plain;charset=utf-8",
            "sale pearl"
          )
        ]
      },
      {
        height: 2,
        hash: "mock-inscription-move-block-2",
        previousHash: "mock-inscription-move-block-1",
        transactions: [
          spendInscriptionTx("tx-move-text", "tx-text", 0, "prl1buyer", "5120buyer", "prl1artist", "5120artist", "1.25000000")
        ]
      }
    ]
  };
}

function makePrl20TransferLotFillFixture() {
  return {
    network: { chain: "pearl-mock", bestHeight: 2 },
    blocks: [
      {
        height: 1,
        hash: "mock-prl20-transfer-lot-block-1",
        previousHash: "mock-genesis",
        transactions: [
          tx(
            "tx-deploy",
            "prl1deployer",
            "5120deployer",
            "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
          ),
          tx(
            "tx-mint-alice-1",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}"
          ),
          tx(
            "tx-mint-alice-2",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}"
          ),
          tx(
            "tx-transfer-expensive",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"transfer\",\"tick\":\"prls\",\"amt\":\"100000\"}"
          ),
          tx(
            "tx-transfer-cheap",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"transfer\",\"tick\":\"prls\",\"amt\":\"100000\"}"
          )
        ]
      },
      {
        height: 2,
        hash: "mock-prl20-transfer-lot-block-2",
        previousHash: "mock-prl20-transfer-lot-block-1",
        transactions: [
          spendInscriptionTx("tx-move-cheap", "tx-transfer-cheap", 0, "prl1buyer", "5120buyer", "prl1alice", "5120alice", "1.00000000")
        ]
      }
    ]
  };
}

function makePrl20AmbiguousSweepFixture(options = {}) {
  const transferLotSweepStyle = Boolean(options.transferLotSweepStyle);
  return {
    network: { chain: "pearl-mock", bestHeight: 2 },
    blocks: [
      {
        height: 1,
        hash: "mock-prl20-ambiguous-sweep-block-1",
        previousHash: "mock-genesis",
        transactions: [
          tx(
            "tx-deploy",
            "prl1deployer",
            "5120deployer",
            "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"prls\",\"max\":\"2100000000\",\"lim\":\"100000\",\"dec\":\"18\"}"
          ),
          tx(
            "tx-mint-alice-1",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}"
          ),
          tx(
            "tx-mint-alice-2",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}"
          ),
          tx(
            "tx-transfer-a",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"transfer\",\"tick\":\"prls\",\"amt\":\"100000\"}"
          ),
          tx(
            "tx-transfer-b",
            "prl1alice",
            "5120alice",
            "{\"p\":\"prl-20\",\"op\":\"transfer\",\"tick\":\"prls\",\"amt\":\"100000\"}"
          )
        ]
      },
      {
        height: 2,
        hash: "mock-prl20-ambiguous-sweep-block-2",
        previousHash: "mock-prl20-ambiguous-sweep-block-1",
        transactions: [
          {
            txid: "tx-sweep",
            ...(options.inscriptionTransfers ? { inscriptionTransfers: options.inscriptionTransfers } : {}),
            inputs: transferLotSweepStyle
              ? [
                  { previousTxid: "tx-buyer-funding", previousVout: 0, witness: [] },
                  { previousTxid: "tx-transfer-a", previousVout: 0, witness: [] },
                  { previousTxid: "tx-transfer-b", previousVout: 0, witness: [] }
                ]
              : [
                  { previousTxid: "tx-transfer-a", previousVout: 0, witness: [] },
                  { previousTxid: "tx-transfer-b", previousVout: 0, witness: [] }
                ],
            outputs: transferLotSweepStyle
              ? [
                  {
                    address: "prl1buyer",
                    scriptPubKey: "5120buyer",
                    valuePrl: "0.00000546"
                  },
                  {
                    address: "prl1alice",
                    scriptPubKey: "5120alice",
                    valuePrl: "1.00000000"
                  },
                  {
                    address: "prl1alice",
                    scriptPubKey: "5120alice",
                    valuePrl: "1.10000000"
                  },
                  {
                    address: "prl1buyer",
                    scriptPubKey: "5120buyer",
                    valuePrl: "0.00000546"
                  }
                ]
              : [
                  {
                    address: "prl1buyerA",
                    scriptPubKey: "5120buyerA",
                    valuePrl: "0.00000546"
                  },
                  {
                    address: "prl1buyerB",
                    scriptPubKey: "5120buyerB",
                    valuePrl: "0.00000546"
                  }
                ]
          }
        ]
      }
    ]
  };
}

function tx(txid, address, scriptPubKey, body) {
  const isMint = body.includes("\"op\":\"mint\"");
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
      }
    ].concat(
      isMint
        ? [
            {
              address: "rprl1pjza054vjtj6zd7j3k5ps2q2wtus3vr8jp0m265a8atyggkrrrmeqehah68",
              scriptPubKey:
                "512090bafa55925cb426fa51b50305014e5f21160cf20bf6ad53a7eac88458631ef2",
              valuePrl: "1.00000000"
            }
          ]
        : []
    )
  };
}

function multiMintTx(txid, address, scriptPubKey, mintCount, feeValuesPrl) {
  const mintWitness = [
    "OP_FALSE",
    "OP_IF",
    "prl-20",
    "application/json",
    "0x00",
    "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls\",\"amt\":\"100000\"}",
    "OP_ENDIF"
  ];
  return {
    txid,
    inputs: Array.from({ length: mintCount }, () => ({ witness: mintWitness })),
    outputs: [
      {
        address,
        scriptPubKey,
        valuePrl: "0.00000546"
      },
      ...feeValuesPrl.map((valuePrl, index) => ({
        address: "rprl1pjza054vjtj6zd7j3k5ps2q2wtus3vr8jp0m265a8atyggkrrrmeqehah68",
        scriptPubKey:
          index % 2 === 0
            ? "512090bafa55925cb426fa51b50305014e5f21160cf20bf6ad53a7eac88458631ef2"
            : undefined,
        valuePrl
      }))
    ]
  };
}

function prl20Witness(body) {
  return ["OP_FALSE", "OP_IF", "prl-20", "application/json", "0x00", body, "OP_ENDIF"];
}

function mintFeeOutput(valuePrl = "1.00000000") {
  return {
    address: "rprl1pjza054vjtj6zd7j3k5ps2q2wtus3vr8jp0m265a8atyggkrrrmeqehah68",
    scriptPubKey: "512090bafa55925cb426fa51b50305014e5f21160cf20bf6ad53a7eac88458631ef2",
    valuePrl
  };
}

function rawTxWithWitness(witnessItems) {
  return rawTxWithWitnessStacks([witnessItems]);
}

function rawTxWithWitnessStacks(witnessStacks) {
  const outputScript = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 2)]);
  const outputValue = Buffer.alloc(8);
  outputValue.writeBigInt64LE(546n);
  return Buffer.concat([
    uint32LE(1),
    Buffer.from([0x00, 0x01]),
    varInt(witnessStacks.length),
    ...witnessStacks.map((_, index) =>
      Buffer.concat([
        Buffer.alloc(32, index),
        uint32LE(index),
        varBytes(Buffer.alloc(0)),
        uint32LE(0xffffffff)
      ])
    ),
    varInt(1),
    outputValue,
    varBytes(outputScript),
    ...witnessStacks.flatMap((witnessItems) => [
      varInt(witnessItems.length),
      ...witnessItems.map(varBytes)
    ]),
    uint32LE(0)
  ]).toString("hex");
}

function envelopeScript(body, marker = "prl-20", contentType = "application/json") {
  return envelopeScriptFromBytes(
    Buffer.from(body, "utf8"),
    Buffer.from(marker, "utf8"),
    Buffer.from(contentType, "utf8")
  );
}

function envelopeScriptFromBytes(bodyBytes, markerBytes, contentTypeBytes) {
  return Buffer.concat([
    Buffer.from([0x00, 0x63]),
    pushData(markerBytes),
    pushData(contentTypeBytes),
    Buffer.from([0x00]),
    pushData(bodyBytes),
    Buffer.from([0x68])
  ]);
}

function envelopeScriptFromChunks(bodyChunks, marker, contentType) {
  return Buffer.concat([
    Buffer.from([0x00, 0x63]),
    pushData(Buffer.from(marker, "utf8")),
    pushData(Buffer.from(contentType, "utf8")),
    Buffer.from([0x00]),
    ...bodyChunks.map(pushData),
    Buffer.from([0x68])
  ]);
}

function taprootControlBlock() {
  return Buffer.concat([Buffer.from([0xc0]), Buffer.alloc(32, 3)]);
}

function pushData(bytes) {
  if (bytes.length <= 0x4b) {
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  }
  if (bytes.length <= 0xff) {
    return Buffer.concat([Buffer.from([0x4c, bytes.length]), bytes]);
  }
  const length = Buffer.alloc(2);
  length.writeUInt16LE(bytes.length);
  return Buffer.concat([Buffer.from([0x4d]), length, bytes]);
}

function varBytes(bytes) {
  return Buffer.concat([varInt(bytes.length), bytes]);
}

function varInt(value) {
  if (value < 0xfd) {
    return Buffer.from([value]);
  }
  const buffer = Buffer.alloc(3);
  buffer[0] = 0xfd;
  buffer.writeUInt16LE(value, 1);
  return buffer;
}

function uint32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
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

function genericBatchTx(txid, address, scriptPubKey, envelopes) {
  return {
    txid,
    inputs: [
      {
        witness: envelopes.flatMap((envelope) => [
          "OP_FALSE",
          "OP_IF",
          envelope.marker,
          envelope.contentType,
          "0x00",
          envelope.body,
          "OP_ENDIF"
        ])
      }
    ],
    outputs: envelopes.map(() => ({
      address,
      scriptPubKey,
      valuePrl: "0.00000546"
    }))
  };
}

function genericMultiInputBatchTx(txid, address, scriptPubKey, envelopeGroups) {
  const envelopes = envelopeGroups.flat();
  return {
    txid,
    inputs: envelopeGroups.map((group) => ({
      witness: group.flatMap((envelope) => [
        "OP_FALSE",
        "OP_IF",
        envelope.marker,
        envelope.contentType,
        "0x00",
        envelope.body,
        "OP_ENDIF"
      ])
    })),
    outputs: envelopes.map(() => ({
      address,
      scriptPubKey,
      valuePrl: "0.00000546"
    }))
  };
}

function multiMintSameLeafTx(txid, address, scriptPubKey, payloads, feeOutputs = []) {
  return {
    txid,
    inputs: [
      {
        witness: payloads.flatMap((payload) => [
          "OP_FALSE",
          "OP_IF",
          "prl-20",
          "application/json",
          "0x00",
          payload,
          "OP_ENDIF"
        ])
      }
    ],
    outputs: [
      {
        address,
        scriptPubKey,
        valuePrl: "0.00000546"
      },
      ...feeOutputs
    ]
  };
}

function spendInscriptionTx(txid, inputTxid, inputVout, recipientAddress, recipientScriptPubKey, changeAddress, changeScriptPubKey, changeValuePrl) {
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
