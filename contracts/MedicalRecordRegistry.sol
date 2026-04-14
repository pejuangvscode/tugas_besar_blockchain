pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

contract MedicalRecordRegistry is Ownable {
    mapping(address => bytes32) private latestRootByPatient;
    mapping(address => bool) public authorizedDoctors;

    event DoctorAuthorizationUpdated(address indexed doctor, bool isAuthorized);
    event RootAnchored(
        address indexed patientAddress,
        bytes32 indexed merkleRoot,
        address indexed doctorAddress,
        uint256 timestamp
    );

    error UnauthorizedDoctor(address doctor);
    error InvalidPatientAddress();
    error InvalidMerkleRoot();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function addAuthorizedDoctor(address doctor) external onlyOwner {
        authorizedDoctors[doctor] = true;
        emit DoctorAuthorizationUpdated(doctor, true);
    }

    function removeAuthorizedDoctor(address doctor) external onlyOwner {
        authorizedDoctors[doctor] = false;
        emit DoctorAuthorizationUpdated(doctor, false);
    }

    function anchorRoot(bytes32 merkleRoot, address patientAddress) external {
        if (!authorizedDoctors[msg.sender]) {
            revert UnauthorizedDoctor(msg.sender);
        }
        if (patientAddress == address(0)) {
            revert InvalidPatientAddress();
        }
        if (merkleRoot == bytes32(0)) {
            revert InvalidMerkleRoot();
        }

        latestRootByPatient[patientAddress] = merkleRoot;
        emit RootAnchored(patientAddress, merkleRoot, msg.sender, block.timestamp);
    }

    function getRoot(address patientAddress) external view returns (bytes32) {
        return latestRootByPatient[patientAddress];
    }
}
