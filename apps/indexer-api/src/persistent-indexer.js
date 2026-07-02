import { createPrl20IngestSession, PRLS_MINT_FEE_POLICY, SKIP_UTXO_MAP } from "./indexer.js";
import {
  normalizeProtocolSnapshotForComparison,
  snapshotDigest,
  summarizeSnapshot
} from "./snapshot-compare.js";
import {
  assertHash,
  blockFileName,
  createIndexerStorage,
  readModelParityDigestFromSnapshot
} from "./storage.js";

const SCHEMA_VERSION = 1;

// MoE hard fork: minimum pearld version that activated the fork (2026-06-12).
// Advisory only — used to flag a node that predates the fork, never to block.
const MIN_NODE_VERSION = "1.1.0";
// btcd-style integer version encoding: major*1_000_000 + minor*10_000 + patch*100.
const MIN_NODE_VERSION_INT = 1010000;

export function createPersistentPrl20Indexer(options = {}) {
  return new PersistentPrl20Indexer(options);
}

export class PersistentPrl20Indexer {
  constructor({
    pearlRpc,
    storeDir,
    storage,
    storageBackend = "json-file",
    chain = "pearl-simnet",
    startHeight = 0,
    batchSize = 100,
    mintFeePolicy = PRLS_MINT_FEE_POLICY,
    rebuildChunkSize,
    parityCheckEveryNBlocks,
    parityMode,
    maxBlocksPerSync,
    // MoE hard fork advisory inputs (all optional / additive). canonicalCheckpoints
    // are the normalized pins from config ({ height, hash, placeholder }); forkEra
    // and indexerVersion are surfaced verbatim in status. None of these ever
    // mutate PRL-20 state, balances, or rollback — they are advisory only.
    canonicalCheckpoints = [],
    forkEra = "moe-v2",
    indexerVersion = null,
    log = console,
    now = () => new Date().toISOString()
  } = {}) {
    if (typeof pearlRpc !== "function") {
      throw new Error("PersistentPrl20Indexer requires a pearlRpc function");
    }
    if (!storeDir && !storage) {
      throw new Error("PersistentPrl20Indexer requires a storeDir");
    }

    this.pearlRpc = pearlRpc;
    this.storage = storage ?? createIndexerStorage({ backend: storageBackend, storeDir });
    this.storeDir = this.storage.storeDir ?? storeDir ?? null;
    this.chain = chain;
    this.startHeight = normalizeNonNegativeInteger(startHeight, "startHeight");
    this.batchSize = Math.max(1, Math.min(1000, normalizeNonNegativeInteger(batchSize, "batchSize")));
    const maxBlocksEnvRaw = Number(process.env.PRL20_INDEXER_MAX_BLOCKS_PER_SYNC);
    const maxBlocksEnv =
      Number.isInteger(maxBlocksEnvRaw) && maxBlocksEnvRaw > 0 ? maxBlocksEnvRaw : 0;
    this.maxBlocksPerSync = Math.max(
      0,
      Math.min(
        1000,
        normalizeNonNegativeInteger(maxBlocksPerSync ?? maxBlocksEnv, "maxBlocksPerSync")
      )
    );
    this.mintFeePolicy = mintFeePolicy;
    // Full rebuilds read and fold canonical blocks in bounded chunks so the
    // worker never holds the entire raw-block history in memory at once (that
    // simultaneous load was the cold-start OOM). Only the current chunk plus the
    // live session accumulators are resident. Env override is clamped to 1..5000.
    const rebuildChunkEnvRaw = Number(process.env.PRL20_INDEXER_REBUILD_CHUNK_SIZE);
    const rebuildChunkEnv =
      Number.isInteger(rebuildChunkEnvRaw) && rebuildChunkEnvRaw > 0 ? rebuildChunkEnvRaw : 0;
    this.rebuildChunkSize = Math.max(
      1,
      Math.min(5000, Number(rebuildChunkSize ?? rebuildChunkEnv) || 250)
    );
    this.now = now;
    this.manifest = null;
    this.syncPromise = null;
    // Incremental ingest state. The session keeps the fold accumulators (PRL-20
    // state + inscriptions + transaction index) alive between syncs so each
    // appended block costs O(block) instead of an O(history) rebuild from
    // genesis. sessionBlocks tracks the canonical (height, hash) pairs already
    // folded in, letting us detect when the stored chain still extends the
    // session tip (pure append) versus a rollback/reorg (full rebuild).
    this.ingestSession = null;
    this.sessionBlocks = [];
    // Optional safety net: every N appended blocks, also run a full rebuild and
    // compare protocol digests. 0 (default) disables it. Clamped >= 0.
    const parityEnvRaw = Number(process.env.PRL20_INDEXER_PARITY_CHECK_EVERY_N_BLOCKS);
    const parityEnv = Number.isInteger(parityEnvRaw) && parityEnvRaw >= 0 ? parityEnvRaw : 0;
    this.parityCheckEveryNBlocks = Math.max(
      0,
      normalizeNonNegativeInteger(parityCheckEveryNBlocks ?? parityEnv, "parityCheckEveryNBlocks")
    );
    this.readModelMode =
      process.env.PRL20_INDEXER_READ_MODEL_MODE === "incremental" ? "incremental" : "full";
    this.blocksAppliedSinceParityCheck = 0;
    this.log = log;
    this.parityMode = normalizeParityMode(parityMode ?? process.env.PRL20_INDEXER_PARITY_MODE);
    // Observability hook for tests: records which ingest path the last sync took
    // ("incremental" | "full-rebuild").
    this.lastIngestPath = null;
    this.lastSyncTimings = null;
    this.lastSyncMemory = null;
    // Protocol parity can run after the incremental read-model write in
    // post-publish mode. This keeps realtime publishes quick while still
    // falling back to a full write if the deterministic digest diverges.
    this.pendingReadModelParitySnapshot = null;
    this.pendingPostPublishProtocolParity = null;

    // --- MoE hard fork advisory status (ADVISORY ONLY; never alters parsing,
    // balances, or rollback). ---
    // Normalized canonical checkpoint pins from config ({ height, hash,
    // placeholder }). Real-hash pins at/below indexedHeight are compared to the
    // stored block hash to detect a non-canonical (old/forked) chain.
    this.canonicalCheckpoints = Array.isArray(canonicalCheckpoints) ? canonicalCheckpoints : [];
    this.forkEra = forkEra ?? "moe-v2";
    this.indexerVersion = indexerVersion ?? null;
    // Result of verifyCanonicalCheckpoints(): { status, height, expectedHash,
    // observedHash } with status in {match, mismatch, unknown}. Starts unknown.
    this.checkpointStatus = {
      status: "unknown",
      height: null,
      expectedHash: null,
      observedHash: null
    };
    // Best-effort node version from getnetworkinfo: { raw, semver|null,
    // meetsMinimum:bool|null, minimum }. Null until readNodeVersion() runs.
    this.nodeVersion = null;
    this.minNodeVersion = MIN_NODE_VERSION;
    // getblock schema compatibility flag (ITEM 6). 'unknown' until the first
    // successful getblock; then 'compatible' or 'incompatible'. On 'incompatible'
    // we surface the flag instead of silently indexing empty blocks; we never
    // throw or crash the sync loop.
    this.nodeSchema = "unknown";
  }

