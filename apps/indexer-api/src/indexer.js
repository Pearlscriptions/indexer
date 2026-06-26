import { readFileSync } from "node:fs";
import {
  PRLS,
  applyPrl20Operation,
  createPrl20State,
  getAddressTokenBalances,
  getPrl20Token,
  getPrlsToken,
  isMintFeeEligible,
  safeParsePrl20Operation
} from "../../../packages/prl20-core/src/index.js";

export const PRLS_MINT_FEE_POLICY = Object.freeze({
  required: true,
  valueGrain: PRLS.mintFeeGrain.toString(),
  valuePrl: PRLS.mintFeePrl,
  address: "rprl1pjza054vjtj6zd7j3k5ps2q2wtus3vr8jp0m265a8atyggkrrrmeqehah68",
  scriptPubKey: "512090bafa55925cb426fa51b50305014e5f21160cf20bf6ad53a7eac88458631ef2"
});

export const PEARLSCRIPTION_DEFAULT_MARKER = "pearlscription";
export const SKIP_UTXO_MAP = Symbol.for("prl20.skipUtxoMap");
const DEFAULT_PAGE_LIMIT = 48;
const MAX_PAGE_LIMIT = 100;
const MAX_PAGE_OFFSET = 50_000_000;

export function loadFixture(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// PRL-20 ingest session.
//
// Holds the forward-only fold accumulators (PRL-20 state, inscription records,
// and the transaction index) alive between applyBlock() calls so each new
// canonical block costs O(block) instead of forcing an O(history) rebuild from
// genesis. Blocks MUST be applied in strictly increasing, contiguous canonical
// order (the same order ingestPearlBlocksFixture sorts them into) for the result
// to stay digest-identical to a full rebuild. Reorg safety is the caller's job:
// on any rollback the caller must discard the session and rebuild from the
// canonical block set (see persistent-indexer.js rebuildSnapshot).
export function createPrl20IngestSession(options = {}) {
  const mintFeePolicy = normalizeMintFeePolicy(options.mintFeePolicy ?? {});
  let state = createPrl20State();
  const inscriptionsById = new Map();
  // Publish-time projections fold over these maps; growing them per block keeps
  // buildSnapshot a O(state) projection rather than an O(history) rebuild.
  const txStatus = {};
  const addressToScriptPubKey = {};
  const transactions = [];
  const outputsByOutpoint = {};
  const spendsByOutpoint = {};
  const readModelDelta = {
    inscriptions: new Set(),
    utxos: new Set()
  };

  function applyBlock(block) {
    const transactionList = normalizeBlockTransactions(block);
    for (let txIndex = 0; txIndex < transactionList.length; txIndex += 1) {
      const tx = transactionList[txIndex];

      // --- PRL-20 state fold (preserves the historical apply order) ---
      applyTransferLotFillsForTransaction(state, tx, { block, txIndex });
      const mintFeeAllocator = createMintFeeAllocator(tx.outputs ?? [], mintFeePolicy);
      const inscriptions = tx.rawTxHex
        ? extractTaprootInscriptionsFromRawTxHex(tx.rawTxHex, tx)
        : extractMockTaprootInscriptions(tx);
      for (const inscription of inscriptions) {
        const inscriptionRecord = buildInscriptionRecord({
          block,
          tx,
          txIndex,
          inscription,
          inscriptionNumber: inscriptionsById.size
        });
        inscriptionsById.set(inscriptionRecord.id, inscriptionRecord);
        readModelDelta.inscriptions.add(inscriptionRecord.id);
        touchReadModelOutpoint(inscriptionRecord.ownerOutpoint);

        if (!isPrl20Inscription(inscription)) {
          continue;
        }

        const context = {
          inscriptionId: inscriptionRecord.id,
          txid: tx.txid,
          blockHeight: block.height,
          txIndex,
          inscriptionIndex: inscription.inscriptionIndex,
          inscriptionNumber: inscriptionRecord.inscriptionNumber,
          protocolMarker: inscription.protocolMarker,
          contentType: inscription.contentType,
          ownerAddress: inscription.ownerAddress,
          ownerScriptPubKey: inscription.ownerScriptPubKey,
          ownerOutpoint: inscriptionRecord.ownerOutpoint,
          source: inscription.source ?? "mock-witness",
          mintFeeRequired: mintFeePolicy.required,
          requiredMintFeeGrain: mintFeePolicy.valueGrain,
          paidMintFeeGrain: "0",
          mintFeePaid: !mintFeePolicy.required,
          mintFeeAddress: mintFeePolicy.address,
          mintFeeScriptPubKey: mintFeePolicy.scriptPubKey
        };
        const parsed = safeParsePrl20Operation(inscription.body);
        context.mintFeeRequired =
          mintFeePolicy.required &&
          parsed.ok &&
          parsed.operation.op === "mint" &&
          parsed.operation.tick === PRLS.ticker;

        if (!parsed.ok) {
          state = appendInvalidOperation(state, {
            ...context,
            op: null,
            ticker: null,
            amount: null,
            valid: false,
            invalidReason: parsed.code,
            invalidMessage: parsed.message
          });
          continue;
        }

        if (
          parsed.operation.op === "mint" &&
          context.mintFeeRequired &&
          isMintFeeEligible(state, parsed.operation, context)
        ) {
          const mintFeePayment = mintFeeAllocator.allocate(mintFeePolicy.valueGrain);
          context.paidMintFeeGrain = mintFeePayment.paidGrain;
          context.mintFeePaid = mintFeePayment.paid;
        }

        state = applyPrl20Operation(state, parsed.operation, context).state;
      }

      // --- Transaction-index fold (mirrors the legacy buildTransactionIndex
      // inner body plus the txStatus / addressToScriptPubKey loop that the old
      // buildSnapshot recomputed from fixture.blocks). Applied in canonical
      // order, the produced arrays/maps are byte-identical to a rebuild. ---
      indexTransaction({ block, tx, txIndex });
    }
  }

  function indexTransaction({ block, tx, txIndex }) {
    txStatus[tx.txid] = {
      txid: tx.txid,
      status: "confirmed",
      blockHeight: block.height
    };
    for (const output of tx.outputs ?? []) {
      if (output.address && output.scriptPubKey) {
        addressToScriptPubKey[output.address] = output.scriptPubKey;
      }
    }

    const inputs = normalizeTransactionInputs(tx);
    const outputs = normalizeTransactionOutputs(tx);
    const coinbase = Boolean(tx.coinbase) || inputs.some((input) => input.coinbase !== undefined);
    const transaction = {
      txid: tx.txid,
      blockHeight: block.height ?? null,
      blockHash: block.hash ?? null,
      txIndex,
      order: transactionOrder(block.height, txIndex),
      coinbase,
      inputs,
      outputs,
      inscriptionTransfers: normalizeInscriptionTransfers(tx),
      inscriptionTransferOutputIndex:
        tx.inscriptionTransferOutputIndex === null || tx.inscriptionTransferOutputIndex === undefined
          ? null
          : Number(tx.inscriptionTransferOutputIndex),
      inscriptionOwnerOutputIndex:
        tx.inscriptionOwnerOutputIndex === null || tx.inscriptionOwnerOutputIndex === undefined
          ? null
          : Number(tx.inscriptionOwnerOutputIndex)
    };
    transactions.push(transaction);

    for (const output of outputs) {
      const outpoint = `${tx.txid}:${output.index}`;
      outputsByOutpoint[outpoint] = {
        txid: tx.txid,
        vout: output.index,
        blockHeight: block.height ?? null,
        txIndex,
        order: transaction.order,
        address: output.address ?? null,
        scriptPubKey: output.scriptPubKey ?? null,
        valueGrain: output.valueGrain ?? "0",
        valuePrl: output.valuePrl ?? grainToPrl(output.valueGrain ?? "0"),
        coinbase
      };
      touchReadModelOutpoint(outpoint);
    }

    for (const input of inputs) {
      if (!input.previousOutpoint || spendsByOutpoint[input.previousOutpoint]) {
        continue;
      }
      spendsByOutpoint[input.previousOutpoint] = {
        outpoint: input.previousOutpoint,
        txid: tx.txid,
        inputIndex: input.inputIndex,
        blockHeight: block.height ?? null,
        txIndex,
        order: transaction.order,
        inputs,
        outputs,
        inscriptionTransfers: transaction.inscriptionTransfers,
        inscriptionTransferOutputIndex: transaction.inscriptionTransferOutputIndex,
        inscriptionOwnerOutputIndex: transaction.inscriptionOwnerOutputIndex
      };
      touchReadModelOutpoint(input.previousOutpoint);
    }
  }

  function touchReadModelOutpoint(outpoint) {
    if (outpoint) {
      readModelDelta.utxos.add(String(outpoint));
    }
  }

  function consumeReadModelDelta() {
    const delta = {
      inscriptions: [...readModelDelta.inscriptions],
      utxos: [...readModelDelta.utxos]
    };
    readModelDelta.inscriptions.clear();
    readModelDelta.utxos.clear();
    return delta;
  }

  function buildSnapshot(networkMeta = {}) {
    const { network, prlBalances, utxos } = normalizeFixtureLikeNetworkMeta(networkMeta);
    return assembleSnapshot({
      state,
      mintFeePolicy,
      // Clone inscription records at publish: applyCurrentInscriptionLocations
      // (and downstream projections) mutate locationHistory / firstMove /
      // current* fields directly on them. Cloning keeps the accumulator records
      // pristine so a second buildSnapshot() on the same live session stays
      // deterministic (and digest-identical to a full re-fold).
      inscriptions: [...inscriptionsById.values()].map(cloneInscriptionRecord),
      txStatus: { ...txStatus },
      addressToScriptPubKey: { ...addressToScriptPubKey },
      transactions,
      outputsByOutpoint,
      spendsByOutpoint,
      network,
      prlBalances,
      utxos
    });
  }

  return {
    applyBlock,
    buildSnapshot,
    consumeReadModelDelta,
    get state() {
      return state;
    },
    get inscriptionCount() {
      return inscriptionsById.size;
    }
  };
}

export function ingestPearlBlocksFixture(fixture, options = {}) {
  const mintFeePolicy = normalizeMintFeePolicy(
    options.mintFeePolicy ?? fixture.prl20MintFee ?? fixture.network?.prl20MintFee
  );
  const session = createPrl20IngestSession({ mintFeePolicy });
  const blocks = [...(fixture.blocks ?? [])].sort((a, b) => a.height - b.height);
  for (const block of blocks) {
    session.applyBlock(block);
  }
  return session.buildSnapshot({
    network: fixture.network ?? { chain: "pearl-mock" },
    prlBalances: fixture.prlBalances ?? {},
    utxos: fixture.utxos ?? null
  });
}

// Accepts either a structured { network, prlBalances, utxos } meta object or a
// bare network object (back-compat with callers passing fixture.network alone).
function normalizeFixtureLikeNetworkMeta(meta = {}) {
  const hasStructuredShape =
    meta &&
    typeof meta === "object" &&
    ("network" in meta || "prlBalances" in meta || "utxos" in meta);
  if (hasStructuredShape) {
    return {
      network: meta.network ?? { chain: "pearl-mock" },
      prlBalances: meta.prlBalances ?? {},
      utxos: meta.utxos ?? null
    };
  }
  return {
    network: meta && typeof meta === "object" ? meta : { chain: "pearl-mock" },
    prlBalances: {},
    utxos: null
  };
}

function cloneInscriptionRecord(record) {
  // Shallow clone is sufficient: buildInscriptionRecord produces flat records and
  // the publish-time mutators REPLACE (never deep-mutate) array/object fields —
  // applyCurrentInscriptionLocations assigns a fresh locationHistory array and a
  // fresh firstMove object, so the clone never shares mutable structure with the
  // accumulator copy.
  return { ...record };
}

export function findMintFeePayment(outputs, policy = PRLS_MINT_FEE_POLICY) {
  const mintFeePolicy = normalizeMintFeePolicy(policy);
  let paidGrain = 0n;

  for (const output of outputs ?? []) {
    if (!outputMatchesMintFeePolicy(output, mintFeePolicy)) {
      continue;
    }
    paidGrain += outputValueGrain(output);
  }

  return {
    paid: !mintFeePolicy.required || paidGrain >= BigInt(mintFeePolicy.valueGrain),
    paidGrain: paidGrain.toString()
  };
}

export function createMintFeeAllocator(outputs, policy = PRLS_MINT_FEE_POLICY) {
  const mintFeePolicy = normalizeMintFeePolicy(policy);
  let remainingGrain = BigInt(findMintFeePayment(outputs, mintFeePolicy).paidGrain);

  return {
    policy: mintFeePolicy,
    get remainingGrain() {
      return remainingGrain.toString();
    },
    allocate(requiredGrain = mintFeePolicy.valueGrain) {
      if (!mintFeePolicy.required) {
        return { paid: true, paidGrain: "0" };
      }
      const required = BigInt(grainString(requiredGrain));
      const paidGrain = remainingGrain >= required ? required : remainingGrain;
      remainingGrain -= paidGrain;
      return {
        paid: paidGrain >= required,
        paidGrain: paidGrain.toString()
      };
    }
  };
}

export function normalizeBlockTransactions(block) {
  if (Array.isArray(block.transactions)) {
    return block.transactions;
  }

  const rawTransactions = Array.isArray(block.rawtx) ? block.rawtx : [];
  if (rawTransactions.length > 0) {
    return rawTransactions.map(normalizePearlRpcTransaction).filter(Boolean);
  }

  const verboseTransactions = Array.isArray(block.tx) ? block.tx : [];
  return verboseTransactions
    .filter((tx) => tx && typeof tx === "object")
    .map(normalizePearlRpcTransaction)
    .filter(Boolean);
}

function normalizePearlRpcTransaction(tx) {
  const rawTxHex = tx.rawTxHex ?? tx.hex;
  if (!rawTxHex) {
    return null;
  }

  return {
    txid: tx.txid ?? tx.hash,
    rawTxHex,
    inputs: normalizeTransactionInputs(tx),
    inscriptionOwnerOutputIndex: tx.inscriptionOwnerOutputIndex ?? 0,
    outputs: normalizePearlRpcOutputs(tx)
  };
}

function normalizeTransactionInputs(tx) {
  const rawInputs = Array.isArray(tx.inputs) ? tx.inputs : tx.vin;
  if (!Array.isArray(rawInputs)) {
    return [];
  }

  return rawInputs.map((input, index) => {
    const previousTxid =
      input.txid ??
      input.previousTxid ??
      input.prevTxid ??
      (typeof input.previousTxidLE === "string" ? reverseHex(input.previousTxidLE) : null);
    const previousVout =
      input.vout ??
      input.previousVout ??
      input.prevVout ??
      input.outputIndex ??
      null;
    return {
      ...input,
      inputIndex: input.inputIndex ?? index,
      previousTxid: previousTxid ?? null,
      previousVout: previousVout === null || previousVout === undefined ? null : Number(previousVout),
      previousOutpoint:
        previousTxid && previousVout !== null && previousVout !== undefined
          ? `${previousTxid}:${Number(previousVout)}`
          : null
    };
  });
}

function normalizeTransactionOutputs(tx) {
  return (tx.outputs ?? []).map((output, index) => ({
    ...output,
    index: Number(output.index ?? output.n ?? index),
    scriptPubKey: output.scriptPubKeyHex ?? output.scriptPubKey ?? null,
    valueGrain:
      output.valueGrain === undefined
        ? output.valuePrl === undefined && output.value === undefined
          ? "0"
          : outputValueGrain(output).toString()
        : grainString(output.valueGrain)
  }));
}

function normalizeInscriptionTransfers(tx) {
  if (!Array.isArray(tx.inscriptionTransfers)) {
    return [];
  }
  return tx.inscriptionTransfers
    .map((transfer) => {
      const previousTxid =
        transfer.inputTxid ??
        transfer.previousTxid ??
        transfer.txid ??
        (typeof transfer.inputOutpoint === "string" ? transfer.inputOutpoint.split(":")[0] : null);
      const previousVout =
        transfer.inputVout ??
        transfer.previousVout ??
        transfer.vout ??
        (typeof transfer.inputOutpoint === "string" ? transfer.inputOutpoint.split(":")[1] : null);
      const inputOutpoint =
        typeof transfer.inputOutpoint === "string"
          ? transfer.inputOutpoint
          : previousTxid && previousVout !== null && previousVout !== undefined
            ? `${previousTxid}:${Number(previousVout)}`
            : null;
      return {
        ...transfer,
        inputOutpoint,
        outputIndex:
          transfer.outputIndex === null || transfer.outputIndex === undefined
            ? null
            : Number(transfer.outputIndex)
      };
    })
    .filter((transfer) => transfer.outputIndex !== null);
}

function reverseHex(hex) {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    return null;
  }
  return Buffer.from(hex, "hex").reverse().toString("hex");
}

