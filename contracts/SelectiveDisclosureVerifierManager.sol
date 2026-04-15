// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IMedicalRecordRegistry {
    function getRoot(address patientAddress) external view returns (bytes32);
}

interface ISelectiveDisclosureVerifier {
    function verifyProof(
        bytes calldata proof,
        uint256[] calldata publicSignals
    ) external view returns (bool);
}

contract SelectiveDisclosureVerifierManager is Ownable {
    enum ClaimType {
        UNKNOWN,
        HAS_CATEGORY,
        LAB_IN_RANGE,
        NO_DISEASE
    }

    struct ClaimSubmission {
        ClaimType claimType;
        address patientAddress;
        bytes32 verifierScope;
        uint64 expiresAt;
        bytes32 nullifier;
        uint256[] publicSignals;
        bytes proof;
    }

    // Public signal index convention must match circuit exports.
    uint256 private constant IDX_CLAIM_TYPE = 0;
    uint256 private constant IDX_CLAIM_KEY_A = 1;
    uint256 private constant IDX_CLAIM_KEY_B = 2;
    uint256 private constant IDX_CLAIM_KEY_C = 3;
    uint256 private constant IDX_ROOT = 4;
    uint256 private constant IDX_PATIENT_COMMITMENT = 5;
    uint256 private constant IDX_VERIFIER_SCOPE = 6;
    uint256 private constant IDX_EXPIRES_AT = 7;
    uint256 private constant IDX_NULLIFIER = 8;

    IMedicalRecordRegistry public immutable registry;

    mapping(ClaimType => ISelectiveDisclosureVerifier) public verifierByClaimType;
    mapping(bytes32 => bool) public nullifierUsed;

    event ClaimVerifierUpdated(ClaimType indexed claimType, address indexed verifier);
    event SelectiveClaimVerified(
        bytes32 indexed claimId,
        ClaimType indexed claimType,
        address indexed patientAddress,
        bytes32 nullifier,
        bytes32 verifierScope,
        uint64 expiresAt,
        bytes32 anchoredRoot
    );

    error UnknownClaimType();
    error InvalidPatientAddress();
    error ClaimExpired();
    error NullifierAlreadyUsed();
    error MissingVerifier();
    error InvalidSignalsLength();
    error RootMismatch();
    error ScopeMismatch();
    error ExpiryMismatch();
    error NullifierMismatch();
    error ClaimTypeMismatch();
    error InvalidOnChainRoot();
    error InvalidProof();

    constructor(address initialOwner, address registryAddress) Ownable(initialOwner) {
        require(registryAddress != address(0), "registry required");
        registry = IMedicalRecordRegistry(registryAddress);
    }

    function setVerifier(ClaimType claimType, address verifier) external onlyOwner {
        if (claimType == ClaimType.UNKNOWN) {
            revert UnknownClaimType();
        }
        verifierByClaimType[claimType] = ISelectiveDisclosureVerifier(verifier);
        emit ClaimVerifierUpdated(claimType, verifier);
    }

    function submitSelectiveClaim(ClaimSubmission calldata submission) external returns (bytes32 claimId) {
        if (submission.claimType == ClaimType.UNKNOWN) {
            revert UnknownClaimType();
        }
        if (submission.patientAddress == address(0)) {
            revert InvalidPatientAddress();
        }
        if (block.timestamp > submission.expiresAt) {
            revert ClaimExpired();
        }
        if (nullifierUsed[submission.nullifier]) {
            revert NullifierAlreadyUsed();
        }
        if (submission.publicSignals.length <= IDX_NULLIFIER) {
            revert InvalidSignalsLength();
        }

        ISelectiveDisclosureVerifier verifier = verifierByClaimType[submission.claimType];
        if (address(verifier) == address(0)) {
            revert MissingVerifier();
        }

        bytes32 anchoredRoot = registry.getRoot(submission.patientAddress);
        if (anchoredRoot == bytes32(0)) {
            revert InvalidOnChainRoot();
        }

        bytes32 rootFromSignals = bytes32(submission.publicSignals[IDX_ROOT]);
        bytes32 scopeFromSignals = bytes32(submission.publicSignals[IDX_VERIFIER_SCOPE]);
        uint64 expiresFromSignals = uint64(submission.publicSignals[IDX_EXPIRES_AT]);
        bytes32 nullifierFromSignals = bytes32(submission.publicSignals[IDX_NULLIFIER]);
        uint8 claimTypeFromSignals = uint8(submission.publicSignals[IDX_CLAIM_TYPE]);

        if (rootFromSignals != anchoredRoot) {
            revert RootMismatch();
        }
        if (scopeFromSignals != submission.verifierScope) {
            revert ScopeMismatch();
        }
        if (expiresFromSignals != submission.expiresAt) {
            revert ExpiryMismatch();
        }
        if (nullifierFromSignals != submission.nullifier) {
            revert NullifierMismatch();
        }
        if (claimTypeFromSignals != uint8(submission.claimType)) {
            revert ClaimTypeMismatch();
        }

        bool ok = verifier.verifyProof(submission.proof, submission.publicSignals);
        if (!ok) {
            revert InvalidProof();
        }

        nullifierUsed[submission.nullifier] = true;

        claimId = keccak256(
            abi.encodePacked(
                block.chainid,
                submission.claimType,
                submission.patientAddress,
                submission.publicSignals[IDX_CLAIM_KEY_A],
                submission.publicSignals[IDX_CLAIM_KEY_B],
                submission.publicSignals[IDX_CLAIM_KEY_C],
                submission.nullifier,
                msg.sender
            )
        );

        emit SelectiveClaimVerified(
            claimId,
            submission.claimType,
            submission.patientAddress,
            submission.nullifier,
            submission.verifierScope,
            submission.expiresAt,
            anchoredRoot
        );
    }
}
