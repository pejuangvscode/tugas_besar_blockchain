import { ethers } from "ethers";

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS;
const RPC_URL = import.meta.env.VITE_SEPOLIA_RPC_URL || "";

export const registryAbi = [
  "function anchorRoot(bytes32 merkleRoot, address patientAddress) external",
  "function getRoot(address patientAddress) external view returns (bytes32)",
  "function authorizedDoctors(address doctor) external view returns (bool)",
];

export function getRegistryContract(providerOrSigner) {
  if (!CONTRACT_ADDRESS) {
    throw new Error("Missing VITE_CONTRACT_ADDRESS in frontend environment variables.");
  }

  return new ethers.Contract(CONTRACT_ADDRESS, registryAbi, providerOrSigner);
}

export async function getBrowserProvider() {
  if (!window.ethereum) {
    throw new Error("MetaMask is not available in this browser.");
  }
  return new ethers.BrowserProvider(window.ethereum);
}

export async function getReadOnlyProvider() {
  if (RPC_URL) {
    return new ethers.JsonRpcProvider(RPC_URL);
  }

  if (window.ethereum) {
    return new ethers.BrowserProvider(window.ethereum);
  }

  throw new Error(
    "No read provider available. Set VITE_SEPOLIA_RPC_URL or open in a browser with MetaMask."
  );
}
