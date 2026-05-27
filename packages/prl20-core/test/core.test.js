import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PRLS,
  applyPrl20Operation,
  createPrl20State,
  getAddressPrlsBalance,
  getPrlsToken,
  parsePrl20Operation,
  safeParsePrl20Operation
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(__dirname, "..", "fixtures");

function fixture(path) {
  return readFileSync(join(fixtureRoot, path), "utf8").trim();
}

function paidMintContext(context = {}) {
  return {
    ownerAddress: "prl1alice",
    requiredMintFeeGrain: PRLS.mintFeeGrain.toString(),
    paidMintFeeGrain: PRLS.mintFeeGrain.toString(),
    mintFeePaid: true,
    ...context
  };
}

test("valid PRLS deploy parses to canonical fixed token parameters", () => {
  const op = parsePrl20Operation(fixture("valid/deploy-prls.json"));

  assert.deepEqual(op, {
    p: "prl-20",
    op: "deploy",
    tick: "prls",
    max: "2100000000",
    lim: "100000",
    dec: 18,
    fairMint: true,
    totalMints: 21000
  });
});

test("valid PRLS mint accepts ticker case and canonicalizes to lowercase", () => {
  const op = parsePrl20Operation(fixture("valid/mint-prls-uppercase.json"));

  assert.equal(op.op, "mint");
  assert.equal(op.tick, "prls");
  assert.equal(op.amt, "100000");
});

test("ticker parsing canonicalizes ASCII tickers and rejects malformed values", () => {
  assert.equal(
    safeParsePrl20Operation(
      "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prls \",\"amt\":\"100000\"}"
    ).code,
    "INVALID_TICKER"
  );
  assert.equal(
    safeParsePrl20Operation(
      "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"prl\\u0073\",\"amt\":\"100000\"}"
    ).ok,
    true
  );
  assert.deepEqual(
    parsePrl20Operation(
      "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"PEARL\",\"amt\":\"250\"}"
    ),
    {
      p: "prl-20",
      op: "mint",
      tick: "pearl",
      amt: "250"
    }
  );
});

test("invalid JSON and duplicate top-level fields are rejected deterministically", () => {
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/malformed-json.txt")).code,
    "MALFORMED_JSON"
  );
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/mint-duplicate-field.json")).code,
    "DUPLICATE_FIELD"
  );
  assert.equal(
    safeParsePrl20Operation("{\"\\uZZZZ\":\"bad\"}").code,
    "MALFORMED_JSON"
  );
});

test("numeric fields must be canonical strings", () => {
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/deploy-numeric-max.json")).code,
    "FIELD_MUST_BE_STRING"
  );
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/mint-decimal.json")).code,
    "INVALID_NUMERIC_STRING"
  );
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/mint-negative.json")).code,
    "INVALID_NUMERIC_STRING"
  );
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/mint-leading-zero.json")).code,
    "INVALID_NUMERIC_STRING"
  );
});

test("PRLS deploy and mint validation enforces fixed parameters", () => {
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/deploy-wrong-max.json")).code,
    "INVALID_PRLS_MAX_SUPPLY"
  );
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/deploy-extra-field.json")).code,
    "UNKNOWN_FIELD"
  );
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/mint-over-limit.json")).code,
    "INVALID_PRLS_MINT_AMOUNT"
  );
  assert.equal(
    safeParsePrl20Operation(fixture("invalid/mint-partial.json")).code,
    "INVALID_PRLS_MINT_AMOUNT"
  );
});

test("generic PRL-20 deploy and mint are open and do not require protocol fee", () => {
  const deploy = parsePrl20Operation(
    "{\"p\":\"prl-20\",\"op\":\"deploy\",\"tick\":\"PEARL\",\"max\":\"21000000\",\"lim\":\"1000\",\"dec\":\"8\"}"
  );
  const mint = parsePrl20Operation(
    "{\"p\":\"prl-20\",\"op\":\"mint\",\"tick\":\"pearl\",\"amt\":\"1000\"}"
  );
  let state = createPrl20State();

  state = applyPrl20Operation(state, deploy, {
    inscriptionId: "deploy:pearl",
    ownerAddress: "prl1deployer"
  }).state;
  const result = applyPrl20Operation(state, mint, {
    inscriptionId: "mint:pearl:0",
    ownerAddress: "prl1alice"
  });

  assert.equal(deploy.tick, "pearl");
  assert.equal(deploy.totalMints, 21000);
  assert.equal(result.operation.valid, true);
  assert.equal(result.operation.mintFeeRequired, false);
  assert.equal(result.operation.requiredMintFeeGrain, null);
  assert.equal(result.state.tokens.pearl.mintedSupply, "1000");
  assert.equal(result.state.balances.prl1alice.pearl, "1000");
});

test("state transition requires deploy before mint and rejects duplicate deploy", () => {
  const deploy = parsePrl20Operation(fixture("valid/deploy-prls.json"));
  const mint = parsePrl20Operation(fixture("valid/mint-prls.json"));

  let state = createPrl20State();
  let result = applyPrl20Operation(state, mint, { ownerAddress: "prl1alice" });
  assert.equal(result.operation.valid, false);
  assert.equal(result.operation.invalidReason, "TOKEN_NOT_DEPLOYED");

  result = applyPrl20Operation(state, deploy, { ownerAddress: "prl1deployer" });
  state = result.state;
  assert.equal(result.operation.valid, true);

  result = applyPrl20Operation(state, deploy, { ownerAddress: "prl1other" });
  assert.equal(result.operation.valid, false);
  assert.equal(result.operation.invalidReason, "DEPLOY_ALREADY_EXISTS");
});

