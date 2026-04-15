pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

// Canonical commitment for one medical record leaf.
template RecordCommitment() {
    signal input category_code;
    signal input disease_code;
    signal input lab_code;
    signal input lab_value_scaled;
    signal input timestamp_day;
    signal input record_salt;

    signal output commitment;

    component hasher = Poseidon(6);
    hasher.inputs[0] <== category_code;
    hasher.inputs[1] <== disease_code;
    hasher.inputs[2] <== lab_code;
    hasher.inputs[3] <== lab_value_scaled;
    hasher.inputs[4] <== timestamp_day;
    hasher.inputs[5] <== record_salt;

    commitment <== hasher.out;
}

template MerklePath(depth) {
    signal input leaf;
    signal input siblings[depth];
    signal input path_index[depth];

    signal output root;

    signal current[depth + 1];
    signal left[depth];
    signal right[depth];
    component hashers[depth];

    current[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        path_index[i] * (path_index[i] - 1) === 0;

        left[i] <== current[i] + path_index[i] * (siblings[i] - current[i]);
        right[i] <== siblings[i] + path_index[i] * (current[i] - siblings[i]);

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        current[i + 1] <== hashers[i].out;
    }

    root <== current[depth];
}

template NullifierHash() {
    signal input patient_secret;
    signal input verifier_scope;
    signal input claim_type;
    signal input claim_key;
    signal input expires_at;
    signal input nonce;

    signal output nullifier;

    component hasher = Poseidon(6);
    hasher.inputs[0] <== patient_secret;
    hasher.inputs[1] <== verifier_scope;
    hasher.inputs[2] <== claim_type;
    hasher.inputs[3] <== claim_key;
    hasher.inputs[4] <== expires_at;
    hasher.inputs[5] <== nonce;

    nullifier <== hasher.out;
}
