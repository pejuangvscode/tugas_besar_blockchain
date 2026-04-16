import os
import hashlib
import json
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from eth_utils import is_address, to_checksum_address
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from models.database import (
    MedicalRecord,
    MerkleRoot,
    SelectiveClaimAuditLog,
    SelectiveNullifierUsed,
    get_db,
)


router = APIRouter()

SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617
SELECTIVE_MANAGER_ADDRESS = os.getenv("SELECTIVE_MANAGER_ADDRESS", "").strip()


class ClaimType(str, Enum):
    HAS_CATEGORY = "HAS_CATEGORY"
    LAB_IN_RANGE = "LAB_IN_RANGE"
    NO_DISEASE = "NO_DISEASE"


CLAIM_TYPE_TO_ID = {
    ClaimType.HAS_CATEGORY: 1,
    ClaimType.LAB_IN_RANGE: 2,
    ClaimType.NO_DISEASE: 3,
}


class PatientContext(BaseModel):
    patient_address: str
    verifier_scope: str
    expires_at: int
    nonce: str


class ProveSelectiveDisclosureRequest(BaseModel):
    claim_type: ClaimType
    patient_context: PatientContext
    claim_params: Dict[str, Any] = Field(default_factory=dict)
    witness_bundle: Dict[str, Any] = Field(default_factory=dict)


class ProveSelectiveDisclosureResponse(BaseModel):
    claim_type: ClaimType
    proof: str
    public_signals: List[str]
    nullifier: str
    expires_at: int
    claim_digest: str
    stub: bool


class VerifySelectiveDisclosureRequest(BaseModel):
    claim_type: ClaimType
    patient_address: str
    verifier_scope: str
    expires_at: int
    nullifier: str
    proof: str
    public_signals: List[str]


class VerifySelectiveDisclosureResponse(BaseModel):
    valid: bool
    reason: str
    onchain_root: Optional[str]
    nullifier_used: bool


class SelectiveAuditLogItem(BaseModel):
    id: int
    created_at: datetime
    updated_at: Optional[datetime]

    claim_type: str
    status: str

    patient_address: str
    verifier_scope: str
    expires_at: int
    nullifier: str

    claim_digest: Optional[str]
    onchain_root: Optional[str]
    record_id: Optional[int]

    claim_params: Dict[str, Any]
    public_signals: List[str]

    valid: Optional[bool]
    reason: Optional[str]
    verified_at: Optional[datetime]
    nullifier_used: bool


class SelectiveAuditLogListResponse(BaseModel):
    items: List[SelectiveAuditLogItem]
    count: int


def _normalize_address(value: str, field_name: str) -> str:
    if not is_address(value):
        raise HTTPException(status_code=400, detail=f"Invalid Ethereum address in {field_name}")
    return to_checksum_address(value)


def _coerce_int(value: Any, field_name: str) -> int:
    if isinstance(value, int):
        return value

    if isinstance(value, str):
        raw = value.strip()
        try:
            if raw.startswith("0x"):
                return int(raw, 16)
            return int(raw)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=f"Invalid numeric value for {field_name}") from error

    raise HTTPException(status_code=400, detail=f"Invalid numeric value for {field_name}")


def _scope_to_int(scope_value: str) -> int:
    try:
        return _coerce_int(scope_value, "verifier_scope") % SNARK_FIELD
    except HTTPException:
        digest = hashlib.sha256(scope_value.encode("utf-8")).digest()
        return int.from_bytes(digest, "big") % SNARK_FIELD


def _patient_commitment_stub(patient_address: str) -> int:
    digest = hashlib.sha256(patient_address.encode("utf-8")).digest()
    return int.from_bytes(digest, "big") % SNARK_FIELD


def _latest_root_for_patient(patient_address: str, db: Session) -> Optional[MerkleRoot]:
    return (
        db.query(MerkleRoot)
        .filter(MerkleRoot.patient_address == patient_address)
        .order_by(MerkleRoot.created_at.desc(), MerkleRoot.id.desc())
        .first()
    )


def _extract_claim_data_from_record(record: MedicalRecord) -> Dict[str, int]:
    try:
        payload = json.loads(record.encrypted_data)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=500, detail="Corrupted encrypted payload in medical_records") from error

    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="Invalid encrypted payload format in medical_records")

    claim_data_raw = payload.get("claim_data", {}) if "encryption" in payload else {}
    if not isinstance(claim_data_raw, dict):
        claim_data_raw = {}

    normalized: Dict[str, int] = {}
    for key in ("diagnosis_code", "category_code", "lab_code", "lab_value"):
        if key in claim_data_raw:
            normalized[key] = _coerce_int(claim_data_raw[key], f"record.claim_data.{key}")

    return normalized


