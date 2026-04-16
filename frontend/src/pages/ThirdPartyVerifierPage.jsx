import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { useSearchParams } from "react-router-dom";

import {
  getPublicVerificationRecords,
  getSelectiveDisclosureAuditLogs,
  proveSelectiveDisclosure,
  verifySelectiveDisclosure,
} from "../services/api";
import { getReadOnlyProvider, getRegistryContract } from "../services/contract";
import { verifyMerkleProofInBrowser } from "../services/merkle";
import { decodeVerificationToken } from "../services/verificationToken";

function toLowerHex(value) {
  return String(value || "").toLowerCase();
}

function truncateAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimestamp(value) {
  if (!value) return "-";

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function normalizeAddressOrThrow(rawAddress) {
  if (!rawAddress || !rawAddress.trim()) {
    throw new Error("Patient wallet address is required.");
  }

  try {
    return ethers.getAddress(rawAddress.trim());
  } catch {
    throw new Error("Invalid patient wallet address.");
  }
}

const SMALL_ACTION_CLASS =
  "rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60";

const PRIMARY_ACTION_CLASS =
  "rounded-full border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-blue-50 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

const SELECTIVE_CLAIM_OPTIONS = [
  { value: "HAS_CATEGORY", label: "Has Category" },
  { value: "LAB_IN_RANGE", label: "Lab In Range" },
  { value: "NO_DISEASE", label: "No Disease" },
];

const SELECTIVE_AUDIT_STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "generated", label: "Generated" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
  { value: "error", label: "Error" },
];