function normalizePearlRpcOutputs(tx) {
  const outputs = Array.isArray(tx.outputs) ? tx.outputs : tx.vout;
  if (!Array.isArray(outputs)) {
    return [];
  }

  return outputs.map((output, index) => {
    const script = output.scriptPubKey ?? {};
    const scriptPubKey =
      output.scriptPubKeyHex ??
      (typeof output.scriptPubKey === "string" ? output.scriptPubKey : script.hex) ??
      null;
    return {
      index,
      address: output.address ?? script.address ?? script.addresses?.[0] ?? null,
      scriptPubKey,
      valuePrl: output.valuePrl ?? (output.value === undefined ? undefined : String(output.value)),
      valueGrain: output.valueGrain
    };
  });
}

export function extractMockTaprootInscriptions(tx) {
  const outputs = tx.outputs ?? [];
  const baseOwnerOutputIndex = tx.inscriptionOwnerOutputIndex ?? 0;
  const inputs = tx.inputs ?? [];
  const entries = [];

  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const witness = inputs[inputIndex].witness ?? [];
    let inscriptionIndex = 0;
    for (let start = 0; start <= witness.length - 6; start += 1) {
      if (witness[start] !== "OP_FALSE" || witness[start + 1] !== "OP_IF") {
        continue;
      }
      const markerBytes = mockWitnessItemToBytes(witness[start + 2]);
      const contentTypeBytes = mockWitnessItemToBytes(witness[start + 3]);
      const separator = witness[start + 4];
      const marker = markerBytes?.toString("utf8") ?? null;
      const contentType = contentTypeBytes?.toString("utf8") ?? null;

      if (
        !marker ||
        !contentType ||
        !isMockSeparator(separator)
      ) {
        continue;
      }

      const bodyChunks = [];
      let cursor = start + 5;
      while (cursor < witness.length && witness[cursor] !== "OP_ENDIF") {
        const chunk = mockWitnessItemToBytes(witness[cursor]);
        if (!chunk) {
          bodyChunks.length = 0;
          break;
        }
        bodyChunks.push(chunk);
        cursor += 1;
      }
      if (bodyChunks.length === 0 || witness[cursor] !== "OP_ENDIF") {
        continue;
      }

      entries.push({
        inputIndex,
        inscriptionIndex,
        envelope: { marker, contentType, bodyBytes: Buffer.concat(bodyChunks) }
      });
      inscriptionIndex += 1;
      start = cursor;
    }
  }

  const sharedOwnerOutput = shouldShareOwnerOutput(entries.map((entry) => entry.envelope));
  const inscriptions = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    const envelope = entry.envelope;
    const ownerOutputIndex = ownerOutputIndexForEnvelope({
      baseOwnerOutputIndex,
      envelopeIndex: entryIndex,
      sharedOwnerOutput
    });
    const ownerOutput = outputs[ownerOutputIndex] ?? {};
    inscriptions.push({
      inputIndex: entry.inputIndex,
      inscriptionIndex: entry.inscriptionIndex,
      ownerOutputIndex,
      protocolMarker: envelope.marker,
      marker: envelope.marker,
      contentType: envelope.contentType,
      body: bodyTextFromBytes(envelope.bodyBytes, envelope.contentType, envelope.marker),
      bodyHex: envelope.bodyBytes.toString("hex"),
      bodyBase64: envelope.bodyBytes.toString("base64"),
      byteLength: envelope.bodyBytes.length,
      ownerAddress: ownerOutput.address ?? null,
      ownerScriptPubKey: ownerOutput.scriptPubKey ?? null
    });
  }

  return inscriptions;
}

