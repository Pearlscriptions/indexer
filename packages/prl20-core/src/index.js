export const PRL20_PROTOCOL = "prl-20";

export const PRLS = Object.freeze({
  displayTicker: "PRLS",
  ticker: "prls",
  maxSupply: 2_100_000_000n,
  mintAmount: 100_000n,
  mintLimit: 100_000n,
  mintFeeGrain: 100_000_000n,
  mintFeePrl: "1.00000000",
  decimals: 18,
  totalMints: 21_000,
  fairMint: true
});

const DEPLOY_KEYS = new Set(["p", "op", "tick", "max", "lim", "dec"]);
const MINT_KEYS = new Set(["p", "op", "tick", "amt"]);
const TRANSFER_KEYS = new Set(["p", "op", "tick", "amt"]);
const COMMON_KEYS = new Set(["p", "op", "tick"]);
const INTEGER_STRING = /^(0|[1-9][0-9]*)$/;
const TICKER_PATTERN = /^[a-z0-9]{1,16}$/;
const MAX_DECIMALS = 18;

export class Prl20ValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "Prl20ValidationError";
    this.code = code;
    this.details = details;
  }
}

export function parsePrl20Operation(rawJson) {
  const payload = parseStrictJsonObject(rawJson);
  validateCommonPayload(payload);
  payload.tick = normalizeTicker(payload.tick);

  if (payload.op === "deploy") {
    assertOnlyKeys(payload, DEPLOY_KEYS, "deploy");
    return validateDeploy(payload);
  }

  if (payload.op === "mint") {
    assertOnlyKeys(payload, MINT_KEYS, "mint");
    return validateMint(payload);
  }

  if (payload.op === "transfer") {
    assertOnlyKeys(payload, TRANSFER_KEYS, "transfer");
    return validateTransfer(payload);
  }

  throw new Prl20ValidationError(
    "UNSUPPORTED_OPERATION",
    `Unsupported PRL-20 operation: ${String(payload.op)}`
  );
}

export function safeParsePrl20Operation(rawJson) {
  try {
    return { ok: true, operation: parsePrl20Operation(rawJson) };
  } catch (error) {
    if (error instanceof Prl20ValidationError) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details
      };
    }
    throw error;
  }
}

export function createPrl20State() {
  return {
    tokens: {},
    balances: {},
    transferLots: {},
    operations: []
  };
}

