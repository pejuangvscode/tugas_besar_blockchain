import { ethers } from "ethers";

const DOMAIN_NAME = "SovereignMedicalRecords";
const DOMAIN_VERSION = "1";
const DOMAIN_CHAIN_ID = Number(import.meta.env.VITE_SEPOLIA_CHAIN_ID || 11155111);
const VERIFYING_CONTRACT =
  import.meta.env.VITE_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";

function buildDomain() {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: DOMAIN_CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  };
}

export function buildCreateRecordTypedData({ patientAddress, doctorAddress, rawText, nonce }) {
  const message = {
    patient: ethers.getAddress(patientAddress),
    doctor: ethers.getAddress(doctorAddress),
    rawTextHash: ethers.sha256(ethers.toUtf8Bytes(rawText)),
    nonce,
  };

  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      CreateRecord: [
        { name: "patient", type: "address" },
        { name: "doctor", type: "address" },
        { name: "rawTextHash", type: "bytes32" },
        { name: "nonce", type: "string" },
      ],
    },
    primaryType: "CreateRecord",
    domain: buildDomain(),
    message,
  };
}

export function buildPatientAccessTypedData({ patientAddress, nonce }) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PatientAccess: [
        { name: "patient", type: "address" },
        { name: "nonce", type: "string" },
      ],
    },
    primaryType: "PatientAccess",
    domain: buildDomain(),
    message: {
      patient: ethers.getAddress(patientAddress),
      nonce,
    },
  };
}

export function buildWalletRoleTypedData({ walletAddress, role, nonce }) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      WalletRole: [
        { name: "wallet", type: "address" },
        { name: "role", type: "string" },
        { name: "nonce", type: "string" },
      ],
    },
    primaryType: "WalletRole",
    domain: buildDomain(),
    message: {
      wallet: ethers.getAddress(walletAddress),
      role,
      nonce,
    },
  };
}

export async function signTypedData(signerAddress, typedData) {
  if (!window.ethereum) {
    throw new Error("MetaMask is not available in this browser.");
  }

  const signature = await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [ethers.getAddress(signerAddress), JSON.stringify(typedData)],
  });

  return signature;
}
