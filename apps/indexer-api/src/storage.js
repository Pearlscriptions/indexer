import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const INDEXER_STORAGE_BACKENDS = {
  jsonFile: "json-file",
  postgres: "postgres"
};

const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_FILE = "snapshot.json";

export function createIndexerStorage(options = {}) {
  const backend = normalizeStorageBackend(options.backend ?? "json-file");
  if (backend === INDEXER_STORAGE_BACKENDS.jsonFile) {
    return new JsonFileIndexerStorage(options);
  }
  if (backend === INDEXER_STORAGE_BACKENDS.postgres) {
    return new PostgresIndexerStorage(options);
  }
  throw new Error(`unsupported PRL-20 indexer storage backend ${backend}`);
}

export class JsonFileIndexerStorage {
  constructor({ storeDir } = {}) {
    if (!storeDir) {
      throw new Error("JsonFileIndexerStorage requires a storeDir");
    }
    this.backend = INDEXER_STORAGE_BACKENDS.jsonFile;
    this.storeDir = storeDir;
    this.blocksDir = join(storeDir, "blocks");
    this.manifestPath = join(storeDir, MANIFEST_FILE);
    this.snapshotPath = join(storeDir, SNAPSHOT_FILE);
  }

  async init() {
    await mkdir(this.blocksDir, { recursive: true });
  }

  async readManifest() {
    return readJson(this.manifestPath).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
  }

  async writeManifest(manifest) {
    await writeJsonAtomic(this.manifestPath, manifest);
  }

  async writeBlock({ height, hash, block }) {
    const file = blockFileName(height, hash);
    await writeJsonAtomic(join(this.blocksDir, file), block);
    return { file };
  }

  async deleteBlock(file) {
    await unlink(join(this.blocksDir, String(file))).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  async readBlock(file) {
    return readJson(join(this.blocksDir, String(file)));
  }

  async readBlocks(blockRefs) {
    const blocks = [];
    for (const block of blockRefs) {
      blocks.push(await this.readBlock(block.file));
    }
    return blocks;
  }

  async writeSnapshot(snapshot) {
    await writeJsonAtomic(this.snapshotPath, snapshot);
  }

  async readSnapshot() {
    return readJson(this.snapshotPath).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
  }

  publicStatus() {
    return {
      backend: this.backend,
      storeDir: this.storeDir,
      productionReady: false,
      warning:
        "JSON/file-backed indexer storage is suitable for local proof work and controlled staging only. Use database-backed storage before public traffic."
    };
  }
}

export class PostgresIndexerStorage {
  constructor({
    databaseUrl = process.env.PRL20_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
    pool = null,
    manifestName = "default"
  } = {}) {
    this.backend = INDEXER_STORAGE_BACKENDS.postgres;
    this.databaseUrl = databaseUrl;
    this.databaseConfigured = Boolean(databaseUrl);
    this.pool = pool;
    this.ownsPool = false;
    this.manifestName = String(manifestName || "default");
  }

  async init() {
    await this.query("SELECT 1 AS ok", []);
  }

  async readManifest() {
    const result = await this.query(
      `SELECT schema_version, chain, start_height, indexed_height, indexed_hash, blocks_json,
              reorg_count, created_at, last_synced_at
         FROM indexer_manifests
        WHERE name = $1`,
      [this.manifestName]
    );
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      schemaVersion: Number(row.schema_version),
      chain: row.chain,
      startHeight: Number(row.start_height),
      indexedHeight: row.indexed_height === null ? null : Number(row.indexed_height),
      indexedHash: row.indexed_hash ?? null,
      blocks: normalizeJsonArray(row.blocks_json),
      reorgCount: Number(row.reorg_count ?? 0),
      createdAt: normalizeIso(row.created_at),
      lastSyncedAt: row.last_synced_at === null ? null : normalizeIso(row.last_synced_at)
    };
  }