export function applyPrl20Operation(state, operation, context = {}) {
  const next = cloneState(state);
  const prlsMint = operation.op === "mint" && isPrlsTicker(operation.tick);
  const record = {
    inscriptionId: context.inscriptionId ?? null,
    txid: context.txid ?? null,
    blockHeight: context.blockHeight ?? null,
    txIndex: context.txIndex ?? null,
    inscriptionIndex: context.inscriptionIndex ?? null,
    inscriptionNumber: context.inscriptionNumber ?? null,
    ownerOutpoint: context.ownerOutpoint ?? null,
    op: operation.op,
    ticker: operation.tick,
    ownerAddress: context.ownerAddress ?? null,
    ownerScriptPubKey: context.ownerScriptPubKey ?? null,
    source: context.source ?? null,
    amount: operation.amt ?? null,
    mintFeeRequired: context.mintFeeRequired ?? prlsMint,
    requiredMintFeeGrain:
      context.requiredMintFeeGrain === undefined
        ? (prlsMint ? PRLS.mintFeeGrain.toString() : null)
        : grainString(context.requiredMintFeeGrain),
    paidMintFeeGrain:
      context.paidMintFeeGrain === undefined ? null : grainString(context.paidMintFeeGrain),
    mintFeePaid: context.mintFeePaid ?? null,
    mintFeeAddress: context.mintFeeAddress ?? null,
    mintFeeScriptPubKey: context.mintFeeScriptPubKey ?? null,
    valid: false,
    invalidReason: null
  };

  if (operation.op === "deploy") {
    if (next.tokens[operation.tick]?.deployed) {
      record.invalidReason = "DEPLOY_ALREADY_EXISTS";
      next.operations.push(record);
      return { state: next, operation: record };
    }

    const prlsToken = isPrlsTicker(operation.tick);
    next.tokens[operation.tick] = {
      ticker: operation.tick,
      displayTicker: operation.tick.toUpperCase(),
      deployed: true,
      deployInscriptionId: record.inscriptionId,
      maxSupply: operation.max,
      mintLimit: operation.lim,
      mintFeeGrain: prlsToken ? PRLS.mintFeeGrain.toString() : "0",
      mintFeePrl: prlsToken ? PRLS.mintFeePrl : "0.00000000",
      decimals: operation.dec,
      fairMint: true,
      mintAmount: operation.lim,
      totalMints: operation.totalMints,
      mintedSupply: "0",
      mintCount: 0,
      deployerAddress: context.ownerAddress ?? null,
      deployerScriptPubKey: context.ownerScriptPubKey ?? null
    };
    record.valid = true;
    next.operations.push(record);
    return { state: next, operation: record };
  }

  if (operation.op === "mint") {
    const token = next.tokens[operation.tick];
    const ownerKey = context.ownerScriptPubKey ?? context.ownerAddress;

    const stateInvalidReason = mintStateInvalidReason(next, operation, ownerKey);
    if (stateInvalidReason) {
      record.invalidReason = stateInvalidReason;
      next.operations.push(record);
      return { state: next, operation: record };
    }

    const currentSupply = BigInt(token.mintedSupply);
    const mintAmount = BigInt(operation.amt);
    const requiredMintFeeGrain = BigInt(record.requiredMintFeeGrain ?? "0");
    const paidMintFeeGrain = BigInt(record.paidMintFeeGrain ?? "0");
    const mintFeePaid =
      context.mintFeePaid === undefined
        ? paidMintFeeGrain >= requiredMintFeeGrain
        : Boolean(context.mintFeePaid) && paidMintFeeGrain >= requiredMintFeeGrain;
    record.mintFeePaid = mintFeePaid;

    if (record.mintFeeRequired && !mintFeePaid) {
      record.invalidReason =
        paidMintFeeGrain > 0n ? "INSUFFICIENT_REQUIRED_MINT_FEE" : "MISSING_REQUIRED_MINT_FEE";
      next.operations.push(record);
      return { state: next, operation: record };
    }

    token.mintedSupply = (currentSupply + mintAmount).toString();
    token.mintCount += 1;
    next.balances[ownerKey] ??= {};
    next.balances[ownerKey][operation.tick] = (
      BigInt(next.balances[ownerKey][operation.tick] ?? "0") + mintAmount
    ).toString();
    record.valid = true;
    next.operations.push(record);
    return { state: next, operation: record };
  }

  if (operation.op === "transfer") {
    const token = next.tokens[operation.tick];
    const ownerKey = context.ownerScriptPubKey ?? context.ownerAddress;
    const amount = BigInt(operation.amt);

    if (!token?.deployed) {
      record.invalidReason = "TOKEN_NOT_DEPLOYED";
      next.operations.push(record);
      return { state: next, operation: record };
    }

    if (!ownerKey) {
      record.invalidReason = "TRANSFER_OWNER_REQUIRED";
      next.operations.push(record);
      return { state: next, operation: record };
    }

    if (!record.inscriptionId) {
      record.invalidReason = "TRANSFER_INSCRIPTION_ID_REQUIRED";
      next.operations.push(record);
      return { state: next, operation: record };
    }

    const currentBalance = BigInt(next.balances[ownerKey]?.[operation.tick] ?? "0");
    if (currentBalance < amount) {
      record.invalidReason = "INSUFFICIENT_PRL20_BALANCE";
      next.operations.push(record);
      return { state: next, operation: record };
    }

    next.balances[ownerKey][operation.tick] = (currentBalance - amount).toString();
    next.transferLots[record.inscriptionId] = {
      id: record.inscriptionId,
      inscriptionId: record.inscriptionId,
      txid: record.txid,
      blockHeight: record.blockHeight,
      inscriptionNumber: record.inscriptionNumber,
      ticker: operation.tick,
      displayTicker: operation.tick.toUpperCase(),
      amount: operation.amt,
      originalOwnerAddress: context.ownerAddress ?? null,
      originalOwnerScriptPubKey: context.ownerScriptPubKey ?? null,
      originalOwnerKey: ownerKey,
      originalOutpoint: context.ownerOutpoint ?? null,
      status: "transferable"
    };
    record.valid = true;
    next.operations.push(record);
    return { state: next, operation: record };
  }

  throw new Prl20ValidationError(
    "UNSUPPORTED_OPERATION",
    `Unsupported PRL-20 operation: ${operation.op}`
  );
}

