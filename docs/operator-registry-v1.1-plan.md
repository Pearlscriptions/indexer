# Operator Registry v1.1 Plan

This document is a planning brief for a future Pearlscriptions public indexer
operator registry. It does not change the v1.0 public indexer boundary:
the public indexer remains read-only, deterministic, protocol-focused, and free
of wallet, signing, broadcast, marketplace, orderbook, and settlement logic.

## 1. Product Goal

The v1.1 registry should make independent Pearlscriptions infrastructure visible
and verifiable without turning the public indexer into an official marketplace or
custodial service.

Goals:

- show independent community operators and their public indexer URLs;
- let users compare live health, chain tip, release manifest digest, and
  deterministic snapshot digest across indexers;
- make Pearlscriptions visibly reproducible instead of dependent on one official
  API;
- create a future eligibility trail for Genesis Oyster Pearlscription rewards;
- preserve the v1 indexer security boundary: no wallets, no private keys, no
  transaction signing, no transaction broadcast, no orderbook, no settlement.

Non-goals:

- no official endorsement that a listed operator is honest;
- no custody or reward-address private material;
- no marketplace listing, matching, buying, selling, sweeping, or settlement;
- no mutation routes in the public indexer package.

## 2. Recommended Architecture

Keep five components separate.

### Public Indexer Package

Each operator runs the public indexer independently against their own Pearl node.
The package serves read-only API state:

- `GET /health`
- `GET /indexer/status`
- `GET /indexer/digest`
- PRL-20, inscription, address, UTXO, and transfer-lot read routes

Optional v1.1 additions may expose static operator metadata, but must remain
read-only and must never accept user secrets.

### Official Registry API

The registry API should live in the official Pearlscriptions backend, not in the
public indexer. It owns registration, validation, rate limits, moderation state,
and reward eligibility data.

### Official Website Registry UI

The website should provide:

- a "Run an indexer" guide;
- a "Register your indexer" flow;
- a public operator list;
- health, sync, digest, and uptime badges;
- reward campaign status and privacy notes.

### Monitoring / Checker Worker

A worker owned by the official backend periodically checks registered indexers.
It must fetch only allowlisted public endpoints, enforce SSRF protections, cap
response size, and record health/digest observations.

### Reward Eligibility / Export Process

Reward eligibility should be derived from stored health history, digest matches,
address proof status, and manual review. Distribution should be a separate,
explicit process, not an automatic side effect of being listed.

## 3. Registration Flow

Recommended flow:

1. Operator runs the public indexer against their own Pearl node.
2. Operator exposes the indexer through a public HTTPS URL.
3. Operator opens the future official Pearlscriptions registry page, for
   example `https://www.pearlscriptions.com/indexer`.
4. Operator selects the Pearl reward address in the official website wallet
   flow. The public indexer never connects to the wallet.
5. Operator enters:
   - public indexer base URL;
   - optional display name;
   - optional X/GitHub/contact URL;
   - optional region;
   - optional notes.
6. Registry validates URL syntax before any network request.
7. Registry creates a short-lived challenge bound to:
   - registry origin;
   - normalized indexer URL;
   - selected reward address;
   - nonce;
   - expiry;
   - challenge version.
8. Operator copies the public URL, reward address, and challenge into the
   indexer environment:

   ```text
   PRL20_OPERATOR_PUBLIC_URL=https://operator.example
   PRL20_OPERATOR_REWARD_ADDRESS=prl1...
   PRL20_OPERATOR_REGISTRY_CHALLENGE=registry-challenge-nonce
   ```

9. Operator restarts the indexer.
10. Registry checker fetches:
    - `/.well-known/pearlscriptions-indexer.json`
    - `/health`
    - `/indexer/status`
    - `/indexer/digest`
11. Registry verifies that the metadata challenge, public URL, and reward
    address match the challenge record.
12. Registry creates a record with status:
   - `pending` while proofs or checks are incomplete;
   - `active` when URL proof and health checks pass;
   - `invalid` when checks fail hard;
   - `suspended` for abuse or manual moderation;
   - `retired` when an operator removes or abandons the indexer.