  async status() {
    await this.load({ refresh: true });
    const publishedSnapshot = await this.readPublishedSnapshotForStatus();
    if (publishedSnapshot) {
      return this.buildStatusFromSnapshot(publishedSnapshot, null);
    }
    return this.buildStatus(null);
  }

  async syncToTip() {
    if (!this.syncPromise) {
      this.syncPromise = this.withStorageSyncLock(() => this.syncToTipUnsafe()).finally(() => {
        this.syncPromise = null;
      });
    }
    return this.syncPromise;
  }

  async withStorageSyncLock(callback) {
    if (typeof this.storage.withSyncLock === "function") {
      return this.storage.withSyncLock(`prl20-indexer:${this.storage.manifestName ?? this.chain}`, callback);
    }
    return callback();
  }

  async syncToTipUnsafe() {
    const syncStartedAt = Date.now();
    const timings = {
      loadMs: 0,
      bestHeightMs: 0,
      rollbackMs: 0,
      appendMs: 0,
      materializeMs: 0,
      writeSnapshotMs: 0,
      protocolParityMs: 0,
      readModelParityMs: 0,
      totalMs: 0
    };
    const mark = () => Date.now();
    let stepStartedAt = mark();
    await this.load({ refresh: true });
    timings.loadMs = mark() - stepStartedAt;

    stepStartedAt = mark();
    const bestHeight = normalizeNonNegativeInteger(
      await this.pearlRpc("getblockcount", []),
      "bestHeight"
    );
    timings.bestHeightMs = mark() - stepStartedAt;

    stepStartedAt = mark();
    const rollbackChanged = await this.rollbackDisconnectedTip(bestHeight);
    timings.rollbackMs = mark() - stepStartedAt;

    const targetHeight = this.syncTargetHeight(bestHeight);
    stepStartedAt = mark();
    const appendChanged = await this.appendMissingBlocks(targetHeight);
    timings.appendMs = mark() - stepStartedAt;

    // MoE hard fork advisory checks (run inside the existing sync lock, after the
    // chain work settles, on every sync regardless of which snapshot path is
    // taken below). All best-effort: they update advisory status only and must
    // never throw, mutate PRL-20 state, or affect rollback.
    this.verifyCanonicalCheckpoints();
    await this.readNodeVersion();

    if (!rollbackChanged && !appendChanged && this.canUseStoredSnapshotFastPath(bestHeight)) {
      const snapshot = await this.storage.readSnapshot();
      if (snapshot && snapshotMatchesManifest(snapshot, this.manifest)) {
        const refreshedSnapshot = this.refreshSnapshotNetwork(snapshot, bestHeight);
        if (snapshotNetworkChanged(snapshot, refreshedSnapshot)) {
          if (typeof this.storage.writeSnapshotNetworkMetadata === "function") {
            await this.storage.writeSnapshotNetworkMetadata(refreshedSnapshot);
          } else {
            await this.storage.writeSnapshot(refreshedSnapshot);
          }
        }
        timings.totalMs = Date.now() - syncStartedAt;
        this.lastSyncTimings = timings;
        this.lastSyncMemory = processMemorySummary();
        return {
          bestHeight,
          targetHeight,
          maxBlocksPerSync: this.maxBlocksPerSync,
          remainingLag: remainingLag(this.manifest.indexedHeight, bestHeight),
          startHeight: this.manifest.startHeight,
          indexedHeight: this.manifest.indexedHeight,
          indexedHash: this.manifest.indexedHash,
          blocks: [],
          snapshot: refreshedSnapshot,
          status: this.buildStatus(bestHeight),
          timings,
          memory: this.lastSyncMemory
        };
      }
    }

    stepStartedAt = mark();
    const { snapshot, blocks, blockCount, writeOptions } = await this.materializeSnapshot(
      bestHeight,
      rollbackChanged
    );
    timings.materializeMs = mark() - stepStartedAt;
    stepStartedAt = mark();
    let writeResult = await this.storage.writeSnapshot(snapshot, writeOptions);
    timings.writeSnapshotMs = mark() - stepStartedAt;
    let finalSnapshot = snapshot;
    let finalBlockCount = blockCount ?? blocks.length;
    stepStartedAt = mark();
    const protocolParityResult = await this.maybePostPublishProtocolParityCheck(bestHeight);
    timings.protocolParityMs = mark() - stepStartedAt;
    if (protocolParityResult?.snapshot) {
      finalSnapshot = protocolParityResult.snapshot;
      finalBlockCount = protocolParityResult.blockCount ?? finalBlockCount;
      writeResult = protocolParityResult.writeResult ?? writeResult;
    }
    if (writeOptions?.readModelMode === "incremental") {
      stepStartedAt = mark();
      const parityResult = await this.maybeReadModelParityCheck(bestHeight);
      timings.readModelParityMs = mark() - stepStartedAt;
      if (parityResult?.snapshot) {
        finalSnapshot = parityResult.snapshot;
        finalBlockCount = parityResult.blockCount ?? finalBlockCount;
        writeResult = parityResult.writeResult ?? writeResult;
      }
    }
    timings.totalMs = Date.now() - syncStartedAt;
    this.lastSyncTimings = timings;
    this.lastSyncMemory = processMemorySummary();

    return {
      bestHeight,
      targetHeight,
      maxBlocksPerSync: this.maxBlocksPerSync,
      remainingLag: remainingLag(this.manifest.indexedHeight, bestHeight),
      startHeight: this.manifest.startHeight,
      indexedHeight: this.manifest.indexedHeight,
      indexedHash: this.manifest.indexedHash,
      blocks,
      blockCount: finalBlockCount,
      snapshot: finalSnapshot,
      status: this.buildStatus(bestHeight),
      readModelMs: writeResult?.readModelMs ?? null,
      touchedRows: writeResult?.touchedRows ?? null,
      readModelMode: writeResult?.readModels?.mode ?? null,
      timings,
      memory: this.lastSyncMemory
    };
  }

