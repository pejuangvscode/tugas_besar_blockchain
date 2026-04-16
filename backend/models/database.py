import os
from datetime import datetime
from pathlib import Path
from typing import Generator

from dotenv import load_dotenv
from sqlalchemy import BigInteger, Boolean, Column, DateTime, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import Session, sessionmaker


# Load backend/.env first, then root .env as fallback for local runs.
BACKEND_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = BACKEND_DIR.parent
load_dotenv(BACKEND_DIR / ".env", override=False)
load_dotenv(ROOT_DIR / ".env", override=False)


DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/medrecords")

engine = create_engine(DATABASE_URL, future=True, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


class MedicalRecord(Base):
    __tablename__ = "medical_records"

    id = Column(Integer, primary_key=True, index=True)
    patient_address = Column(Text, nullable=False, index=True)
    doctor_address = Column(Text, nullable=False, index=True)
    encrypted_data = Column(Text, nullable=False)
    leaf_hash = Column(Text, nullable=False, index=True)
    merkle_proof = Column(JSONB, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class MerkleRoot(Base):
    __tablename__ = "merkle_roots"

    id = Column(Integer, primary_key=True, index=True)
    patient_address = Column(Text, nullable=False, index=True)
    merkle_root = Column(Text, nullable=False)
    tx_hash = Column(String(66), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class WalletRole(Base):
    __tablename__ = "wallet_roles"

    id = Column(Integer, primary_key=True, index=True)
    wallet_address = Column(Text, nullable=False, unique=True, index=True)
    role = Column(String(32), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class SelectiveClaimAuditLog(Base):
    __tablename__ = "selective_claim_audit_logs"

    id = Column(BigInteger, primary_key=True, index=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    claim_type = Column(String(32), nullable=False, index=True)
    status = Column(String(32), nullable=False, default="generated", index=True)

    patient_address = Column(Text, nullable=False, index=True)
    verifier_scope = Column(Text, nullable=False)
    expires_at = Column(BigInteger, nullable=False)
    nullifier = Column(Text, nullable=False, index=True)

    claim_digest = Column(Text, nullable=True)
    claim_id = Column(Text, nullable=True, index=True)
    onchain_root = Column(Text, nullable=True)
    manager_contract_address = Column(Text, nullable=True)
    tx_hash = Column(Text, nullable=True)

    record_id = Column(Integer, ForeignKey("medical_records.id", ondelete="SET NULL"), nullable=True)

    claim_params = Column(JSONB, nullable=False, default=dict)
    public_signals = Column(JSONB, nullable=False, default=list)
    proof_payload = Column(JSONB, nullable=False, default=dict)

    valid = Column(Boolean, nullable=True)
    reason = Column(Text, nullable=True)
    verified_at = Column(DateTime(timezone=True), nullable=True)


class SelectiveNullifierUsed(Base):
    __tablename__ = "selective_nullifier_used"

    id = Column(BigInteger, primary_key=True, index=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    nullifier = Column(Text, nullable=False, index=True)
    claim_type = Column(String(32), nullable=False, index=True)

    patient_address = Column(Text, nullable=False, index=True)
    verifier_scope = Column(Text, nullable=False)
    expires_at = Column(BigInteger, nullable=False)

    used_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    claim_log_id = Column(
        BigInteger,
        ForeignKey("selective_claim_audit_logs.id", ondelete="SET NULL"),
        nullable=True,
    )
    reason = Column(Text, nullable=True)


class NoDiseaseSmtSnapshot(Base):
    __tablename__ = "no_disease_smt_snapshots"

    id = Column(BigInteger, primary_key=True, index=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    patient_address = Column(Text, nullable=False, index=True)
    snapshot_version = Column(Integer, nullable=False)
    tree_depth = Column(Integer, nullable=False, default=32)

    disease_index_namespace = Column(Text, nullable=False, default="ICD10")
    sparse_root = Column(Text, nullable=False)
    default_leaf_value = Column(Text, nullable=False, default="0")
    leaf_count = Column(Integer, nullable=False, default=0)

    is_active = Column(Boolean, nullable=False, default=True)
    metadata_json = Column("metadata", JSONB, nullable=False, default=dict)

    anchored_merkle_root_id = Column(
        Integer,
        ForeignKey("merkle_roots.id", ondelete="SET NULL"),
        nullable=True,
    )
    anchored_tx_hash = Column(Text, nullable=True)


class NoDiseaseSmtLeafIndex(Base):
    __tablename__ = "no_disease_smt_leaf_index"

    id = Column(BigInteger, primary_key=True, index=True)
    snapshot_id = Column(
        BigInteger,
        ForeignKey("no_disease_smt_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    disease_code = Column(Text, nullable=False)
    smt_key = Column(Text, nullable=False)
    leaf_value = Column(Text, nullable=False, default="0")
    presence_count = Column(Integer, nullable=False, default=0)

    latest_record_id = Column(
        Integer,
        ForeignKey("medical_records.id", ondelete="SET NULL"),
        nullable=True,
    )
    metadata_json = Column("metadata", JSONB, nullable=False, default=dict)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class NoDiseaseSmtProofCache(Base):
    __tablename__ = "no_disease_smt_proof_cache"

    id = Column(BigInteger, primary_key=True, index=True)
    snapshot_id = Column(
        BigInteger,
        ForeignKey("no_disease_smt_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    disease_code = Column(Text, nullable=False)

    proof_siblings = Column(JSONB, nullable=False, default=list)
    proof_path_indices = Column(JSONB, nullable=False, default=list)

    generated_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)


def create_tables() -> None:
    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
