const hre = require("hardhat");

const CLAIMS = [
  {
    claimTypeId: 1,
    claimLabel: "HAS_CATEGORY",
    verifierEnv: "HAS_CATEGORY_GROTH16_VERIFIER_ADDRESS",
  },
  {
    claimTypeId: 2,
    claimLabel: "LAB_IN_RANGE",
    verifierEnv: "LAB_IN_RANGE_GROTH16_VERIFIER_ADDRESS",
  },
  {
    claimTypeId: 3,
    claimLabel: "NO_DISEASE",
    verifierEnv: "NO_DISEASE_GROTH16_VERIFIER_ADDRESS",
  },
];

function readAddressFromEnv(name, { required = false } = {}) {
  const rawValue = (process.env[name] || "").trim();

  if (!rawValue) {
    if (required) {
      throw new Error(`Missing required env var: ${name}`);
    }
    return "";
  }

  if (!hre.ethers.isAddress(rawValue)) {
    throw new Error(`Invalid address in env ${name}: ${rawValue}`);
  }

  return hre.ethers.getAddress(rawValue);
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = deployer.address;

  console.log(`Deploying selective disclosure contracts with account: ${deployerAddress}`);

  const ownerAddress = readAddressFromEnv("SELECTIVE_OWNER_ADDRESS") || deployerAddress;

  const registryAddress =
    readAddressFromEnv("REGISTRY_ADDRESS") ||
    readAddressFromEnv("CONTRACT_ADDRESS", { required: true });

  console.log(`Using MedicalRecordRegistry at: ${registryAddress}`);
  console.log(`Selective manager owner: ${ownerAddress}`);

  const managerFactory = await hre.ethers.getContractFactory("SelectiveDisclosureVerifierManager");
  const manager = await managerFactory.deploy(ownerAddress, registryAddress);
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();

  console.log(`SelectiveDisclosureVerifierManager deployed to: ${managerAddress}`);

  const canConfigureManager = ownerAddress.toLowerCase() === deployerAddress.toLowerCase();
  if (!canConfigureManager) {
    console.log(
      "Owner is different from deployer; adapter deployment can continue, but setVerifier must be called by owner."
    );
  }

  const adapterFactory = await hre.ethers.getContractFactory("Groth16VerifierAdapter");
  const deployedAdapters = [];

  for (const claim of CLAIMS) {
    const baseVerifierAddress = readAddressFromEnv(claim.verifierEnv);

    if (!baseVerifierAddress) {
      console.log(
        `Skip ${claim.claimLabel}: env ${claim.verifierEnv} not provided (no adapter deployed).`
      );
      continue;
    }

    const adapter = await adapterFactory.deploy(baseVerifierAddress);
    await adapter.waitForDeployment();
    const adapterAddress = await adapter.getAddress();

    deployedAdapters.push({
      claimTypeId: claim.claimTypeId,
      claimLabel: claim.claimLabel,
      adapterAddress,
      baseVerifierAddress,
    });

    console.log(
      `${claim.claimLabel} adapter deployed to: ${adapterAddress} (base verifier: ${baseVerifierAddress})`
    );

    if (canConfigureManager) {
      const tx = await manager.setVerifier(claim.claimTypeId, adapterAddress);
      await tx.wait();
      console.log(`Manager verifier set for ${claim.claimLabel}`);
    }
  }

  console.log("\n=== Deploy Summary ===");
  console.log(`REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`SELECTIVE_MANAGER_ADDRESS=${managerAddress}`);

  for (const adapter of deployedAdapters) {
    console.log(`${adapter.claimLabel}_ADAPTER_ADDRESS=${adapter.adapterAddress}`);
  }

  if (!canConfigureManager && deployedAdapters.length) {
    console.log("\nRun these as owner to bind adapters:");
    for (const adapter of deployedAdapters) {
      console.log(
        `setVerifier(${adapter.claimTypeId}, ${adapter.adapterAddress}) on manager ${managerAddress}`
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