export function extractTaprootInscriptionsFromRawTxHex(rawTxHex, tx = {}) {
  const parsed = parsePearlRawTransaction(rawTxHex);
  const entries = [];
  const outputs = tx.outputs ?? [];
  const baseOwnerOutputIndex = tx.inscriptionOwnerOutputIndex ?? 0;

  for (let inputIndex = 0; inputIndex < parsed.inputs.length; inputIndex += 1) {
    const input = parsed.inputs[inputIndex];
    const script = taprootScriptPathLeaf(input.witness);
    if (!script) {
      continue;
    }
    const envelopes = extractPearlscriptionEnvelopesFromScript(script);
    for (let envelopeIndex = 0; envelopeIndex < envelopes.length; envelopeIndex += 1) {
      entries.push({
        inputIndex,
        inscriptionIndex: envelopeIndex,
        envelope: envelopes[envelopeIndex]
      });
    }
  }

  const sharedOwnerOutput = shouldShareOwnerOutput(entries.map((entry) => entry.envelope));
  const inscriptions = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    const envelope = entry.envelope;
    const ownerOutputIndex = ownerOutputIndexForEnvelope({
      baseOwnerOutputIndex,
      envelopeIndex: entryIndex,
      sharedOwnerOutput
    });
    const ownerOutput = ownerOutputForInscription(outputs, parsed.outputs, ownerOutputIndex);

    inscriptions.push({
      inputIndex: entry.inputIndex,
      inscriptionIndex: entry.inscriptionIndex,
      ownerOutputIndex,
      protocolMarker: envelope.protocolMarker,
      marker: envelope.protocolMarker,
      contentType: envelope.contentType,
      body: bodyTextFromBytes(envelope.bodyBytes, envelope.contentType, envelope.protocolMarker),
      bodyHex: envelope.bodyBytes.toString("hex"),
      bodyBase64: envelope.bodyBytes.toString("base64"),
      byteLength: envelope.bodyBytes.length,
      ownerAddress: ownerOutput.address ?? null,
      ownerScriptPubKey: ownerOutput.scriptPubKey ?? null,
      source: "raw-pearl-witness"
    });
  }

  return inscriptions;
}

function shouldShareOwnerOutput(envelopes) {
  return (
    envelopes.length > 0 &&
    envelopes.every(
      (envelope) =>
        String(envelope.protocolMarker ?? envelope.marker ?? "")
          .trim()
          .toLowerCase() === "prl-20"
    )
  );
}

function ownerOutputIndexForEnvelope({ baseOwnerOutputIndex, envelopeIndex, sharedOwnerOutput }) {
  const base = Number(baseOwnerOutputIndex ?? 0);
  return sharedOwnerOutput ? base : base + Number(envelopeIndex ?? 0);
}

function taprootScriptPathLeaf(witness) {
  if (!Array.isArray(witness) || witness.length < 2) {
    return null;
  }
  const controlBlock = witness.at(-1);
  if (!isPlausibleTaprootControlBlock(controlBlock)) {
    return null;
  }
  return witness.at(-2) ?? null;
}

function isPlausibleTaprootControlBlock(controlBlock) {
  if (!Buffer.isBuffer(controlBlock)) {
    return false;
  }
  if (controlBlock.length < 33 || (controlBlock.length - 33) % 32 !== 0) {
    return false;
  }
  return (controlBlock[0] & 0xfe) === 0xc0;
}

function ownerOutputForInscription(outputs, parsedOutputs, ownerOutputIndex) {
  const explicit = outputs[ownerOutputIndex];
  if (explicit) {
    return explicit;
  }

  const parsed = parsedOutputs[ownerOutputIndex];
  if (!parsed) {
    return {};
  }

  return {
    address: null,
    scriptPubKey: parsed.scriptPubKey.toString("hex"),
    valueGrain: parsed.valueGrain
  };
}

export function parsePearlRawTransaction(rawTxHex) {
  const reader = new HexReader(rawTxHex);
  const version = reader.readUInt32LE();
  let hasWitness = false;

  let inputCount = reader.readVarInt();
  if (inputCount === 0n) {
    const flag = reader.readUInt8();
    if (flag !== 1) {
      throw new Error(`unsupported Pearl transaction flag ${flag}`);
    }
    hasWitness = true;
    inputCount = reader.readVarInt();
  }

  const inputs = [];
  for (let inputIndex = 0n; inputIndex < inputCount; inputIndex += 1n) {
    inputs.push({
      previousTxidLE: reader.readBytes(32).toString("hex"),
      previousVout: reader.readUInt32LE(),
      scriptSig: reader.readVarBytes(),
      sequence: reader.readUInt32LE(),
      witness: []
    });
  }

  const outputCount = reader.readVarInt();
  const outputs = [];
  for (let outputIndex = 0n; outputIndex < outputCount; outputIndex += 1n) {
    outputs.push({
      valueGrain: reader.readInt64LE().toString(),
      scriptPubKey: reader.readVarBytes()
    });
  }

  if (hasWitness) {
    for (const input of inputs) {
      const witnessItemCount = reader.readVarInt();
      for (let itemIndex = 0n; itemIndex < witnessItemCount; itemIndex += 1n) {
        input.witness.push(reader.readVarBytes());
      }
    }
  }

  const lockTime = reader.readUInt32LE();
  reader.assertComplete();

  return { version, hasWitness, inputs, outputs, lockTime };
}

function extractPearlscriptionEnvelopeFromScript(script) {
  return extractPearlscriptionEnvelopesFromScript(script)[0] ?? null;
}

function extractPearlscriptionEnvelopesFromScript(script) {
  let tokens;
  try {
    tokens = parseScript(script);
  } catch {
    return [];
  }

  const envelopes = [];
  for (let index = 0; index <= tokens.length - 6; index += 1) {
    if (!isOpcode(tokens[index], 0x00) || !isOpcode(tokens[index + 1], 0x63)) {
      continue;
    }

    const marker = tokenData(tokens[index + 2]);
    const contentType = tokenData(tokens[index + 3]);
    const separator = tokenData(tokens[index + 4]);

    if (
      !isSafeEnvelopeText(marker, { maxBytes: 80 }) ||
      !isSafeEnvelopeText(contentType, { maxBytes: 120 }) ||
      !separator ||
      separator.length !== 0
    ) {
      continue;
    }

    const bodyChunks = [];
    let cursor = index + 5;
    while (cursor < tokens.length && !isOpcode(tokens[cursor], 0x68)) {
      const chunk = tokenData(tokens[cursor]);
      if (!chunk) {
        bodyChunks.length = 0;
        break;
      }
      bodyChunks.push(chunk);
      cursor += 1;
    }
    if (bodyChunks.length === 0 || !isOpcode(tokens[cursor], 0x68)) {
      continue;
    }

    const markerText = marker.toString("utf8");
    const contentTypeText = contentType.toString("utf8");
    envelopes.push({
      protocolMarker: markerText,
      contentType: contentTypeText,
      bodyBytes: Buffer.concat(bodyChunks)
    });
    index = cursor;
  }

  return envelopes;
}

function isSafeEnvelopeText(value, { maxBytes }) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > maxBytes) {
    return false;
  }
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) {
    return false;
  }
  return /^[\x20-\x7e]+$/.test(text);
}

