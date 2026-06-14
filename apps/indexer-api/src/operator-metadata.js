export const OPERATOR_METADATA_SCHEMA = "pearlscriptions-indexer-operator-v1";

const TEXT_LIMITS = Object.freeze({
  name: 80,
  region: 40,
  registryChallenge: 256,
  rewardAddress: 128,
  url: 2048
});

const EXPECTED_URL_PROOFS = new Set(["not-configured", "challenge-present"]);
const EXPECTED_REWARD_ADDRESS_PROOFS = new Set(["not-configured", "wallet-selected-deferred"]);
const OPERATOR_ENDPOINTS = Object.freeze({
  health: "/health",
  status: "/indexer/status",
  digest: "/indexer/digest",
  operator: "/operator",
  wellKnown: "/.well-known/pearlscriptions-indexer.json"
});

export function loadOperatorMetadata(env = {}) {
  const metadata = {
    name: optionalPlainText(env.PRL20_OPERATOR_NAME, "PRL20_OPERATOR_NAME", TEXT_LIMITS.name),
    publicUrl: optionalPublicUrl(env.PRL20_OPERATOR_PUBLIC_URL, "PRL20_OPERATOR_PUBLIC_URL"),
    rewardAddress: optionalRewardAddress(env.PRL20_OPERATOR_REWARD_ADDRESS),
    region: optionalPlainText(env.PRL20_OPERATOR_REGION, "PRL20_OPERATOR_REGION", TEXT_LIMITS.region),
    contactUrl: optionalContactUrl(env.PRL20_OPERATOR_CONTACT_URL, "PRL20_OPERATOR_CONTACT_URL"),
    registryChallenge: optionalPlainText(
      env.PRL20_OPERATOR_REGISTRY_CHALLENGE,
      "PRL20_OPERATOR_REGISTRY_CHALLENGE",
      TEXT_LIMITS.registryChallenge
    )
  };
  return {
    configured: Object.values(metadata).some((value) => value !== null),
    ...metadata
  };
}

export function operatorMetadataDocument(metadata = {}, { chain, version, forkEra } = {}) {
  const safeMetadata = {
    configured: Boolean(metadata.configured),
    name: metadata.name ?? null,
    publicUrl: metadata.publicUrl ?? null,
    rewardAddress: metadata.rewardAddress ?? null,
    region: metadata.region ?? null,
    contactUrl: metadata.contactUrl ?? null,
    registryChallenge: metadata.registryChallenge ?? null
  };
  return {
    schema: OPERATOR_METADATA_SCHEMA,
    service: "pearlscriptions-indexer",
    readOnly: true,
    configured: safeMetadata.configured,
    chain: chain ?? null,
    version: version ?? null,
    // MoE hard fork: static, OPTIONAL advisory tag. Older operator self-checks
    // must still pass validateOperatorMetadataDocument, so this is never required
    // by the validator and is omitted when not provided.
    ...(forkEra ? { forkEra } : {}),
    endpoints: OPERATOR_ENDPOINTS,
    operator: {
      name: safeMetadata.name,
      publicUrl: safeMetadata.publicUrl,
      rewardAddress: safeMetadata.rewardAddress,
      region: safeMetadata.region,
      contactUrl: safeMetadata.contactUrl
    },
    registry: {
      urlProof: safeMetadata.registryChallenge ? "challenge-present" : "not-configured",
      rewardAddressProof: safeMetadata.rewardAddress ? "wallet-selected-deferred" : "not-configured",
      challenge: safeMetadata.registryChallenge
    }
  };
}

