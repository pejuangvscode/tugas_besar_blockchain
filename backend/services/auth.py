import hashlib
import json
import os
from typing import Dict

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import to_checksum_address


def _domain_data() -> Dict:
    contract_address = os.getenv("CONTRACT_ADDRESS", "0x0000000000000000000000000000000000000000")
    chain_id = int(os.getenv("SEPOLIA_CHAIN_ID", "11155111"))

    return {
        "name": "SovereignMedicalRecords",
        "version": "1",
        "chainId": chain_id,
        "verifyingContract": contract_address,
    }


def build_create_record_typed_data(
    patient_address: str,
    doctor_address: str,
    raw_text: str,
    nonce: str,
    structured_claim: Dict | None = None,
) -> Dict:
    raw_text_hash = "0x" + hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
    canonical_claim = json.dumps(structured_claim or {}, sort_keys=True, separators=(",", ":"))
    structured_claim_hash = "0x" + hashlib.sha256(canonical_claim.encode("utf-8")).hexdigest()

    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "CreateRecord": [
                {"name": "patient", "type": "address"},
                {"name": "doctor", "type": "address"},
                {"name": "rawTextHash", "type": "bytes32"},
                {"name": "structuredClaimHash", "type": "bytes32"},
                {"name": "nonce", "type": "string"},
            ],
        },
        "primaryType": "CreateRecord",
        "domain": _domain_data(),
        "message": {
            "patient": patient_address,
            "doctor": doctor_address,
            "rawTextHash": raw_text_hash,
            "structuredClaimHash": structured_claim_hash,
            "nonce": nonce,
        },
    }


def build_patient_access_typed_data(patient_address: str, nonce: str) -> Dict:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "PatientAccess": [
                {"name": "patient", "type": "address"},
                {"name": "nonce", "type": "string"},
            ],
        },
        "primaryType": "PatientAccess",
        "domain": _domain_data(),
        "message": {
            "patient": patient_address,
            "nonce": nonce,
        },
    }


def build_wallet_role_typed_data(wallet_address: str, role: str, nonce: str) -> Dict:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "WalletRole": [
                {"name": "wallet", "type": "address"},
                {"name": "role", "type": "string"},
                {"name": "nonce", "type": "string"},
            ],
        },
        "primaryType": "WalletRole",
        "domain": _domain_data(),
        "message": {
            "wallet": wallet_address,
            "role": role,
            "nonce": nonce,
        },
    }


def recover_typed_data_signer(typed_data: Dict, signature: str) -> str:
    encoded_message = encode_typed_data(full_message=typed_data)
    signer_address = Account.recover_message(encoded_message, signature=signature)
    return to_checksum_address(signer_address)


def verify_typed_data_signature(typed_data: Dict, signature: str, expected_address: str) -> bool:
    recovered_address = recover_typed_data_signer(typed_data, signature)
    return recovered_address.lower() == to_checksum_address(expected_address).lower()