function mockWitnessItemToBytes(item) {
  if (Buffer.isBuffer(item)) {
    return item;
  }
  if (item instanceof Uint8Array) {
    return Buffer.from(item);
  }
  if (item && typeof item === "object") {
    if (typeof item.hex === "string") {
      return Buffer.from(item.hex, "hex");
    }
    if (typeof item.base64 === "string") {
      return Buffer.from(item.base64, "base64");
    }
  }
  if (typeof item === "string") {
    return Buffer.from(item, "utf8");
  }
  return null;
}

function isMockSeparator(item) {
  if (item === "0x00") {
    return true;
  }
  const bytes = mockWitnessItemToBytes(item);
  return Boolean(bytes && bytes.length === 0);
}

function bodyTextFromBytes(bytes, contentType, marker) {
  if (!bytes) {
    return null;
  }
  if (marker === "prl-20" || isSafeTextContentType(contentType)) {
    return bytes.toString("utf8");
  }
  return null;
}

function parseScript(script) {
  const reader = new BufferReader(script);
  const tokens = [];

  while (!reader.done()) {
    const opcode = reader.readUInt8();

    if (opcode >= 0x01 && opcode <= 0x4b) {
      tokens.push({ opcode, data: reader.readBytes(opcode) });
      continue;
    }

    if (opcode === 0x4c) {
      const size = reader.readUInt8();
      tokens.push({ opcode, data: reader.readBytes(size) });
      continue;
    }

    if (opcode === 0x4d) {
      const size = reader.readUInt16LE();
      tokens.push({ opcode, data: reader.readBytes(size) });
      continue;
    }

    if (opcode === 0x4e) {
      const size = reader.readUInt32LE();
      tokens.push({ opcode, data: reader.readBytes(size) });
      continue;
    }

    tokens.push({ opcode });
  }

  return tokens;
}

function isOpcode(token, opcode) {
  return token?.opcode === opcode && token.data === undefined;
}

function tokenData(token) {
  if (!token) {
    return null;
  }
  if (token.data) {
    return token.data;
  }
  if (token.opcode === 0x00) {
    return Buffer.alloc(0);
  }
  return null;
}

export function getAddressBalances(snapshot, address) {
  const ownerScriptPubKey = snapshot.addressToScriptPubKey?.[address];
  const state = snapshot.state ?? { balances: {} };
  const tokens = mergeAddressTokenBalances(
    ownerScriptPubKey ? getAddressTokenBalances(state, ownerScriptPubKey) : {},
    getAddressTokenBalances(state, address)
  );

  return {
    address,
    prl: snapshot.prlBalances?.[address] ?? "0",
    prls: tokens[PRLS.ticker] ?? "0",
    tokens
  };
}

export function getAddressTransferLots(snapshot, address) {
  const ownerScriptPubKey = snapshot.addressToScriptPubKey?.[address];
  const lots = (snapshot.transferLots ?? buildTransferLotSnapshot(snapshot))
    .filter((lot) => lot.status === "transferable" && addressOwnsTransferLot(lot, address, ownerScriptPubKey))
    .map(publicTransferLotRecord);
  const tokens = {};

  for (const lot of lots) {
    const ticker = String(lot.ticker ?? "").toLowerCase();
    if (!ticker) {
      continue;
    }
    const amount = BigInt(lot.amount ?? "0");
    const confirmed = lot.locationStatus !== "mempool";
    tokens[ticker] ??= {
      ticker,
      displayTicker: String(lot.displayTicker ?? ticker).toUpperCase(),
      transferable: "0",
      confirmedTransferable: "0",
      pendingTransferable: "0",
      lotCount: 0,
      confirmedLotCount: 0,
      pendingLotCount: 0
    };
    tokens[ticker].transferable = (BigInt(tokens[ticker].transferable) + amount).toString();
    tokens[ticker].lotCount += 1;
    if (confirmed) {
      tokens[ticker].confirmedTransferable = (
        BigInt(tokens[ticker].confirmedTransferable) + amount
      ).toString();
      tokens[ticker].confirmedLotCount += 1;
    } else {
      tokens[ticker].pendingTransferable = (
        BigInt(tokens[ticker].pendingTransferable) + amount
      ).toString();
      tokens[ticker].pendingLotCount += 1;
    }
  }

  return {
    address,
    transferLots: lots,
    tokens,
    total: lots.length
  };
}

function applyTransferLotFillsForTransaction(state, tx, context = {}) {
  const inputs = normalizeTransactionInputs(tx);
  if (!inputs.length || !state.transferLots) {
    return state;
  }

  const lotsByOutpoint = new Map();
  for (const lot of Object.values(state.transferLots)) {
    if (lot?.status !== "transferable" || !lot.originalOutpoint) {
      continue;
    }
    lotsByOutpoint.set(lot.originalOutpoint, lot);
  }
  if (lotsByOutpoint.size === 0) {
    return state;
  }

  const spendingInputs = inputs.filter((input) => input.previousOutpoint && lotsByOutpoint.has(input.previousOutpoint));
  if (spendingInputs.length === 0) {
    return state;
  }

  const normalizedTx = {
    ...tx,
    inputs,
    outputs: normalizeTransactionOutputs(tx),
    inscriptionTransfers: normalizeInscriptionTransfers(tx),
    inscriptionTransferOutputIndex:
      tx.inscriptionTransferOutputIndex === null || tx.inscriptionTransferOutputIndex === undefined
        ? null
        : Number(tx.inscriptionTransferOutputIndex),
    inscriptionOwnerOutputIndex:
      tx.inscriptionOwnerOutputIndex === null || tx.inscriptionOwnerOutputIndex === undefined
        ? null
        : Number(tx.inscriptionOwnerOutputIndex)
  };
  const ambiguousWithoutExplicit = spendingInputs.length > 1;
  const inferredSweepOutputs = inferTransferLotSweepOutputs(normalizedTx, spendingInputs);

  for (const input of spendingInputs) {
    const lot = lotsByOutpoint.get(input.previousOutpoint);
    if (!lot?.id || state.transferLots[lot.id]?.status !== "transferable") {
      continue;
    }
    const resolution = resolveInscriptionTransferOutput(normalizedTx, lot, input.previousOutpoint, {
      ambiguousWithoutExplicit,
      inferredOutputIndex: inferredSweepOutputs.get(input.previousOutpoint)
    });
    if (!resolution.ok) {
      markTransferLotFilled(state, lot, {
        txid: normalizedTx.txid,
        blockHeight: context.block?.height ?? null,
        invalidReason: resolution.reason
      });
      continue;
    }

    const output = normalizedTx.outputs.find((candidate) => candidate.index === resolution.outputIndex);
    const fillOwnerKey = output?.scriptPubKey ?? output?.address ?? null;
    if (!output || !fillOwnerKey) {
      markTransferLotFilled(state, lot, {
        txid: normalizedTx.txid,
        blockHeight: context.block?.height ?? null,
        invalidReason: "FILL_OUTPUT_NOT_FOUND"
      });
      continue;
    }

    markTransferLotFilled(state, lot, {
      txid: normalizedTx.txid,
      blockHeight: context.block?.height ?? null,
      output,
      ownerKey: fillOwnerKey
    });
    creditPrl20Balance(state, fillOwnerKey, lot.ticker, lot.amount);
  }

  return state;
}

function markTransferLotFilled(state, lot, fill = {}) {
  const current = state.transferLots?.[lot.id];
  if (!current || current.status !== "transferable") {
    return;
  }
  state.transferLots[lot.id] = {
    ...current,
    status: "filled",
    fillTxid: fill.txid ?? null,
    fillBlockHeight: fill.blockHeight ?? null,
    fillOwnerAddress: fill.output?.address ?? null,
    fillOwnerScriptPubKey: fill.output?.scriptPubKey ?? null,
    fillOwnerKey: fill.ownerKey ?? null,
    fillOutputIndex: fill.output?.index ?? null,
    fillOutpoint: fill.output ? `${fill.txid}:${fill.output.index}` : null,
    fillInvalidReason: fill.invalidReason ?? null
  };
}

function mergeAddressTokenBalances(...balanceSets) {
  const merged = {};
  for (const balances of balanceSets) {
    for (const [ticker, amount] of Object.entries(balances ?? {})) {
      const nextAmount = BigInt(amount ?? "0");
      const currentAmount = BigInt(merged[ticker] ?? "0");
      if (nextAmount > currentAmount) {
        merged[ticker] = nextAmount.toString();
      }
    }
  }
  return merged;
}

export function isPrl20Inscription(inscription) {
  return (
    inscription?.protocolMarker === "prl-20" &&
    inscription?.contentType === "application/json" &&
    typeof inscription?.body === "string"
  );
}

