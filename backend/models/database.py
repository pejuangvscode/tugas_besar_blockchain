import os
from datetime import datetime
from pathlib import Path
from typing import Generator

from dotenv import load_dotenv
from sqlalchemy import Column, DateTime, Integer, String, Text, create_engine
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


def create_tables() -> None:
    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
