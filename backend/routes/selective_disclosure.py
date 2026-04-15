import hashlib
import json
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from eth_utils import is_address, to_checksum_address
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from models.database import MerkleRoot, get_db


router = APIRouter()

SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617


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


def _normalize_address(value: str, field_name: str) -> str:
    if not is_address(value):
        raise HTTPException(status_code=400, detail=f"Invalid Ethereum address in {field_name}")
    return to_checksum_address(value)


def _coerce_int(value: Any, field_name: str) -> int:
    if isinstance(value, int):
        return value

    if isinstance(value, str):
        raw = value.strip()
        if raw.startswith("0x"):
            return int(raw, 16)
        return int(raw)

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


@router.post("/prove", response_model=ProveSelectiveDisclosureResponse)
def prove_selective_disclosure(
    payload: ProveSelectiveDisclosureRequest,
    db: Session = Depends(get_db),
) -> ProveSelectiveDisclosureResponse:
    normalized_patient = _normalize_address(payload.patient_context.patient_address, "patient_address")

    latest_root_entry = _latest_root_for_patient(normalized_patient, db)
    if not latest_root_entry:
        raise HTTPException(status_code=404, detail="No anchored Merkle root found for this patient")

    claim_type_id = CLAIM_TYPE_TO_ID[payload.claim_type]
    claim_key_a, claim_key_b, claim_key_c = _claim_keys(payload.claim_type, payload.claim_params)

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
        "claim_params": payload.claim_params,
        "public_signals": public_signals,
    }
    claim_digest = hashlib.sha256(
        json.dumps(claim_digest_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    proof_stub = "0x" + hashlib.sha256(("proof|" + claim_digest).encode("utf-8")).hexdigest()

    return ProveSelectiveDisclosureResponse(
        claim_type=payload.claim_type,
        proof=proof_stub,
        public_signals=public_signals,
        nullifier="0x" + format(nullifier_int, "x"),
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
    latest_root_entry = _latest_root_for_patient(normalized_patient, db)
    if not latest_root_entry:
        return VerifySelectiveDisclosureResponse(
            valid=False,
            reason="No anchored root found for this patient",
            onchain_root=None,
            nullifier_used=False,
        )

    if len(payload.public_signals) < 9:
        return VerifySelectiveDisclosureResponse(
            valid=False,
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
    provided_nullifier = _coerce_int(payload.nullifier, "nullifier") % SNARK_FIELD

    now_epoch = int(datetime.now(tz=timezone.utc).timestamp())

    if signal_claim_type != expected_claim_type:
        return VerifySelectiveDisclosureResponse(
            valid=False,
            reason="Claim type mismatch between payload and public signals",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if signal_root != expected_root:
        return VerifySelectiveDisclosureResponse(
            valid=False,
            reason="Merkle root mismatch between public signals and latest anchored root",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if signal_expires_at != payload.expires_at:
        return VerifySelectiveDisclosureResponse(
            valid=False,
            reason="Expiry mismatch between payload and public signals",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if signal_nullifier != provided_nullifier:
        return VerifySelectiveDisclosureResponse(
            valid=False,
            reason="Nullifier mismatch between payload and public signals",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if payload.expires_at < now_epoch:
        return VerifySelectiveDisclosureResponse(
            valid=False,
            reason="Claim expired",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    if not payload.proof.strip():
        return VerifySelectiveDisclosureResponse(
            valid=False,
            reason="Proof is required",
            onchain_root=latest_root_entry.merkle_root,
            nullifier_used=False,
        )

    return VerifySelectiveDisclosureResponse(
        valid=True,
        reason="Stub verification passed structural checks only (cryptographic proof verification not yet enabled)",
        onchain_root=latest_root_entry.merkle_root,
        nullifier_used=False,
    )