export function getPrlsToken(state) {
  return state.tokens[PRLS.ticker] ?? {
    ticker: PRLS.ticker,
    displayTicker: PRLS.displayTicker,
    deployed: false,
    maxSupply: PRLS.maxSupply.toString(),
    mintLimit: PRLS.mintLimit.toString(),
    mintFeeGrain: PRLS.mintFeeGrain.toString(),
    mintFeePrl: PRLS.mintFeePrl,
    decimals: PRLS.decimals,
    fairMint: true,
    mintAmount: PRLS.mintAmount.toString(),
    totalMints: PRLS.totalMints,
    mintedSupply: "0",
    mintCount: 0
  };
}

export function getAddressPrlsBalance(state, ownerKey) {
  return state.balances[ownerKey]?.[PRLS.ticker] ?? "0";
}

export function getPrl20Token(state, ticker) {
  const normalizedTicker = normalizeTicker(ticker);
  if (isPrlsTicker(normalizedTicker)) {
    return getPrlsToken(state);
  }
  return state.tokens[normalizedTicker] ?? null;
}

export function getAddressTokenBalance(state, ownerKey, ticker) {
  const normalizedTicker = normalizeTicker(ticker);
  return state.balances[ownerKey]?.[normalizedTicker] ?? "0";
}

export function getAddressTokenBalances(state, ownerKey) {
  return { ...(state.balances[ownerKey] ?? {}) };
}

export function isMintFeeEligible(state, operation, context = {}) {
  if (operation?.op !== "mint" || !isPrlsTicker(operation.tick)) {
    return false;
  }
  const ownerKey = context.ownerScriptPubKey ?? context.ownerAddress;
  return mintStateInvalidReason(state, operation, ownerKey) === null;
}

function validateDeploy(payload) {
  const tick = normalizeTicker(payload.tick);
  const max = parseIntegerString("max", payload.max);
  const lim = parseIntegerString("lim", payload.lim);
  const dec = parseIntegerString("dec", payload.dec);

  if (max <= 0n) {
    throw new Prl20ValidationError(
      "INVALID_MAX_SUPPLY",
      "PRL-20 deploy max must be greater than zero"
    );
  }
  if (lim <= 0n) {
    throw new Prl20ValidationError(
      "INVALID_MINT_LIMIT",
      "PRL-20 deploy lim must be greater than zero"
    );
  }
  if (lim > max) {
    throw new Prl20ValidationError(
      "INVALID_MINT_LIMIT",
      "PRL-20 deploy lim cannot exceed max"
    );
  }
  if (dec > BigInt(MAX_DECIMALS)) {
    throw new Prl20ValidationError(
      "INVALID_DECIMALS",
      `PRL-20 deploy dec cannot exceed ${MAX_DECIMALS}`
    );
  }

  if (isPrlsTicker(tick) && max !== PRLS.maxSupply) {
    throw new Prl20ValidationError(
      "INVALID_PRLS_MAX_SUPPLY",
      `PRLS deploy max must be ${PRLS.maxSupply.toString()}`
    );
  }
  if (isPrlsTicker(tick) && lim !== PRLS.mintLimit) {
    throw new Prl20ValidationError(
      "INVALID_PRLS_MINT_LIMIT",
      `PRLS deploy lim must be ${PRLS.mintLimit.toString()}`
    );
  }
  if (isPrlsTicker(tick) && dec !== BigInt(PRLS.decimals)) {
    throw new Prl20ValidationError(
      "INVALID_PRLS_DECIMALS",
      `PRLS deploy dec must be ${PRLS.decimals}`
    );
  }

  return {
    p: PRL20_PROTOCOL,
    op: "deploy",
    tick,
    max: max.toString(),
    lim: lim.toString(),
    dec: Number(dec),
    fairMint: true,
    totalMints: isPrlsTicker(tick) ? PRLS.totalMints : safeTotalMints(max, lim)
  };
}

