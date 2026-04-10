import hashlib
from typing import Dict, List, Sequence, Tuple


def _strip_hex_prefix(value: str) -> str:
    return value[2:] if value.startswith("0x") else value


def _hex_to_bytes(value: str) -> bytes:
    return bytes.fromhex(_strip_hex_prefix(value))


def _bytes_to_hex(value: bytes) -> str:
    return f"0x{value.hex()}"


def _hash_pair(left: bytes, right: bytes) -> bytes:
    # Pair sorting keeps backend verification aligned with frontend merkletreejs settings.
    pair = sorted([left, right])
    return hashlib.sha256(pair[0] + pair[1]).digest()


def build_merkle_root_and_proofs(leaf_hashes: Sequence[str]) -> Tuple[str, List[List[Dict[str, str]]]]:
    if not leaf_hashes:
        return "0x" + "0" * 64, []

    leaves = [_hex_to_bytes(leaf) for leaf in leaf_hashes]
    levels: List[List[bytes]] = [leaves]

    current_level = leaves
    while len(current_level) > 1:
        if len(current_level) % 2 == 1:
            current_level = current_level + [current_level[-1]]

        next_level: List[bytes] = []
        for index in range(0, len(current_level), 2):
            next_level.append(_hash_pair(current_level[index], current_level[index + 1]))

        levels.append(next_level)
        current_level = next_level

    root = _bytes_to_hex(levels[-1][0])
    proofs: List[List[Dict[str, str]]] = []

    for leaf_index in range(len(leaves)):
        proof: List[Dict[str, str]] = []
        index_at_level = leaf_index

        for level_idx in range(len(levels) - 1):
            level_nodes = levels[level_idx]
            level_length = len(level_nodes)

            sibling_index = index_at_level ^ 1
            if sibling_index >= level_length:
                sibling_index = index_at_level

            sibling_hash = level_nodes[sibling_index]
            proof.append(
                {
                    "position": "left" if sibling_index < index_at_level else "right",
                    "hash": _bytes_to_hex(sibling_hash),
                }
            )

            index_at_level //= 2

        proofs.append(proof)

    return root, proofs


def verify_merkle_proof(leaf_hash: str, merkle_proof: Sequence[Dict[str, str]], merkle_root: str) -> bool:
    computed_hash = _hex_to_bytes(leaf_hash)

    for step in merkle_proof:
        sibling_hash = _hex_to_bytes(step["hash"])
        computed_hash = _hash_pair(computed_hash, sibling_hash)

    return _bytes_to_hex(computed_hash).lower() == merkle_root.lower()
