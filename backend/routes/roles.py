from typing import Any, Dict, Literal, Optional

from eth_utils import is_address, to_checksum_address
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from models.database import WalletRole, get_db
from services.auth import build_wallet_role_typed_data, verify_typed_data_signature


router = APIRouter()

ALLOWED_ROLES = {"doctor", "patient", "verifier"}


class WalletRoleResponse(BaseModel):
    wallet_address: str
    role: Optional[Literal["doctor", "patient", "verifier"]] = None


class UpsertWalletRoleRequest(BaseModel):
    wallet_address: str = Field(..., description="Wallet address being assigned a role")
    role: Literal["doctor", "patient", "verifier"]
    signature: str = Field(..., description="EIP-712 signature from wallet owner")
    nonce: str = Field(default="", description="Client-generated replay protection nonce")


class UpsertWalletRoleResponse(BaseModel):
    wallet_address: str
    role: Literal["doctor", "patient", "verifier"]
    status: Literal["created", "updated"]


def _assert_eth_address(value: str, field_name: str) -> str:
    if not is_address(value):
        raise HTTPException(status_code=400, detail=f"Invalid Ethereum address in {field_name}")
    return to_checksum_address(value)


@router.get("/{wallet_address}", response_model=WalletRoleResponse)
def get_wallet_role(wallet_address: str, db: Session = Depends(get_db)) -> WalletRoleResponse:
    normalized_wallet = _assert_eth_address(wallet_address, "wallet_address")

    existing = (
        db.query(WalletRole)
        .filter(WalletRole.wallet_address == normalized_wallet)
        .first()
    )

    if not existing:
        return WalletRoleResponse(wallet_address=normalized_wallet, role=None)

    role = existing.role.lower()
    if role not in ALLOWED_ROLES:
        raise HTTPException(status_code=500, detail="Stored wallet role is invalid")

    return WalletRoleResponse(wallet_address=normalized_wallet, role=role)


@router.post("/upsert", response_model=UpsertWalletRoleResponse)
def upsert_wallet_role(
    payload: UpsertWalletRoleRequest, db: Session = Depends(get_db)
) -> UpsertWalletRoleResponse:
    normalized_wallet = _assert_eth_address(payload.wallet_address, "wallet_address")
    role = payload.role.lower()

    typed_data = build_wallet_role_typed_data(normalized_wallet, role, payload.nonce)
    is_valid_signature = verify_typed_data_signature(typed_data, payload.signature, normalized_wallet)

    if not is_valid_signature:
        raise HTTPException(status_code=401, detail="Invalid EIP-712 wallet role signature")

    existing = (
        db.query(WalletRole)
        .filter(WalletRole.wallet_address == normalized_wallet)
        .first()
    )

    status: Literal["created", "updated"]

    if existing:
        existing.role = role
        status = "updated"
    else:
        db.add(WalletRole(wallet_address=normalized_wallet, role=role))
        status = "created"

    db.commit()

    return UpsertWalletRoleResponse(wallet_address=normalized_wallet, role=role, status=status)
