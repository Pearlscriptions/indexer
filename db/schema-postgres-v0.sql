-- PRL-20 / Pearlscriptions production schema draft v0.
-- The persistent indexer runtime currently uses chain_blocks, indexer_manifests,
-- and indexer_snapshots. The remaining normalized tables are the target schema
-- for production query serving and later rebuild jobs.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chain_blocks (
  manifest_name TEXT NOT NULL DEFAULT 'default',
  height BIGINT NOT NULL,
  hash TEXT NOT NULL,
  previous_hash TEXT,
  block_time TIMESTAMPTZ,
  raw_json JSONB NOT NULL,
  canonical BOOLEAN NOT NULL DEFAULT TRUE,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_name, height),
  UNIQUE (manifest_name, hash)
);

ALTER TABLE chain_blocks
  ADD COLUMN IF NOT EXISTS manifest_name TEXT NOT NULL DEFAULT 'default';

CREATE UNIQUE INDEX IF NOT EXISTS chain_blocks_manifest_height_idx
  ON chain_blocks(manifest_name, height);

CREATE UNIQUE INDEX IF NOT EXISTS chain_blocks_manifest_hash_idx
  ON chain_blocks(manifest_name, hash);

CREATE TABLE IF NOT EXISTS indexer_manifests (
  name TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  chain TEXT NOT NULL,
  start_height BIGINT NOT NULL,
  indexed_height BIGINT,
  indexed_hash TEXT,
  blocks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  reorg_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_snapshots (
  name TEXT PRIMARY KEY,
  snapshot_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_read_inscriptions (
  manifest_name TEXT NOT NULL,
  inscription_id TEXT NOT NULL,
  inscription_number BIGINT NOT NULL,
  current_owner_address TEXT,
  current_owner_script_pubkey TEXT,
  record_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_name, inscription_id)
);

CREATE INDEX IF NOT EXISTS indexer_read_inscriptions_number_idx
  ON indexer_read_inscriptions(manifest_name, inscription_number);

CREATE INDEX IF NOT EXISTS indexer_read_inscriptions_owner_idx
  ON indexer_read_inscriptions(manifest_name, current_owner_address, inscription_number);

CREATE TABLE IF NOT EXISTS indexer_read_utxos (
  manifest_name TEXT NOT NULL,
  outpoint TEXT NOT NULL,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  address TEXT,
  script_pubkey TEXT,
  value_grain NUMERIC(30,0) NOT NULL,
  block_height BIGINT,
  confirmations BIGINT NOT NULL DEFAULT 0,
  coinbase BOOLEAN NOT NULL DEFAULT FALSE,
  spendable BOOLEAN NOT NULL DEFAULT FALSE,
  protected BOOLEAN NOT NULL DEFAULT FALSE,
  protection_reason TEXT,
  inscription_id TEXT,
  inscription_number BIGINT,
  transfer_lot_id TEXT,
  record_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_name, outpoint)
);

CREATE INDEX IF NOT EXISTS indexer_read_utxos_address_idx
  ON indexer_read_utxos(manifest_name, address, spendable, protected, value_grain DESC);

CREATE INDEX IF NOT EXISTS indexer_read_utxos_address_scan_idx
  ON indexer_read_utxos(manifest_name, address, protected, spendable DESC, value_grain DESC, outpoint);

CREATE INDEX IF NOT EXISTS indexer_read_utxos_protected_idx
  ON indexer_read_utxos(manifest_name, protected, inscription_number);

CREATE INDEX IF NOT EXISTS indexer_read_utxos_coinbase_maturity_idx
  ON indexer_read_utxos(manifest_name, block_height)
  WHERE coinbase = TRUE
    AND protected = FALSE
    AND spendable = FALSE
    AND block_height IS NOT NULL;

