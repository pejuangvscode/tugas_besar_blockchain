import json
from typing import Any, Dict, List, Optional

from eth_utils import is_address, to_checksum_address
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from models.database import MedicalRecord, MerkleRoot, get_db
from services.auth import (
    build_create_record_typed_data,
    build_patient_access_typed_data,
    verify_typed_data_signature,
)
from services.crypto import encrypt_raw_text, hash_encrypted_blob
from services.merkle import build_merkle_root_and_proofs, verify_merkle_proof


router = APIRouter()


class CreateRecordRequest(BaseModel):
    patient_address: str = Field(..., description="Patient wallet address")
    raw_text: str = Field(..., description="Raw medical note text")
    doctor_address: str = Field(..., description="Doctor wallet address")
    signature: str = Field(..., description="EIP-712 signature from doctor")
    nonce: str = Field(default="", description="Client-generated replay protection nonce")


class CreateRecordResponse(BaseModel):
    merkle_root: str
    leaf_hash: str
    merkle_proof: List[Dict[str, str]]
    merkle_root_id: int


class VerifyRecordRequest(BaseModel):
    leaf_hash: str
    merkle_proof: List[Dict[str, str]]
    merkle_root: str


class VerifyRecordResponse(BaseModel):
    valid: bool


class UpdateMerkleTxHashRequest(BaseModel):
    merkle_root_id: int
    tx_hash: str


class RecordItem(BaseModel):
    id: int
    patient_address: str
    doctor_address: str
    encrypted_data: Dict[str, Any]
    leaf_hash: str
    merkle_proof: Optional[List[Dict[str, str]]]
    created_at: str


class PatientRecordsResponse(BaseModel):
    records: List[RecordItem]


class PublicVerificationRecordItem(BaseModel):
    id: int
    patient_address: str
    doctor_address: str
    leaf_hash: str
    merkle_proof: Optional[List[Dict[str, str]]]
    created_at: str


class PublicPatientVerificationResponse(BaseModel):
    patient_address: str
    latest_merkle_root: Optional[str]
    latest_tx_hash: Optional[str]
    records: List[PublicVerificationRecordItem]


def _assert_eth_address(value: str, field_name: str) -> str:
    if not is_address(value):
        raise HTTPException(status_code=400, detail=f"Invalid Ethereum address in {field_name}")
    return to_checksum_address(value)


@router.post("/create", response_model=CreateRecordResponse)
def create_record(payload: CreateRecordRequest, db: Session = Depends(get_db)) -> CreateRecordResponse:
    patient_address = _assert_eth_address(payload.patient_address, "patient_address")
    doctor_address = _assert_eth_address(payload.doctor_address, "doctor_address")

    typed_data = build_create_record_typed_data(
        patient_address=patient_address,
        doctor_address=doctor_address,
        raw_text=payload.raw_text,
        nonce=payload.nonce,
    )
    is_valid_signature = verify_typed_data_signature(typed_data, payload.signature, doctor_address)
    if not is_valid_signature:
        raise HTTPException(status_code=401, detail="Invalid EIP-712 doctor signature")

    encrypted_payload = encrypt_raw_text(payload.raw_text, patient_address)
    leaf_hash = hash_encrypted_blob(encrypted_payload)

    new_record = MedicalRecord(
        patient_address=patient_address,
        doctor_address=doctor_address,
        encrypted_data=json.dumps(encrypted_payload),
        leaf_hash=leaf_hash,
    )
    db.add(new_record)
    db.flush()

    patient_records = (
        db.query(MedicalRecord)
        .filter(MedicalRecord.patient_address == patient_address)
        .order_by(MedicalRecord.id.asc())
        .all()
    )
    leaf_hashes = [record.leaf_hash for record in patient_records]

    merkle_root, merkle_proofs = build_merkle_root_and_proofs(leaf_hashes)

    for index, record in enumerate(patient_records):
        record.merkle_proof = merkle_proofs[index]

    root_entry = MerkleRoot(patient_address=patient_address, merkle_root=merkle_root)
    db.add(root_entry)
    db.commit()
    db.refresh(root_entry)

    return CreateRecordResponse(
        merkle_root=merkle_root,
        leaf_hash=leaf_hash,
        merkle_proof=merkle_proofs[-1],
        merkle_root_id=root_entry.id,
    )