test("state transition rejects deployed mints without the required 1 PRL fee", () => {
  const deploy = parsePrl20Operation(fixture("valid/deploy-prls.json"));
  const mint = parsePrl20Operation(fixture("valid/mint-prls.json"));
  let state = createPrl20State();

  state = applyPrl20Operation(state, deploy, {
    inscriptionId: "deploy:0",
    ownerAddress: "prl1deployer"
  }).state;

  const missingFee = applyPrl20Operation(state, mint, { ownerAddress: "prl1alice" });
  assert.equal(missingFee.operation.valid, false);
  assert.equal(missingFee.operation.invalidReason, "MISSING_REQUIRED_MINT_FEE");

  const shortFee = applyPrl20Operation(state, mint, {
    ownerAddress: "prl1alice",
    paidMintFeeGrain: "50000000"
  });
  assert.equal(shortFee.operation.valid, false);
  assert.equal(shortFee.operation.invalidReason, "INSUFFICIENT_REQUIRED_MINT_FEE");
  assert.equal(getAddressPrlsBalance(shortFee.state, "prl1alice"), "0");
});

test("state transition credits balances and enforces the 21000 mint supply cap", () => {
  const deploy = parsePrl20Operation(fixture("valid/deploy-prls.json"));
  const mint = parsePrl20Operation(fixture("valid/mint-prls.json"));
  let state = createPrl20State();

  state = applyPrl20Operation(state, deploy, {
    inscriptionId: "deploy:0",
    ownerAddress: "prl1deployer"
  }).state;

  for (let index = 0; index < PRLS.totalMints; index += 1) {
    const ownerAddress = index % 2 === 0 ? "prl1alice" : "prl1bob";
    const result = applyPrl20Operation(state, mint, paidMintContext({
      inscriptionId: `mint:${index}`,
      ownerAddress
    }));
    assert.equal(result.operation.valid, true);
    state = result.state;
  }

  const token = getPrlsToken(state);
  assert.equal(token.mintedSupply, "2100000000");
  assert.equal(token.mintCount, 21000);
  assert.equal(getAddressPrlsBalance(state, "prl1alice"), "1050000000");
  assert.equal(getAddressPrlsBalance(state, "prl1bob"), "1050000000");

  const capped = applyPrl20Operation(state, mint, paidMintContext({
    inscriptionId: "mint:21000",
    ownerAddress: "prl1late"
  }));
  assert.equal(capped.operation.valid, false);
  assert.equal(capped.operation.invalidReason, "TOTAL_MINT_COUNT_REACHED");
  assert.equal(getAddressPrlsBalance(capped.state, "prl1late"), "0");
});

test("transfer inscriptions debit available balance and create transferable lots", () => {
  const deploy = parsePrl20Operation(fixture("valid/deploy-prls.json"));
  const mint = parsePrl20Operation(fixture("valid/mint-prls.json"));
  const transfer = parsePrl20Operation(
    "{\"p\":\"prl-20\",\"op\":\"transfer\",\"tick\":\"PRLS\",\"amt\":\"25000\"}"
  );
  let state = createPrl20State();

  state = applyPrl20Operation(state, deploy, {
    inscriptionId: "deploy:0",
    ownerAddress: "prl1deployer"
  }).state;
  state = applyPrl20Operation(state, mint, paidMintContext({
    inscriptionId: "mint:0",
    ownerAddress: "prl1alice"
  })).state;

  const result = applyPrl20Operation(state, transfer, {
    inscriptionId: "transfer:0",
    txid: "transfer",
    ownerAddress: "prl1alice",
    ownerOutpoint: "transfer:0"
  });

  assert.equal(result.operation.valid, true);
  assert.equal(getAddressPrlsBalance(result.state, "prl1alice"), "75000");
  assert.deepEqual(result.state.transferLots["transfer:0"], {
    id: "transfer:0",
    inscriptionId: "transfer:0",
    txid: "transfer",
    blockHeight: null,
    inscriptionNumber: null,
    ticker: "prls",
    displayTicker: "PRLS",
    amount: "25000",
    originalOwnerAddress: "prl1alice",
    originalOwnerScriptPubKey: null,
    originalOwnerKey: "prl1alice",
    originalOutpoint: "transfer:0",
    status: "transferable"
  });
});

test("transfer inscriptions require existing available PRLS balance", () => {
  const deploy = parsePrl20Operation(fixture("valid/deploy-prls.json"));
  const transfer = parsePrl20Operation(
    "{\"p\":\"prl-20\",\"op\":\"transfer\",\"tick\":\"prls\",\"amt\":\"1\"}"
  );
  let state = createPrl20State();

  state = applyPrl20Operation(state, deploy, {
    inscriptionId: "deploy:0",
    ownerAddress: "prl1deployer"
  }).state;

  const result = applyPrl20Operation(state, transfer, {
    inscriptionId: "transfer:0",
    ownerAddress: "prl1alice"
  });

  assert.equal(result.operation.valid, false);
  assert.equal(result.operation.invalidReason, "INSUFFICIENT_PRL20_BALANCE");
  assert.equal(result.state.transferLots["transfer:0"], undefined);
});