URL normalization rules:

- require `https://`;
- reject username/password in URL;
- reject query strings and fragments;
- normalize host casing and trailing slash;
- optionally restrict to default port `443` until a clear need exists;
- store normalized origin separately from submitted display URL.

A custom domain is not required. Operators may use a stable public HTTPS
hostname from a VPS/app provider, an HTTPS tunnel, dynamic DNS, an
`sslip.io`/`nip.io` style hostname, or their own domain. Localhost and private
network addresses are useful for local self-checks only; they cannot be listed
as public registry endpoints.

## 4. Wallet / Reward Address Binding

The registry must never ask for seed phrases, private keys, WIF, mnemonic words,
RPC passwords, browser wallet export data, unsigned transaction payloads, or
custodial control.

### v1.1 Path: Wallet-Selected, Cryptographic Proof Deferred

For v1.1, the reward address is selected in the official Pearlscriptions website
wallet flow and then must appear in the operator indexer metadata. This binds
the visible indexer URL claim to the reward address the operator selected in the
official flow, but it does not yet prove cryptographic control of that address.

The public indexer exposes:

```json
{
  "operator": {
    "publicUrl": "https://operator.example",
    "rewardAddress": "prl1..."
  },
  "registry": {
    "urlProof": "challenge-present",
    "rewardAddressProof": "wallet-selected-deferred",
    "challenge": "registry-challenge-nonce"
  }
}
```

The official registry stores `addressProofStatus = "wallet-selected-deferred"`
or equivalent until a Pearl message-signing standard is confirmed. Genesis
Oyster reward selection must remain manual and reviewed; there is no automatic
payout logic in the public indexer.

### Future Path: Signed Challenge

If Pearl wallet tooling supports safe message signing for the reward address,
use a client-side signed challenge.

Challenge text:

```text
Pearlscriptions Indexer Registry v1.1
registry: https://www.pearlscriptions.com
indexerUrl: https://operator.example
rewardAddress: prl1...
nonce: <random 128-bit value>
issuedAt: <ISO timestamp>
expiresAt: <ISO timestamp>
purpose: operator-registry-reward-address-proof
```

The client submits:

- challenge id;
- reward address;
- signature;
- public key or witness data if required by the Pearl verification method;
- wallet software identifier, optional and user-controlled.

Replay protection:

- nonce must be random and single-use;
- challenge expires quickly, for example 10 minutes;
- challenge binds registry origin, indexer URL, reward address, and purpose;
- registry stores only signature proof metadata, not wallet secrets.

Stored fields:

- reward address;
- signature;
- public key or verification material if needed;
- challenge hash;
- proof method;
- verified timestamp;
- wallet software string if supplied.

### URL Control Proof

Use one of these, in order of preference:

1. `/.well-known/pearlscriptions-indexer.json` on the same origin as the
   submitted indexer URL.
2. Optional v1.1 read-only indexer endpoint such as `GET /operator`, returning
   configured metadata and current challenge.
3. DNS TXT record for operators using custom domains.

Example `.well-known` file:

```json
{
  "schema": "pearlscriptions-indexer-operator-v1",
  "service": "pearlscriptions-indexer",
  "readOnly": true,
  "chain": "pearl-mainnet",
  "version": "1.1.0",
  "endpoints": {
    "health": "/health",
    "status": "/indexer/status",
    "digest": "/indexer/digest",
    "operator": "/operator",
    "wellKnown": "/.well-known/pearlscriptions-indexer.json"
  },
  "operator": {
    "publicUrl": "https://operator.example",
    "rewardAddress": "prl1..."
  },
  "registry": {
    "urlProof": "challenge-present",
    "rewardAddressProof": "wallet-selected-deferred",
    "challenge": "registry-challenge-nonce"
  }
}
```

### If Pearl Message Signing Remains Unavailable

Do not fake reward-address ownership.

Recommended fallback:

