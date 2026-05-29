import { createHash } from "node:crypto";

const VOLATILE_NETWORK_KEYS = new Set([
  "bestHeight",
  "blocksStored",
  "reorgCount",
  "source",
  "startHeight",
  "warning",
  "lastSyncedAt",
  "persistenceReady",
  "productionReady",
  "storageBackend",
  "storageProductionReady"
]);

export function normalizeSnapshotForComparison(snapshot) {
  const normalized = normalizeValue(snapshot);
  if (normalized?.network && typeof normalized.network === "object") {
    for (const key of VOLATILE_NETWORK_KEYS) {
      delete normalized.network[key];
    }
  }
  return normalized;
}

export function normalizeProtocolSnapshotForComparison(snapshot) {
  return normalizeSnapshotForComparison(publicProtocolSnapshot(snapshot));
}

export function snapshotDigest(snapshot) {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

export function compareSnapshots(left, right) {
  const normalizedLeft = normalizeSnapshotForComparison(left);
  const normalizedRight = normalizeSnapshotForComparison(right);
  const leftJson = stableStringify(normalizedLeft);
  const rightJson = stableStringify(normalizedRight);
  const ok = leftJson === rightJson;
  return {
    ok,
    leftDigest: snapshotDigest(normalizedLeft),
    rightDigest: snapshotDigest(normalizedRight),
    diff: ok ? null : firstMismatch(normalizedLeft, normalizedRight)
  };
}

export function summarizeSnapshot(snapshot) {
  return {
    chain: snapshot?.network?.chain ?? null,
    indexedHeight: snapshot?.network?.indexedHeight ?? snapshot?.network?.bestHeight ?? null,
    indexedHash: snapshot?.network?.indexedHash ?? null,
    tokenDeployed: snapshot?.token?.deployed ?? null,
    mintCount: snapshot?.token?.mintCount ?? 0,
    mintedSupply: snapshot?.token?.mintedSupply ?? "0",
    inscriptions: snapshot?.inscriptions?.length ?? 0,
    operations: snapshot?.operations?.length ?? 0,
    transferLots: snapshot?.transferLots?.length ?? 0
  };
}

export function publicProtocolSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return snapshot;
  }
  const projected = {};
  if (snapshot.network && typeof snapshot.network === "object" && !Array.isArray(snapshot.network)) {
    projected.network = pickDefined(snapshot.network, [
      "chain",
      "indexedHeight",
      "indexedHash",
      "prl20MintFee"
    ]);
  }
  if (snapshot.state && typeof snapshot.state === "object" && !Array.isArray(snapshot.state)) {
    projected.state = pickDefined(snapshot.state, [
      "tokens",
      "balances",
      "transferLots",
      "operations"
    ]);
  }
  for (const key of ["inscriptions", "token", "tokens", "operations", "transferLots"]) {
    if (snapshot[key] !== undefined) {
      projected[key] = snapshot[key];
    }
  }
  return projected;
}

export function stableStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

function normalizeValue(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = normalizeValue(value[key]);
  }
  return output;
}

function pickDefined(source, keys) {
  const output = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      output[key] = source[key];
    }
  }
  return output;
}

function firstMismatch(left, right, path = "$") {
  if (Object.is(left, right)) {
    return null;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return mismatch(path, left, right);
    }
    if (left.length !== right.length) {
      return mismatch(`${path}.length`, left.length, right.length);
    }
    for (let index = 0; index < left.length; index += 1) {
      const nested = firstMismatch(left[index], right[index], `${path}[${index}]`);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      return mismatch(path, left, right);
    }
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!(key in left) || !(key in right)) {
        return mismatch(`${path}.${key}`, left[key], right[key]);
      }
      const nested = firstMismatch(left[key], right[key], `${path}.${key}`);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  return mismatch(path, left, right);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mismatch(path, left, right) {
  return {
    path,
    left: previewValue(left),
    right: previewValue(right)
  };
}

function previewValue(value) {
  const text = stableStringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