  syncTargetHeight(bestHeight) {
    const normalizedBestHeight = normalizeNonNegativeInteger(bestHeight, "bestHeight");
    if (this.maxBlocksPerSync <= 0) {
      return normalizedBestHeight;
    }
    // Cold starts and rollback recovery keep the existing full catch-up path.
    // Micro-batching is only for a warm, append-only session so a backlog can
    // publish one small confirmed slice per tick instead of waiting for all
    // missing blocks to finish.
    if (!this.ingestSession || !this.sessionExtendsStoredChain()) {
      return normalizedBestHeight;
    }
    const nextHeight =
      this.manifest.blocks.length === 0
        ? this.manifest.startHeight
        : this.manifest.blocks.at(-1).height + 1;
    if (nextHeight > normalizedBestHeight) {
      return normalizedBestHeight;
    }
    return Math.min(normalizedBestHeight, nextHeight + this.maxBlocksPerSync - 1);
  }

  // MoE hard fork anti-old-chain check (ADVISORY ONLY).
  //
  // For each configured (non-placeholder) checkpoint pin at or below the current
  // indexedHeight, compares the manifest's stored block hash at that height to
  // the pinned hash. The manifest block list is contiguous and height-ordered
  // (validateManifestContinuity), so the stored hash is
  // manifest.blocks[height - startHeight].hash.
  //
  // Sets this.checkpointStatus = { status, height, expectedHash, observedHash }:
  //   'match'    - at least one pin was applicable and ALL applicable pins agree.
  //   'mismatch' - ANY applicable pin disagrees (reports the first mismatch).
  //   'unknown'  - no pins, only placeholder pins, or indexedHeight is still below
  //                the lowest applicable pin (nothing to compare yet).
  //
  // NEVER throws and NEVER mutates PRL-20 state / balances / rollback.
  verifyCanonicalCheckpoints() {
    const result = { status: "unknown", height: null, expectedHash: null, observedHash: null };
    try {
      const indexedHeight = this.manifest?.indexedHeight;
      const startHeight = this.manifest?.startHeight ?? 0;
      const blocks = this.manifest?.blocks ?? [];
      let applicableCount = 0;
      let firstMatch = null;

      for (const checkpoint of this.canonicalCheckpoints) {
        if (!checkpoint || checkpoint.placeholder) {
          continue;
        }
        if (indexedHeight === null || indexedHeight === undefined || checkpoint.height > indexedHeight) {
          // Not yet indexed up to this pin; cannot judge it.
          continue;
        }
        const stored = blocks[checkpoint.height - startHeight];
        const observedHash = stored?.hash ?? null;
        const expectedHash = String(checkpoint.hash).toLowerCase();
        const normalizedObserved = observedHash ? String(observedHash).toLowerCase() : null;
        applicableCount += 1;
        if (normalizedObserved !== expectedHash) {
          this.checkpointStatus = {
            status: "mismatch",
            height: checkpoint.height,
            expectedHash,
            observedHash: normalizedObserved
          };
          return this.checkpointStatus;
        }
        if (!firstMatch) {
          firstMatch = {
            status: "match",
            height: checkpoint.height,
            expectedHash,
            observedHash: normalizedObserved
          };
        }
      }

      if (applicableCount > 0 && firstMatch) {
        this.checkpointStatus = firstMatch;
        return this.checkpointStatus;
      }
    } catch (error) {
      this.log?.error?.(
        JSON.stringify({ evt: "indexer-checkpoint-verify-error", message: safeText(error) })
      );
    }
    this.checkpointStatus = result;
    return this.checkpointStatus;
  }

  // MoE hard fork node-version probe (ADVISORY ONLY, best-effort).
  //
  // Calls getnetworkinfo and parses the pearld semver out of `subversion`
  // (e.g. "/pearlwire:0.5.0/pearld:1.0.6/", robust to suffixes like "-presync").
  // Falls back to the integer `version` field (btcd-style encoding) when the
  // subversion cannot be parsed. The method MAY be absent on some builds, so the
  // whole thing is wrapped in try/catch: on any error it stores nulls and the
  // sync continues. NEVER throws, NEVER blocks sync.
  //
  // Stores this.nodeVersion = { raw, semver|null, meetsMinimum:bool|null, minimum }.
  async readNodeVersion() {
    try {
      const info = await this.pearlRpc("getnetworkinfo", []);
      const raw = info?.subversion ?? null;
      const semver = parsePearldSemver(raw);
      let meetsMinimum = null;
      if (semver) {
        meetsMinimum = compareSemver(semver, MIN_NODE_VERSION) >= 0;
      } else if (Number.isInteger(info?.version)) {
        meetsMinimum = info.version >= MIN_NODE_VERSION_INT;
      }
      this.nodeVersion = {
        raw,
        semver: semver ?? null,
        meetsMinimum,
        minimum: MIN_NODE_VERSION
      };
    } catch (error) {
      // getnetworkinfo missing / RPC failure: degrade to nulls, never throw.
      this.nodeVersion = {
        raw: null,
        semver: null,
        meetsMinimum: null,
        minimum: MIN_NODE_VERSION
      };
      this.log?.debug?.(
        JSON.stringify({ evt: "indexer-node-version-unavailable", message: safeText(error) })
      );
    }
    return this.nodeVersion;
  }

  // ITEM 6 getblock-schema compatibility check (ADVISORY ONLY). Called from
  // appendMissingBlocks on the first successful getblock of a sync. Asserts the
  // block carries height/hash/previousblockhash/time and a tx array
  // (rawtx|tx|transactions) whose entries have hex (rawTxHex) | txid. On a missing
  // required field, sets this.nodeSchema='incompatible' and logs; otherwise
  // 'compatible'. NEVER throws / crashes sync.
  checkBlockSchema(block) {
    try {
      if (isCompatibleGetblockSchema(block)) {
        this.nodeSchema = "compatible";
      } else {
        this.nodeSchema = "incompatible";
        this.log?.error?.(
          JSON.stringify({
            evt: "indexer-node-schema-incompatible",
            height: block?.height ?? null,
            hash: block?.hash ?? null
          })
        );
      }
    } catch {
      this.nodeSchema = "incompatible";
    }
    return this.nodeSchema;
  }