  async writeManifest(manifest) {
    await this.query(
      `INSERT INTO indexer_manifests (
          name, schema_version, chain, start_height, indexed_height, indexed_hash,
          blocks_json, reorg_count, created_at, last_synced_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now())
       ON CONFLICT (name) DO UPDATE SET
          schema_version = EXCLUDED.schema_version,
          chain = EXCLUDED.chain,
          start_height = EXCLUDED.start_height,
          indexed_height = EXCLUDED.indexed_height,
          indexed_hash = EXCLUDED.indexed_hash,
          blocks_json = EXCLUDED.blocks_json,
          reorg_count = EXCLUDED.reorg_count,
          created_at = EXCLUDED.created_at,
          last_synced_at = EXCLUDED.last_synced_at,
          updated_at = now()`,
      [
        this.manifestName,
        manifest.schemaVersion,
        manifest.chain,
        manifest.startHeight,
        manifest.indexedHeight,
        manifest.indexedHash,
        JSON.stringify(manifest.blocks ?? []),
        manifest.reorgCount ?? 0,
        manifest.createdAt,
        manifest.lastSyncedAt
      ]
    );
  }

  async writeBlock({ height, hash, block }) {
    const normalizedHeight = normalizeNonNegativeInteger(height, "height");
    const normalizedHash = assertHash(hash, "hash");
    await this.query(
      `INSERT INTO chain_blocks (manifest_name, height, hash, previous_hash, block_time, raw_json, canonical, indexed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, now())
       ON CONFLICT (manifest_name, height) DO UPDATE SET
          hash = EXCLUDED.hash,
          previous_hash = EXCLUDED.previous_hash,
          block_time = EXCLUDED.block_time,
          raw_json = EXCLUDED.raw_json,
          canonical = TRUE,
          indexed_at = now()`,
      [
        this.manifestName,
        normalizedHeight,
        normalizedHash,
        block.previousblockhash ?? block.previousHash ?? null,
        blockTimeToDate(block.time ?? block.blocktime ?? null),
        JSON.stringify(block)
      ]
    );
    return { file: postgresBlockRef(normalizedHeight, normalizedHash) };
  }

  async deleteBlock(file) {
    const { height, hash } = parsePostgresBlockRef(file);
    await this.query(
      "UPDATE chain_blocks SET canonical = FALSE WHERE manifest_name = $1 AND height = $2 AND hash = $3",
      [this.manifestName, height, hash]
    );
  }

  async readBlock(file) {
    const { height, hash } = parsePostgresBlockRef(file);
    const result = await this.query(
      "SELECT raw_json FROM chain_blocks WHERE manifest_name = $1 AND height = $2 AND hash = $3 AND canonical = TRUE",
      [this.manifestName, height, hash]
    );
    if (result.rows.length === 0) {
      const error = new Error(`stored block not found ${file}`);
      error.code = "ENOENT";
      throw error;
    }
    return result.rows[0].raw_json;
  }

  async readBlocks(blockRefs) {
    const blocks = [];
    for (const blockRef of blockRefs) {
      blocks.push(await this.readBlock(blockRef.file));
    }
    return blocks;
  }