function validateMint(payload) {
  const tick = normalizeTicker(payload.tick);
  const amt = parseIntegerString("amt", payload.amt);

  if (amt <= 0n) {
    throw new Prl20ValidationError(
      "INVALID_MINT_AMOUNT",
      "PRL-20 mint amt must be greater than zero"
    );
  }

  if (isPrlsTicker(tick) && amt !== PRLS.mintAmount) {
    throw new Prl20ValidationError(
      "INVALID_PRLS_MINT_AMOUNT",
      `PRLS mint amt must be exactly ${PRLS.mintAmount.toString()}`
    );
  }

  return {
    p: PRL20_PROTOCOL,
    op: "mint",
    tick,
    amt: amt.toString()
  };
}

function validateTransfer(payload) {
  const tick = normalizeTicker(payload.tick);
  const amt = parseIntegerString("amt", payload.amt);

  if (amt <= 0n) {
    throw new Prl20ValidationError(
      "INVALID_TRANSFER_AMOUNT",
      "PRL-20 transfer amt must be greater than zero"
    );
  }

  if (isPrlsTicker(tick) && amt > PRLS.maxSupply) {
    throw new Prl20ValidationError(
      "INVALID_PRLS_TRANSFER_AMOUNT",
      `PRLS transfer amt cannot exceed ${PRLS.maxSupply.toString()}`
    );
  }

  return {
    p: PRL20_PROTOCOL,
    op: "transfer",
    tick,
    amt: amt.toString()
  };
}

function mintStateInvalidReason(state, operation, ownerKey) {
  const token = state.tokens[operation.tick];
  if (!token?.deployed) {
    return "TOKEN_NOT_DEPLOYED";
  }
  if (!ownerKey) {
    return "MINT_OWNER_REQUIRED";
  }
  const currentSupply = BigInt(token.mintedSupply);
  const mintAmount = BigInt(operation.amt);
  if (mintAmount > BigInt(token.mintLimit)) {
    return "MINT_AMOUNT_EXCEEDS_LIMIT";
  }
  if (isPrlsTicker(operation.tick) && token.mintCount >= PRLS.totalMints) {
    return "TOTAL_MINT_COUNT_REACHED";
  }
  if (currentSupply + mintAmount > BigInt(token.maxSupply)) {
    return "MAX_SUPPLY_EXCEEDED";
  }
  return null;
}

function validateCommonPayload(payload) {
  for (const key of COMMON_KEYS) {
    if (!(key in payload)) {
      throw new Prl20ValidationError(
        "MISSING_FIELD",
        `Missing required field: ${key}`,
        { field: key }
      );
    }
    if (typeof payload[key] !== "string") {
      throw new Prl20ValidationError(
        "FIELD_MUST_BE_STRING",
        `Field ${key} must be a string`,
        { field: key }
      );
    }
  }

  if (payload.p !== PRL20_PROTOCOL) {
    throw new Prl20ValidationError(
      "INVALID_PROTOCOL",
      `Protocol must be ${PRL20_PROTOCOL}`
    );
  }

  const ticker = normalizeTicker(payload.tick);
  if (!TICKER_PATTERN.test(ticker)) {
    throw new Prl20ValidationError(
      "INVALID_TICKER",
      "PRL-20 tick must be 1-16 ASCII letters or digits"
    );
  }
}

export function normalizeTicker(ticker) {
  if (typeof ticker !== "string") {
    throw new Prl20ValidationError(
      "FIELD_MUST_BE_STRING",
      "Field tick must be a string",
      { field: "tick" }
    );
  }
  return ticker.toLowerCase();
}

function isPrlsTicker(ticker) {
  return normalizeTicker(ticker) === PRLS.ticker;
}

function safeTotalMints(max, lim) {
  const total = (max + lim - 1n) / lim;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString();
}