export function routeSnapshot(snapshot, method, path) {
  const url = path instanceof URL ? path : new URL(String(path ?? "/"), "http://snapshot.local");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/health") {
    return json(200, {
      ok: true,
      service: "prl20-indexer-api",
      source: "mock-fixture"
    });
  }

  if (method === "GET" && pathname === "/network") {
    return json(200, snapshot.network);
  }

  if (method === "GET" && pathname === "/tokens") {
    const tokens = snapshot.tokens ?? buildTokenSummaries(snapshot.state);
    return json(200, {
      tokens,
      total: tokens.length
    });
  }

  if (method === "GET" && pathname === "/tokens/prls") {
    return json(200, snapshot.token);
  }

  const tokenDetail = pathname.match(/^\/tokens\/([^/]+)$/);
  if (method === "GET" && tokenDetail) {
    const ticker = decodeURIComponent(tokenDetail[1]).toLowerCase();
    const token =
      (snapshot.tokens ?? buildTokenSummaries(snapshot.state)).find(
        (candidate) => candidate.ticker === ticker
      ) ?? getPrl20Token(snapshot.state, ticker);
    if (!token) {
      return json(404, { ok: false, error: "TOKEN_NOT_FOUND" });
    }
    return json(200, token);
  }

  if (method === "GET" && pathname === "/operations") {
    const page = paginateItems(snapshot.operations ?? [], url.searchParams, {
      defaultLimit: DEFAULT_PAGE_LIMIT,
      maxLimit: MAX_PAGE_LIMIT
    });
    return json(200, {
      operations: page.items.map(publicOperationRecord),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      page: page.page,
      pageCount: page.pageCount,
      hasPrev: page.hasPrev,
      hasNext: page.hasNext,
      itemStart: page.itemStart,
      itemEnd: page.itemEnd
    });
  }

  if (method === "GET" && pathname === "/inscriptions") {
    const page = paginateCanonicalInscriptions(snapshot.inscriptions ?? [], url.searchParams);
    return json(200, {
      inscriptions: page.items.map(publicInscriptionRecord),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      page: page.page,
      pageCount: page.pageCount,
      hasPrev: page.hasPrev,
      hasNext: page.hasNext,
      order: page.order,
      itemStart: page.itemStart,
      itemEnd: page.itemEnd,
      firstInscriptionNumber: page.firstInscriptionNumber,
      latestInscriptionNumber: page.latestInscriptionNumber,
      rangeFirstInscriptionNumber: page.items[0]?.inscriptionNumber ?? null,
      rangeLastInscriptionNumber: page.items.at(-1)?.inscriptionNumber ?? null
    });
  }

  const inscriptionContent = pathname.match(/^\/inscriptions\/([^/]+)\/content$/);
  if (method === "GET" && inscriptionContent) {
    const inscription = findInscription(snapshot, decodeURIComponent(inscriptionContent[1]));
    if (!inscription) {
      return json(404, { ok: false, error: "INSCRIPTION_NOT_FOUND" });
    }
    return json(200, {
      id: inscription.id,
      inscriptionNumber: inscription.inscriptionNumber,
      contentType: inscription.contentType,
      byteLength: inscription.byteLength,
      encoding: "base64",
      bodyBase64: inscription.bodyBase64,
      bodyHex: inscription.bodyHex,
      bodyText: safeBodyText(inscription)
    });
  }

  const inscriptionLocation = pathname.match(/^\/inscriptions\/([^/]+)\/location$/);
  if (method === "GET" && inscriptionLocation) {
    const inscription = findInscription(snapshot, decodeURIComponent(inscriptionLocation[1]));
    if (!inscription) {
      return json(404, { ok: false, error: "INSCRIPTION_NOT_FOUND" });
    }
    return json(200, publicInscriptionLocation(inscription));
  }

  const inscriptionDetail = pathname.match(/^\/inscriptions\/([^/]+)$/);
  if (method === "GET" && inscriptionDetail) {
    const inscription = findInscription(snapshot, decodeURIComponent(inscriptionDetail[1]));
    if (!inscription) {
      return json(404, { ok: false, error: "INSCRIPTION_NOT_FOUND" });
    }
    return json(200, publicInscriptionRecord(inscription));
  }

  const addressInscriptions = pathname.match(/^\/addresses\/([^/]+)\/inscriptions$/);
  if (method === "GET" && addressInscriptions) {
    const address = decodeURIComponent(addressInscriptions[1]);
    const owned = orderedInscriptions(snapshot).filter(
      (inscription) => (inscription.currentOwnerAddress ?? inscription.ownerAddress) === address
    );
    const page = paginateItems(owned, url.searchParams, {
      defaultLimit: 48,
      maxLimit: 100
    });
    return json(200, {
      address,
      inscriptions: page.items.map(publicInscriptionRecord),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      page: page.page,
      pageCount: page.pageCount,
      hasPrev: page.hasPrev,
      hasNext: page.hasNext,
      itemStart: page.itemStart,
      itemEnd: page.itemEnd
    });
  }

  const addressBalances = pathname.match(/^\/addresses\/([^/]+)\/balances$/);
  if (method === "GET" && addressBalances) {
    return json(200, getAddressBalances(snapshot, decodeURIComponent(addressBalances[1])));
  }

  const addressTransferLots = pathname.match(/^\/addresses\/([^/]+)\/transfer-lots$/);
  if (method === "GET" && addressTransferLots) {
    return json(200, getAddressTransferLots(snapshot, decodeURIComponent(addressTransferLots[1])));
  }

  const addressUtxos = pathname.match(/^\/addresses\/([^/]+)\/utxos$/);
  if (method === "GET" && addressUtxos) {
    const address = decodeURIComponent(addressUtxos[1]);
    return json(200, {
      address,
      utxos: snapshot.utxos[address] ?? []
    });
  }

  const txStatus = pathname.match(/^\/tx\/([^/]+)\/status$/);
  if (method === "GET" && txStatus) {
    const txid = decodeURIComponent(txStatus[1]);
    return json(200, snapshot.txStatus[txid] ?? { txid, status: "unknown" });
  }

  return json(404, { ok: false, error: "NOT_FOUND" });
}

// Pure publish-time projection: assembles the public snapshot from already-built
// fold accumulators. Every step here is O(state) (inscriptions / transactions /
// outputs), never an O(history) re-fold over raw blocks. The txStatus and
// addressToScriptPubKey maps are folded per block by the ingest session, so this
// no longer re-walks fixture.blocks the way the legacy buildSnapshot did.
function assembleSnapshot({
  state,
  mintFeePolicy = PRLS_MINT_FEE_POLICY,
  inscriptions = [],
  txStatus = {},
  addressToScriptPubKey = {},
  transactions = [],
  outputsByOutpoint = {},
  spendsByOutpoint = {},
  network = { chain: "pearl-mock" },
  prlBalances = {},
  utxos = null
}) {
  const snapshot = {
    network: {
      ...network,
      prl20MintFee: mintFeePolicy
    },
    state,
    inscriptions,
    token: getPrlsToken(state),
    tokens: [],
    operations: state.operations,
    addressToScriptPubKey,
    prlBalances,
    utxos,
    txStatus,
    transactions,
    outputsByOutpoint,
    spendsByOutpoint
  };
  applyCurrentInscriptionLocations(snapshot);
  snapshot.transferLots = buildTransferLotSnapshot(snapshot);
  if (snapshot.utxos !== SKIP_UTXO_MAP) {
    snapshot.utxos = snapshot.utxos ?? buildUtxoSnapshot(snapshot);
  }
  snapshot.tokens = buildTokenSummaries(snapshot.state);
  snapshot.token =
    snapshot.tokens.find((token) => token.ticker === PRLS.ticker) ?? getPrlsToken(snapshot.state);
  return snapshot;
}

function buildTokenSummaries(state) {
  const holderCounts = {};
  for (const balances of Object.values(state.balances ?? {})) {
    for (const [ticker, amount] of Object.entries(balances ?? {})) {
      if (BigInt(amount ?? "0") <= 0n) {
        continue;
      }
      holderCounts[ticker] = (holderCounts[ticker] ?? 0) + 1;
    }
  }

  return Object.values(state.tokens ?? {})
    .filter((token) => token?.deployed)
    .map((token) => publicTokenSummary(token, holderCounts[token.ticker] ?? 0))
    .sort((left, right) => {
      if (left.ticker === PRLS.ticker) return -1;
      if (right.ticker === PRLS.ticker) return 1;
      return left.ticker.localeCompare(right.ticker);
    });
}

function publicTokenSummary(token, holderCount = 0) {
  const maxSupply = BigInt(token.maxSupply ?? "0");
  const mintedSupply = BigInt(token.mintedSupply ?? "0");
  const remainingSupply = maxSupply > mintedSupply ? maxSupply - mintedSupply : 0n;
  const mintProgress =
    maxSupply === 0n ? 0 : Number((mintedSupply * 10_000n) / maxSupply) / 100;

  return {
    ...token,
    holderCount,
    remainingSupply: remainingSupply.toString(),
    mintProgress
  };
}

function publicOperationRecord(operation) {
  return {
    inscriptionId: operation.inscriptionId ?? null,
    txid: operation.txid ?? null,
    blockHeight: operation.blockHeight ?? null,
    txIndex: operation.txIndex ?? null,
    inscriptionIndex: operation.inscriptionIndex ?? null,
    inscriptionNumber: operation.inscriptionNumber ?? null,
    ownerOutpoint: operation.ownerOutpoint ?? null,
    op: operation.op ?? null,
    ticker: operation.ticker ?? null,
    amount: operation.amount ?? null,
    ownerAddress: operation.ownerAddress ?? null,
    ownerScriptPubKey: operation.ownerScriptPubKey ?? null,
    source: operation.source ?? null,
    valid: Boolean(operation.valid),
    invalidReason: operation.invalidReason ?? null,
    invalidMessage: operation.invalidMessage ?? null,
    mintFeeRequired: Boolean(operation.mintFeeRequired),
    requiredMintFeeGrain: operation.requiredMintFeeGrain ?? null,
    paidMintFeeGrain: operation.paidMintFeeGrain ?? null,
    mintFeePaid: operation.mintFeePaid ?? null,
    mintFeeAddress: operation.mintFeeAddress ?? null,
    mintFeeScriptPubKey: operation.mintFeeScriptPubKey ?? null
  };
}

