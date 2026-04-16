BEGIN;

-- =========================================================
-- Core tables (existing app flow)
-- =========================================================
CREATE TABLE IF NOT EXISTS medical_records (
  id SERIAL PRIMARY KEY,
  patient_address TEXT NOT NULL,
  doctor_address TEXT NOT NULL,
  encrypted_data TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  merkle_proof JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merkle_roots (
  id SERIAL PRIMARY KEY,
  patient_address TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  tx_hash TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_roles (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =========================================================
-- Helper trigger for updated_at columns
-- =========================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- =========================================================
-- Selective disclosure audit trail
-- =========================================================
CREATE TABLE IF NOT EXISTS selective_claim_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  claim_type TEXT NOT NULL CHECK (claim_type IN ('HAS_CATEGORY', 'LAB_IN_RANGE', 'NO_DISEASE')),
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'verified', 'rejected', 'expired', 'error')),

  patient_address TEXT NOT NULL,
  verifier_scope TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  nullifier TEXT NOT NULL,

  claim_digest TEXT,
  claim_id TEXT,
  onchain_root TEXT,
  manager_contract_address TEXT,
  tx_hash TEXT,

  record_id INTEGER REFERENCES medical_records(id) ON DELETE SET NULL,

  claim_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  public_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  proof_payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  valid BOOLEAN,
  reason TEXT,
  verified_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_selective_claim_audit_claim_id
  ON selective_claim_audit_logs (claim_id)
  WHERE claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_selective_claim_audit_patient_created
  ON selective_claim_audit_logs (LOWER(patient_address), created_at DESC);

CREATE INDEX IF NOT EXISTS idx_selective_claim_audit_type_created
  ON selective_claim_audit_logs (claim_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_selective_claim_audit_status_created
  ON selective_claim_audit_logs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_selective_claim_audit_nullifier
  ON selective_claim_audit_logs (LOWER(nullifier));

CREATE INDEX IF NOT EXISTS idx_selective_claim_audit_claim_params_gin
  ON selective_claim_audit_logs
  USING GIN (claim_params);

DROP TRIGGER IF EXISTS trg_selective_claim_audit_logs_updated_at
  ON selective_claim_audit_logs;

CREATE TRIGGER trg_selective_claim_audit_logs_updated_at
BEFORE UPDATE ON selective_claim_audit_logs
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- Off-chain nullifier usage for replay protection
-- =========================================================
CREATE TABLE IF NOT EXISTS selective_nullifier_used (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  nullifier TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('HAS_CATEGORY', 'LAB_IN_RANGE', 'NO_DISEASE')),

  patient_address TEXT NOT NULL,
  verifier_scope TEXT NOT NULL,
  expires_at BIGINT NOT NULL,

  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_log_id BIGINT REFERENCES selective_claim_audit_logs(id) ON DELETE SET NULL,

  reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_selective_nullifier_used_lower
  ON selective_nullifier_used (LOWER(nullifier));

CREATE INDEX IF NOT EXISTS idx_selective_nullifier_patient_scope
  ON selective_nullifier_used (LOWER(patient_address), LOWER(verifier_scope));

CREATE INDEX IF NOT EXISTS idx_selective_nullifier_used_at
  ON selective_nullifier_used (used_at DESC);

-- =========================================================
-- NO_DISEASE sparse Merkle snapshot metadata and index
-- =========================================================
CREATE TABLE IF NOT EXISTS no_disease_smt_snapshots (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  patient_address TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  tree_depth INTEGER NOT NULL DEFAULT 32 CHECK (tree_depth > 0 AND tree_depth <= 256),

  disease_index_namespace TEXT NOT NULL DEFAULT 'ICD10',
  sparse_root TEXT NOT NULL,
  default_leaf_value TEXT NOT NULL DEFAULT '0',
  leaf_count INTEGER NOT NULL DEFAULT 0 CHECK (leaf_count >= 0),

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  anchored_merkle_root_id INTEGER REFERENCES merkle_roots(id) ON DELETE SET NULL,
  anchored_tx_hash TEXT,

  UNIQUE (patient_address, snapshot_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_no_disease_active_snapshot_per_patient
  ON no_disease_smt_snapshots (LOWER(patient_address))
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_no_disease_snapshot_patient_created
  ON no_disease_smt_snapshots (LOWER(patient_address), created_at DESC);

CREATE INDEX IF NOT EXISTS idx_no_disease_snapshot_namespace
  ON no_disease_smt_snapshots (disease_index_namespace);

CREATE INDEX IF NOT EXISTS idx_no_disease_snapshot_metadata_gin
  ON no_disease_smt_snapshots
  USING GIN (metadata);

DROP TRIGGER IF EXISTS trg_no_disease_smt_snapshots_updated_at
  ON no_disease_smt_snapshots;

CREATE TRIGGER trg_no_disease_smt_snapshots_updated_at
BEFORE UPDATE ON no_disease_smt_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS no_disease_smt_leaf_index (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES no_disease_smt_snapshots(id) ON DELETE CASCADE,

  disease_code TEXT NOT NULL,
  smt_key TEXT NOT NULL,
  leaf_value TEXT NOT NULL DEFAULT '0',
  presence_count INTEGER NOT NULL DEFAULT 0 CHECK (presence_count >= 0),

  latest_record_id INTEGER REFERENCES medical_records(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (snapshot_id, disease_code),
  UNIQUE (snapshot_id, smt_key)
);

CREATE INDEX IF NOT EXISTS idx_no_disease_leaf_snapshot_presence
  ON no_disease_smt_leaf_index (snapshot_id, presence_count DESC);

CREATE INDEX IF NOT EXISTS idx_no_disease_leaf_metadata_gin
  ON no_disease_smt_leaf_index
  USING GIN (metadata);

DROP TRIGGER IF EXISTS trg_no_disease_smt_leaf_index_updated_at
  ON no_disease_smt_leaf_index;

CREATE TRIGGER trg_no_disease_smt_leaf_index_updated_at
BEFORE UPDATE ON no_disease_smt_leaf_index
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS no_disease_smt_proof_cache (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES no_disease_smt_snapshots(id) ON DELETE CASCADE,
  disease_code TEXT NOT NULL,

  proof_siblings JSONB NOT NULL DEFAULT '[]'::jsonb,
  proof_path_indices JSONB NOT NULL DEFAULT '[]'::jsonb,

  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_id, disease_code)
);

COMMIT;