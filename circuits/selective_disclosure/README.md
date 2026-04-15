# Selective Disclosure Circuit Skeletons

This folder provides starter circuits for two selective disclosure claims:

- `has_category.circom`
- `lab_in_range.circom`

Both circuits expose public signals in fixed order:
1. claim_type
2. claim_key_a
3. claim_key_b
4. claim_key_c
5. record_merkle_root
6. patient_commitment
7. verifier_scope
8. expires_at
9. nullifier

Notes:
- Merkle depth is currently hardcoded to 20 in each `main` component.
- These are skeleton circuits for integration and iteration, not production-audited circuits.
- `NO_DISEASE` requires a sparse Merkle non-membership design and is intentionally not included yet.

Quick compile commands from `circuits` directory:

- `npx circom2 selective_disclosure/has_category.circom --r1cs --sym -o build -l ./node_modules -l ./selective_disclosure`
- `npx circom2 selective_disclosure/lab_in_range.circom --r1cs --sym -o build -l ./node_modules -l ./selective_disclosure`