@router.get("/{patient_address}", response_model=PatientRecordsResponse)
def get_patient_records(
    patient_address: str,
    signature: str = Query(..., description="EIP-712 signature from patient"),
    nonce: str = Query("", description="Client-generated replay protection nonce"),
    db: Session = Depends(get_db),
) -> PatientRecordsResponse:
    normalized_patient = _assert_eth_address(patient_address, "patient_address")

    typed_data = build_patient_access_typed_data(normalized_patient, nonce)
    is_valid_signature = verify_typed_data_signature(typed_data, signature, normalized_patient)
    if not is_valid_signature:
        raise HTTPException(status_code=401, detail="Invalid EIP-712 patient signature")

    patient_records = (
        db.query(MedicalRecord)
        .filter(MedicalRecord.patient_address == normalized_patient)
        .order_by(MedicalRecord.created_at.desc())
        .all()
    )

    records_output: List[RecordItem] = []
    for record in patient_records:
        encrypted_data = json.loads(record.encrypted_data)
        records_output.append(
            RecordItem(
                id=record.id,
                patient_address=record.patient_address,
                doctor_address=record.doctor_address,
                encrypted_data=encrypted_data,
                leaf_hash=record.leaf_hash,
                merkle_proof=record.merkle_proof,
                created_at=record.created_at.isoformat(),
            )
        )

    return PatientRecordsResponse(records=records_output)


@router.get("/public/{patient_address}", response_model=PublicPatientVerificationResponse)
def get_public_patient_verification_records(
    patient_address: str,
    db: Session = Depends(get_db),
) -> PublicPatientVerificationResponse:
    normalized_patient = _assert_eth_address(patient_address, "patient_address")

    patient_records = (
        db.query(MedicalRecord)
        .filter(MedicalRecord.patient_address == normalized_patient)
        .order_by(MedicalRecord.created_at.desc())
        .all()
    )

    latest_root_entry = (
        db.query(MerkleRoot)
        .filter(MerkleRoot.patient_address == normalized_patient)
        .order_by(MerkleRoot.created_at.desc(), MerkleRoot.id.desc())
        .first()
    )

    records_output: List[PublicVerificationRecordItem] = []
    for record in patient_records:
        records_output.append(
            PublicVerificationRecordItem(
                id=record.id,
                patient_address=record.patient_address,
                doctor_address=record.doctor_address,
                leaf_hash=record.leaf_hash,
                merkle_proof=record.merkle_proof,
                created_at=record.created_at.isoformat(),
            )
        )

    return PublicPatientVerificationResponse(
        patient_address=normalized_patient,
        latest_merkle_root=latest_root_entry.merkle_root if latest_root_entry else None,
        latest_tx_hash=latest_root_entry.tx_hash if latest_root_entry else None,
        records=records_output,
    )


@router.post("/verify", response_model=VerifyRecordResponse)
def verify_record(payload: VerifyRecordRequest) -> VerifyRecordResponse:
    is_valid = verify_merkle_proof(payload.leaf_hash, payload.merkle_proof, payload.merkle_root)
    return VerifyRecordResponse(valid=is_valid)


@router.patch("/merkle_root/tx_hash")
def update_merkle_root_tx_hash(
    payload: UpdateMerkleTxHashRequest, db: Session = Depends(get_db)
) -> Dict[str, Any]:
    merkle_root_entry = db.query(MerkleRoot).filter(MerkleRoot.id == payload.merkle_root_id).first()
    if not merkle_root_entry:
        raise HTTPException(status_code=404, detail="Merkle root entry not found")

    merkle_root_entry.tx_hash = payload.tx_hash
    db.commit()

    return {
        "status": "updated",
        "merkle_root_id": merkle_root_entry.id,
        "tx_hash": merkle_root_entry.tx_hash,
    }