  // Chooses the incremental ingest path when the stored chain is a pure append
  // on top of the live session tip; otherwise rebuilds the session from all
  // canonical blocks in bounded chunks (Fix C). Returns the published snapshot
  // plus the blocks read off disk for this sync (only the appended slice on the
  // fast path; an empty array from a full rebuild so the whole history is never
  // re-materialized into one array).
  async materializeSnapshot(bestHeight, rollbackChanged) {
    const sessionInSync =
      !rollbackChanged && this.ingestSession && this.sessionExtendsStoredChain();
    const appendedManifestBlocks = sessionInSync
      ? this.manifest.blocks.slice(this.sessionBlocks.length)
      : this.manifest.blocks;

    if (sessionInSync && appendedManifestBlocks.length === 0) {
      // No new blocks and the in-memory session already matches the stored
      // canonical chain. This stays cheap for Postgres read models too: if a
      // previous snapshot was stale, the live session can publish the current
      // metadata without a full re-fold from genesis.
      this.lastIngestPath = "incremental";
      const canUseIncrementalReadModel = this.canUseIncrementalReadModel();
      const delta = canUseIncrementalReadModel ? this.ingestSession.consumeReadModelDelta() : null;
      return {
        snapshot: this.publishSessionSnapshot(bestHeight, {
          skipUtxos: canUseIncrementalReadModel
        }),
        blocks: [],
        blockCount: 0,
        writeOptions: canUseIncrementalReadModel
          ? {
              readModelMode: "incremental",
              readModelDelta: {
                ...delta,
                previousIndexedHeight: this.manifest.indexedHeight,
                previousBestHeight: this.manifest.indexedHeight,
                indexedHeight: this.manifest.indexedHeight,
                bestHeight
              }
            }
          : { readModelMode: "full" }
      };
    }

    const canIncrement = sessionInSync && appendedManifestBlocks.length > 0;
    if (!canIncrement) {
      // Full rebuild covers rollbacks and a missing/out-of-sync session.
      // Incremental only fires for a pure append on top of the live session tip.
      return this.rebuildSnapshot(bestHeight);
    }

    const previousIndexedHeight = this.sessionBlocks.at(-1)?.height ?? null;
    const appendedBlocks = await this.storage.readBlocks(appendedManifestBlocks);
    for (let index = 0; index < appendedBlocks.length; index += 1) {
      this.ingestSession.applyBlock(appendedBlocks[index]);
      this.sessionBlocks.push({
        height: appendedManifestBlocks[index].height,
        hash: appendedManifestBlocks[index].hash
      });
      this.blocksAppliedSinceParityCheck += 1;
    }

    this.lastIngestPath = "incremental";
    let snapshot = this.publishSessionSnapshot(bestHeight, {
      skipUtxos: this.canUseIncrementalReadModel()
    });
    snapshot = await this.maybeParityCheck(snapshot, bestHeight);
    if (this.lastIngestPath !== "incremental" || !this.canUseIncrementalReadModel()) {
      return {
        snapshot,
        blocks: appendedBlocks,
        blockCount: appendedBlocks.length,
        writeOptions: { readModelMode: "full" }
      };
    }
    const delta = this.ingestSession.consumeReadModelDelta();
    return {
      snapshot,
      blocks: appendedBlocks,
      blockCount: appendedBlocks.length,
      writeOptions: {
        readModelMode: "incremental",
        readModelDelta: {
          ...delta,
          previousIndexedHeight,
          previousBestHeight: previousIndexedHeight,
          indexedHeight: this.manifest.indexedHeight,
          bestHeight
        }
      }
    };
  }

  async rebuildSnapshot(bestHeight) {
    const session = createPrl20IngestSession({ mintFeePolicy: this.mintFeePolicy });
    const manifestBlocks = this.manifest.blocks;
    // Read and fold the canonical chain in manifest order, one bounded chunk at a
    // time. manifest.blocks is contiguous and height-ordered (enforced by
    // validateManifestContinuity), so chunked application is byte-identical to a
    // single ordered fold — only the per-chunk raw blocks are ever resident, and
    // the whole-history re-sort the legacy path did is unnecessary.
    for (let start = 0; start < manifestBlocks.length; start += this.rebuildChunkSize) {
      const slice = manifestBlocks.slice(start, start + this.rebuildChunkSize);
      const chunkBlocks = await this.storage.readBlocks(slice);
      for (const block of chunkBlocks) {
        session.applyBlock(block);
      }
      // chunkBlocks/slice fall out of scope on the next iteration so the GC can
      // reclaim the raw-block memory before the next chunk is read.
    }
    this.ingestSession = session;
    // Track the canonical (height, hash) pairs in manifest order so a later
    // append can confirm the session still prefixes the stored chain.
    this.sessionBlocks = manifestBlocks.map((block) => ({
      height: block.height,
      hash: block.hash
    }));
    this.ingestSession.consumeReadModelDelta();
    this.blocksAppliedSinceParityCheck = 0;
    this.lastIngestPath = "full-rebuild";
    const snapshot = this.publishSessionSnapshot(bestHeight);
    // Do not return the raw blocks: re-materializing the whole history here would
    // reintroduce the very memory spike this chunking removes. Callers that need a
    // count use blockCount; the appended-blocks fast path still returns its slice.
    return {
      snapshot,
      blocks: [],
      blockCount: manifestBlocks.length,
      writeOptions: { readModelMode: "full" }
    };
  }

  // Builds the published snapshot from the live session accumulators and tags it
  // with the published-snapshot metadata (protocol digest + summary) the API and
  // status paths read back, exactly as buildSnapshot(bestHeight, blocks) did.
  publishSessionSnapshot(bestHeight, { skipUtxos = false } = {}) {
    const snapshot = this.ingestSession.buildSnapshot({
      network: this.buildNetworkMeta(bestHeight),
      prlBalances: {},
      utxos: skipUtxos ? SKIP_UTXO_MAP : null
    });
    return withPublishedSnapshotMetadata(snapshot);
  }

  // True when the blocks already folded into the session are an exact, in-order
  // prefix of the currently stored canonical chain (pure append on top).
  sessionExtendsStoredChain() {
    if (this.sessionBlocks.length > this.manifest.blocks.length) {
      return false;
    }
    for (let index = 0; index < this.sessionBlocks.length; index += 1) {
      const sessionBlock = this.sessionBlocks[index];
      const storedBlock = this.manifest.blocks[index];
      if (
        !storedBlock ||
        sessionBlock.height !== storedBlock.height ||
        sessionBlock.hash !== storedBlock.hash
      ) {
        return false;
      }
    }
    return true;
  }