export function parseStrictJsonObject(rawJson) {
  if (typeof rawJson !== "string") {
    throw new Prl20ValidationError("PAYLOAD_NOT_STRING", "Payload must be a string");
  }

  const duplicateKeys = findDuplicateTopLevelKeys(rawJson);
  if (duplicateKeys.length > 0) {
    throw new Prl20ValidationError(
      "DUPLICATE_FIELD",
      `Duplicate JSON field: ${duplicateKeys[0]}`,
      { fields: duplicateKeys }
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    throw new Prl20ValidationError("MALFORMED_JSON", "Payload is not valid JSON");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Prl20ValidationError(
      "PAYLOAD_NOT_OBJECT",
      "Payload must be a JSON object"
    );
  }

  for (const [key, value] of Object.entries(payload)) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Prl20ValidationError("INVALID_FIELD_NAME", "Field names must be non-empty");
    }
    if (value !== null && typeof value === "object") {
      throw new Prl20ValidationError(
        "NESTED_VALUE_UNSUPPORTED",
        `Nested values are not supported for field ${key}`,
        { field: key }
      );
    }
  }

  return payload;
}

function assertOnlyKeys(payload, allowedKeys, op) {
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Prl20ValidationError(
        "UNKNOWN_FIELD",
        `Unknown ${op} field: ${key}`,
        { field: key }
      );
    }
  }
}

function parseIntegerString(field, value) {
  if (typeof value !== "string") {
    throw new Prl20ValidationError(
      "FIELD_MUST_BE_STRING",
      `Field ${field} must be a string`,
      { field }
    );
  }

  if (!INTEGER_STRING.test(value)) {
    throw new Prl20ValidationError(
      "INVALID_NUMERIC_STRING",
      `Field ${field} must be a non-negative base-10 integer string without leading zeroes`,
      { field, value }
    );
  }

  return BigInt(value);
}

function findDuplicateTopLevelKeys(rawJson) {
  const text = rawJson.trim();
  if (!text.startsWith("{")) {
    return [];
  }

  let index = 1;
  const seen = new Set();
  const duplicates = [];

  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (text[index] === "}") {
      return duplicates;
    }
    if (text[index] !== "\"") {
      return duplicates;
    }

    const keyToken = readJsonStringToken(text, index);
    if (!keyToken) {
      return duplicates;
    }
    let key;
    try {
      key = JSON.parse(keyToken.raw);
    } catch {
      return duplicates;
    }
    if (seen.has(key) && !duplicates.includes(key)) {
      duplicates.push(key);
    }
    seen.add(key);
    index = skipWhitespace(text, keyToken.nextIndex);
    if (text[index] !== ":") {
      return duplicates;
    }
    index = skipTopLevelValue(text, index + 1);
    index = skipWhitespace(text, index);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] === "}") {
      return duplicates;
    }
    return duplicates;
  }

  return duplicates;
}

function readJsonStringToken(text, startIndex) {
  let index = startIndex + 1;
  let escaped = false;
  while (index < text.length) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      return {
        raw: text.slice(startIndex, index + 1),
        nextIndex: index + 1
      };
    }
    index += 1;
  }
  return null;
}

function skipTopLevelValue(text, startIndex) {
  let index = skipWhitespace(text, startIndex);
  let depth = 0;
  let inString = false;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === "\"") {
      inString = true;
      index += 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return index;
    }
    index += 1;
  }

  return index;
}

function skipWhitespace(text, index) {
  while (/\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function cloneState(state) {
  const tokens = {};
  for (const [ticker, token] of Object.entries(state.tokens ?? {})) {
    tokens[ticker] = { ...token };
  }

  const balances = {};
  for (const [owner, tickerBalances] of Object.entries(state.balances ?? {})) {
    balances[owner] = { ...tickerBalances };
  }

  return {
    tokens,
    balances,
    transferLots: Object.fromEntries(
      Object.entries(state.transferLots ?? {}).map(([id, lot]) => [id, { ...lot }])
    ),
    operations: [...(state.operations ?? [])]
  };
}

function grainString(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  const text = String(value ?? "").trim();
  if (!INTEGER_STRING.test(text)) {
    throw new Prl20ValidationError(
      "INVALID_CONTEXT_GRAIN_AMOUNT",
      "Context grain amounts must be non-negative integer strings"
    );
  }
  return text;
}