- allow listing with `addressProofStatus = "wallet-selected-deferred"`;
- require URL control proof for registry visibility;
- require message-signing proof later, before reward eligibility or claim;
- if message signing cannot be standardized, consider a small on-chain proof
  transaction only for reward eligibility, after privacy and cost review.

On-chain proof tradeoffs:

- strongest address-control proof if message signing is unavailable;
- costs PRL and creates public linkage;
- can exclude operators who do not want to spend or reveal linkage;
- should not be required for basic public listing in v1.1.

## 5. Health Check Model

The checker should evaluate only public read endpoints.

Required checks:

- URL is reachable over HTTPS;
- TLS certificate is valid;
- `GET /health` returns JSON, `readOnly: true`, expected service name, and no
  local path leakage;
- `GET /indexer/status` returns chain, indexed height/hash when available,
  sync mode, storage health, and no local store path;
- `GET /indexer/digest` returns chain, snapshot digest, release manifest digest,
  indexed height/hash, and summary;
- chain is `pearl-mainnet` for mainnet registry;
- release manifest digest matches the current public release manifest;
- indexed height is within a configured lag threshold;
- digest matches the official/reference digest at the same chain height/hash;
- response latency is below warning and failure thresholds;
- repeated checks show the indexer is advancing when the Pearl chain advances.

Suggested thresholds for v1.1 beta:

- hard timeout: 5 seconds per request;
- max JSON body: 512 KB for health/status/digest;
- warning latency: over 1500 ms;
- failure latency: over 5000 ms or timeout;
- healthy lag: <= 6 blocks or <= 30 minutes, whichever is stricter after chain
  cadence is confirmed;
- stale warning: same indexed height for 3 consecutive checks while reference
  height advances;
- active status: at least 3 successful checks over 30 minutes.

Digest comparison:

- compare only when chain, indexed height, indexed hash, and release manifest
  digest match the reference;
- if the operator is behind, classify as `lagging`, not `digest_mismatch`;
- if height/hash match but digest differs, classify as `consensus_mismatch`;
- record mismatches for manual review and do not count them as healthy time.

## 6. Anti-Sybil And Reward Eligibility

Sybil resistance cannot be solved completely with an HTTP registry, and running
many real independent indexers is not harmful by itself. More healthy endpoints
can improve the visible network. Rewards should therefore be selective and
reviewed rather than distributed automatically to every registered operator.

Pragmatic v1.1 model:

- one normalized URL can have one active registration;
- one reward address may register multiple indexers, but reward scoring can be
  capped per reward address or manually bucketed;
- require unique URL origin;
- require URL control proof;
- require minimum active days before reward eligibility;
- require minimum synced percentage over the campaign window;
- require digest match percentage over comparable checks;
- penalize repeated consensus mismatches;
- flag duplicate fingerprints such as identical IP ASN, identical TLS cert,
  identical response headers, and synchronized downtime;
- use manual review for top reward candidates;
- export reward snapshots rather than auto-paying.

Example eligibility gates:

- URL proof verified;
- reward address wallet-selected in the official flow and present in the
  operator metadata;
- at least 14 active days;
- at least 95% successful checker windows;
- at least 98% digest match where comparable;
- no unresolved critical security or abuse flags;
- latest status healthy at snapshot time.

Reward export should include:

- operator id;
- normalized URL;
- reward address;
- score;
- active days;
- successful checks;
- comparable digest checks;
- digest matches;
- mismatch count;
- notes and review state.

## 7. API Design

These endpoints belong to the official registry backend, not the public indexer.

### `POST /api/indexer-registry/challenge`

Creates a URL proof challenge bound to the selected reward address.

Request:

```json
{
  "indexerUrl": "https://operator.example",
  "rewardAddress": "prl1...",
  "displayName": "Operator name",
  "contactUrl": "https://x.com/operator",
  "region": "EU",
  "notes": "Optional"
}
```

Response:

```json
{
  "challengeId": "uuid",
  "nonce": "base64url-random",
  "expiresAt": "2026-06-01T12:00:00Z",
  "wellKnownUrl": "https://operator.example/.well-known/pearlscriptions-indexer.json",
  "env": {
    "PRL20_OPERATOR_PUBLIC_URL": "https://operator.example",
    "PRL20_OPERATOR_REWARD_ADDRESS": "prl1...",
    "PRL20_OPERATOR_REGISTRY_CHALLENGE": "registry-challenge-nonce"
  }
}
```