  // Optional safety net: every N appended blocks, also run a full chunked rebuild
  // and compare protocol digests. On mismatch, keep the full-rebuild result,
  // reset the session, and log a structured error. In post-publish mode the
  // rebuild runs immediately after the incremental snapshot lands, reducing the
  // time users wait for confirmed blocks while preserving the same fallback.
  async maybeParityCheck(incrementalSnapshot, bestHeight) {
    if (
      this.parityCheckEveryNBlocks <= 0 ||
      this.blocksAppliedSinceParityCheck < this.parityCheckEveryNBlocks
    ) {
      return incrementalSnapshot;
    }
    this.blocksAppliedSinceParityCheck = 0;
    this.pendingReadModelParitySnapshot = null;
    this.pendingPostPublishProtocolParity = null;

    if (this.parityMode === "off") {
      this.log?.warn?.(
        JSON.stringify({
          evt: "indexer-incremental-parity-skipped",
          mode: this.parityMode,
          indexedHeight: this.manifest.indexedHeight,
          indexedHash: this.manifest.indexedHash
        })
      );
      return incrementalSnapshot;
    }

    if (this.parityMode === "post-publish") {
      this.pendingPostPublishProtocolParity = {
        bestHeight,
        incrementalDigest: snapshotDigest(
          normalizeProtocolSnapshotForComparison(incrementalSnapshot)
        )
      };
      return incrementalSnapshot;
    }

    const sessionSnapshot = this.ingestSession;
    const sessionBlocks = this.sessionBlocks;
    this.ingestSession = null;
    this.sessionBlocks = [];
    const { snapshot: rebuilt } = await this.rebuildSnapshot(bestHeight);
    const incrementalDigest = snapshotDigest(
      normalizeProtocolSnapshotForComparison(incrementalSnapshot)
    );
    const rebuiltDigest = snapshotDigest(normalizeProtocolSnapshotForComparison(rebuilt));
    if (incrementalDigest !== rebuiltDigest) {
      this.log?.error?.(
        JSON.stringify({
          evt: "indexer-incremental-parity-mismatch",
          indexedHeight: this.manifest.indexedHeight,
          indexedHash: this.manifest.indexedHash,
          incrementalDigest,
          rebuiltDigest
        })
      );
      // Prefer the trusted full rebuild (already installed as the live session).
      return rebuilt;
    }
    // Digests match: keep the cheaper incremental session/result.
    this.ingestSession = sessionSnapshot;
    this.sessionBlocks = sessionBlocks;
    this.lastIngestPath = "incremental";
    this.pendingReadModelParitySnapshot = rebuilt;
    return incrementalSnapshot;
  }

  async maybePostPublishProtocolParityCheck(bestHeight) {
    const pending = this.pendingPostPublishProtocolParity;
    this.pendingPostPublishProtocolParity = null;
    if (!pending || this.parityMode !== "post-publish") {
      return null;
    }

    const sessionSnapshot = this.ingestSession;
    const sessionBlocks = this.sessionBlocks;
    this.ingestSession = null;
    this.sessionBlocks = [];
    const rebuilt = await this.rebuildSnapshot(bestHeight);
    const rebuiltDigest = snapshotDigest(normalizeProtocolSnapshotForComparison(rebuilt.snapshot));
    if (pending.incrementalDigest !== rebuiltDigest) {
      this.log?.error?.(
        JSON.stringify({
          evt: "indexer-incremental-parity-mismatch",
          mode: this.parityMode,
          indexedHeight: this.manifest.indexedHeight,
          indexedHash: this.manifest.indexedHash,
          incrementalDigest: pending.incrementalDigest,
          rebuiltDigest
        })
      );
      const writeResult = await this.storage.writeSnapshot(rebuilt.snapshot, {
        readModelMode: "full"
      });
      return {
        snapshot: rebuilt.snapshot,
        blockCount: rebuilt.blockCount,
        writeResult
      };
    }

    this.ingestSession = sessionSnapshot;
    this.sessionBlocks = sessionBlocks;
    this.lastIngestPath = "incremental";
    this.pendingReadModelParitySnapshot = rebuilt.snapshot;
    return null;
  }

  canUseIncrementalReadModel() {
    const storageStatus = this.storage.publicStatus?.() ?? {};
    return (
      this.readModelMode === "incremental" &&
      storageStatus.backend === "postgres" &&
      storageStatus.readModels === true
    );
  }

  storageSupportsReadModelParity() {
    const storageStatus = this.storage.publicStatus?.() ?? {};
    return (
      storageStatus.backend === "postgres" &&
      storageStatus.readModels === true &&
      typeof this.storage.readModelParityDigest === "function"
    );
  }

  async maybeReadModelParityCheck(bestHeight) {
    const rebuiltSnapshot = this.pendingReadModelParitySnapshot;
    this.pendingReadModelParitySnapshot = null;
    if (
      !rebuiltSnapshot ||
      this.readModelMode !== "incremental" ||
      !this.storageSupportsReadModelParity()
    ) {
      return null;
    }
    return this.checkReadModelParity(rebuiltSnapshot, bestHeight);
  }

  async checkReadModelParity(rebuiltSnapshot, bestHeight) {
    const dbDigest = await this.storage.readModelParityDigest();
    const truthDigest = readModelParityDigestFromSnapshot(rebuiltSnapshot);
    if (dbDigest === truthDigest) {
      return null;
    }
    this.log?.error?.(
      JSON.stringify({
        evt: "indexer-readmodel-delta-mismatch",
        indexedHeight: this.manifest.indexedHeight,
        indexedHash: this.manifest.indexedHash,
        dbDigest,
        truthDigest
      })
    );
    const writeResult = await this.storage.writeSnapshot(rebuiltSnapshot, {
      readModelMode: "full"
    });
    return {
      snapshot: rebuiltSnapshot,
      blockCount: this.manifest.blocks.length,
      writeResult
    };
  }

