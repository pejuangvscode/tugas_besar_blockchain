# Selective Disclosure Medical Record Blueprint

This blueprint defines an implementation-ready scheme for selective disclosure claims in this repository.

Goal:
- Prove specific medical conditions without revealing full medical records.
- Keep compatibility with current Merkle root anchoring and on-chain verification flow.

## 1) Claim Types

This design separates claims into dedicated circuits:

1. `HAS_CATEGORY`
- Statement: patient has at least one medical record in category X.

2. `LAB_IN_RANGE`
- Statement: lab metric Y is within [min, max], without revealing actual value.

3. `NO_DISEASE`
- Statement: patient has no record for disease code Z.
- Requires non-membership structure (Sparse Merkle Tree or indexed accumulator), not a simple append-only Merkle list.

## 2) Canonical Data and Commitments

Use canonical integer encodings for all fields before hashing.

Recommended field encoding:
- `categoryCode`: uint16
- `diseaseCode`: uint32
- `labCode`: uint32
- `labValueScaled`: uint32 (value multiplied by fixed decimal scale)
- `timestampDay`: uint32
- `recordSalt`: field element (random)

Record commitment:
- `recordCommitment = Poseidon(categoryCode, diseaseCode, labCode, labValueScaled, timestampDay, recordSalt)`

Merkle root:
- Existing `merkleRoot` is anchored on chain and treated as authoritative public state.

Patient commitment (privacy-friendly identifier):
- `patientCommitment = Poseidon(patientSecret)`

## 3) Nullifier Design (Anti Replay)

Nullifier formula:
- `nullifier = Poseidon(patientSecret, verifierScope, claimType, claimKey, epochBucket, nonce)`

Fields:
- `verifierScope`: hashed verifier domain or verifier wallet
- `claimType`: enum id (1, 2, 3)
- `claimKey`: claim-specific key (category code, lab code, disease code)
- `epochBucket`: optional time bucket for rotating consent windows
- `nonce`: patient-chosen random value to avoid deterministic reuse

Rule:
- Contract must reject reused nullifier.

## 4) Exact Signal Contracts Per Circuit

## 4.1 HAS_CATEGORY Circuit

Private inputs:
- `patientSecret`
- `categoryCodePrivate`
- `recordCommitmentPreimage` (encoded fields + `recordSalt`)
- `merklePathSiblings[]`
- `merklePathIndices[]`
- `nonce`

Public inputs:
- `claimType = 1`
- `fieldCategory` (expected category code)
- `recordMerkleRoot`
- `patientCommitment`
- `verifierScope`
- `expiresAt`
- `nullifier`

Constraints:
- Recompute `recordCommitment` from preimage.
- Verify Merkle membership of `recordCommitment` in `recordMerkleRoot`.
- Enforce `categoryCodePrivate == fieldCategory`.
- Enforce `patientCommitment == Poseidon(patientSecret)`.
- Enforce `nullifier` computed from private/public context.

Output behavior:
- If proof verifies, condition is true by construction.

## 4.2 LAB_IN_RANGE Circuit

Private inputs:
- `patientSecret`
- `labCodePrivate`
- `labValueScaledPrivate`
- `recordCommitmentPreimage`
- `merklePathSiblings[]`
- `merklePathIndices[]`
- `nonce`

Public inputs:
- `claimType = 2`
- `labCode`
- `rangeMin`
- `rangeMax`
- `recordMerkleRoot`
- `patientCommitment`
- `verifierScope`
- `expiresAt`
- `nullifier`

Constraints:
- Membership proof for committed record.
- Enforce `labCodePrivate == labCode`.
- Range checks: `rangeMin <= labValueScaledPrivate <= rangeMax`.
- Enforce patient commitment and nullifier binding.

Output behavior:
- Proof validity implies `conditionMet = true`.

## 4.3 NO_DISEASE Circuit

Precondition:
- Must use Sparse Merkle Tree keyed by `diseaseCode`.
- Leaf value indicates presence count or boolean presence.

Private inputs:
- `patientSecret`
- `diseaseCodePrivate`
- `absenceLeafPreimage` (zero/default value)
- `smtPathSiblings[]`
- `smtPathIndices[]`
- `nonce`

Public inputs:
- `claimType = 3`
- `diseaseCode`
- `recordMerkleRoot` (SMT root for disease index)
- `patientCommitment`
- `verifierScope`
- `expiresAt`
- `nullifier`