Validation:

- HTTPS URL only;
- no private IPs after DNS resolution;
- valid Pearl reward address format;
- per-IP and per-address rate limits;
- challenge expires and is single-use.

### `POST /api/indexer-registry/register`

Consumes the URL proof and creates or updates a pending registration.

Request:

```json
{
  "challengeId": "uuid",
  "urlProofMethod": "well-known",
  "addressProofMethod": "wallet-selected-deferred",
  "metadata": {
    "displayName": "Operator name",
    "contactUrl": "https://x.com/operator",
    "region": "EU"
  }
}
```

Response:

```json
{
  "operatorId": "idx_...",
  "status": "pending",
  "urlProofStatus": "verified",
  "addressProofStatus": "wallet-selected-deferred",
  "nextCheckAfter": "2026-06-01T12:01:00Z"
}
```

Failure cases:

- expired challenge;
- URL proof missing or mismatched;
- selected reward address does not match the operator metadata;
- URL already registered;
- reward address malformed;
- rate limited.

### `GET /api/indexer-registry/operators`

Returns public registry rows.

Query parameters:

- `status=active|lagging|invalid|pending`
- `chain=pearl-mainnet`
- `region=...`
- `limit`, `cursor`

Response:

```json
{
  "operators": [
    {
      "id": "idx_...",
      "displayName": "Operator name",
      "indexerUrl": "https://operator.example",
      "rewardAddress": "prl1...",
      "status": "active",
      "chain": "pearl-mainnet",
      "indexedHeight": 123456,
      "indexedHash": "...",
      "snapshotDigest": "...",
      "releaseManifestDigest": "...",
      "lagBlocks": 0,
      "latencyMs": 240,
      "uptime30d": 99.2,
      "digestMatch30d": 100,
      "lastCheckedAt": "2026-06-01T12:00:00Z",
      "version": "1.1.0"
    }
  ],
  "nextCursor": null
}
```

### `GET /api/indexer-registry/operators/:id`

Returns detailed public health history for one operator. Do not expose raw IP,
internal checker errors, private moderation notes, or sensitive abuse signals.

### `POST /api/indexer-registry/:id/refresh`

Optional endpoint to request an out-of-band check. Must be rate limited and
queued. It should not make the frontend directly fetch submitted URLs.

### Admin / Reward Export Endpoint

Admin-only endpoint or offline job:

```text
POST /api/admin/indexer-registry/reward-snapshot
```

It should require official admin auth and produce a reviewable export. It should
not auto-distribute rewards.

## 8. Data Model

### `registered_indexers`

Important fields:

- `id`
- `normalized_url`
- `url_hash`
- `hostname`
- `reward_address`
- `reward_address_hash`
- `display_name`
- `contact_url`
- `region`
- `notes_public`
- `status`
- `url_proof_status`
- `address_proof_status`
- `proof_method_url`
- `proof_method_address`
- `first_seen_at`
- `last_checked_at`
- `last_healthy_at`
- `suspended_at`
- `retired_at`
- `created_at`
- `updated_at`

Indexes:

- unique `url_hash`;
- index `reward_address_hash`;
- index `(status, last_checked_at)`;
- index `(hostname)`.

### `indexer_registry_challenges`

Fields:

- `id`
- `normalized_url`
- `reward_address`
- `nonce_hash`
- `challenge_payload_hash`
- `expires_at`
- `consumed_at`
- `created_ip_hash`
- `created_user_agent_hash`
- `url_proof_method`
- `address_proof_method`
- `created_at`

Indexes:

- unique `nonce_hash`;
- index `(expires_at)`;
- index `(normalized_url, created_at)`.

### `indexer_health_checks`

Fields:

- `id`
- `operator_id`
- `checked_at`
- `status`
- `http_status_health`
- `http_status_status`
- `http_status_digest`
- `latency_ms_health`
- `latency_ms_status`
- `latency_ms_digest`
- `chain`
- `indexed_height`
- `indexed_hash`
- `best_height`
- `lag_blocks`
- `error_code`
- `error_public`

Indexes:

- `(operator_id, checked_at DESC)`;
- `(status, checked_at DESC)`;
- `(chain, indexed_height)`.

### `indexer_digest_checks`

Fields:

- `id`
- `operator_id`
- `checked_at`
- `chain`
- `indexed_height`
- `indexed_hash`
- `snapshot_digest`
- `release_manifest_digest`
- `reference_snapshot_digest`
- `reference_release_manifest_digest`
- `comparison_status`
- `summary_json`

Indexes:

- `(operator_id, checked_at DESC)`;
- `(chain, indexed_height, indexed_hash)`;
- `(comparison_status, checked_at DESC)`.

### `reward_snapshots`

Fields:

- `id`
- `campaign_name`
- `snapshot_at`
- `criteria_json`
- `created_by`
- `created_at`

### `reward_candidates`

Fields:

- `snapshot_id`
- `operator_id`
- `reward_address`
- `score`
- `active_days`
- `successful_checks`
- `digest_checks`
- `digest_matches`
- `digest_mismatches`
- `review_status`
- `review_notes`

Indexes:

- `(snapshot_id, score DESC)`;
- `(reward_address)`;
- `(review_status)`.

## 9. Website UI Plan

Primary page sections:

- Run an indexer: short instructions and link to operator docs.
- Public HTTPS URL setup: explain provider hostnames, HTTPS tunnels, dynamic DNS,
  `sslip.io`/`nip.io`, and custom domains.
- Register your indexer: URL, wallet-selected reward address, optional metadata,
  proof steps.
- Community indexers: searchable and filterable operator list.
- Status badges: healthy, lagging, stale, digest mismatch, pending, invalid.
- Health details: height, lag, digest status, latency, uptime, version.
- Reward campaign: eligibility criteria, campaign dates, no guarantee notice.
- Privacy note: public URL, reward address, and submitted public metadata may be
  displayed.

Operator list columns:

- display name;
- region;
- indexer URL hostname;
- status;
- indexed height;
- lag;
- digest match;
- uptime;
- version;
- last checked;
- reward eligibility status.

Frontend trust rules:

- never call arbitrary submitted URLs from the browser;
- display checker results from the official registry API;
- treat operator-provided display fields as untrusted text;
- no HTML rendering from operator metadata;
- link out with safe `rel` attributes.

## 10. Public Indexer Repo Changes

Initial public-indexer-side compatibility additions:

- optional read-only `GET /operator`;
- optional read-only `GET /.well-known/pearlscriptions-indexer.json`;
- optional operator metadata environment variables;
- local `npm run registry:check` readiness command.
- public metadata schema with declared read-only endpoints;
- version reporting for operator/checker compatibility.

Further recommended v1.1 additions to this repo:

- docs page for registry compatibility and proof formats;
- optional DNS TXT proof docs if needed by the official registry;
- optional exported JSON schema for checker implementations.

Rules:

- no public indexer mutation routes;
- no wallet connection in the public indexer;
- no signing, transaction building, or transaction broadcast;
- no registry database in the public indexer;
- no official marketplace coupling.

## 11. Security Review

### SSRF Through Submitted URLs

Risk: attacker submits private IP, metadata endpoint, localhost, or redirect
chain to internal services.

Mitigations:

- HTTPS only;
- reject public registry submissions that are localhost, private IP, link-local,
  cloud metadata, or raw IP-literal endpoints;
- resolve DNS server-side and block private, loopback, link-local, multicast,
  reserved, and cloud metadata ranges;
- re-resolve before every check;
- block redirects or allow one redirect only after revalidation;
- no custom ports until needed;
- checker runs in a network sandbox with no access to internal services.
- website frontend must never fetch submitted operator URLs directly.

### Malicious Huge Responses

Risk: memory exhaustion or slow response attacks.

Mitigations:

- small request timeout;
- response byte cap;
- JSON parser cap;
- no compression bombs unless safely bounded;
- reject unexpected content types.

### Fake Digest

Risk: operator returns reference digest without actually indexing.

Mitigations:

- compare height/hash/digest over time;
- request multiple endpoints, not digest only;
- check that height advances naturally;
- optionally sample token/inscription routes at known tips;
- score over time, not one request.

### URL Takeover

Risk: abandoned domain or hosting takeover receives rewards.

Mitigations:

- periodic URL proof refresh;
- detect DNS/cert ownership changes;
- require re-proof before reward snapshot if stale;
- suspend on repeated certificate or host changes.

### Replayed Signatures

Risk: old signature re-used for another URL or reward address.

Mitigations:

- bind challenge to URL, reward address, registry origin, nonce, expiry, and
  purpose;
- single-use nonce;
- store challenge hash and consumed timestamp.

### Reward-Address Hijack

Risk: attacker registers someone else's reward address.

Mitigations:

- require address-control proof before reward eligibility;
- if proof is deferred, mark address as unverified and exclude from automatic
  reward snapshots;
- notify operators to re-verify before campaign close.

### Spam Registrations

Risk: registration flood and database bloat.

Mitigations:

- rate limits by IP, URL hash, hostname, and reward address;
- CAPTCHA or proof-of-work only on registry frontend if needed;
- pending records expire;
- moderation queue for suspicious metadata.

### DDoS Through Checker

Risk: attacker uses registry to make official backend hammer victims.

Mitigations:

- verify URL ownership before repeated checks;
- initial check rate limits;
- backoff failed checks;
- cap refresh endpoint usage;
- checker queue budget per hostname and ASN.

### Private IP Scanning

Risk: registry checker becomes a port scanner.

Mitigations:

- fixed path allowlist;
- no arbitrary path fetches;
- no non-HTTPS schemes;
- DNS/IP denylist;
- no custom headers from users.

### API Poisoning

Risk: operator metadata injects HTML or misleading links.

Mitigations:

- strict field length and character limits;
- render as text;
- validate URL fields;
- store raw and normalized metadata separately;
- moderation for display names.

### Frontend Trust Mistakes

Risk: browser directly fetches arbitrary operator URLs or treats status as
official truth.

Mitigations:

- frontend reads official registry API only;
- UI labels results as observed by registry checker;
- clear "independent operator" and "not official endpoint" wording.

## 12. Rollout Plan

1. v1.1 docs/spec plan in this repository.
2. Define Pearl reward-address proof standard or defer address proof.
3. Build local registry prototype outside the public indexer package.
4. Add optional read-only operator metadata endpoint to public indexer.
5. Add registry checker worker in staging.
6. Private beta with a small set of known operators.
7. Publish registry page with conservative labels and no reward promises.
8. Run reward campaign observation window.
9. Export reward snapshot for manual review.
10. Distribute Genesis Oyster rewards through a separate reviewed process.

## 13. Open Questions

- Does Pearl have a safe, wallet-supported message signing standard for the
  reward address type used by PRLS operators?
- What verification material is required for Taproot/Pearl address signatures?
- Should URL proof be `.well-known`, `GET /operator`, DNS TXT, or all three?
- Should reward address be public in the operator list, partially redacted, or
  visible only in reward exports?
- What is the canonical source of the reference digest for each height/hash?
- What lag threshold matches Pearl mainnet cadence in practice?
- Which free HTTPS URL patterns should the website guide document first:
  provider hostnames, tunnels, dynamic DNS, `sslip.io`/`nip.io`, or all of them?
- What is the exact Genesis Oyster reward scoring formula?
- Who performs manual review and how are disputes handled?
- Should operators be able to retire or rotate reward addresses, and with what
  proof?

## Recommendation

GO for v1.1 planning and prototype work.

Do not put the registry database, wallet connection, address signing, or reward
campaign logic into the public indexer package. The public indexer may add only
read-only metadata and self-check helpers. The official backend should own
registration, checking, scoring, and reward exports.