function applyCurrentInscriptionLocations(snapshot) {
  const byOutpoint = new Map();
  for (const inscription of snapshot.inscriptions ?? []) {
    const initialOutput = snapshot.outputsByOutpoint?.[inscription.ownerOutpoint] ?? null;
    const initialLocation = {
      outpoint: inscription.ownerOutpoint,
      txid: inscription.txid,
      vout: inscription.ownerOutputIndex,
      address: inscription.ownerAddress ?? initialOutput?.address ?? null,
      scriptPubKey: inscription.ownerScriptPubKey ?? initialOutput?.scriptPubKey ?? null,
      blockHeight: inscription.blockHeight,
      txIndex: inscription.txIndex,
      order: transactionOrder(inscription.blockHeight, inscription.txIndex)
    };
    inscription.locationHistory = [initialLocation];
    setCurrentInscriptionLocation(inscription, initialLocation);
    if (initialLocation.outpoint) {
      const ids = byOutpoint.get(initialLocation.outpoint) ?? [];
      ids.push(inscription.id);
      byOutpoint.set(initialLocation.outpoint, ids);
    }
  }

  const byId = new Map((snapshot.inscriptions ?? []).map((inscription) => [inscription.id, inscription]));
  for (const tx of snapshot.transactions ?? []) {
    const trackedInputs = (tx.inputs ?? []).filter((input) => byOutpoint.has(input.previousOutpoint));
    const trackedInputCount = trackedInputs.length;
    const trackedTransferInputs = trackedInputs.filter((input) =>
      (byOutpoint.get(input.previousOutpoint) ?? []).some((id) => isPrl20TransferInscription(byId.get(id)))
    );
    const inferredSweepOutputs = inferTransferLotSweepOutputs(tx, trackedTransferInputs);
    for (const input of tx.inputs ?? []) {
      const ids = byOutpoint.get(input.previousOutpoint);
      if (!ids?.length) {
        continue;
      }
      byOutpoint.delete(input.previousOutpoint);
      for (const id of ids) {
        const inscription = byId.get(id);
        if (!inscription) {
          continue;
        }
        const resolution = resolveInscriptionTransferOutput(tx, inscription, input.previousOutpoint, {
          ambiguousWithoutExplicit: trackedInputCount > 1,
          inferredOutputIndex: inferredSweepOutputs.get(input.previousOutpoint)
        });
        const output = resolution.ok
          ? tx.outputs.find((candidate) => candidate.index === resolution.outputIndex) ?? null
          : null;
        const outpoint = output ? `${tx.txid}:${output.index}` : null;
        const nextLocation = {
          outpoint,
          txid: tx.txid,
          vout: output?.index ?? null,
          address: output?.address ?? null,
          scriptPubKey: output?.scriptPubKey ?? null,
          blockHeight: tx.blockHeight,
          txIndex: tx.txIndex,
          order: tx.order,
          spentFromOutpoint: input.previousOutpoint,
          unresolvedReason: resolution.ok ? null : resolution.reason
        };
        inscription.locationHistory.push(nextLocation);
        setCurrentInscriptionLocation(inscription, nextLocation);
        if (!inscription.firstMove && input.previousOutpoint === inscription.ownerOutpoint) {
          inscription.firstMove = nextLocation;
        }
        if (outpoint) {
          const nextIds = byOutpoint.get(outpoint) ?? [];
          nextIds.push(inscription.id);
          byOutpoint.set(outpoint, nextIds);
        }
      }
    }
  }
}

function resolveInscriptionTransferOutputIndex(tx, inscription, previousOutpoint) {
  const resolution = resolveInscriptionTransferOutput(tx, inscription, previousOutpoint);
  return resolution.ok ? resolution.outputIndex : null;
}

function resolveInscriptionTransferOutput(tx, inscription, previousOutpoint, options = {}) {
  const explicitTransfer = tx.inscriptionTransfers?.find(
    (transfer) =>
      transfer.inscriptionId === inscription.id ||
      transfer.inscriptionId === inscription.inscriptionId ||
      transfer.inputOutpoint === previousOutpoint
  );
  if (explicitTransfer?.outputIndex !== null && explicitTransfer?.outputIndex !== undefined) {
    return { ok: true, outputIndex: Number(explicitTransfer.outputIndex), source: "explicit" };
  }

  if (options.inferredOutputIndex !== null && options.inferredOutputIndex !== undefined) {
    return { ok: true, outputIndex: Number(options.inferredOutputIndex), source: "inferred-transfer-lot-sweep" };
  }

  if (options.ambiguousWithoutExplicit) {
    return { ok: false, outputIndex: null, reason: "AMBIGUOUS_TRANSFER_OUTPUT" };
  }

  if (tx.inscriptionTransferOutputIndex !== null && tx.inscriptionTransferOutputIndex !== undefined) {
    return { ok: true, outputIndex: Number(tx.inscriptionTransferOutputIndex), source: "transaction-transfer-index" };
  }

  if (tx.inscriptionOwnerOutputIndex !== null && tx.inscriptionOwnerOutputIndex !== undefined) {
    return { ok: true, outputIndex: Number(tx.inscriptionOwnerOutputIndex), source: "transaction-owner-index" };
  }

  return { ok: true, outputIndex: 0, source: "single-input-default" };
}

function inferTransferLotSweepOutputs(tx, transferInputs = []) {
  const sortedInputs = (transferInputs ?? [])
    .filter((input) => input?.previousOutpoint)
    .map((input) => ({
      ...input,
      inputIndex: Number(input.inputIndex ?? 0)
    }))
    .sort((left, right) => left.inputIndex - right.inputIndex);

  if (sortedInputs.length < 2) {
    return new Map();
  }

  // Public transfer-lot sweep convention:
  // input 0: non-transfer funding
  // inputs 1..N: transfer-lot assets
  // output 0: first transfer-lot recipient output
  // outputs 1..N: unrelated payment/change outputs
  // outputs N+1..2N-1: remaining transfer-lot recipient outputs
  if (!sortedInputs.every((input, index) => input.inputIndex === index + 1)) {
    return new Map();
  }

  const outputs = new Set((tx.outputs ?? []).map((output) => Number(output.index ?? 0)));
  const lotCount = sortedInputs.length;
  const mapping = new Map();
  for (let index = 0; index < lotCount; index += 1) {
    const outputIndex = index === 0 ? 0 : lotCount + index;
    if (!outputs.has(outputIndex)) {
      return new Map();
    }
    mapping.set(sortedInputs[index].previousOutpoint, outputIndex);
  }
  return mapping;
}

function isPrl20TransferInscription(inscription) {
  if (!inscription) {
    return false;
  }
  if ((inscription.protocolMarker ?? inscription.marker) !== "prl-20") {
    return false;
  }
  const parsed = safeParsePrl20Operation(inscription.body);
  return parsed.ok && parsed.operation.op === "transfer";
}

function setCurrentInscriptionLocation(inscription, location) {
  inscription.currentOutpoint = location.outpoint;
  inscription.currentOwnerAddress = location.address;
  inscription.currentOwnerScriptPubKey = location.scriptPubKey;
  inscription.currentOutputIndex = location.vout;
  inscription.locationStatus =
    location.blockHeight === null || location.blockHeight === undefined ? "mempool" : "confirmed";
}

function buildTransferLotSnapshot(snapshot) {
  const lots = [];
  for (const lot of Object.values(snapshot.state.transferLots ?? {})) {
    const inscription = findInscription(snapshot, lot.inscriptionId);
    const firstSpend = lot.originalOutpoint ? snapshot.spendsByOutpoint?.[lot.originalOutpoint] : null;
    const transferInputCount = firstSpend
      ? (firstSpend.inputs ?? []).filter((input) =>
          Object.values(snapshot.state.transferLots ?? {}).some(
            (candidate) => candidate.originalOutpoint === input.previousOutpoint
          )
        ).length
      : 0;
    const fillResolution =
      firstSpend && lot.fillOutputIndex == null
        ? resolveInscriptionTransferOutput(firstSpend, inscription ?? lot, lot.originalOutpoint, {
            ambiguousWithoutExplicit: transferInputCount > 1
          })
        : null;
    const fillOutputIndex =
      lot.fillOutputIndex === null || lot.fillOutputIndex === undefined
        ? fillResolution?.outputIndex
        : Number(lot.fillOutputIndex);
    const fillOutput =
      fillOutputIndex === null || fillOutputIndex === undefined
        ? null
        : firstSpend?.outputs.find((output) => output.index === fillOutputIndex) ?? null;
    const fillOwnerKey = fillOutput?.scriptPubKey ?? fillOutput?.address ?? null;
    const filled = lot.status === "filled" || Boolean(firstSpend);
    const publicLot = {
      ...lot,
      status: filled ? "filled" : "transferable",
      currentOutpoint: inscription?.currentOutpoint ?? lot.originalOutpoint,
      currentOwnerAddress: inscription?.currentOwnerAddress ?? lot.originalOwnerAddress,
      currentOwnerScriptPubKey: inscription?.currentOwnerScriptPubKey ?? lot.originalOwnerScriptPubKey,
      locationStatus: inscription?.locationStatus ?? inscription?.status ?? null,
      fillTxid: filled ? lot.fillTxid ?? firstSpend?.txid ?? null : null,
      fillBlockHeight: filled ? lot.fillBlockHeight ?? firstSpend?.blockHeight ?? null : null,
      fillOwnerAddress: filled ? lot.fillOwnerAddress ?? fillOutput?.address ?? null : null,
      fillOwnerScriptPubKey: filled ? lot.fillOwnerScriptPubKey ?? fillOutput?.scriptPubKey ?? null : null,
      fillOutputIndex: filled ? lot.fillOutputIndex ?? fillOutput?.index ?? null : null,
      fillOutpoint: filled ? lot.fillOutpoint ?? (fillOutput ? `${firstSpend.txid}:${fillOutput.index}` : null) : null,
      fillInvalidReason: filled ? lot.fillInvalidReason ?? (fillResolution?.ok === false ? fillResolution.reason : null) : null
    };
    if (filled && fillOwnerKey && !lot.fillOwnerKey && lot.status !== "filled") {
      publicLot.fillOwnerKey = fillOwnerKey;
    }
    lots.push(publicLot);
  }
  return lots.sort((a, b) => Number(a.inscriptionNumber ?? 0) - Number(b.inscriptionNumber ?? 0));
}