  // Network metadata block shared by every published snapshot, matching the
  // shape buildSnapshot(bestHeight, blocks) produces for full rebuilds.
  buildNetworkMeta(bestHeight) {
    const storageStatus = this.storage.publicStatus?.() ?? {
      backend: "custom",
      productionReady: false
    };
    return {
      chain: this.manifest.chain,
      source: "persistent-pearl-rpc",
      bestHeight,
      startHeight: this.manifest.startHeight,
      indexedHeight: this.manifest.indexedHeight,
      indexedHash: this.manifest.indexedHash,
      blocksStored: this.manifest.blocks.length,
      reorgCount: this.manifest.reorgCount,
      lastSyncedAt: this.manifest.lastSyncedAt,
      persistenceReady: true,
      productionReady: storageStatus.productionReady === true,
      storageBackend: storageStatus.backend ?? "custom",
      storageProductionReady: storageStatus.productionReady === true,
      warning:
        storageStatus.productionReady === true
          ? "Persistent indexer is using production-capable storage. Keep migrations, monitoring, backups, and restore drills current before public launch."
          : "Persistent local indexer stores canonical raw blocks and derived PRL-20 state, but still needs production DB operations, monitoring, and deployment hardening."
    };
  }

  async load({ refresh = false } = {}) {
    if (this.manifest && !refresh) {
      return this.manifest;
    }

    await this.storage.init();
    const manifest = await this.storage.readManifest();

    if (manifest) {
      this.manifest = normalizeManifest(manifest, this.chain, this.startHeight);
      validateManifestContinuity(this.manifest);
      return this.manifest;
    }

    this.manifest = createEmptyManifest(this.chain, this.startHeight, this.now());
    validateManifestContinuity(this.manifest);
    await this.persistManifest();
    return this.manifest;
  }

  async rollbackDisconnectedTip(bestHeight) {
    let changed = false;

    while (this.manifest.blocks.length > 0) {
      const tip = this.manifest.blocks.at(-1);
      if (tip.height > bestHeight) {
        await this.removeTipBlock();
        changed = true;
        continue;
      }

      const canonicalHash = await this.pearlRpc("getblockhash", [tip.height]);
      if (canonicalHash === tip.hash) {
        break;
      }

      await this.removeTipBlock();
      this.manifest.reorgCount += 1;
      changed = true;
    }

    if (changed) {
      await this.persistManifest();
    }
    return changed;
  }

  async appendMissingBlocks(bestHeight) {
    let changed = false;
    let nextHeight =
      this.manifest.blocks.length === 0
        ? this.manifest.startHeight
        : this.manifest.blocks.at(-1).height + 1;

    while (nextHeight <= bestHeight) {
      const upperHeight = Math.min(bestHeight, nextHeight + this.batchSize - 1);
      for (let height = nextHeight; height <= upperHeight; height += 1) {
        const hash = await this.pearlRpc("getblockhash", [height]);
        const block = await this.pearlRpc("getblock", [hash, 2]);
        // ITEM 6: advisory getblock-schema compat check on the first block we see
        // this sync. Surfaces nodeSchema='incompatible' instead of silently
        // indexing empty blocks; does not alter the ingest below.
        if (this.nodeSchema === "unknown") {
          this.checkBlockSchema(block);
        }
        const previousHash = block.previousblockhash ?? block.previousHash ?? null;
        const tip = this.manifest.blocks.at(-1);

        if (tip && previousHash && previousHash !== tip.hash) {
          await this.removeTipBlock();
          this.manifest.reorgCount += 1;
          await this.persistManifest();
          await this.appendMissingBlocks(bestHeight);
          return true;
        }

        const transactionCount = (block.rawtx ?? block.tx ?? block.transactions ?? []).length;
        const normalizedBlock = {
          ...block,
          height,
          hash
        };
        const { file } = await this.storage.writeBlock({
          height,
          hash,
          block: normalizedBlock
        });
        this.manifest.blocks.push({
          height,
          hash,
          previousHash,
          time: block.time ?? block.blocktime ?? null,
          txCount: transactionCount,
          file
        });
        this.manifest.indexedHeight = height;
        this.manifest.indexedHash = hash;
        this.manifest.lastSyncedAt = this.now();
        changed = true;
      }
      await this.persistManifest();
      nextHeight = upperHeight + 1;
    }
    return changed;
  }

  async removeTipBlock() {
    const tip = this.manifest.blocks.pop();
    if (!tip) {
      this.manifest.indexedHeight = null;
      this.manifest.indexedHash = null;
      return;
    }

    await this.storage.deleteBlock(tip.file);
    const nextTip = this.manifest.blocks.at(-1);
    this.manifest.indexedHeight = nextTip?.height ?? null;
    this.manifest.indexedHash = nextTip?.hash ?? null;
    this.manifest.lastSyncedAt = this.now();
  }

  // MoE hard fork advisory status fields, shared by buildStatus and
  // buildStatusFromSnapshot so /health and /indexer/status expose them
  // identically. ALL fields are additive/optional and advisory:
  //   indexerVersion   - this indexer's package version (or null).
  //   pearlNodeVersion - { raw, semver, meetsMinimum, minimum } | null. Carries
  //                      only a version string, never host/path.
  //   checkpoint       - { status, height, expectedHash, observedHash }.
  //   forkEra          - frozen cross-repo tag, e.g. "moe-v2".
  //   nodeSchema       - 'compatible' | 'incompatible' | 'unknown'.
  //   message          - human advisory string, or null when everything is fine.
  advisoryStatusFields(indexedHeight) {
    const checkpoint = {
      status: this.checkpointStatus?.status ?? "unknown",
      height: this.checkpointStatus?.height ?? null,
      expectedHash: this.checkpointStatus?.expectedHash ?? null,
      observedHash: this.checkpointStatus?.observedHash ?? null
    };
    return {
      indexerVersion: this.indexerVersion ?? null,
      pearlNodeVersion: this.nodeVersion ? { ...this.nodeVersion } : null,
      checkpoint,
      forkEra: this.forkEra ?? null,
      nodeSchema: this.nodeSchema ?? "unknown",
      message: buildAdvisoryMessage({
        checkpoint,
        nodeVersion: this.nodeVersion,
        nodeSchema: this.nodeSchema
      })
    };
  }

  buildStatus(bestHeight) {
    const indexedHeight = this.manifest.indexedHeight;
    return {
      enabled: true,
      mode: "persistent",
      schemaVersion: this.manifest.schemaVersion,
      chain: this.manifest.chain,
      storeDir: this.storeDir,
      startHeight: this.manifest.startHeight,
      indexedHeight,
      indexedHash: this.manifest.indexedHash,
      bestHeight,
      synced: bestHeight === null ? null : indexedHeight === bestHeight,
      blocksStored: this.manifest.blocks.length,
      reorgCount: this.manifest.reorgCount,
      storage: this.storage.publicStatus?.() ?? {
        backend: "custom",
        productionReady: false
      },
      lastSyncedAt: this.manifest.lastSyncedAt,
      ...this.advisoryStatusFields(indexedHeight)
    };
  }