def _resolve_claim_params(
    *,
    claim_type: ClaimType,
    claim_params: Dict[str, Any],
    witness_bundle: Dict[str, Any],
    patient_address: str,
    db: Session,
) -> tuple[Dict[str, int], int]:
    record_id_raw = witness_bundle.get("record_id")
    if record_id_raw is None:
        raise HTTPException(status_code=400, detail="witness_bundle.record_id is required")

    record_id = _coerce_int(record_id_raw, "witness_bundle.record_id")
    record = (
        db.query(MedicalRecord)
        .filter(
            MedicalRecord.id == record_id,
            MedicalRecord.patient_address == patient_address,
        )
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Record not found for this patient")

    record_claim_data = _extract_claim_data_from_record(record)
    if not record_claim_data:
        raise HTTPException(
            status_code=400,
            detail="Selected record has no structured claim data. Create a new structured record from doctor dashboard.",
        )

    if claim_type == ClaimType.HAS_CATEGORY:
        if "category_code" not in record_claim_data:
            raise HTTPException(status_code=400, detail="Selected record does not include category_code")

        record_category = record_claim_data["category_code"]
        if "category_code" in claim_params and _coerce_int(claim_params["category_code"], "category_code") != record_category:
            raise HTTPException(status_code=400, detail="category_code does not match selected record")

        return {"category_code": record_category}, record_id

    if claim_type == ClaimType.LAB_IN_RANGE:
        if "lab_code" not in record_claim_data or "lab_value" not in record_claim_data:
            raise HTTPException(status_code=400, detail="Selected record does not include lab_code/lab_value")

        range_min = _coerce_int(claim_params.get("range_min"), "range_min")
        range_max = _coerce_int(claim_params.get("range_max"), "range_max")
        if range_min > range_max:
            raise HTTPException(status_code=400, detail="range_min must be <= range_max")

        record_lab_code = record_claim_data["lab_code"]
        record_lab_value = record_claim_data["lab_value"]

        if "lab_code" in claim_params and _coerce_int(claim_params["lab_code"], "lab_code") != record_lab_code:
            raise HTTPException(status_code=400, detail="lab_code does not match selected record")

        if record_lab_value < range_min or record_lab_value > range_max:
            raise HTTPException(
                status_code=400,
                detail="Selected record lab_value is outside requested range",
            )

        return {
            "lab_code": record_lab_code,
            "range_min": range_min,
            "range_max": range_max,
            "lab_value": record_lab_value,
        }, record_id

    if "diagnosis_code" not in record_claim_data:
        raise HTTPException(status_code=400, detail="Selected record does not include diagnosis_code")

    disease_code = _coerce_int(claim_params.get("disease_code"), "disease_code")
    diagnosis_code = record_claim_data["diagnosis_code"]
    if disease_code == diagnosis_code:
        raise HTTPException(
            status_code=400,
            detail="Cannot issue NO_DISEASE for a disease code present in selected record",
        )

    return {
        "disease_code": disease_code,
        "diagnosis_code": diagnosis_code,
    }, record_id


def _claim_keys(claim_type: ClaimType, claim_params: Dict[str, Any]) -> tuple[int, int, int]:
    if claim_type == ClaimType.HAS_CATEGORY:
        return _coerce_int(claim_params.get("category_code", 0), "category_code"), 0, 0

    if claim_type == ClaimType.LAB_IN_RANGE:
        return (
            _coerce_int(claim_params.get("lab_code", 0), "lab_code"),
            _coerce_int(claim_params.get("range_min", 0), "range_min"),
            _coerce_int(claim_params.get("range_max", 0), "range_max"),
        )

    return _coerce_int(claim_params.get("disease_code", 0), "disease_code"), 0, 0


def _normalize_nullifier(value: Any) -> tuple[int, str]:
    nullifier_int = _coerce_int(value, "nullifier") % SNARK_FIELD
    return nullifier_int, "0x" + format(nullifier_int, "x")


def _claim_params_from_signals(claim_type: ClaimType, public_signals: List[str]) -> Dict[str, int]:
    if len(public_signals) < 4:
        return {}

    try:
        claim_key_a = _coerce_int(public_signals[1], "public_signals[1]")
        claim_key_b = _coerce_int(public_signals[2], "public_signals[2]")
        claim_key_c = _coerce_int(public_signals[3], "public_signals[3]")
    except HTTPException:
        return {}

    if claim_type == ClaimType.HAS_CATEGORY:
        return {"category_code": claim_key_a}

    if claim_type == ClaimType.LAB_IN_RANGE:
        return {
            "lab_code": claim_key_a,
            "range_min": claim_key_b,
            "range_max": claim_key_c,
        }

    return {"disease_code": claim_key_a}


def _find_nullifier_usage(db: Session, canonical_nullifier: str) -> Optional[SelectiveNullifierUsed]:
    return (
        db.query(SelectiveNullifierUsed)
        .filter(func.lower(SelectiveNullifierUsed.nullifier) == canonical_nullifier.lower())
        .first()
    )


def _upsert_selective_claim_audit(
    db: Session,
    *,
    claim_type: ClaimType,
    patient_address: str,
    verifier_scope: str,
    expires_at: int,
    nullifier: str,
    status: str,
    valid: Optional[bool],
    reason: Optional[str],
    onchain_root: Optional[str],
    claim_params: Optional[Dict[str, Any]] = None,
    public_signals: Optional[List[str]] = None,
    proof_payload: Optional[Dict[str, Any]] = None,
    claim_digest: Optional[str] = None,
    record_id: Optional[int] = None,
    mark_verified: bool = False,
) -> SelectiveClaimAuditLog:
    claim_log = (
        db.query(SelectiveClaimAuditLog)
        .filter(
            SelectiveClaimAuditLog.patient_address == patient_address,
            func.lower(SelectiveClaimAuditLog.nullifier) == nullifier.lower(),
        )
        .order_by(SelectiveClaimAuditLog.created_at.desc(), SelectiveClaimAuditLog.id.desc())
        .first()
    )

    if not claim_log:
        claim_log = SelectiveClaimAuditLog(
            claim_type=claim_type.value,
            patient_address=patient_address,
            verifier_scope=verifier_scope,
            expires_at=expires_at,
            nullifier=nullifier,
        )
        db.add(claim_log)

    claim_log.claim_type = claim_type.value
    claim_log.status = status
    claim_log.patient_address = patient_address
    claim_log.verifier_scope = verifier_scope
    claim_log.expires_at = expires_at
    claim_log.nullifier = nullifier
    claim_log.valid = valid
    claim_log.reason = reason

    if onchain_root is not None:
        claim_log.onchain_root = onchain_root

    if claim_params is not None:
        claim_log.claim_params = claim_params

    if public_signals is not None:
        claim_log.public_signals = public_signals

    if proof_payload is not None:
        claim_log.proof_payload = proof_payload

    if claim_digest is not None:
        claim_log.claim_digest = claim_digest

    if record_id is not None:
        claim_log.record_id = record_id

    if SELECTIVE_MANAGER_ADDRESS:
        claim_log.manager_contract_address = SELECTIVE_MANAGER_ADDRESS

    if mark_verified:
        claim_log.verified_at = datetime.now(timezone.utc)

    db.flush()
    return claim_log


@router.get("/audit", response_model=SelectiveAuditLogListResponse)
def get_selective_disclosure_audit_logs(
    patient_address: Optional[str] = None,
    claim_type: Optional[ClaimType] = None,
    status: Optional[str] = None,
    limit: int = Query(default=20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> SelectiveAuditLogListResponse:
    query = db.query(SelectiveClaimAuditLog)

    if patient_address:
        normalized_patient = _normalize_address(patient_address, "patient_address")
        query = query.filter(SelectiveClaimAuditLog.patient_address == normalized_patient)

    if claim_type:
        query = query.filter(SelectiveClaimAuditLog.claim_type == claim_type.value)

    if status and status.strip():
        query = query.filter(func.lower(SelectiveClaimAuditLog.status) == status.strip().lower())

    rows = (
        query.order_by(SelectiveClaimAuditLog.created_at.desc(), SelectiveClaimAuditLog.id.desc())
        .limit(limit)
        .all()
    )

    nullifier_keys = [row.nullifier.strip().lower() for row in rows if isinstance(row.nullifier, str)]
    used_nullifiers: set[str] = set()
    if nullifier_keys:
        used_rows = (
            db.query(func.lower(SelectiveNullifierUsed.nullifier))
            .filter(func.lower(SelectiveNullifierUsed.nullifier).in_(nullifier_keys))
            .all()
        )
        used_nullifiers = {value for (value,) in used_rows if value}

    items: List[SelectiveAuditLogItem] = []
    for row in rows:
        parsed_public_signals = [str(item) for item in (row.public_signals or [])]
        parsed_claim_params = row.claim_params or {}
        normalized_nullifier = (row.nullifier or "").strip().lower()

        items.append(
            SelectiveAuditLogItem(
                id=row.id,
                created_at=row.created_at,
                updated_at=row.updated_at,
                claim_type=row.claim_type,
                status=row.status,
                patient_address=row.patient_address,
                verifier_scope=row.verifier_scope,
                expires_at=row.expires_at,
                nullifier=row.nullifier,
                claim_digest=row.claim_digest,
                onchain_root=row.onchain_root,
                record_id=row.record_id,
                claim_params=parsed_claim_params,
                public_signals=parsed_public_signals,
                valid=row.valid,
                reason=row.reason,
                verified_at=row.verified_at,
                nullifier_used=normalized_nullifier in used_nullifiers,
            )
        )

    return SelectiveAuditLogListResponse(items=items, count=len(items))


@router.post("/prove", response_model=ProveSelectiveDisclosureResponse)
def prove_selective_disclosure(
    payload: ProveSelectiveDisclosureRequest,
    db: Session = Depends(get_db),
) -> ProveSelectiveDisclosureResponse:
    normalized_patient = _normalize_address(payload.patient_context.patient_address, "patient_address")

    latest_root_entry = _latest_root_for_patient(normalized_patient, db)
    if not latest_root_entry:
        raise HTTPException(status_code=404, detail="No anchored Merkle root found for this patient")

    resolved_claim_params, record_id = _resolve_claim_params(
        claim_type=payload.claim_type,
        claim_params=payload.claim_params,
        witness_bundle=payload.witness_bundle,
        patient_address=normalized_patient,
        db=db,
    )

    claim_type_id = CLAIM_TYPE_TO_ID[payload.claim_type]
    claim_key_a, claim_key_b, claim_key_c = _claim_keys(payload.claim_type, resolved_claim_params)

    root_int = _coerce_int(latest_root_entry.merkle_root, "record_merkle_root") % SNARK_FIELD
    patient_commitment_int = _patient_commitment_stub(normalized_patient)
    verifier_scope_int = _scope_to_int(payload.patient_context.verifier_scope)

    nullifier_seed = "|".join(
        [
            normalized_patient,
            str(claim_type_id),
            str(claim_key_a),
            str(verifier_scope_int),
            str(payload.patient_context.expires_at),
            payload.patient_context.nonce,
        ]
    )
    nullifier_hash = hashlib.sha256(nullifier_seed.encode("utf-8")).hexdigest()
    nullifier_int = int(nullifier_hash, 16) % SNARK_FIELD

    public_signals = [
        str(claim_type_id),
        str(claim_key_a),
        str(claim_key_b),
        str(claim_key_c),
        str(root_int),
        str(patient_commitment_int),
        str(verifier_scope_int),
        str(payload.patient_context.expires_at),
        str(nullifier_int),
    ]

    claim_digest_payload = {
        "claim_type": payload.claim_type.value,
        "patient_address": normalized_patient,
        "claim_params": resolved_claim_params,
        "public_signals": public_signals,
    }
    claim_digest = hashlib.sha256(
        json.dumps(claim_digest_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    proof_stub = "0x" + hashlib.sha256(("proof|" + claim_digest).encode("utf-8")).hexdigest()
    nullifier_hex = "0x" + format(nullifier_int, "x")

    _upsert_selective_claim_audit(
        db,
        claim_type=payload.claim_type,
        patient_address=normalized_patient,
        verifier_scope=payload.patient_context.verifier_scope,
        expires_at=payload.patient_context.expires_at,
        nullifier=nullifier_hex,
        status="generated",
        valid=None,
        reason=None,
        onchain_root=latest_root_entry.merkle_root,
        claim_params=resolved_claim_params,
        public_signals=public_signals,
        proof_payload={
            "proof": proof_stub,
            "stub": True,
            "witness_bundle": payload.witness_bundle,
        },
        claim_digest="0x" + claim_digest,
        record_id=record_id,
        mark_verified=False,
    )
    db.commit()

    return ProveSelectiveDisclosureResponse(
        claim_type=payload.claim_type,
        proof=proof_stub,
        public_signals=public_signals,
        nullifier=nullifier_hex,
        expires_at=payload.patient_context.expires_at,
        claim_digest="0x" + claim_digest,
        stub=True,
    )


@router.post("/verify", response_model=VerifySelectiveDisclosureResponse)
def verify_selective_disclosure(
    payload: VerifySelectiveDisclosureRequest,
    db: Session = Depends(get_db),
) -> VerifySelectiveDisclosureResponse:
    normalized_patient = _normalize_address(payload.patient_address, "patient_address")
    provided_nullifier_int, canonical_nullifier = _normalize_nullifier(payload.nullifier)

    def reject_response(
        *,
        reason: str,
        onchain_root: Optional[str],
        status: str = "rejected",
        nullifier_used: bool = False,
    ) -> VerifySelectiveDisclosureResponse:
        _upsert_selective_claim_audit(
            db,
            claim_type=payload.claim_type,
            patient_address=normalized_patient,
            verifier_scope=payload.verifier_scope,
            expires_at=payload.expires_at,
            nullifier=canonical_nullifier,
            status=status,
            valid=False,
            reason=reason,
            onchain_root=onchain_root,
            claim_params=_claim_params_from_signals(payload.claim_type, payload.public_signals),
            public_signals=payload.public_signals,
            proof_payload={"proof": payload.proof, "stub": True},
            mark_verified=True,
        )
        db.commit()

        return VerifySelectiveDisclosureResponse(
            valid=False,
            reason=reason,
            onchain_root=onchain_root,
            nullifier_used=nullifier_used,
        )

    latest_root_entry = _latest_root_for_patient(normalized_patient, db)
    if not latest_root_entry:
        return reject_response(
            reason="No anchored root found for this patient",
            onchain_root=None,
            status="error",
            nullifier_used=False,
        )

    if _find_nullifier_usage(db, canonical_nullifier):
        return reject_response(
            reason="Nullifier already used (replay detected)",
            onchain_root=latest_root_entry.merkle_root,
            status="rejected",
            nullifier_used=True,
        )

    if len(payload.public_signals) < 9:
        return reject_response(
            reason="public_signals must contain at least 9 values",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    expected_claim_type = CLAIM_TYPE_TO_ID[payload.claim_type]
    signal_claim_type = _coerce_int(payload.public_signals[0], "public_signals[0]")

    expected_root = _coerce_int(latest_root_entry.merkle_root, "onchain_root") % SNARK_FIELD
    signal_root = _coerce_int(payload.public_signals[4], "public_signals[4]") % SNARK_FIELD

    signal_expires_at = _coerce_int(payload.public_signals[7], "public_signals[7]")
    signal_nullifier = _coerce_int(payload.public_signals[8], "public_signals[8]") % SNARK_FIELD
    provided_nullifier = provided_nullifier_int

    now_epoch = int(datetime.now(tz=timezone.utc).timestamp())

    if signal_claim_type != expected_claim_type:
        return reject_response(
            reason="Claim type mismatch between payload and public signals",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if signal_root != expected_root:
        return reject_response(
            reason="Merkle root mismatch between public signals and latest anchored root",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if signal_expires_at != payload.expires_at:
        return reject_response(
            reason="Expiry mismatch between payload and public signals",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if signal_nullifier != provided_nullifier:
        return reject_response(
            reason="Nullifier mismatch between payload and public signals",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if payload.expires_at < now_epoch:
        return reject_response(
            reason="Claim expired",
            onchain_root=latest_root_entry.merkle_root,
            status="expired",
            nullifier_used=False,
        )

    if not payload.proof.strip():
        return reject_response(
            reason="Proof is required",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    success_reason = (
        "Stub verification passed structural checks only "
        "(cryptographic proof verification not yet enabled)"
    )

    claim_log = _upsert_selective_claim_audit(
        db,
        claim_type=payload.claim_type,
        patient_address=normalized_patient,
        verifier_scope=payload.verifier_scope,
        expires_at=payload.expires_at,
        nullifier=canonical_nullifier,
        status="verified",
        valid=True,
        reason=success_reason,
        onchain_root=latest_root_entry.merkle_root,
        claim_params=_claim_params_from_signals(payload.claim_type, payload.public_signals),
        public_signals=payload.public_signals,
        proof_payload={"proof": payload.proof, "stub": True},
        mark_verified=True,
    )

    db.add(
        SelectiveNullifierUsed(
            nullifier=canonical_nullifier,
            claim_type=payload.claim_type.value,
            patient_address=normalized_patient,
            verifier_scope=payload.verifier_scope,
            expires_at=payload.expires_at,
            claim_log_id=claim_log.id,
            reason="verified",
        )
    )
    db.commit()

    return VerifySelectiveDisclosureResponse(
        valid=True,
        reason=success_reason,
        onchain_root=latest_root_entry.merkle_root,
        nullifier_used=False,
    )