Constraints:
- Verify SMT non-membership (or membership to zero leaf, depending on SMT design).
- Enforce `diseaseCodePrivate == diseaseCode`.
- Enforce patient commitment and nullifier binding.

Output behavior:
- Proof validity implies no matched disease under current root snapshot.

## 5) Public Signal Order (Recommended)

To avoid Solidity verifier mismatches, use fixed order per circuit:

1. `claimType`
2. `claimKeyA` (categoryCode or labCode or diseaseCode)
3. `claimKeyB` (rangeMin or 0)
4. `claimKeyC` (rangeMax or 0)
5. `recordMerkleRoot`
6. `patientCommitment`
7. `verifierScope`
8. `expiresAt`
9. `nullifier`

Notes:
- Keep unused keys as zero for non-range claims.
- Store this order in one shared constant file across backend, frontend, and circuit generation scripts.

## 6) Contract Template Flow

Recommended contract responsibilities:

1. Root source of truth:
- Read root from `MedicalRecordRegistry` (or a dedicated selective-disclosure root registry).

2. Verification entrypoint:
- `submitSelectiveClaim(ClaimSubmission calldata submission)`

3. Checks before proof verify:
- Claim not expired (`block.timestamp <= expiresAt`).
- Nullifier unused.
- Root in public signals equals on-chain root for selected patient context.

4. Proof verification:
- Dispatch to verifier contract by claim type.
- Validate Groth16 proof with expected public signals.

5. Effects:
- Mark nullifier as used.
- Emit event with claim metadata and result.

Suggested event:
- `SelectiveClaimVerified(bytes32 claimId, uint8 claimType, bytes32 nullifier, bytes32 verifierScope, uint64 expiresAt, bool valid)`

## 7) API Payload Templates

## 7.1 Prove Request (frontend -> backend prover service)

`POST /selective-disclosure/prove`

Request body:
- `claim_type`: `HAS_CATEGORY | LAB_IN_RANGE | NO_DISEASE`
- `patient_context`:
  - `patient_address` or `patient_commitment`
  - `verifier_scope`
  - `expires_at`
  - `nonce`
- `claim_params`:
  - has category: `category_code`
  - lab in range: `lab_code`, `range_min`, `range_max`
  - no disease: `disease_code`
- `witness_bundle`:
  - record preimage fields
  - merkle siblings + indices (or SMT witness)
  - anchored root snapshot

Response body:
- `proof`
- `public_signals`
- `claim_digest`
- `nullifier`
- `expires_at`

## 7.2 Verify Request (frontend/backend verifier -> backend or chain)

`POST /selective-disclosure/verify`

Request body:
- `claim_type`
- `proof`
- `public_signals`
- `root_context`:
  - `patient_address` (if root lookup by patient)
  - optional expected root

Response body:
- `valid`
- `reason`
- `onchain_root`
- `nullifier_used`

## 7.3 On-chain Verify Submission

`submitSelectiveClaim(submission)` where submission includes:
- `claimType`
- `patientAddress` (or patient root context id)
- `verifierScope`
- `expiresAt`
- `nullifier`
- `publicSignals`
- `proof`

## 8) Integration Plan For This Repository

Phase 1 (MVP, high impact):
1. Implement `HAS_CATEGORY` circuit.
2. Implement `LAB_IN_RANGE` circuit.
3. Add verifier manager contract with nullifier guard.
4. Add frontend claim form and proof generation flow.
5. Add verifier page support for selective claim package.

Phase 2:
1. Introduce SMT structure for `NO_DISEASE` non-membership.
2. Add dedicated non-membership circuit.
3. Add consistency tests with changing root snapshots.

## 9) Security Checklist

- Use domain-separated Poseidon hashes for commitments and nullifiers.
- Bind proofs to verifier scope and expiry.
- Prevent nullifier replay on chain.
- Require exact public signal ordering.
- Reject stale roots and zero roots.
- Add property tests for range constraints and non-membership edge cases.
- Keep patient secret client-side only.

## 10) Compatibility Notes

- Existing root anchoring contract can remain unchanged for Phase 1.
- Existing third-party verifier route can be extended to accept selective claim package verification.
- Existing QR share flow can encode selective proof package as token payload.
