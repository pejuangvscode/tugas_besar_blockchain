pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

template MedicalProof() {
    signal input raw_data_hash;
    signal input leaf_hash;

    component poseidonHasher = Poseidon(1);
    poseidonHasher.inputs[0] <== raw_data_hash;

    leaf_hash === poseidonHasher.out;
}

component main { public [leaf_hash] } = MedicalProof();