  async readPublishedSnapshotForStatus() {
    const storageStatus = this.storage.publicStatus?.() ?? {};
    if (storageStatus.backend !== "postgres" || storageStatus.readModels !== true) {
      return null;
    }
    const network =
      typeof this.storage.readSnapshotNetworkMetadata === "function"
        ? await this.storage.readSnapshotNetworkMetadata()
        : (await this.storage.readSnapshot())?.network;
    if (!snapshotNetworkMatchesManifest(network, this.manifest)) {
      return null;
    }
    return { network };
  }

  buildStatusFromSnapshot(snapshot, bestHeight) {
    const network = snapshot.network ?? {};
    const indexedHeight = network.indexedHeight ?? this.manifest.indexedHeight;
    return {
      enabled: true,
      mode: "persistent",
      schemaVersion: this.manifest.schemaVersion,
      chain: network.chain ?? this.manifest.chain,
      storeDir: this.storeDir,
      startHeight: network.startHeight ?? this.manifest.startHeight,
      indexedHeight,
      indexedHash: network.indexedHash ?? this.manifest.indexedHash,
      bestHeight,
      synced: bestHeight === null ? null : indexedHeight === bestHeight,
      blocksStored: network.blocksStored ?? this.manifest.blocks.length,
      reorgCount: network.reorgCount ?? this.manifest.reorgCount,
      storage: this.storage.publicStatus?.() ?? {
        backend: "custom",
        productionReady: false
      },
      lastSyncedAt: network.lastSyncedAt ?? this.manifest.lastSyncedAt,
      ...this.advisoryStatusFields(indexedHeight)
    };
  }

  async persistManifest() {
    await this.storage.writeManifest(this.manifest);
  }

  canUseStoredSnapshotFastPath(bestHeight) {
    const storageStatus = this.storage.publicStatus?.() ?? {};
    return (
      bestHeight === this.manifest.indexedHeight &&
      storageStatus.backend === "postgres" &&
      storageStatus.readModels === true &&
      typeof this.storage.readSnapshot === "function"
    );
  }

  refreshSnapshotNetwork(snapshot, bestHeight) {
    return withPublishedSnapshotMetadata({
      ...snapshot,
      network: {
        ...(snapshot.network ?? {}),
        chain: this.manifest.chain,
        bestHeight,
        startHeight: this.manifest.startHeight,
        indexedHeight: this.manifest.indexedHeight,
        indexedHash: this.manifest.indexedHash,
        blocksStored: this.manifest.blocks.length,
        reorgCount: this.manifest.reorgCount,
        lastSyncedAt: this.manifest.lastSyncedAt,
        persistenceReady: true
      }
    });
  }
}

function createEmptyManifest(chain, startHeight, createdAt) {
  return {
    schemaVersion: SCHEMA_VERSION,
    chain,
    startHeight,
    indexedHeight: null,
    indexedHash: null,
    blocks: [],
    reorgCount: 0,
    createdAt,
    lastSyncedAt: null
  };
}

