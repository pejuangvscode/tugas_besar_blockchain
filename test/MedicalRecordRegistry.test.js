const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MedicalRecordRegistry", function () {
  async function deployFixture() {
    const [owner, doctor, patient, stranger] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MedicalRecordRegistry");
    const registry = await factory.deploy(owner.address);
    await registry.waitForDeployment();

    return { registry, owner, doctor, patient, stranger };
  }

  it("allows owner to authorize and deauthorize doctors", async function () {
    const { registry, doctor } = await deployFixture();

    await expect(registry.addAuthorizedDoctor(doctor.address))
      .to.emit(registry, "DoctorAuthorizationUpdated")
      .withArgs(doctor.address, true);

    expect(await registry.authorizedDoctors(doctor.address)).to.equal(true);

    await expect(registry.removeAuthorizedDoctor(doctor.address))
      .to.emit(registry, "DoctorAuthorizationUpdated")
      .withArgs(doctor.address, false);

    expect(await registry.authorizedDoctors(doctor.address)).to.equal(false);
  });

  it("prevents unauthorized doctors from anchoring", async function () {
    const { registry, doctor, patient } = await deployFixture();
    const sampleRoot = ethers.keccak256(ethers.toUtf8Bytes("sample-root"));

    await expect(registry.connect(doctor).anchorRoot(sampleRoot, patient.address)).to.be.reverted;
  });

  it("anchors and retrieves latest root", async function () {
    const { registry, doctor, patient } = await deployFixture();
    const rootOne = ethers.keccak256(ethers.toUtf8Bytes("root-one"));
    const rootTwo = ethers.keccak256(ethers.toUtf8Bytes("root-two"));

    await registry.addAuthorizedDoctor(doctor.address);

    await expect(registry.connect(doctor).anchorRoot(rootOne, patient.address))
      .to.emit(registry, "RootAnchored")
      .withArgs(patient.address, rootOne, doctor.address, anyUint());

    expect(await registry.getRoot(patient.address)).to.equal(rootOne);

    await registry.connect(doctor).anchorRoot(rootTwo, patient.address);
    expect(await registry.getRoot(patient.address)).to.equal(rootTwo);
  });
});

function anyUint() {
  return (value) => typeof value === "bigint";
}
