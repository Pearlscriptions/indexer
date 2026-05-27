import { ingestPearlBlocksFixture, PRLS_MINT_FEE_POLICY } from "./indexer.js";
import { assertHash, blockFileName, createIndexerStorage } from "./storage.js";

const SCHEMA_VERSION = 1;

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
    this.mintFeePolicy = mintFeePolicy;
    this.now = now;
    this.manifest = null;
    this.syncPromise = null;
  }

  async status() {
    await this.load();
    return this.buildStatus(null);
  }

  async syncToTip() {
    if (!this.syncPromise) {
      this.syncPromise = this.syncToTipUnsafe().finally(() => {
        this.syncPromise = null;
      });
    }
    return this.syncPromise;
  }

  async syncToTipUnsafe() {
    await this.load();
    const bestHeight = normalizeNonNegativeInteger(
      await this.pearlRpc("getblockcount", []),
      "bestHeight"
    );

    const rollbackChanged = await this.rollbackDisconnectedTip(bestHeight);
    const appendChanged = await this.appendMissingBlocks(bestHeight);

    if (!rollbackChanged && !appendChanged && this.canUseStoredSnapshotFastPath(bestHeight)) {
      const snapshot = await this.storage.readSnapshot();
      if (snapshot) {
        return {
          bestHeight,
          startHeight: this.manifest.startHeight,
          indexedHeight: this.manifest.indexedHeight,
          indexedHash: this.manifest.indexedHash,
          blocks: [],
          snapshot: this.refreshSnapshotNetwork(snapshot, bestHeight),
          status: this.buildStatus(bestHeight)
        };
      }
    }

    const blocks = await this.readCanonicalBlocks();
    const snapshot = this.buildSnapshot(bestHeight, blocks);
    await this.storage.writeSnapshot(snapshot);

    return {
      bestHeight,
      startHeight: this.manifest.startHeight,
      indexedHeight: this.manifest.indexedHeight,
      indexedHash: this.manifest.indexedHash,
      blocks,
      snapshot,
      status: this.buildStatus(bestHeight)
    };
  }

  async load() {
    if (this.manifest) {
      return this.manifest;
    }

    await this.storage.init();
    const manifest = await this.storage.readManifest();

    this.manifest = manifest
      ? normalizeManifest(manifest, this.chain, this.startHeight)
      : createEmptyManifest(this.chain, this.startHeight, this.now());

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

  async readCanonicalBlocks() {
    return this.storage.readBlocks(this.manifest.blocks);
  }

  buildSnapshot(bestHeight, blocks) {
    const storageStatus = this.storage.publicStatus?.() ?? {
      backend: "custom",
      productionReady: false
    };
    return ingestPearlBlocksFixture(
      {
        network: {
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
        },
        prl20MintFee: this.mintFeePolicy,
        blocks
      },
      { mintFeePolicy: this.mintFeePolicy }
    );
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
      lastSyncedAt: this.manifest.lastSyncedAt
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
    return {
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
    };
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
