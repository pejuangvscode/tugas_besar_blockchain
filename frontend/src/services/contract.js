import { ethers } from "ethers";

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS;

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