export function validateOperatorMetadataDocument(document) {
  const errors = [];
  const operator = document?.operator ?? {};
  const registry = document?.registry ?? {};
  if (document?.schema !== OPERATOR_METADATA_SCHEMA) {
    errors.push("OPERATOR_SCHEMA_INVALID");
  }
  if (document?.readOnly !== true) {
    errors.push("OPERATOR_READ_ONLY_NOT_TRUE");
  }
  if (document?.service !== "pearlscriptions-indexer") {
    errors.push("OPERATOR_SERVICE_INVALID");
  }
  if (!hasExpectedEndpoints(document?.endpoints)) {
    errors.push("OPERATOR_ENDPOINTS_INVALID");
  }
  let publicUrl = null;
  try {
    optionalPlainText(operator.name, "operator.name", TEXT_LIMITS.name);
  } catch {
    errors.push("OPERATOR_NAME_INVALID");
  }
  try {
    publicUrl = optionalPublicUrl(operator.publicUrl, "operator.publicUrl");
  } catch {
    errors.push("OPERATOR_PUBLIC_URL_INVALID");
  }
  let rewardAddress = null;
  try {
    rewardAddress = optionalRewardAddress(operator.rewardAddress, "operator.rewardAddress");
  } catch {
    errors.push("OPERATOR_REWARD_ADDRESS_INVALID");
  }
  try {
    optionalPlainText(operator.region, "operator.region", TEXT_LIMITS.region);
  } catch {
    errors.push("OPERATOR_REGION_INVALID");
  }
  try {
    optionalContactUrl(operator.contactUrl, "operator.contactUrl");
  } catch {
    errors.push("OPERATOR_CONTACT_URL_INVALID");
  }
  let challenge = null;
  try {
    challenge = optionalPlainText(registry.challenge, "registry.challenge", TEXT_LIMITS.registryChallenge);
  } catch {
    errors.push("OPERATOR_REGISTRY_CHALLENGE_INVALID");
  }
  if (!EXPECTED_URL_PROOFS.has(registry.urlProof)) {
    errors.push("OPERATOR_REGISTRY_URL_PROOF_INVALID");
  }
  if (!EXPECTED_REWARD_ADDRESS_PROOFS.has(registry.rewardAddressProof)) {
    errors.push("OPERATOR_REGISTRY_REWARD_ADDRESS_PROOF_INVALID");
  }
  if (registry.urlProof === "challenge-present" && !challenge) {
    errors.push("OPERATOR_REGISTRY_CHALLENGE_MISSING");
  }
  if (registry.urlProof === "not-configured" && challenge) {
    errors.push("OPERATOR_REGISTRY_CHALLENGE_UNEXPECTED");
  }
  if (registry.urlProof === "challenge-present" && !publicUrl) {
    errors.push("OPERATOR_REGISTRY_PUBLIC_URL_MISSING");
  }
  if (registry.rewardAddressProof === "wallet-selected-deferred" && !rewardAddress) {
    errors.push("OPERATOR_REGISTRY_REWARD_ADDRESS_MISSING");
  }
  if (registry.rewardAddressProof === "not-configured" && rewardAddress) {
    errors.push("OPERATOR_REGISTRY_REWARD_ADDRESS_UNEXPECTED");
  }
  return errors;
}

function hasExpectedEndpoints(endpoints) {
  if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) {
    return false;
  }
  return Object.entries(OPERATOR_ENDPOINTS).every(([key, expected]) => endpoints[key] === expected);
}

function optionalPlainText(value, fieldName, maxLength) {
  const text = optionalTrimmed(value, fieldName);
  if (text === null) {
    return null;
  }
  if (text.length > maxLength) {
    throw new Error(`${fieldName} exceeds ${maxLength} characters`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>]/.test(text)) {
    throw new Error(`${fieldName} must be plain text without control characters or angle brackets`);
  }
  return text;
}

function optionalPublicUrl(value, fieldName) {
  const text = optionalTrimmed(value, fieldName);
  if (text === null) {
    return null;
  }
  if (text.length > TEXT_LIMITS.url) {
    throw new Error(`${fieldName} exceeds ${TEXT_LIMITS.url} characters`);
  }
  const url = parseUrl(text, fieldName);
  if (url.protocol !== "https:") {
    throw new Error(`${fieldName} must use https`);
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName} must not include username or password`);
  }
  if (url.search || url.hash) {
    throw new Error(`${fieldName} must not include query strings or fragments`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${fieldName} must be an origin URL without a path`);
  }
  return url.origin;
}

function optionalContactUrl(value, fieldName) {
  const text = optionalTrimmed(value, fieldName);
  if (text === null) {
    return null;
  }
  if (text.length > TEXT_LIMITS.url) {
    throw new Error(`${fieldName} exceeds ${TEXT_LIMITS.url} characters`);
  }
  const url = parseUrl(text, fieldName);
  if (url.protocol !== "https:") {
    throw new Error(`${fieldName} must use https`);
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName} must not include username or password`);
  }
  return url.toString();
}

function optionalRewardAddress(value, fieldName = "PRL20_OPERATOR_REWARD_ADDRESS") {
  const text = optionalTrimmed(value, fieldName);
  if (text === null) {
    return null;
  }
  if (text.length > TEXT_LIMITS.rewardAddress) {
    throw new Error(`${fieldName} exceeds ${TEXT_LIMITS.rewardAddress} characters`);
  }
  const normalized = text.toLowerCase();
  if (!/^(?:prl|rprl)1[ac-hj-np-z02-9]{6,120}$/.test(normalized)) {
    throw new Error(`${fieldName} must be a Pearl bech32 address`);
  }
  return normalized;
}

function parseUrl(value, fieldName) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
}

function optionalTrimmed(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const text = value.trim();
  return text === "" ? null : text;
}
