pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "common.circom";

// Claim: patient has at least one record in category X.
template HasCategoryClaim(depth) {
    // Private inputs
    signal input patient_secret;
    signal input category_code_private;
    signal input disease_code_private;
    signal input lab_code_private;
    signal input lab_value_scaled_private;
    signal input timestamp_day_private;
    signal input record_salt;
    signal input merkle_siblings[depth];
    signal input merkle_path_index[depth];
    signal input nonce;

    // Public inputs (fixed order for Solidity compatibility)
    signal input claim_type;
    signal input claim_key_a;
    signal input claim_key_b;
    signal input claim_key_c;
    signal input record_merkle_root;
    signal input patient_commitment;
    signal input verifier_scope;
    signal input expires_at;
    signal input nullifier;

    // HAS_CATEGORY type id
    claim_type === 1;

    // For this claim type, keyA is the category and keyB/keyC are unused.
    claim_key_a === category_code_private;
    claim_key_b === 0;
    claim_key_c === 0;

    component recordCommitment = RecordCommitment();
    recordCommitment.category_code <== category_code_private;
    recordCommitment.disease_code <== disease_code_private;
    recordCommitment.lab_code <== lab_code_private;
    recordCommitment.lab_value_scaled <== lab_value_scaled_private;
    recordCommitment.timestamp_day <== timestamp_day_private;
    recordCommitment.record_salt <== record_salt;

    component merklePath = MerklePath(depth);
    merklePath.leaf <== recordCommitment.commitment;

    for (var i = 0; i < depth; i++) {
        merklePath.siblings[i] <== merkle_siblings[i];
        merklePath.path_index[i] <== merkle_path_index[i];
    }

    merklePath.root === record_merkle_root;

    component patientHasher = Poseidon(1);
    patientHasher.inputs[0] <== patient_secret;
    patientHasher.out === patient_commitment;

    component nullifierHasher = NullifierHash();
    nullifierHasher.patient_secret <== patient_secret;
    nullifierHasher.verifier_scope <== verifier_scope;
    nullifierHasher.claim_type <== claim_type;
    nullifierHasher.claim_key <== claim_key_a;
    nullifierHasher.expires_at <== expires_at;
    nullifierHasher.nonce <== nonce;
    nullifierHasher.nullifier === nullifier;
}

component main {
    public [
        claim_type,
        claim_key_a,
        claim_key_b,
        claim_key_c,
        record_merkle_root,
        patient_commitment,
        verifier_scope,
        expires_at,
        nullifier
    ]
} = HasCategoryClaim(20);
