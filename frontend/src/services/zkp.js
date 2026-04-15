import { sha256 } from "js-sha256";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function textToField(rawText) {
  const rawHashHex = sha256(rawText);
  return BigInt(`0x${rawHashHex}`) % SNARK_FIELD;
}

export async function generateMedicalProof(rawText, anchoredLeafHash) {
  const poseidon = await buildPoseidon();
  const rawDataHash = textToField(rawText);
  const poseidonLeaf = poseidon([rawDataHash]);
  const leafHash = poseidon.F.toString(poseidonLeaf);

  const input = {
    raw_data_hash: rawDataHash.toString(),
    leaf_hash: leafHash,
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    "/zk/medical_proof.wasm",
    "/zk/medical_proof_final.zkey"
  );

  const verificationKey = await fetch("/zk/verification_key.json").then((response) => {
    if (!response.ok) {
      throw new Error("Failed to load verification key. Build circuit artifacts first.");
    }
    return response.json();
  });

  const verified = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);

  return {
    scheme: "groth16",
    generated_at: new Date().toISOString(),
    anchored_leaf_hash: anchoredLeafHash,
    zkp_leaf_hash: leafHash,
    public_signals: publicSignals,
    proof,
    verified,
  };
}

export function downloadCertificateJson(filename, certificate) {
  const content = JSON.stringify(certificate, null, 2);
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  URL.revokeObjectURL(url);
}

export async function verifyMedicalCertificate(certificate) {
  if (!certificate || typeof certificate !== "object") {
    throw new Error("Invalid certificate payload.");
  }

  if (!certificate.proof || !certificate.public_signals) {
    throw new Error("Certificate must include proof and public_signals.");
  }

  const verificationKey = await fetch("/zk/verification_key.json").then((response) => {
    if (!response.ok) {
      throw new Error("Failed to load verification key. Build circuit artifacts first.");
    }
    return response.json();
  });

  return snarkjs.groth16.verify(
    verificationKey,
    certificate.public_signals,
    certificate.proof
  );
}