function addressOwnsTransferLot(lot, address, ownerScriptPubKey) {
  const lotAddress = lot.currentOwnerAddress ?? lot.originalOwnerAddress;
  if (lotAddress === address) {
    return true;
  }
  const lotScript = lot.currentOwnerScriptPubKey ?? lot.originalOwnerScriptPubKey;
  return Boolean(
    ownerScriptPubKey &&
      lotScript &&
      String(ownerScriptPubKey).toLowerCase() === String(lotScript).toLowerCase()
  );
}

function publicTransferLotRecord(lot) {
  return {
    id: lot.id,
    inscriptionId: lot.inscriptionId ?? lot.id,
    inscriptionNumber: lot.inscriptionNumber ?? null,
    ticker: lot.ticker,
    displayTicker: lot.displayTicker ?? String(lot.ticker ?? "").toUpperCase(),
    amount: lot.amount,
    status: lot.status,
    txid: lot.txid ?? null,
    blockHeight: lot.blockHeight ?? null,
    currentOutpoint: lot.currentOutpoint ?? lot.originalOutpoint ?? null,
    currentOwnerAddress: lot.currentOwnerAddress ?? lot.originalOwnerAddress ?? null,
    currentOwnerScriptPubKey: lot.currentOwnerScriptPubKey ?? lot.originalOwnerScriptPubKey ?? null,
    originalOutpoint: lot.originalOutpoint ?? null,
    locationStatus: lot.locationStatus ?? null
  };
}

function buildUtxoSnapshot(snapshot) {
  const byAddress = {};
  const bestHeight = Number(
    snapshot.network?.bestHeight ??
      snapshot.network?.indexedHeight ??
      Math.max(0, ...(snapshot.transactions ?? []).map((tx) => Number(tx.blockHeight ?? 0)))
  );
  const protectionByOutpoint = buildUtxoProtectionIndex(snapshot);

  for (const [outpoint, output] of Object.entries(snapshot.outputsByOutpoint ?? {})) {
    if (!outpoint || snapshot.spendsByOutpoint?.[outpoint] || !output.address) {
      continue;
    }
    const blockHeight =
      output.blockHeight === null || output.blockHeight === undefined ? null : Number(output.blockHeight);
    const confirmations = blockHeight === null ? 0 : Math.max(0, bestHeight - blockHeight + 1);
    const coinbase = Boolean(output.coinbase);
    const protection = protectionByOutpoint.get(outpoint) ?? null;
    const spendable = (!coinbase || confirmations >= 100) && !protection;
    const row = {
      outpoint,
      txid: output.txid,
      vout: output.vout,
      address: output.address,
      scriptPubKey: output.scriptPubKey,
      valueGrain: output.valueGrain ?? "0",
      valuePrl: output.valuePrl ?? grainToPrl(output.valueGrain ?? "0"),
      blockHeight,
      confirmations,
      coinbase,
      spendable,
      protected: Boolean(protection),
      protectionReason: protection?.protectionReason ?? null,
      inscriptionId: protection?.inscriptionId ?? null,
      inscriptionNumber: protection?.inscriptionNumber ?? null,
      transferLotId: protection?.transferLotId ?? null,
      source: "snapshot-utxo-read-model"
    };
    byAddress[output.address] ??= [];
    byAddress[output.address].push(row);
  }

  for (const rows of Object.values(byAddress)) {
    rows.sort((left, right) => {
      const valueDiff = BigInt(right.valueGrain ?? "0") - BigInt(left.valueGrain ?? "0");
      if (valueDiff !== 0n) {
        return valueDiff > 0n ? 1 : -1;
      }
      return `${left.txid}:${left.vout}`.localeCompare(`${right.txid}:${right.vout}`);
    });
  }
  return byAddress;
}

function buildUtxoProtectionIndex(snapshot) {
  const protectionByOutpoint = new Map();
  for (const inscription of snapshot.inscriptions ?? []) {
    const outpoint = inscription.currentOutpoint ?? inscription.ownerOutpoint;
    if (!outpoint) {
      continue;
    }
    protectionByOutpoint.set(outpoint, {
      protectionReason: "INSCRIPTION_UTXO",
      inscriptionId: inscription.id ?? inscription.inscriptionId ?? null,
      inscriptionNumber: inscription.inscriptionNumber ?? null,
      transferLotId: null
    });
  }
  for (const lot of snapshot.transferLots ?? []) {
    if (lot.status !== "transferable" || !lot.currentOutpoint) {
      continue;
    }
    protectionByOutpoint.set(lot.currentOutpoint, {
      protectionReason: "PRL20_TRANSFER_LOT_UTXO",
      inscriptionId: lot.inscriptionId ?? lot.id ?? null,
      inscriptionNumber: lot.inscriptionNumber ?? null,
      transferLotId: lot.id ?? lot.inscriptionId ?? null
    });
  }
  return protectionByOutpoint;
}

function creditPrl20Balance(state, ownerKey, ticker, amount) {
  if (!ownerKey) {
    return;
  }
  state.balances[ownerKey] ??= {};
  state.balances[ownerKey][ticker] = (
    BigInt(state.balances[ownerKey][ticker] ?? "0") + BigInt(amount)
  ).toString();
}

function transactionOrder(blockHeight, txIndex) {
  const height = blockHeight === null || blockHeight === undefined ? Number.MAX_SAFE_INTEGER : Number(blockHeight);
  return height * 1_000_000 + Number(txIndex ?? 0);
}

function buildInscriptionRecord({ block, tx, txIndex, inscription, inscriptionNumber }) {
  const id = `${tx.txid}:i${inscription.inputIndex}:n${inscription.inscriptionIndex}`;
  const ownerOutputIndex = inscription.ownerOutputIndex ?? tx.inscriptionOwnerOutputIndex ?? 0;
  return {
    id,
    inscriptionId: id,
    inscriptionNumber,
    txid: tx.txid,
    inputIndex: inscription.inputIndex,
    inscriptionIndex: inscription.inscriptionIndex,
    ownerOutputIndex,
    ownerOutpoint: `${tx.txid}:${ownerOutputIndex}`,
    blockHeight: block.height ?? null,
    blockHash: block.hash ?? null,
    txIndex,
    ownerAddress: inscription.ownerAddress ?? null,
    ownerScriptPubKey: inscription.ownerScriptPubKey ?? null,
    protocolMarker: inscription.protocolMarker ?? inscription.marker ?? null,
    marker: inscription.protocolMarker ?? inscription.marker ?? null,
    contentType: inscription.contentType ?? "application/octet-stream",
    byteLength: inscription.byteLength ?? byteLengthFromInscription(inscription),
    body: inscription.body ?? null,
    bodyHex: inscription.bodyHex ?? null,
    bodyBase64: inscription.bodyBase64 ?? null,
    bodyPreview: previewBody(inscription),
    source: inscription.source ?? "mock-witness",
    status: block.height === null || block.height === undefined ? "mempool" : "confirmed"
  };
}

function publicInscriptionRecord(inscription) {
  return {
    id: inscription.id,
    inscriptionId: inscription.inscriptionId ?? inscription.id,
    inscriptionNumber: inscription.inscriptionNumber,
    txid: inscription.txid,
    inputIndex: inscription.inputIndex,
    inscriptionIndex: inscription.inscriptionIndex,
    ownerOutputIndex: inscription.ownerOutputIndex,
    ownerOutpoint: inscription.ownerOutpoint,
    currentOutpoint: inscription.currentOutpoint ?? inscription.ownerOutpoint,
    currentOwnerAddress: inscription.currentOwnerAddress ?? inscription.ownerAddress,
    currentOwnerScriptPubKey: inscription.currentOwnerScriptPubKey ?? inscription.ownerScriptPubKey,
    currentOutputIndex: inscription.currentOutputIndex ?? inscription.ownerOutputIndex,
    locationStatus: inscription.locationStatus ?? inscription.status,
    blockHeight: inscription.blockHeight,
    blockHash: inscription.blockHash,
    txIndex: inscription.txIndex,
    ownerAddress: inscription.ownerAddress,
    ownerScriptPubKey: inscription.ownerScriptPubKey,
    protocolMarker: inscription.protocolMarker,
    marker: inscription.marker,
    contentType: inscription.contentType,
    byteLength: inscription.byteLength,
    bodyPreview: inscription.bodyPreview,
    source: inscription.source,
    status: inscription.status
  };
}