function normalizeManifest(manifest, chain, fallbackStartHeight) {
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported PRL-20 indexer manifest schema ${manifest.schemaVersion}`);
  }
  if (!Array.isArray(manifest.blocks)) {
    throw new Error("invalid PRL-20 indexer manifest: blocks must be an array");
  }
  if (manifest.chain && manifest.chain !== chain) {
    throw new Error(
      `PRL-20 indexer manifest chain mismatch: stored ${manifest.chain}, configured ${chain}. Use a separate manifest/store or run an explicit migration/reset.`
    );
  }
  return {
    ...manifest,
    chain,
    startHeight: normalizeNonNegativeInteger(
      manifest.startHeight ?? fallbackStartHeight,
      "manifest.startHeight"
    ),
    indexedHeight:
      manifest.indexedHeight === null || manifest.indexedHeight === undefined
        ? null
        : normalizeNonNegativeInteger(manifest.indexedHeight, "manifest.indexedHeight"),
    indexedHash: manifest.indexedHash ?? null,
    reorgCount: normalizeNonNegativeInteger(manifest.reorgCount ?? 0, "manifest.reorgCount"),
    blocks: manifest.blocks.map((block) => ({
      height: normalizeNonNegativeInteger(block.height, "block.height"),
      hash: assertHash(block.hash, "block.hash"),
      previousHash: block.previousHash ?? null,
      time: block.time ?? null,
      txCount: normalizeNonNegativeInteger(block.txCount ?? 0, "block.txCount"),
      file: String(block.file ?? blockFileName(block.height, block.hash))
    }))
  };
}

function normalizeNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || !Number.isSafeInteger(number)) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return number;
}

function normalizeParityMode(value) {
  const mode = String(value ?? "inline").trim().toLowerCase() || "inline";
  if (mode === "inline" || mode === "post-publish" || mode === "off") {
    return mode;
  }
  throw new Error(
    `PRL20_INDEXER_PARITY_MODE must be one of "inline", "post-publish", or "off"; got "${value}"`
  );
}

function remainingLag(indexedHeight, bestHeight) {
  const indexed = Number(indexedHeight);
  const best = Number(bestHeight);
  if (!Number.isSafeInteger(indexed) || !Number.isSafeInteger(best)) {
    return null;
  }
  return Math.max(0, best - indexed);
}

function processMemorySummary() {
  const memory = process.memoryUsage();
  return {
    rssMb: bytesToMiB(memory.rss),
    heapUsedMb: bytesToMiB(memory.heapUsed),
    heapTotalMb: bytesToMiB(memory.heapTotal),
    externalMb: bytesToMiB(memory.external),
    arrayBuffersMb: bytesToMiB(memory.arrayBuffers ?? 0)
  };
}

function bytesToMiB(bytes) {
  return Math.round((Number(bytes ?? 0) / 1024 / 1024) * 10) / 10;
}

// Parse "pearld:MAJOR.MINOR.PATCH" out of a btcd-style subversion string such as
// "/pearlwire:0.5.0/pearld:1.0.6/" or "/pearld:1.1.0-presync/". Returns
// { major, minor, patch } or null when no pearld token is present.
export function parsePearldSemver(subversion) {
  if (typeof subversion !== "string") {
    return null;
  }
  const match = subversion.match(/pearld:(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

// Compares a parsed { major, minor, patch } against a "x.y.z" minimum string.
// Returns >0 when version > minimum, 0 when equal, <0 when older.
export function compareSemver(version, minimumString) {
  const [minMajor, minMinor, minPatch] = String(minimumString)
    .split(".")
    .map((part) => Number(part) || 0);
  if (version.major !== minMajor) return version.major - minMajor;
  if (version.minor !== minMinor) return version.minor - minMinor;
  return version.patch - minPatch;
}

// ITEM 6: returns true when a `getblock <hash> 2` result has the fields ingest
// consumes — height/hash/previousblockhash/time and a tx array
// (rawtx|tx|transactions) whose entries each carry hex (rawTxHex) | txid. An
// empty tx array is allowed (an empty block is legitimate); a missing tx array
// or entries lacking both hex and txid mark the schema incompatible.
export function isCompatibleGetblockSchema(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return false;
  }
  if (block.height === undefined || block.height === null) return false;
  if (!block.hash) return false;
  if (block.previousblockhash === undefined && block.previousHash === undefined) return false;
  if (block.time === undefined && block.blocktime === undefined) return false;
  const txArray = block.rawtx ?? block.tx ?? block.transactions;
  if (!Array.isArray(txArray)) {
    return false;
  }
  return txArray.every((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const hasHex = Boolean(entry.hex ?? entry.rawTxHex);
    const hasTxid = Boolean(entry.txid ?? entry.hash);
    return hasHex || hasTxid;
  });
}

function safeText(error) {
  return String(error?.message ?? error ?? "unknown error").slice(0, 200);
}

// Builds the human advisory `message` for status/health. Priority: a checkpoint
// mismatch (the indexer is provably on a non-canonical chain) outranks a stale
// node version, which outranks an incompatible getblock schema. Returns null when
// none apply. Advisory only — never changes ok/synced semantics.
function buildAdvisoryMessage({ checkpoint, nodeVersion, nodeSchema }) {
  if (checkpoint?.status === "mismatch") {
    const height = checkpoint.height ?? "?";
    return `Indexer is on a non-canonical chain (checkpoint mismatch at height ${height}). Re-sync against a Pearl node >= v1.1.0 with the MoE hard fork.`;
  }
  if (nodeVersion && nodeVersion.meetsMinimum === false) {
    return "Pearl node predates the MoE hard fork; update pearld to >= v1.1.0.";
  }
  if (nodeSchema === "incompatible") {
    return "Pearl node getblock response is missing fields the indexer needs (rawtx/tx with hex or txid). Update pearld to a MoE-compatible build.";
  }
  return null;
}

function validateManifestContinuity(manifest) {
  let previous = null;
  const seen = new Set();
  for (const block of manifest.blocks) {
    if (seen.has(block.height)) {
      throw new Error(`invalid PRL-20 indexer manifest: duplicate block height ${block.height}`);
    }
    seen.add(block.height);
    if (!previous && block.height !== manifest.startHeight) {
      throw new Error(
        `invalid PRL-20 indexer manifest: first block height ${block.height} does not match startHeight ${manifest.startHeight}`
      );
    }
    if (previous && block.height !== previous.height + 1) {
      throw new Error(
        `invalid PRL-20 indexer manifest: non-contiguous height ${block.height} after ${previous.height}`
      );
    }
    if (previous && block.previousHash && block.previousHash !== previous.hash) {
      throw new Error(
        `invalid PRL-20 indexer manifest: previousHash mismatch at height ${block.height}`
      );
    }
    previous = block;
  }

  const tip = manifest.blocks.at(-1);
  if (tip) {
    if (manifest.indexedHeight !== tip.height || manifest.indexedHash !== tip.hash) {
      throw new Error("invalid PRL-20 indexer manifest: indexed tip does not match last block");
    }
  } else if (manifest.indexedHeight !== null || manifest.indexedHash !== null) {
    throw new Error("invalid PRL-20 indexer manifest: empty block list has an indexed tip");
  }
}

function withPublishedSnapshotMetadata(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return snapshot;
  }
  const normalized = normalizeProtocolSnapshotForComparison(snapshot);
  return {
    ...snapshot,
    network: {
      ...(snapshot.network ?? {}),
      protocolSnapshotDigest: snapshotDigest(normalized),
      protocolSummary: summarizeSnapshot(normalized)
    }
  };
}

function snapshotMatchesManifest(snapshot, manifest) {
  return (
    snapshotNetworkMatchesManifest(snapshot?.network, manifest) &&
    Number(snapshot.network.indexedHeight) === manifest.indexedHeight &&
    snapshot.network.indexedHash === manifest.indexedHash
  );
}

function snapshotNetworkMatchesManifest(network, manifest) {
  if (!network || network.indexedHeight === undefined || !network.indexedHash) {
    return false;
  }
  if (network.chain && network.chain !== manifest.chain) {
    return false;
  }
  if (network.startHeight !== undefined && network.startHeight !== manifest.startHeight) {
    return false;
  }
  const indexedHeight = Number(network.indexedHeight);
  if (!Number.isSafeInteger(indexedHeight) || indexedHeight < manifest.startHeight) {
    return false;
  }
  const block = manifest.blocks[indexedHeight - manifest.startHeight];
  return Boolean(block && block.height === indexedHeight && block.hash === network.indexedHash);
}

function snapshotNetworkChanged(left, right) {
  const leftNetwork = left?.network ?? {};
  const rightNetwork = right?.network ?? {};
  return (
    leftNetwork.chain !== rightNetwork.chain ||
    leftNetwork.bestHeight !== rightNetwork.bestHeight ||
    leftNetwork.startHeight !== rightNetwork.startHeight ||
    leftNetwork.indexedHeight !== rightNetwork.indexedHeight ||
    leftNetwork.indexedHash !== rightNetwork.indexedHash ||
    leftNetwork.blocksStored !== rightNetwork.blocksStored ||
    leftNetwork.reorgCount !== rightNetwork.reorgCount ||
    leftNetwork.lastSyncedAt !== rightNetwork.lastSyncedAt ||
    leftNetwork.persistenceReady !== rightNetwork.persistenceReady ||
    leftNetwork.protocolSnapshotDigest !== rightNetwork.protocolSnapshotDigest ||
    JSON.stringify(leftNetwork.protocolSummary ?? null) !== JSON.stringify(rightNetwork.protocolSummary ?? null)
  );
}