  async writeSnapshot(snapshot) {
    const storedSnapshot = compactSnapshotForStorage(snapshot);
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO indexer_snapshots (name, snapshot_json, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (name) DO UPDATE SET
            snapshot_json = EXCLUDED.snapshot_json,
            updated_at = now()`,
        [this.manifestName, JSON.stringify(storedSnapshot)]
      );
      if (hasReadModelSnapshot(snapshot)) {
        await materializeReadModels(client, this.manifestName, snapshot);
      }
    });
  }

  async readSnapshot() {
    const result = await this.query(
      "SELECT snapshot_json FROM indexer_snapshots WHERE name = $1",
      [this.manifestName]
    );
    return result.rows.length === 0 ? null : normalizeJsonObject(result.rows[0].snapshot_json);
  }

  async listInscriptionsPage(searchParams = new URLSearchParams()) {
    return this.listInscriptionsPageForOwner(null, searchParams);
  }

  async listAddressInscriptionsPage(address, searchParams = new URLSearchParams()) {
    return this.listInscriptionsPageForOwner(String(address ?? ""), searchParams);
  }

  async listAddressUtxos(address, searchParams = new URLSearchParams()) {
    const pagination = parseReadPagination(searchParams, { defaultLimit: 200, maxLimit: 500 });
    const params = [this.manifestName, String(address ?? "")];
    const where = ["manifest_name = $1", "address = $2"];
    const protectedFilter = searchParams.get("protected");
    if (protectedFilter === "true" || protectedFilter === "false") {
      params.push(protectedFilter === "true");
      where.push(`protected = $${params.length}`);
    }
    const spendableFilter = searchParams.get("spendable");
    if (spendableFilter === "true" || spendableFilter === "false") {
      params.push(spendableFilter === "true");
      where.push(`spendable = $${params.length}`);
    }
    const whereSql = where.join(" AND ");
    const count = await this.query(
      `SELECT COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE protected)::bigint AS protected_total,
              COUNT(*) FILTER (WHERE spendable)::bigint AS spendable_total,
              COALESCE(SUM(value_grain), 0)::text AS total_value_grain
         FROM indexer_read_utxos
        WHERE ${whereSql}`,
      params
    );
    const rows = await this.query(
      `SELECT record_json
         FROM indexer_read_utxos
        WHERE ${whereSql}
        ORDER BY protected ASC, spendable DESC, value_grain DESC, block_height ASC NULLS LAST, outpoint ASC
        LIMIT $${params.length + 1}
       OFFSET $${params.length + 2}`,
      [...params, pagination.limit, pagination.offset]
    );
    const utxos = rows.rows.map((row) => normalizeJsonObject(row.record_json));
    const total = dbInteger(count.rows[0]?.total);
    const totalValueGrain = String(count.rows[0]?.total_value_grain ?? "0");
    return {
      utxos,
      ...readPageMetadata(total, pagination.limit, pagination.offset, utxos.length),
      protectedTotal: dbInteger(count.rows[0]?.protected_total),
      spendableTotal: dbInteger(count.rows[0]?.spendable_total),
      totalValueGrain,
      totalValuePrl: grainToPrl(totalValueGrain)
    };
  }

  async listInscriptionsPageForOwner(address, searchParams) {
    const order = searchParams.get("order") === "desc" ? "desc" : "asc";
    const pagination = parseReadPagination(searchParams, { defaultLimit: 48, maxLimit: 100 });
    const params = [this.manifestName];
    const where = ["manifest_name = $1"];
    if (address) {
      params.push(address);
      where.push(`current_owner_address = $${params.length}`);
    }
    const whereSql = where.join(" AND ");
    const count = await this.query(
      `SELECT COUNT(*)::bigint AS total,
              MIN(inscription_number)::bigint AS first_inscription_number,
              MAX(inscription_number)::bigint AS latest_inscription_number
         FROM indexer_read_inscriptions
        WHERE ${whereSql}`,
      params
    );
    const orderSql = order === "desc" ? "DESC" : "ASC";
    const rows = await this.query(
      `SELECT record_json
         FROM indexer_read_inscriptions
        WHERE ${whereSql}
        ORDER BY inscription_number ${orderSql}
        LIMIT $${params.length + 1}
       OFFSET $${params.length + 2}`,
      [...params, pagination.limit, pagination.offset]
    );
    const inscriptions = rows.rows.map((row) => normalizeJsonObject(row.record_json));
    const total = dbInteger(count.rows[0]?.total);
    return {
      inscriptions,
      ...readPageMetadata(total, pagination.limit, pagination.offset, inscriptions.length),
      order,
      firstInscriptionNumber: dbNullableInteger(count.rows[0]?.first_inscription_number),
      latestInscriptionNumber: dbNullableInteger(count.rows[0]?.latest_inscription_number),
      rangeFirstInscriptionNumber: inscriptions[0]?.inscriptionNumber ?? null,
      rangeLastInscriptionNumber: inscriptions.at(-1)?.inscriptionNumber ?? null
    };
  }

  async close() {
    if (this.ownsPool && this.pool?.end) {
      await this.pool.end();
    }
  }

  publicStatus() {
    return {
      backend: this.backend,
      databaseConfigured: this.databaseConfigured,
      productionReady: this.databaseConfigured || Boolean(this.pool),
      readModels: true,
      warning:
        "Postgres indexer storage is available. Run migrations before production sync."
    };
  }

  async getPool() {
    if (this.pool) {
      return this.pool;
    }
    if (!this.databaseUrl) {
      throw new Error("POSTGRES_DATABASE_URL_REQUIRED");
    }
    const { Pool } = await import("pg");
    this.pool = new Pool({
      connectionString: this.databaseUrl,
      application_name: "prl20-indexer-storage"
    });
    this.ownsPool = true;
    return this.pool;
  }

  async query(sql, params = []) {
    const pool = await this.getPool();
    return pool.query(sql, params);
  }

  async withTransaction(callback) {
    const pool = await this.getPool();
    const client = typeof pool.connect === "function" ? await pool.connect() : pool;
    const release = typeof client.release === "function" ? () => client.release() : null;
    const transactional = typeof pool.connect === "function";
    try {
      if (transactional) {
        await client.query("BEGIN", []);
      }
      const result = await callback(client);
      if (transactional) {
        await client.query("COMMIT", []);
      }
      return result;
    } catch (error) {
      if (transactional) {
        await client.query("ROLLBACK", []).catch(() => {});
      }
      throw error;
    } finally {
      release?.();
    }
  }
}

export function blockFileName(height, hash) {
  return `${String(normalizeNonNegativeInteger(height, "height")).padStart(12, "0")}-${assertHash(hash, "hash")}.json`;
}

export function assertHash(value, name) {
  const text = String(value ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error(`invalid ${name}`);
  }
  return text.toLowerCase();
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJsonAtomic(path, value) {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function normalizeStorageBackend(value) {
  const backend = String(value ?? "json-file").trim().toLowerCase();
  if (backend === "json" || backend === "file" || backend === "json-file") {
    return INDEXER_STORAGE_BACKENDS.jsonFile;
  }
  if (backend === "postgres" || backend === "postgresql" || backend === "pg") {
    return INDEXER_STORAGE_BACKENDS.postgres;
  }
  return backend;
}

function normalizeNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || !Number.isSafeInteger(number)) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return number;
}

function normalizeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

function normalizeIso(value) {
  if (!value) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function postgresBlockRef(height, hash) {
  return `pg:${normalizeNonNegativeInteger(height, "height")}:${assertHash(hash, "hash")}`;
}

function parsePostgresBlockRef(value) {
  const text = String(value ?? "");
  if (text.startsWith("pg:")) {
    const [, height, hash] = text.split(":");
    return {
      height: normalizeNonNegativeInteger(height, "height"),
      hash: assertHash(hash, "hash")
    };
  }
  const match = text.match(/^(\d+)-([0-9a-fA-F]{64})\.json$/);
  if (match) {
    return {
      height: normalizeNonNegativeInteger(match[1], "height"),
      hash: assertHash(match[2], "hash")
    };
  }
  throw new Error(`invalid postgres block ref ${text}`);
}

function blockTimeToDate(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return new Date(number * 1000);
}

function hasReadModelSnapshot(snapshot) {
  return Boolean(
    snapshot &&
      (Array.isArray(snapshot.inscriptions) ||
        (snapshot.utxos && typeof snapshot.utxos === "object"))
  );
}

function compactSnapshotForStorage(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }

  const {
    transactions,
    outputsByOutpoint,
    spendsByOutpoint,
    txStatus,
    utxos,
    prlBalances,
    addressToScriptPubKey,
    ...compact
  } = snapshot;

  const stored = { ...compact };
  if (
    addressToScriptPubKey !== undefined ||
    Array.isArray(snapshot.inscriptions) ||
    Array.isArray(snapshot.transferLots)
  ) {
    stored.addressToScriptPubKey = compactAddressToScriptPubKey(snapshot, addressToScriptPubKey);
  }
  if (prlBalances !== undefined) {
    stored.prlBalances = {};
  }
  return stored;
}

function compactAddressToScriptPubKey(snapshot, originalMap = {}) {
  const compact = {};
  const addPair = (address, scriptPubKey) => {
    const normalizedAddress = normalizeOptionalText(address);
    const normalizedScript = normalizeOptionalText(scriptPubKey);
    if (normalizedAddress && normalizedScript) {
      compact[normalizedAddress] = normalizedScript;
    }
  };

  for (const inscription of snapshot.inscriptions ?? []) {
    addPair(inscription.ownerAddress, inscription.ownerScriptPubKey);
    addPair(inscription.currentOwnerAddress, inscription.currentOwnerScriptPubKey);
  }

  for (const lot of snapshot.transferLots ?? []) {
    addPair(lot.originalOwnerAddress, lot.originalOwnerScriptPubKey);
    addPair(lot.currentOwnerAddress, lot.currentOwnerScriptPubKey);
    addPair(lot.fillOwnerAddress, lot.fillOwnerScriptPubKey);
  }

  for (const [address, scriptPubKey] of Object.entries(originalMap ?? {})) {
    if (compact[address]) {
      continue;
    }
    const addressHasTokenState =
      Boolean(snapshot.state?.balances?.[address]) || Boolean(snapshot.state?.balances?.[scriptPubKey]);
    if (addressHasTokenState) {
      addPair(address, scriptPubKey);
    }
  }

  return compact;
}

async function materializeReadModels(client, manifestName, snapshot) {
  await materializeReadModelTable({
    client,
    manifestName,
    table: "indexer_read_inscriptions",
    rows: inscriptionReadRows(snapshot)
  });
  await materializeReadModelTable({
    client,
    manifestName,
    table: "indexer_read_utxos",
    rows: utxoReadRows(snapshot)
  });
}

async function materializeReadModelTable({ client, manifestName, table, rows }) {
  await client.query(`DELETE FROM ${table} WHERE manifest_name = $1`, [manifestName]);
  if (rows.length === 0) {
    return;
  }
  const json = JSON.stringify(rows);
  if (table === "indexer_read_inscriptions") {
    await client.query(
      `INSERT INTO indexer_read_inscriptions (
          manifest_name, inscription_id, inscription_number, current_owner_address,
          current_owner_script_pubkey, record_json, updated_at
       )
       SELECT $1, row.inscription_id, row.inscription_number, row.current_owner_address,
              row.current_owner_script_pubkey, row.record_json, now()
         FROM jsonb_to_recordset($2::jsonb) AS row(
              inscription_id TEXT,
              inscription_number BIGINT,
              current_owner_address TEXT,
              current_owner_script_pubkey TEXT,
              record_json JSONB
            )`,
      [manifestName, json]
    );
    return;
  }
  if (table === "indexer_read_utxos") {
    await client.query(
      `INSERT INTO indexer_read_utxos (
          manifest_name, outpoint, txid, vout, address, script_pubkey, value_grain,
          block_height, confirmations, coinbase, spendable, protected,
          protection_reason, inscription_id, inscription_number, transfer_lot_id,
          record_json, updated_at
       )
       SELECT $1, row.outpoint, row.txid, row.vout, row.address, row.script_pubkey,
              row.value_grain, row.block_height, row.confirmations, row.coinbase,
              row.spendable, row.protected, row.protection_reason, row.inscription_id,
              row.inscription_number, row.transfer_lot_id, row.record_json, now()
         FROM jsonb_to_recordset($2::jsonb) AS row(
              outpoint TEXT,
              txid TEXT,
              vout INTEGER,
              address TEXT,
              script_pubkey TEXT,
              value_grain NUMERIC(30,0),
              block_height BIGINT,
              confirmations INTEGER,
              coinbase BOOLEAN,
              spendable BOOLEAN,
              protected BOOLEAN,
              protection_reason TEXT,
              inscription_id TEXT,
              inscription_number BIGINT,
              transfer_lot_id TEXT,
              record_json JSONB
            )`,
      [manifestName, json]
    );
  }
}

function inscriptionReadRows(snapshot) {
  return (snapshot.inscriptions ?? [])
    .map((inscription) => {
      const id = String(inscription.id ?? inscription.inscriptionId ?? "");
      const inscriptionNumber = safeIntegerOrNull(inscription.inscriptionNumber);
      if (!id || inscriptionNumber === null) {
        return null;
      }
      const record = publicInscriptionReadRecord(inscription);
      return {
        inscription_id: id,
        inscription_number: inscriptionNumber,
        current_owner_address: record.currentOwnerAddress ?? null,
        current_owner_script_pubkey: record.currentOwnerScriptPubKey ?? null,
        record_json: record
      };
    })
    .filter(Boolean);
}

function publicInscriptionReadRecord(inscription) {
  return {
    id: inscription.id ?? inscription.inscriptionId,
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

function utxoReadRows(snapshot) {
  const rows = [];
  for (const [address, utxos] of Object.entries(snapshot.utxos ?? {})) {
    if (!Array.isArray(utxos)) {
      continue;
    }
    for (const utxo of utxos) {
      const outpoint = normalizeOptionalText(utxo.outpoint ?? `${utxo.txid ?? ""}:${utxo.vout ?? ""}`);
      const txid = normalizeOptionalText(utxo.txid);
      const vout = safeIntegerOrNull(utxo.vout);
      const valueGrain = numericStringOrNull(utxo.valueGrain ?? "0") ?? "0";
      if (!outpoint || !txid || vout === null) {
        continue;
      }
      const record = publicUtxoReadRecord(utxo, { address, outpoint, txid, vout, valueGrain });
      rows.push({
        outpoint,
        txid,
        vout,
        address: normalizeOptionalText(record.address) ?? address,
        script_pubkey: normalizeOptionalText(record.scriptPubKey),
        value_grain: valueGrain,
        block_height: safeIntegerOrNull(record.blockHeight),
        confirmations: safeIntegerOrNull(record.confirmations),
        coinbase: Boolean(record.coinbase),
        spendable: Boolean(record.spendable),
        protected: Boolean(record.protected),
        protection_reason: normalizeOptionalText(record.protectionReason),
        inscription_id: normalizeOptionalText(record.inscriptionId),
        inscription_number: safeIntegerOrNull(record.inscriptionNumber),
        transfer_lot_id: normalizeOptionalText(record.transferLotId),
        record_json: record
      });
    }
  }
  return rows;
}

function publicUtxoReadRecord(utxo, normalized) {
  return {
    ...utxo,
    key: normalized.outpoint,
    outpoint: normalized.outpoint,
    txid: normalized.txid,
    vout: normalized.vout,
    address: normalizeOptionalText(utxo.address) ?? normalized.address,
    scriptPubKey: utxo.scriptPubKey ?? null,
    valueGrain: normalized.valueGrain,
    valuePrl: utxo.valuePrl ?? grainToPrl(normalized.valueGrain),
    blockHeight: utxo.blockHeight ?? null,
    confirmations: utxo.confirmations ?? null,
    coinbase: Boolean(utxo.coinbase),
    spendable: Boolean(utxo.spendable),
    protected: Boolean(utxo.protected),
    protectionReason: utxo.protectionReason ?? null,
    inscriptionId: utxo.inscriptionId ?? null,
    inscriptionNumber: utxo.inscriptionNumber ?? null,
    transferLotId: utxo.transferLotId ?? null,
    source: utxo.source ?? "indexer-read-model"
  };
}

function parseReadPagination(searchParams, { defaultLimit, maxLimit }) {
  const limit = boundedInteger(searchParams.get("limit"), defaultLimit, { min: 1, max: maxLimit });
  const pageValue = searchParams.get("page");
  if (pageValue !== null && pageValue !== "") {
    const page = boundedInteger(pageValue, 1, { min: 1, max: Number.MAX_SAFE_INTEGER });
    return { limit, offset: Math.min((page - 1) * limit, 50_000_000) };
  }
  return {
    limit,
    offset: boundedInteger(searchParams.get("offset"), 0, { min: 0, max: 50_000_000 })
  };
}

function readPageMetadata(total, limit, offset, itemsLength) {
  return {
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pageCount: Math.max(1, Math.ceil(total / limit)),
    hasPrev: offset > 0,
    hasNext: offset + limit < total,
    itemStart: total === 0 || itemsLength === 0 ? 0 : offset + 1,
    itemEnd: total === 0 || itemsLength === 0 ? 0 : Math.min(total, offset + itemsLength)
  };
}

function boundedInteger(value, fallback, { min, max }) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function dbInteger(value) {
  return Number(value ?? 0);
}

function dbNullableInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

function normalizeJsonObject(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function safeIntegerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function normalizeOptionalText(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function numericStringOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = String(value);
  return /^(0|[1-9][0-9]*)$/.test(text) ? text : null;
}

function grainToPrl(value) {
  const grains = BigInt(String(value ?? "0"));
  const whole = grains / 100_000_000n;
  const fractional = (grains % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${fractional}`;
}