CREATE TABLE IF NOT EXISTS chain_transactions (
  txid TEXT PRIMARY KEY,
  block_height BIGINT,
  tx_index INTEGER NOT NULL,
  raw_tx_hex TEXT NOT NULL,
  canonical BOOLEAN NOT NULL DEFAULT TRUE,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chain_transactions_block_idx
  ON chain_transactions(block_height, tx_index);

CREATE TABLE IF NOT EXISTS chain_outputs (
  outpoint TEXT PRIMARY KEY,
  txid TEXT NOT NULL REFERENCES chain_transactions(txid),
  vout INTEGER NOT NULL,
  value_grain NUMERIC(30,0) NOT NULL,
  address TEXT,
  script_pubkey TEXT,
  spent_by_txid TEXT,
  spent_by_input_index INTEGER,
  spent_at_height BIGINT,
  protected BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS chain_outputs_address_idx
  ON chain_outputs(address);

CREATE INDEX IF NOT EXISTS chain_outputs_spent_idx
  ON chain_outputs(spent_by_txid);

CREATE TABLE IF NOT EXISTS chain_inputs (
  txid TEXT NOT NULL REFERENCES chain_transactions(txid),
  input_index INTEGER NOT NULL,
  previous_outpoint TEXT,
  witness_json JSONB,
  PRIMARY KEY (txid, input_index)
);

CREATE TABLE IF NOT EXISTS inscriptions (
  inscription_id TEXT PRIMARY KEY,
  inscription_number BIGINT NOT NULL UNIQUE,
  txid TEXT NOT NULL REFERENCES chain_transactions(txid),
  input_index INTEGER NOT NULL,
  inscription_index INTEGER NOT NULL,
  owner_output_index INTEGER NOT NULL,
  owner_outpoint TEXT,
  owner_address TEXT,
  owner_script_pubkey TEXT,
  protocol_marker TEXT,
  content_type TEXT,
  byte_length INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_preview TEXT,
  body_bytes BYTEA,
  block_height BIGINT NOT NULL,
  tx_index INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
);

CREATE INDEX IF NOT EXISTS inscriptions_marker_idx
  ON inscriptions(protocol_marker, content_type);

CREATE INDEX IF NOT EXISTS inscriptions_owner_idx
  ON inscriptions(owner_address);

CREATE TABLE IF NOT EXISTS inscription_locations (
  id BIGSERIAL PRIMARY KEY,
  inscription_id TEXT NOT NULL REFERENCES inscriptions(inscription_id),
  outpoint TEXT NOT NULL,
  owner_address TEXT,
  owner_script_pubkey TEXT,
  output_index INTEGER NOT NULL,
  block_height BIGINT,
  txid TEXT,
  tx_index INTEGER,
  location_order NUMERIC(30,0) NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS inscription_locations_current_idx
  ON inscription_locations(inscription_id, location_order DESC);

CREATE TABLE IF NOT EXISTS prl20_operations (
  inscription_id TEXT PRIMARY KEY REFERENCES inscriptions(inscription_id),
  op TEXT,
  ticker TEXT,
  amount NUMERIC(40,0),
  valid BOOLEAN NOT NULL,
  invalid_reason TEXT,
  invalid_message TEXT,
  owner_address TEXT,
  owner_script_pubkey TEXT,
  mint_fee_required BOOLEAN NOT NULL DEFAULT FALSE,
  required_mint_fee_grain NUMERIC(30,0),
  paid_mint_fee_grain NUMERIC(30,0),
  block_height BIGINT NOT NULL,
  tx_index INTEGER NOT NULL,
  inscription_number BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS prl20_operations_ticker_op_idx
  ON prl20_operations(ticker, op, valid);

CREATE TABLE IF NOT EXISTS prl20_balances (
  owner_key TEXT NOT NULL,
  owner_address TEXT,
  owner_script_pubkey TEXT,
  ticker TEXT NOT NULL,
  overall_balance NUMERIC(40,0) NOT NULL DEFAULT 0,
  available_balance NUMERIC(40,0) NOT NULL DEFAULT 0,
  transferable_balance NUMERIC(40,0) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_key, ticker)
);

CREATE TABLE IF NOT EXISTS prl20_transfer_lots (
  inscription_id TEXT PRIMARY KEY REFERENCES inscriptions(inscription_id),
  ticker TEXT NOT NULL,
  amount NUMERIC(40,0) NOT NULL,
  original_outpoint TEXT NOT NULL,
  current_outpoint TEXT,
  original_owner_address TEXT,
  original_owner_script_pubkey TEXT,
  current_owner_address TEXT,
  current_owner_script_pubkey TEXT,
  status TEXT NOT NULL,
  filled_txid TEXT,
  filled_block_height BIGINT
);

CREATE INDEX IF NOT EXISTS prl20_transfer_lots_owner_idx
  ON prl20_transfer_lots(current_owner_address, ticker, status);

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  name TEXT PRIMARY KEY,
  block_height BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  metadata JSONB
);

INSERT INTO schema_migrations (version, description)
VALUES ('schema-postgres-v0', 'Initial Pearlscriptions / PRL-20 public indexer schema')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, description)
VALUES ('schema-postgres-v0-1.3.0-coinbase-maturity-index', 'Add partial index for incremental read-model coinbase maturity updates')
ON CONFLICT (version) DO NOTHING;