function publicInscriptionLocation(inscription) {
  return {
    id: inscription.id,
    inscriptionId: inscription.inscriptionId ?? inscription.id,
    inscriptionNumber: inscription.inscriptionNumber,
    ownerOutpoint: inscription.ownerOutpoint,
    currentOutpoint: inscription.currentOutpoint ?? inscription.ownerOutpoint,
    currentOwnerAddress: inscription.currentOwnerAddress ?? inscription.ownerAddress,
    currentOwnerScriptPubKey: inscription.currentOwnerScriptPubKey ?? inscription.ownerScriptPubKey,
    currentOutputIndex: inscription.currentOutputIndex ?? inscription.ownerOutputIndex,
    status: inscription.locationStatus ?? inscription.status,
    history: inscription.locationHistory ?? []
  };
}

function boundedQueryInteger(value, fallback, { min, max }) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parsePagination(searchParams, { defaultLimit = DEFAULT_PAGE_LIMIT, maxLimit = MAX_PAGE_LIMIT } = {}) {
  const limit = boundedQueryInteger(searchParams.get("limit"), defaultLimit, {
    min: 1,
    max: maxLimit
  });
  const pageValue = searchParams.get("page");
  if (pageValue !== null && pageValue !== "") {
    const page = boundedQueryInteger(pageValue, 1, { min: 1, max: Number.MAX_SAFE_INTEGER });
    return {
      limit,
      offset: Math.min((page - 1) * limit, MAX_PAGE_OFFSET)
    };
  }
  return {
    limit,
    offset: boundedQueryInteger(searchParams.get("offset"), 0, {
      min: 0,
      max: MAX_PAGE_OFFSET
    })
  };
}

function paginationMetadata(total, limit, offset, itemsLength) {
  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  return {
    total,
    limit,
    offset,
    page,
    pageCount,
    hasPrev,
    hasNext,
    itemStart: total === 0 || itemsLength === 0 ? 0 : offset + 1,
    itemEnd: total === 0 || itemsLength === 0 ? 0 : Math.min(total, offset + itemsLength)
  };
}

function paginateItems(items, searchParams, options = {}) {
  const { limit, offset } = parsePagination(searchParams, options);
  const pageItems = items.slice(offset, offset + limit);
  return {
    items: pageItems,
    ...paginationMetadata(items.length, limit, offset, pageItems.length)
  };
}

function paginateCanonicalInscriptions(inscriptions, searchParams) {
  const order = searchParams.get("order") === "desc" ? "desc" : "asc";
  const { limit, offset } = parsePagination(searchParams, {
    defaultLimit: DEFAULT_PAGE_LIMIT,
    maxLimit: MAX_PAGE_LIMIT
  });
  const total = inscriptions.length;
  const items = [];

  if (order === "asc") {
    items.push(...inscriptions.slice(offset, offset + limit));
  } else {
    const start = Math.max(total - offset - 1, -1);
    const end = Math.max(start - limit, -1);
    for (let index = start; index > end; index -= 1) {
      if (inscriptions[index]) {
        items.push(inscriptions[index]);
      }
    }
  }

  return {
    items,
    order,
    firstInscriptionNumber: inscriptions[0]?.inscriptionNumber ?? null,
    latestInscriptionNumber: inscriptions.at(-1)?.inscriptionNumber ?? null,
    ...paginationMetadata(total, limit, offset, items.length)
  };
}

function findInscription(snapshot, id) {
  return (snapshot.inscriptions ?? []).find((inscription) => inscription.id === id);
}

function orderedInscriptions(snapshot) {
  return [...(snapshot.inscriptions ?? [])].sort(
    (a, b) =>
      Number(a.inscriptionNumber ?? Number.MAX_SAFE_INTEGER) -
      Number(b.inscriptionNumber ?? Number.MAX_SAFE_INTEGER)
  );
}

function previewBody(inscription) {
  const text = safeBodyText(inscription);
  if (!text) {
    return null;
  }
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function safeBodyText(inscription) {
  if (typeof inscription.body !== "string") {
    return null;
  }
  if (isSafeTextContentType(inscription.contentType) || inscription.protocolMarker === "prl-20") {
    return inscription.body;
  }
  return null;
}

function isSafeTextContentType(contentType) {
  const type = String(contentType ?? "").toLowerCase();
  return (
    type.startsWith("text/plain") ||
    type === "application/json" ||
    type.endsWith("+json")
  );
}

function byteLengthFromInscription(inscription) {
  if (inscription.bodyHex) {
    return inscription.bodyHex.length / 2;
  }
  if (inscription.bodyBase64) {
    return Buffer.from(inscription.bodyBase64, "base64").length;
  }
  return typeof inscription.body === "string" ? Buffer.byteLength(inscription.body, "utf8") : 0;
}

export function normalizeMintFeePolicy(policy = {}) {
  const raw = policy ?? {};
  const valueGrain = grainString(
    raw.valueGrain ??
      raw.mintFeeGrain ??
      (raw.valuePrl === undefined ? PRLS_MINT_FEE_POLICY.valueGrain : prlToGrain(raw.valuePrl))
  );
  return {
    required: raw.required !== false,
    valueGrain,
    valuePrl: raw.valuePrl ?? grainToPrl(valueGrain),
    address: Object.hasOwn(raw, "address") ? raw.address : PRLS_MINT_FEE_POLICY.address,
    scriptPubKey: normalizeScriptPubKey(
      Object.hasOwn(raw, "scriptPubKey") ? raw.scriptPubKey : PRLS_MINT_FEE_POLICY.scriptPubKey
    )
  };
}

function outputMatchesMintFeePolicy(output, policy) {
  if (!policy.address && !policy.scriptPubKey) {
    return false;
  }
  const addressMatches = policy.address && output.address === policy.address;
  const scriptMatches =
    policy.scriptPubKey &&
    normalizeScriptPubKey(output.scriptPubKey ?? output.scriptPubKeyHex) === policy.scriptPubKey;
  return Boolean(addressMatches || scriptMatches);
}

function outputValueGrain(output) {
  if (output.valueGrain !== undefined) {
    return BigInt(grainString(output.valueGrain));
  }
  if (output.valuePrl !== undefined) {
    return prlToGrain(output.valuePrl);
  }
  if (output.value !== undefined) {
    return prlToGrain(output.value);
  }
  return 0n;
}

function prlToGrain(value) {
  const decimal = typeof value === "number" ? value.toFixed(8) : String(value);
  if (!/^\d+(?:\.\d{1,8})?$/.test(decimal)) {
    throw new Error(`invalid PRL amount ${value}`);
  }
  const [whole, fractional = ""] = decimal.split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fractional.padEnd(8, "0"));
}

function grainToPrl(value) {
  const grains = BigInt(grainString(value));
  const whole = grains / 100_000_000n;
  const fractional = String(grains % 100_000_000n).padStart(8, "0");
  return `${whole}.${fractional}`;
}

function grainString(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  const text = String(value ?? "").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`invalid grain amount ${value}`);
  }
  return text;
}

function normalizeScriptPubKey(scriptPubKey) {
  const value = String(scriptPubKey ?? "").trim().toLowerCase();
  return value === "" ? null : value;
}

function appendInvalidOperation(state, operation) {
  return {
    tokens: state.tokens,
    balances: state.balances,
    transferLots: state.transferLots ?? {},
    operations: [...state.operations, operation]
  };
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body
  };
}

class HexReader {
  constructor(hex) {
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
      throw new Error("raw transaction hex must have an even number of hex characters");
    }
    this.reader = new BufferReader(Buffer.from(hex, "hex"));
  }

  readUInt8() {
    return this.reader.readUInt8();
  }

  readUInt16LE() {
    return this.reader.readUInt16LE();
  }

  readUInt32LE() {
    return this.reader.readUInt32LE();
  }

  readInt64LE() {
    return this.reader.readInt64LE();
  }

  readBytes(size) {
    return this.reader.readBytes(size);
  }

  readVarBytes() {
    const size = this.readVarInt();
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`varbytes size ${size} exceeds safe parser limit`);
    }
    return this.readBytes(Number(size));
  }

  readVarInt() {
    const first = this.readUInt8();
    if (first < 0xfd) {
      return BigInt(first);
    }
    if (first === 0xfd) {
      return BigInt(this.readUInt16LE());
    }
    if (first === 0xfe) {
      return BigInt(this.readUInt32LE());
    }
    return this.reader.readUInt64LE();
  }

  assertComplete() {
    this.reader.assertComplete();
  }
}

class BufferReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  done() {
    return this.offset === this.buffer.length;
  }

  readUInt8() {
    this.require(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUInt16LE() {
    this.require(2);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readUInt32LE() {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt64LE() {
    this.require(8);
    const value = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readUInt64LE() {
    this.require(8);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readBytes(size) {
    this.require(size);
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  assertComplete() {
    if (!this.done()) {
      throw new Error(`${this.buffer.length - this.offset} trailing transaction bytes`);
    }
  }

  require(size) {
    if (this.offset + size > this.buffer.length) {
      throw new Error(`unexpected end of buffer while reading ${size} bytes`);
    }
  }
}
