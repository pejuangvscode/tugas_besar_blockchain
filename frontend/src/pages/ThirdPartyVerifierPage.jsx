import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { useSearchParams } from "react-router-dom";

import { getPublicVerificationRecords } from "../services/api";
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
    </section>
  );
}
