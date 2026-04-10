const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log(`Deploying with account: ${deployer.address}`);

  const registryFactory = await hre.ethers.getContractFactory("MedicalRecordRegistry");
  const registry = await registryFactory.deploy(deployer.address);

  await registry.waitForDeployment();
  const address = await registry.getAddress();

  console.log(`MedicalRecordRegistry deployed to: ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
