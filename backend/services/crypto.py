import base64
import hashlib
import json
import os
from typing import Dict

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def derive_key_from_patient_address(patient_address: str) -> bytes:
    normalized_address = patient_address.lower().encode("utf-8")
    return hashlib.sha256(normalized_address).digest()


def encrypt_raw_text(raw_text: str, patient_address: str) -> Dict[str, str]:
    key = derive_key_from_patient_address(patient_address)
    iv = os.urandom(12)

    aesgcm = AESGCM(key)
    encrypted = aesgcm.encrypt(iv, raw_text.encode("utf-8"), None)
    ciphertext = encrypted[:-16]
    tag = encrypted[-16:]

    return {
        "alg": "AES-256-GCM",
        "iv": base64.b64encode(iv).decode("utf-8"),
        "ciphertext": base64.b64encode(ciphertext).decode("utf-8"),
        "tag": base64.b64encode(tag).decode("utf-8"),
    }


def decrypt_raw_text(encrypted_payload: Dict[str, str], patient_address: str) -> str:
    key = derive_key_from_patient_address(patient_address)
    iv = base64.b64decode(encrypted_payload["iv"])
    ciphertext = base64.b64decode(encrypted_payload["ciphertext"])
    tag = base64.b64decode(encrypted_payload["tag"])

    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ciphertext + tag, None)
    return plaintext.decode("utf-8")


def hash_encrypted_blob(encrypted_payload: Dict[str, str]) -> str:
    canonical_json = json.dumps(encrypted_payload, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
    return f"0x{digest}"