function parseIntegerOrThrow(rawValue, fieldLabel) {
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldLabel} must be a valid integer.`);
  }
  return parsed;
}

function formatEpochTimestamp(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined || epochSeconds === "") {
    return "-";
  }

  const numeric = Number(epochSeconds);
  if (!Number.isFinite(numeric)) {
    return String(epochSeconds);
  }

  return new Date(numeric * 1000).toLocaleString();
}

function getSelectiveAuditStatusMeta(status, valid) {
  const normalized = String(status || "").toLowerCase();

  if (normalized === "verified" && valid) {
    return {
      label: "verified",
      className: "bg-emerald-300/20 text-emerald-100",
    };
  }

  if (normalized === "generated") {
    return {
      label: "generated",
      className: "bg-cyan-300/20 text-cyan-100",
    };
  }

  if (normalized === "expired") {
    return {
      label: "expired",
      className: "bg-amber-300/20 text-amber-100",
    };
  }

  if (normalized === "rejected" || valid === false) {
    return {
      label: normalized || "rejected",
      className: "bg-red-300/20 text-red-100",
    };
  }

  if (normalized === "error") {
    return {
      label: "error",
      className: "bg-amber-300/20 text-amber-100",
    };
  }

  return {
    label: normalized || "unknown",
    className: "bg-slate-300/20 text-slate-100",
  };
}

function getStatusMeta(statusItem) {
  if (!statusItem) {
    return {
      label: "Not verified",
      className: "bg-slate-300/20 text-slate-200",
      detail: "",
    };
  }

  if (statusItem.status === "pass") {
    return {
      label: "Valid",
      className: "bg-emerald-300/20 text-emerald-100",
      detail: statusItem.detail || "Merkle proof matches on-chain root.",
    };
  }

  if (statusItem.status === "fail") {
    return {
      label: "Invalid",
      className: "bg-red-300/20 text-red-100",
      detail: statusItem.detail || "Merkle proof does not match on-chain root.",
    };
  }

  return {
    label: "Error",
    className: "bg-amber-300/20 text-amber-100",
    detail: statusItem.detail || "Unable to verify this record.",
  };
}

export default function ThirdPartyVerifierPage() {
  const [searchParams] = useSearchParams();

  const [patientAddressInput, setPatientAddressInput] = useState("");
  const [activePatientAddress, setActivePatientAddress] = useState("");
  const [tokenLeafHint, setTokenLeafHint] = useState("");

  const [records, setRecords] = useState([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState([]);
  const [verificationResults, setVerificationResults] = useState({});

  const [onChainRoot, setOnChainRoot] = useState("");
  const [latestStoredRoot, setLatestStoredRoot] = useState("");
  const [latestRootTxHash, setLatestRootTxHash] = useState("");

  const [isLoadingRecords, setIsLoadingRecords] = useState(false);
  const [isVerifyingSelected, setIsVerifyingSelected] = useState(false);
  const [isVerifyingAll, setIsVerifyingAll] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");
  const [infoMessage, setInfoMessage] = useState("");

  const [claimType, setClaimType] = useState("HAS_CATEGORY");
  const [categoryCodeInput, setCategoryCodeInput] = useState("12");
  const [labCodeInput, setLabCodeInput] = useState("2201");
  const [rangeMinInput, setRangeMinInput] = useState("700");
  const [rangeMaxInput, setRangeMaxInput] = useState("990");
  const [diseaseCodeInput, setDiseaseCodeInput] = useState("1001");
  const [verifierScopeInput, setVerifierScopeInput] = useState("raphamedical.verifier");
  const [expiresAtInput, setExpiresAtInput] = useState(
    String(Math.floor(Date.now() / 1000) + 60 * 60)
  );
  const [nonceInput, setNonceInput] = useState(String(Date.now()));

  const [isGeneratingSelectiveProof, setIsGeneratingSelectiveProof] = useState(false);
  const [isVerifyingSelectiveProof, setIsVerifyingSelectiveProof] = useState(false);
  const [selectiveErrorMessage, setSelectiveErrorMessage] = useState("");
  const [selectiveInfoMessage, setSelectiveInfoMessage] = useState("");
  const [selectiveClaimPackage, setSelectiveClaimPackage] = useState(null);
  const [selectiveVerifyResult, setSelectiveVerifyResult] = useState(null);
  const [selectiveAuditStatusFilter, setSelectiveAuditStatusFilter] = useState("all");
  const [selectiveAuditLogs, setSelectiveAuditLogs] = useState([]);
  const [isLoadingSelectiveAuditLogs, setIsLoadingSelectiveAuditLogs] = useState(false);

  useEffect(() => {
    const token = searchParams.get("token") || "";
    if (!token) {
      setTokenLeafHint("");
      return;
    }

    try {
      const decoded = decodeVerificationToken(token);
      const normalizedAddress = normalizeAddressOrThrow(decoded.patient_address || "");
      const hintedLeaf = decoded?.leaf_hash ? toLowerHex(decoded.leaf_hash) : "";

      setPatientAddressInput(normalizedAddress);
      setTokenLeafHint(hintedLeaf);
      setErrorMessage("");
      setInfoMessage(
        "Verification token detected. Patient wallet is prefilled. Click Load Records to choose records to verify."
      );
    } catch (error) {
      setTokenLeafHint("");
      setErrorMessage(error?.message || "Failed to decode verification token.");
    }
  }, [searchParams]);

  const selectedRecords = useMemo(() => {
    if (!selectedRecordIds.length) {
      return [];
    }

    const selectedSet = new Set(selectedRecordIds);
    return records.filter((record) => selectedSet.has(record.id));
  }, [records, selectedRecordIds]);

  const allSelected = records.length > 0 && selectedRecordIds.length === records.length;
  const preferredSelectiveRecord = selectedRecords[0] || records[0] || null;
  const preferredRecordClaimData = useMemo(() => {
    if (!preferredSelectiveRecord || typeof preferredSelectiveRecord.claim_data !== "object") {
      return {};
    }

    return preferredSelectiveRecord.claim_data || {};
  }, [preferredSelectiveRecord]);

  useEffect(() => {
    setSelectiveClaimPackage(null);
    setSelectiveVerifyResult(null);
    setSelectiveErrorMessage("");
    setSelectiveInfoMessage("");
    setSelectiveAuditLogs([]);
    setSelectiveAuditStatusFilter("all");
  }, [activePatientAddress]);

  const fetchOnChainRoot = async (patientAddress) => {
    const provider = await getReadOnlyProvider();
    const contract = getRegistryContract(provider);
    const root = await contract.getRoot(patientAddress);
    setOnChainRoot(root);
    return root;
  };

  const handleLoadRecords = async () => {
    try {
      setIsLoadingRecords(true);
      setErrorMessage("");
      setInfoMessage("");

      const normalizedPatientAddress = normalizeAddressOrThrow(patientAddressInput);
      const response = await getPublicVerificationRecords(normalizedPatientAddress);

      const nextRecords = Array.isArray(response.records) ? response.records : [];
      const nextSelectedByToken = tokenLeafHint
        ? nextRecords
            .filter((record) => toLowerHex(record.leaf_hash) === tokenLeafHint)
            .map((record) => record.id)
        : [];

      setActivePatientAddress(response.patient_address || normalizedPatientAddress);
      setRecords(nextRecords);
      setSelectedRecordIds(nextSelectedByToken);
      setVerificationResults({});

      setLatestStoredRoot(response.latest_merkle_root || "");
      setLatestRootTxHash(response.latest_tx_hash || "");

      const root = await fetchOnChainRoot(response.patient_address || normalizedPatientAddress);

      if (!nextRecords.length) {
        setInfoMessage("No records found for this patient wallet.");
      } else if (root === ethers.ZeroHash) {
        setInfoMessage(
          "Records loaded, but on-chain root is still zero. Verification will fail until root is anchored on-chain."
        );
      } else if (nextSelectedByToken.length > 0) {
        setInfoMessage(
          `Loaded ${nextRecords.length} records. Selected ${nextSelectedByToken.length} record from token hint.`
        );
      } else {
        setInfoMessage(`Loaded ${nextRecords.length} records. Select records to verify or use Verify All.`);
      }
    } catch (error) {
      setRecords([]);
      setSelectedRecordIds([]);
      setVerificationResults({});
      setActivePatientAddress("");
      setOnChainRoot("");
      setLatestStoredRoot("");
      setLatestRootTxHash("");
      setErrorMessage(error?.message || "Failed to load patient records.");
    } finally {
      setIsLoadingRecords(false);
    }
  };

  const toggleRecordSelection = (recordId) => {
    setSelectedRecordIds((previous) => {
      if (previous.includes(recordId)) {
        return previous.filter((id) => id !== recordId);
      }

      return [...previous, recordId];
    });
  };

  const handleSelectAll = () => {
    setSelectedRecordIds(records.map((record) => record.id));
  };

  const handleClearSelection = () => {
    setSelectedRecordIds([]);
  };

  const verifyRecords = async (targetRecords) => {
    if (!activePatientAddress) {
      setErrorMessage("Load patient records first.");
      return;
    }

    if (!targetRecords.length) {
      setInfoMessage("No records selected for verification.");
      return;
    }

    try {
      setErrorMessage("");
      setInfoMessage("");

      const root = onChainRoot || (await fetchOnChainRoot(activePatientAddress));

      const nextStatuses = {};
      let validCount = 0;

      targetRecords.forEach((record) => {
        try {
          const isValid = verifyMerkleProofInBrowser(record.leaf_hash, record.merkle_proof || [], root);
          if (isValid) {
            validCount += 1;
          }

          nextStatuses[record.id] = {
            status: isValid ? "pass" : "fail",
            detail: isValid
              ? "Merkle proof matches on-chain root."
              : "Merkle proof does not match on-chain root.",
          };
        } catch (error) {
          nextStatuses[record.id] = {
            status: "error",
            detail: error?.message || "Verification failed for this record.",
          };
        }
      });

      setVerificationResults((previous) => ({
        ...previous,
        ...nextStatuses,
      }));

      const summarySuffix = root === ethers.ZeroHash ? " (on-chain root is zero)" : "";
      setInfoMessage(`${validCount}/${targetRecords.length} records are valid.${summarySuffix}`);
    } catch (error) {
      setErrorMessage(error?.message || "Verification failed.");
    }
  };

  const handleVerifySelected = async () => {
    try {
      setIsVerifyingSelected(true);
      await verifyRecords(selectedRecords);
    } finally {
      setIsVerifyingSelected(false);
    }
  };

  const handleVerifyAll = async () => {
    try {
      setIsVerifyingAll(true);
      await verifyRecords(records);
    } finally {
      setIsVerifyingAll(false);
    }
  };

  const buildClaimParams = () => {
    const claimData = preferredRecordClaimData;

    if (claimType === "HAS_CATEGORY") {
      if (claimData.category_code === undefined) {
        throw new Error("Selected record has no category_code. Ask doctor to create structured record.");
      }

      const categoryCode = parseIntegerOrThrow(claimData.category_code, "Record category code");

      return {
        category_code: categoryCode,
      };
    }

    if (claimType === "LAB_IN_RANGE") {
      if (claimData.lab_code === undefined || claimData.lab_value === undefined) {
        throw new Error("Selected record has no lab_code/lab_value. Ask doctor to create structured record.");
      }

      const labCode = parseIntegerOrThrow(claimData.lab_code, "Record lab code");
      const labValue = parseIntegerOrThrow(claimData.lab_value, "Record lab value");

      const rangeMin = parseIntegerOrThrow(rangeMinInput, "Range min");
      const rangeMax = parseIntegerOrThrow(rangeMaxInput, "Range max");
      if (rangeMin > rangeMax) {
        throw new Error("Range min must be less than or equal to range max.");
      }

      if (labValue !== null && (labValue < rangeMin || labValue > rangeMax)) {
        throw new Error("Selected record lab value is outside the requested range.");
      }

      return {
        lab_code: labCode,
        range_min: rangeMin,
        range_max: rangeMax,
        lab_value: labValue,
      };
    }

    if (claimData.diagnosis_code === undefined) {
      throw new Error("Selected record has no diagnosis_code. Ask doctor to create structured record.");
    }

    const diagnosisCode = parseIntegerOrThrow(claimData.diagnosis_code, "Record diagnosis code");
    const diseaseCode = parseIntegerOrThrow(diseaseCodeInput, "Disease code");

    if (diseaseCode === diagnosisCode) {
      throw new Error("Disease code cannot match diagnosis code in selected record for NO_DISEASE claim.");
    }

    return {
      disease_code: diseaseCode,
      diagnosis_code: diagnosisCode,
    };
  };

  const buildWitnessBundle = () => {
    if (!preferredSelectiveRecord) {
      throw new Error("No witness record available. Load records first.");
    }

    const merkleProof = Array.isArray(preferredSelectiveRecord.merkle_proof)
      ? preferredSelectiveRecord.merkle_proof
      : [];

    return {
      record_id: preferredSelectiveRecord.id,
      leaf_hash: preferredSelectiveRecord.leaf_hash,
      claim_data: preferredSelectiveRecord.claim_data || {},
      merkle_path_siblings: merkleProof.map((step) => step.hash),
      merkle_path_indices: merkleProof.map((step) => (step.position === "right" ? 1 : 0)),
      root_snapshot: onChainRoot || latestStoredRoot || "",
    };
  };

  const refreshSelectiveAuditLogs = async ({ silent = false } = {}) => {
    if (!activePatientAddress) {
      return;
    }

    try {
      setIsLoadingSelectiveAuditLogs(true);

      const response = await getSelectiveDisclosureAuditLogs({
        patient_address: activePatientAddress,
        claim_type: claimType,
        status: selectiveAuditStatusFilter === "all" ? "" : selectiveAuditStatusFilter,
        limit: 25,
      });

      const items = Array.isArray(response.items) ? response.items : [];
      setSelectiveAuditLogs(items);

      if (!silent) {
        setSelectiveInfoMessage(`Loaded ${items.length} selective audit log(s).`);
      }
    } catch (error) {
      if (!silent) {
        setSelectiveErrorMessage(error?.message || "Failed to load selective audit logs.");
      }
    } finally {
      setIsLoadingSelectiveAuditLogs(false);
    }
  };

  useEffect(() => {
    if (!activePatientAddress) {
      return;
    }

    void refreshSelectiveAuditLogs({ silent: true });
  }, [activePatientAddress, claimType, selectiveAuditStatusFilter]);

  const handleGenerateSelectiveProof = async () => {
    try {
      if (!activePatientAddress) {
        throw new Error("Load patient records first.");
      }

      const expiresAt = parseIntegerOrThrow(expiresAtInput, "Expires at");
      const verifierScope = verifierScopeInput.trim();
      const nonce = nonceInput.trim() || String(Date.now());

      if (!verifierScope) {
        throw new Error("Verifier scope is required.");
      }

      setIsGeneratingSelectiveProof(true);
      setSelectiveErrorMessage("");
      setSelectiveInfoMessage("");

      const payload = {
        claim_type: claimType,
        patient_context: {
          patient_address: activePatientAddress,
          verifier_scope: verifierScope,
          expires_at: expiresAt,
          nonce,
        },
        claim_params: buildClaimParams(),
        witness_bundle: buildWitnessBundle(),
      };

      const response = await proveSelectiveDisclosure(payload);

      setSelectiveClaimPackage(response);
      setSelectiveVerifyResult(null);
      setNonceInput(String(Date.now()));
      setSelectiveInfoMessage("Selective disclosure proof package generated.");
      await refreshSelectiveAuditLogs({ silent: true });
    } catch (error) {
      setSelectiveErrorMessage(error?.message || "Failed to generate selective disclosure proof.");
    } finally {
      setIsGeneratingSelectiveProof(false);
    }
  };

  const handleVerifySelectiveClaim = async () => {
    try {
      if (!selectiveClaimPackage) {
        throw new Error("Generate selective claim package first.");
      }

      if (!activePatientAddress) {
        throw new Error("Load patient records first.");
      }

      const verifierScope = verifierScopeInput.trim();
      if (!verifierScope) {
        throw new Error("Verifier scope is required.");
      }

      setIsVerifyingSelectiveProof(true);
      setSelectiveErrorMessage("");
      setSelectiveInfoMessage("");

      const response = await verifySelectiveDisclosure({
        claim_type: selectiveClaimPackage.claim_type || claimType,
        patient_address: activePatientAddress,
        verifier_scope: verifierScope,
        expires_at: Number(selectiveClaimPackage.expires_at || expiresAtInput),
        nullifier: selectiveClaimPackage.nullifier,
        proof: selectiveClaimPackage.proof,
        public_signals: selectiveClaimPackage.public_signals || [],
      });

      setSelectiveVerifyResult(response);
      setSelectiveInfoMessage("Selective disclosure verification finished.");
      await refreshSelectiveAuditLogs({ silent: true });
    } catch (error) {
      setSelectiveErrorMessage(error?.message || "Failed to verify selective disclosure proof.");
    } finally {
      setIsVerifyingSelectiveProof(false);
    }
  };

  return (
    <section className="space-y-6 animate-fadeInUp">
      <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
        <h1 className="font-heading text-3xl font-bold text-white">Third-Party Verification Page</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-200">
          Masukkan wallet address patient, pilih records yang ingin diverifikasi, atau klik Verify All.
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="text-sm text-slate-200">
            Patient Wallet Address
            <input
              type="text"
              value={patientAddressInput}
              onChange={(event) => setPatientAddressInput(event.target.value)}
              placeholder="0x..."
              className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
            />
          </label>

          <button
            type="button"
            onClick={handleLoadRecords}
            disabled={isLoadingRecords}
            className={PRIMARY_ACTION_CLASS}
          >
            {isLoadingRecords ? "Loading..." : "Load Records"}
          </button>
        </div>

        {errorMessage && (
          <div className="mt-4 rounded-xl border border-red-200/40 bg-red-500/10 p-3 text-sm text-red-100">
            {errorMessage}
          </div>
        )}

        {infoMessage && (
          <div className="mt-4 rounded-xl border border-cyan-200/40 bg-cyan-400/10 p-3 text-sm text-cyan-100">
            {infoMessage}
          </div>
        )}

        {activePatientAddress && (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-100">
              <p>
                <strong>Patient:</strong> {truncateAddress(activePatientAddress)}
              </p>
              <p className="mt-2 break-all">
                <strong>On-chain Root:</strong> {onChainRoot || "-"}
              </p>
              <p className="mt-2 break-all">
                <strong>Latest Stored Root:</strong> {latestStoredRoot || "-"}
              </p>
              {latestRootTxHash && (
                <p className="mt-2 break-all">
                  <strong>Latest Tx Hash:</strong> {latestRootTxHash}
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-100">
              <p>
                <strong>Total Records:</strong> {records.length}
              </p>
              <p className="mt-2">
                <strong>Selected:</strong> {selectedRecordIds.length}
              </p>
              <p className="mt-2">
                <strong>Root Match:</strong>{" "}
                {latestStoredRoot
                  ? toLowerHex(latestStoredRoot) === toLowerHex(onChainRoot)
                    ? "Yes"
                    : "No"
                  : "Unknown"}
              </p>
            </div>
          </div>
        )}
      </article>

      <article className="panel overflow-hidden rounded-3xl shadow-glow">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <h2 className="font-heading text-xl font-bold text-white">Patient Records</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSelectAll}
              disabled={!records.length || allSelected}
              className={SMALL_ACTION_CLASS}
            >
              Select All
            </button>
            <button
              type="button"
              onClick={handleClearSelection}
              disabled={!selectedRecordIds.length}
              className={SMALL_ACTION_CLASS}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => void handleVerifySelected()}
              disabled={!selectedRecordIds.length || isVerifyingSelected || isVerifyingAll}
              className={PRIMARY_ACTION_CLASS}
            >
              {isVerifyingSelected ? "Verifying..." : "Verify Selected"}
            </button>
            <button
              type="button"
              onClick={() => void handleVerifyAll()}
              disabled={!records.length || isVerifyingAll || isVerifyingSelected}
              className={PRIMARY_ACTION_CLASS}
            >
              {isVerifyingAll ? "Verifying..." : "Verify All"}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-white/10 text-left text-sm">
            <thead className="bg-slate-900/35 text-slate-200">
              <tr>
                <th className="px-4 py-3 font-semibold">Select</th>
                <th className="px-4 py-3 font-semibold">Created</th>
                <th className="px-4 py-3 font-semibold">Doctor</th>
                <th className="px-4 py-3 font-semibold">Leaf Hash</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {records.map((record) => {
                const isSelected = selectedRecordIds.includes(record.id);
                const statusMeta = getStatusMeta(verificationResults[record.id]);

                return (
                  <tr
                    key={record.id}
                    className={`align-top text-slate-100 ${isSelected ? "bg-blue-300/10" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRecordSelection(record.id)}
                        className="h-4 w-4 cursor-pointer accent-blue-600"
                        aria-label={`Select record ${record.id}`}
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300">{formatTimestamp(record.created_at)}</td>
                    <td className="px-4 py-3 text-xs text-slate-200">
                      {truncateAddress(record.doctor_address)}
                    </td>
                    <td className="max-w-md px-4 py-3 text-xs text-slate-100">
                      <code className="break-all">{record.leaf_hash}</code>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] ${statusMeta.className}`}
                      >
                        {statusMeta.label}
                      </span>
                      {statusMeta.detail && (
                        <p className="mt-1 max-w-sm text-xs text-slate-300">{statusMeta.detail}</p>
                      )}
                    </td>
                  </tr>
                );
              })}

              {records.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-300">
                    No records loaded. Enter patient wallet address, then click Load Records.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
        <h2 className="font-heading text-2xl font-bold text-white">Selective Disclosure Claim</h2>
        <p className="mt-2 text-sm text-slate-200">
          Generate proof package by claim type, then verify it through selective-disclosure API.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="text-sm text-slate-200">
            Claim Type
            <select
              value={claimType}
              onChange={(event) => setClaimType(event.target.value)}
              className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
            >
              {SELECTIVE_CLAIM_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="text-slate-900">
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-slate-200">
            Verifier Scope
            <input
              type="text"
              value={verifierScopeInput}
              onChange={(event) => setVerifierScopeInput(event.target.value)}
              placeholder="company.insurance"
              className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
            />
          </label>
        </div>

        {claimType === "HAS_CATEGORY" && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm text-slate-200">
              Category Code
              <input
                type="number"
                value={
                  preferredRecordClaimData.category_code !== undefined
                    ? String(preferredRecordClaimData.category_code)
                    : categoryCodeInput
                }
                onChange={(event) => setCategoryCodeInput(event.target.value)}
                disabled={preferredRecordClaimData.category_code !== undefined}
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
              />
            </label>
          </div>
        )}

        {claimType === "LAB_IN_RANGE" && (
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <label className="text-sm text-slate-200">
              Lab Code
              <input
                type="number"
                value={
                  preferredRecordClaimData.lab_code !== undefined
                    ? String(preferredRecordClaimData.lab_code)
                    : labCodeInput
                }
                onChange={(event) => setLabCodeInput(event.target.value)}
                disabled={preferredRecordClaimData.lab_code !== undefined}
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
              />
            </label>
            <label className="text-sm text-slate-200">
              Range Min
              <input
                type="number"
                value={rangeMinInput}
                onChange={(event) => setRangeMinInput(event.target.value)}
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
              />
            </label>
            <label className="text-sm text-slate-200">
              Range Max
              <input
                type="number"
                value={rangeMaxInput}
                onChange={(event) => setRangeMaxInput(event.target.value)}
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
              />
            </label>
            <label className="text-sm text-slate-200">
              Record Lab Value
              <input
                type="number"
                value={
                  preferredRecordClaimData.lab_value !== undefined
                    ? String(preferredRecordClaimData.lab_value)
                    : ""
                }
                readOnly
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none"
              />
            </label>
          </div>
        )}

        {claimType === "NO_DISEASE" && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm text-slate-200">
              Disease Code
              <input
                type="number"
                value={diseaseCodeInput}
                onChange={(event) => setDiseaseCodeInput(event.target.value)}
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
              />
            </label>
            <label className="text-sm text-slate-200">
              Record Diagnosis Code
              <input
                type="number"
                value={
                  preferredRecordClaimData.diagnosis_code !== undefined
                    ? String(preferredRecordClaimData.diagnosis_code)
                    : ""
                }
                readOnly
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none"
              />
            </label>
          </div>
        )}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-sm text-slate-200">
            Expires At (Unix Timestamp)
            <input
              type="number"
              value={expiresAtInput}
              onChange={(event) => setExpiresAtInput(event.target.value)}
              className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
            />
          </label>

          <label className="text-sm text-slate-200">
            Nonce
            <input
              type="text"
              value={nonceInput}
              onChange={(event) => setNonceInput(event.target.value)}
              className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
            />
          </label>
        </div>

        <div className="mt-4 rounded-2xl border border-white/15 bg-white/5 p-4 text-xs text-slate-200">
          <p>
            <strong>Witness Source:</strong>{" "}
            {preferredSelectiveRecord
              ? `Record #${preferredSelectiveRecord.id} (${truncateAddress(
                  preferredSelectiveRecord.doctor_address
                )})`
              : "No record available"}
          </p>
          <p className="mt-2 break-all">
            <strong>Leaf Hash:</strong> {preferredSelectiveRecord?.leaf_hash || "-"}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleGenerateSelectiveProof()}
            disabled={isGeneratingSelectiveProof || !activePatientAddress || !preferredSelectiveRecord}
            className={PRIMARY_ACTION_CLASS}
          >
            {isGeneratingSelectiveProof ? "Generating..." : "Generate Selective Proof"}
          </button>

          <button
            type="button"
            onClick={() => void handleVerifySelectiveClaim()}
            disabled={isVerifyingSelectiveProof || !selectiveClaimPackage}
            className={PRIMARY_ACTION_CLASS}
          >
            {isVerifyingSelectiveProof ? "Verifying..." : "Verify Selective Claim"}
          </button>

          <button
            type="button"
            onClick={() => void refreshSelectiveAuditLogs()}
            disabled={isLoadingSelectiveAuditLogs || !activePatientAddress}
            className={PRIMARY_ACTION_CLASS}
          >
            {isLoadingSelectiveAuditLogs ? "Refreshing..." : "Refresh Audit Logs"}
          </button>
        </div>

        {selectiveErrorMessage && (
          <div className="mt-4 rounded-xl border border-red-200/40 bg-red-500/10 p-3 text-sm text-red-100">
            {selectiveErrorMessage}
          </div>
        )}

        {selectiveInfoMessage && (
          <div className="mt-4 rounded-xl border border-cyan-200/40 bg-cyan-400/10 p-3 text-sm text-cyan-100">
            {selectiveInfoMessage}
          </div>
        )}

        {selectiveClaimPackage && (
          <div className="mt-4 rounded-2xl border border-white/15 bg-white/5 p-4">
            <p className="text-sm font-semibold text-white">Generated Claim Package</p>
            <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-slate-900/60 p-3 text-xs text-slate-200">
              {JSON.stringify(selectiveClaimPackage, null, 2)}
            </pre>
          </div>
        )}

        {selectiveVerifyResult && (
          <div className="mt-4 rounded-2xl border border-white/15 bg-white/5 p-4">
            <p className="text-sm font-semibold text-white">Selective Verification Result</p>
            <p
              className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] ${
                selectiveVerifyResult.valid
                  ? "bg-emerald-300/20 text-emerald-100"
                  : "bg-red-300/20 text-red-100"
              }`}
            >
              {selectiveVerifyResult.valid ? "valid" : "invalid"}
            </p>
            {selectiveVerifyResult.nullifier_used && (
              <p className="mt-2 text-xs text-amber-200">
                Nullifier has already been used. This indicates replay attempt was blocked.
              </p>
            )}
            <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-slate-900/60 p-3 text-xs text-slate-200">
              {JSON.stringify(selectiveVerifyResult, null, 2)}
            </pre>
          </div>
        )}

        <div className="mt-4 rounded-2xl border border-white/15 bg-white/5 p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">Selective Audit Trail</p>
              <p className="mt-1 text-xs text-slate-300">
                Menampilkan riwayat claim sesuai patient, claim type, dan status filter.
              </p>
            </div>

            <label className="text-xs text-slate-200">
              Status Filter
              <select
                value={selectiveAuditStatusFilter}
                onChange={(event) => setSelectiveAuditStatusFilter(event.target.value)}
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs text-white outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
              >
                {SELECTIVE_AUDIT_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} className="text-slate-900">
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full divide-y divide-white/10 text-left text-xs">
              <thead className="bg-slate-900/35 text-slate-200">
                <tr>
                  <th className="px-3 py-2 font-semibold">Time</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Nullifier</th>
                  <th className="px-3 py-2 font-semibold">Expires</th>
                  <th className="px-3 py-2 font-semibold">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-slate-100">
                {selectiveAuditLogs.map((logItem) => {
                  const statusMeta = getSelectiveAuditStatusMeta(logItem.status, logItem.valid);

                  return (
                    <tr key={logItem.id}>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-300">
                        {formatTimestamp(logItem.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${statusMeta.className}`}
                        >
                          {statusMeta.label}
                        </span>
                        {logItem.nullifier_used && (
                          <span className="ml-2 inline-flex rounded-full bg-amber-300/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-amber-100">
                            nullifier used
                          </span>
                        )}
                      </td>
                      <td className="max-w-[280px] px-3 py-2 text-slate-200">
                        <code className="break-all">{logItem.nullifier || "-"}</code>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-300">
                        {formatEpochTimestamp(logItem.expires_at)}
                      </td>
                      <td className="max-w-md px-3 py-2 text-slate-300">{logItem.reason || "-"}</td>
                    </tr>
                  );
                })}

                {selectiveAuditLogs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-slate-300">
                      {activePatientAddress
                        ? "No selective audit logs found for current filters."
                        : "Load records first to view selective audit logs."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </article>
    </section>
  );
}
