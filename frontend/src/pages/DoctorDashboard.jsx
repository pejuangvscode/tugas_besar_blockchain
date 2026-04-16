import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

import { useMetaMask } from "../hooks/useMetaMask";
import {
  createRecord,
  getPatientWallets,
  getSelectiveDisclosureAuditLogs,
  updateMerkleRootTxHash,
} from "../services/api";
import { getBrowserProvider, getRegistryContract } from "../services/contract";
import { buildCreateRecordTypedData, signTypedData } from "../services/eip712";

function truncateAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function parseIntOrThrow(value, label) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid integer.`);
  }
  return parsed;
}

const PATIENT_BOOK_STORAGE_KEY = "smr.patientBook.v1";

const SELECTIVE_CLAIM_FILTERS = [
  { value: "all", label: "All Claim Types" },
  { value: "HAS_CATEGORY", label: "Has Category" },
  { value: "LAB_IN_RANGE", label: "Lab In Range" },
  { value: "NO_DISEASE", label: "No Disease" },
];

const SELECTIVE_STATUS_FILTERS = [
  { value: "all", label: "All Statuses" },
  { value: "generated", label: "Generated" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
  { value: "error", label: "Error" },
];

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

function getSelectiveAuditStatusBadge(status, valid) {
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

function loadPatientBook() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(PATIENT_BOOK_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item.address === "string" && typeof item.label === "string")
      .slice(0, 20);
  } catch {
    return [];
  }
}

function persistPatientBook(book) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PATIENT_BOOK_STORAGE_KEY, JSON.stringify(book.slice(0, 20)));
}

function upsertPatientBookEntry(book, address, label) {
  const lower = address.toLowerCase();
  const filtered = book.filter((item) => item.address.toLowerCase() !== lower);

  return [
    {
      label,
      address,
      updated_at: new Date().toISOString(),
    },
    ...filtered,
  ].slice(0, 20);
}

export default function DoctorDashboard() {
  const [patientType, setPatientType] = useState("existing");
  const [patientAddress, setPatientAddress] = useState("");
  const [patientLabel, setPatientLabel] = useState("");
  const [rawText, setRawText] = useState("");
  const [diagnosisCodeInput, setDiagnosisCodeInput] = useState("1001");
  const [categoryCodeInput, setCategoryCodeInput] = useState("12");
  const [labCodeInput, setLabCodeInput] = useState("2201");
  const [labValueInput, setLabValueInput] = useState("860");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [bookMessage, setBookMessage] = useState("");
  const [result, setResult] = useState(null);
  const [patientBook, setPatientBook] = useState(() => loadPatientBook());
  const [detectedPatients, setDetectedPatients] = useState([]);
  const [isLoadingDetectedPatients, setIsLoadingDetectedPatients] = useState(false);
  const [detectedPatientsError, setDetectedPatientsError] = useState("");
  const [selectiveClaimFilter, setSelectiveClaimFilter] = useState("all");
  const [selectiveStatusFilter, setSelectiveStatusFilter] = useState("all");
  const [selectiveAuditLogs, setSelectiveAuditLogs] = useState([]);
  const [isLoadingSelectiveAudit, setIsLoadingSelectiveAudit] = useState(false);
  const [selectiveAuditError, setSelectiveAuditError] = useState("");

  const {
    account,
    isSepolia,
    connectWallet,
    switchWalletAccount,
    switchToSepolia,
    requiredChainId,
    isConnecting,
    walletError,
  } = useMetaMask();

  const requiredNetworkLabel = requiredChainId === 11155111 ? "Sepolia" : `Chain ${requiredChainId}`;

  const detectedPatientOptions = useMemo(() => {
    const labelsByAddress = new Map(
      patientBook.map((entry) => [entry.address.toLowerCase(), entry.label])
    );

    return detectedPatients
      .filter((wallet) => typeof wallet === "string" && wallet)
      .map((wallet) => ({
        address: wallet,
        label: labelsByAddress.get(wallet.toLowerCase()) || `Patient ${truncateAddress(wallet)}`,
      }));
  }, [detectedPatients, patientBook]);

  const selectedDetectedPatientAddress = useMemo(() => {
    const lowerPatientAddress = patientAddress.toLowerCase();
    const selected = detectedPatientOptions.find(
      (entry) => entry.address.toLowerCase() === lowerPatientAddress
    );

    return selected ? selected.address : "";
  }, [patientAddress, detectedPatientOptions]);

  const normalizedAuditPatientAddress = useMemo(() => {
    if (!patientAddress.trim()) {
      return "";
    }

    try {
      return ethers.getAddress(patientAddress.trim());
    } catch {
      return "";
    }
  }, [patientAddress]);

  const loadDetectedPatients = useCallback(async () => {
    try {
      setIsLoadingDetectedPatients(true);
      setDetectedPatientsError("");

      const response = await getPatientWallets();
      const patients = Array.isArray(response?.patients) ? response.patients : [];
      setDetectedPatients(patients);
    } catch (error) {
      setDetectedPatientsError(error?.message || "Failed to load patient wallets from backend.");
    } finally {
      setIsLoadingDetectedPatients(false);
    }
  }, []);

  useEffect(() => {
    persistPatientBook(patientBook);
  }, [patientBook]);

  useEffect(() => {
    void loadDetectedPatients();
  }, [loadDetectedPatients]);

  useEffect(() => {
    if (patientType !== "existing") {
      return;
    }

    if (detectedPatientOptions.length === 0) {
      return;
    }

    if (selectedDetectedPatientAddress) {
      return;
    }

    const firstPatient = detectedPatientOptions[0];
    setPatientAddress(firstPatient.address);
    setPatientLabel(firstPatient.label);
  }, [patientType, detectedPatientOptions, selectedDetectedPatientAddress]);

  useEffect(() => {
    if (!normalizedAuditPatientAddress) {
      setSelectiveAuditLogs([]);
      setSelectiveAuditError("");
      return;
    }

    const run = async () => {
      await refreshSelectiveAuditLogs(true);
    };

    void run();
  }, [normalizedAuditPatientAddress, selectiveClaimFilter, selectiveStatusFilter]);

  const explorerLink = useMemo(() => {
    if (!result?.tx_hash) return "";
    return `https://sepolia.etherscan.io/tx/${result.tx_hash}`;
  }, [result]);

  const refreshSelectiveAuditLogs = async (silent = false) => {
    if (!normalizedAuditPatientAddress) {
      if (!silent) {
        setSelectiveAuditError("Select a valid patient wallet first.");
      }
      return;
    }

    try {
      setIsLoadingSelectiveAudit(true);
      setSelectiveAuditError("");

      const response = await getSelectiveDisclosureAuditLogs({
        patient_address: normalizedAuditPatientAddress,
        claim_type: selectiveClaimFilter === "all" ? "" : selectiveClaimFilter,
        status: selectiveStatusFilter === "all" ? "" : selectiveStatusFilter,
        limit: 20,
      });

      setSelectiveAuditLogs(Array.isArray(response.items) ? response.items : []);
    } catch (error) {
      if (!silent) {
        setSelectiveAuditError(error?.message || "Failed to load selective audit logs.");
      }
    } finally {
      setIsLoadingSelectiveAudit(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErrorMessage("");
    setResult(null);

    if (!account) {
      setErrorMessage("Connect doctor wallet first.");
      return;
    }

    if (!isSepolia) {
      setErrorMessage(`Switch to ${requiredNetworkLabel} before anchoring medical roots.`);
      return;
    }

    if (patientType === "existing" && !selectedDetectedPatientAddress) {
      setErrorMessage("Select an existing patient from the dropdown first.");
      return;
    }

    if (patientType === "new" && !patientAddress.trim()) {
      setErrorMessage("Enter new patient wallet address first.");
      return;
    }

    let normalizedPatient = "";
    try {
      normalizedPatient = ethers.getAddress(patientAddress.trim());
    } catch {
      setErrorMessage("Patient wallet address is not valid.");
      return;
    }

    try {
      const structuredClaim = {
        diagnosis_code: parseIntOrThrow(diagnosisCodeInput, "Diagnosis code"),
        category_code: parseIntOrThrow(categoryCodeInput, "Category code"),
        lab_code: parseIntOrThrow(labCodeInput, "Lab code"),
        lab_value: parseIntOrThrow(labValueInput, "Lab value"),
      };

      setIsSubmitting(true);
      const nonce = `${Date.now()}`;
      const typedData = buildCreateRecordTypedData({
        patientAddress: normalizedPatient,
        doctorAddress: account,
        rawText,
        nonce,
        structuredClaim,
      });

      const signature = await signTypedData(account, typedData);

      const createResponse = await createRecord({
        patient_address: normalizedPatient,
        raw_text: rawText,
        doctor_address: account,
        structured_claim: structuredClaim,
        signature,
        nonce,
      });

      const provider = await getBrowserProvider();
      const signer = await provider.getSigner();
      const contract = getRegistryContract(signer);

      const tx = await contract.anchorRoot(createResponse.merkle_root, normalizedPatient);
      await tx.wait();

      await updateMerkleRootTxHash({
        merkle_root_id: createResponse.merkle_root_id,
        tx_hash: tx.hash,
      });

      setResult({
        tx_hash: tx.hash,
        merkle_root: createResponse.merkle_root,
        leaf_hash: createResponse.leaf_hash,
        structured_claim: structuredClaim,
      });

      const fallbackLabel = patientLabel.trim() || `Patient ${truncateAddress(normalizedPatient)}`;
      setPatientBook((previous) =>
        upsertPatientBookEntry(previous, normalizedPatient, fallbackLabel)
      );
      setBookMessage(`Saved ${fallbackLabel} to quick patient list.`);

      void loadDetectedPatients();
      await refreshSelectiveAuditLogs(true);

      setRawText("");
    } catch (error) {
      setErrorMessage(error?.message || "Failed to submit and anchor record.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSavePatient = () => {
    try {
      const normalizedPatient = ethers.getAddress(patientAddress.trim());
      const label = patientLabel.trim() || `Patient ${truncateAddress(normalizedPatient)}`;

      setPatientBook((previous) => upsertPatientBookEntry(previous, normalizedPatient, label));
      setBookMessage(`Saved ${label} to quick patient list.`);
      setErrorMessage("");
    } catch {
      setErrorMessage("Enter a valid patient wallet before saving to quick list.");
    }
  };

  const handleUseSavedPatient = (entry) => {
    setPatientType("new");
    setPatientAddress(entry.address);
    setPatientLabel(entry.label);
    setBookMessage(`Selected ${entry.label}.`);
    setErrorMessage("");
  };

  const handleSelectPatientType = (nextType) => {
    setPatientType(nextType);
    setErrorMessage("");

    if (nextType === "existing") {
      if (detectedPatientOptions.length === 0) {
        setPatientAddress("");
        setBookMessage("No existing patient found yet. Switch to New Patient.");
        return;
      }

      const selected =
        detectedPatientOptions.find(
          (entry) => entry.address.toLowerCase() === patientAddress.toLowerCase()
        ) || detectedPatientOptions[0];

      setPatientAddress(selected.address);
      setPatientLabel(selected.label);
      setBookMessage(`Selected ${selected.label}.`);
      return;
    }

    setPatientAddress("");
    setBookMessage("Enter a new patient wallet address manually.");
  };

  const handleSelectDetectedPatient = (address) => {
    setPatientAddress(address);

    const selected = detectedPatientOptions.find(
      (entry) => entry.address.toLowerCase() === address.toLowerCase()
    );
    if (selected) {
      setPatientLabel(selected.label);
      setBookMessage(`Selected ${selected.label}.`);
    }

    setErrorMessage("");
  };

  const handleRemoveSavedPatient = (address) => {
    setPatientBook((previous) =>
      previous.filter((entry) => entry.address.toLowerCase() !== address.toLowerCase())
    );

    if (patientAddress.toLowerCase() === address.toLowerCase()) {
      setPatientAddress("");
    }

    setBookMessage("Removed patient from quick list.");
  };

  return (
    <section className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
      <article className="panel rounded-3xl p-6 shadow-glow sm:p-8 animate-fadeInUp">
        <h1 className="font-heading text-3xl font-bold text-white">Doctor Page</h1>
        <p className="mt-2 text-sm text-slate-200">
          Create encrypted patient notes, produce Merkle proofs, and anchor the latest root on
          Ethereum Sepolia.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={connectWallet}
            disabled={isConnecting}
            className="rounded-full bg-cyan-300 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {account ? `Connected: ${truncateAddress(account)}` : "Connect MetaMask"}
          </button>

          {account && (
            <button
              type="button"
              onClick={switchWalletAccount}
              className="rounded-full border border-cyan-200/60 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-300/20"
            >
              Switch Wallet
            </button>
          )}

          {!isSepolia && account && (
            <button
              type="button"
              onClick={switchToSepolia}
              className="rounded-full border border-orange-200/60 bg-orange-200/10 px-4 py-2 text-sm font-semibold text-orange-100 hover:bg-orange-200/20"
            >
              {`Switch to ${requiredNetworkLabel}`}
            </button>
          )}
        </div>

        {(walletError || errorMessage) && (
          <div className="mt-4 rounded-xl border border-red-200/40 bg-red-500/10 p-3 text-sm text-red-100">
            {walletError || errorMessage}
          </div>
        )}

        {bookMessage && (
          <div className="mt-4 rounded-xl border border-cyan-200/40 bg-cyan-400/10 p-3 text-sm text-cyan-100">
            {bookMessage}
          </div>
        )}

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-300">Patient Type</p>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => handleSelectPatientType("existing")}
                className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${
                  patientType === "existing"
                    ? "border-cyan-200/70 bg-cyan-400/20 text-cyan-100"
                    : "border-white/20 bg-slate-950/30 text-slate-200 hover:bg-slate-900/50"
                }`}
              >
                Existing Patient
              </button>

              <button
                type="button"
                onClick={() => handleSelectPatientType("new")}
                className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${
                  patientType === "new"
                    ? "border-cyan-200/70 bg-cyan-400/20 text-cyan-100"
                    : "border-white/20 bg-slate-950/30 text-slate-200 hover:bg-slate-900/50"
                }`}
              >
                New Patient
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-300">
              Quick Patient List
            </p>

            {patientBook.length === 0 ? (
              <p className="mt-2 text-sm text-slate-300">
                No saved patient yet. Save an address once, then reuse with one click.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {patientBook.map((entry) => (
                  <div
                    key={entry.address}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2"
                  >
                    <button
                      type="button"
                      onClick={() => handleUseSavedPatient(entry)}
                      className="text-left text-sm font-semibold text-cyan-100 hover:text-cyan-50"
                    >
                      {entry.label} · {truncateAddress(entry.address)}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleRemoveSavedPatient(entry.address)}
                      className="rounded-full border border-red-200/40 bg-red-400/10 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-red-100 hover:bg-red-400/20"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {patientType === "existing" ? (
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-slate-100">
                Existing Patient Wallets (Supabase)
              </span>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <select
                  value={selectedDetectedPatientAddress}
                  onChange={(event) => handleSelectDetectedPatient(event.target.value)}
                  className="w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none focus:border-cyan-200/70"
                  required
                  disabled={isLoadingDetectedPatients || detectedPatientOptions.length === 0}
                >
                  <option value="">Select patient from backend list...</option>
                  {detectedPatientOptions.map((entry) => (
                    <option key={entry.address} value={entry.address}>
                      {entry.label} ({truncateAddress(entry.address)})
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => void loadDetectedPatients()}
                  className="rounded-xl border border-cyan-200/60 bg-cyan-300/10 px-4 py-3 text-sm font-bold text-cyan-100 hover:bg-cyan-300/20"
                >
                  {isLoadingDetectedPatients ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              <p className="mt-2 text-xs text-slate-300">
                {isLoadingDetectedPatients
                  ? "Loading patient wallets from backend..."
                  : `${detectedPatientOptions.length} patient wallet(s) detected.`}
              </p>

              {detectedPatientsError && (
                <p className="mt-2 text-xs text-red-200">{detectedPatientsError}</p>
              )}
            </label>
          ) : (
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-slate-100">
                New Patient Wallet Address
              </span>
              <input
                value={patientAddress}
                onChange={(event) => setPatientAddress(event.target.value)}
                placeholder="0x..."
                className="w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
                required
              />
            </label>
          )}

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-100">
              Patient Label (optional)
            </span>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <input
                value={patientLabel}
                onChange={(event) => setPatientLabel(event.target.value)}
                placeholder="e.g. John Doe / Patient A"
                className="w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
              />

              <button
                type="button"
                onClick={handleSavePatient}
                className="rounded-xl border border-cyan-200/60 bg-cyan-300/10 px-4 py-3 text-sm font-bold text-cyan-100 hover:bg-cyan-300/20"
              >
                Save Patient
              </button>
            </div>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-100">
              Structured Claim Data
            </span>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <input
                type="number"
                value={diagnosisCodeInput}
                onChange={(event) => setDiagnosisCodeInput(event.target.value)}
                placeholder="Diagnosis code"
                className="w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
                required
              />
              <input
                type="number"
                value={categoryCodeInput}
                onChange={(event) => setCategoryCodeInput(event.target.value)}
                placeholder="Category code"
                className="w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
                required
              />
              <input
                type="number"
                value={labCodeInput}
                onChange={(event) => setLabCodeInput(event.target.value)}
                placeholder="Lab code"
                className="w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
                required
              />
              <input
                type="number"
                value={labValueInput}
                onChange={(event) => setLabValueInput(event.target.value)}
                placeholder="Lab value"
                className="w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
                required
              />
            </div>
            <p className="mt-2 text-xs text-slate-300">
              These values are signed in EIP-712 and committed into the record leaf hash.
            </p>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-100">
              Raw Clinical Note
            </span>
            <textarea
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
              placeholder="Doctor enters raw medical text directly here..."
              className="min-h-40 w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
              required
            />
          </label>

          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-full bg-gradient-to-r from-cyan-300 to-orange-300 px-6 py-3 text-sm font-extrabold text-slate-950 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSubmitting ? "Submitting & Anchoring..." : "Anchor"}
          </button>
        </form>
      </article>

      <div className="space-y-6 animate-fadeInUp">
        <aside className="panel rounded-3xl p-6 shadow-glow sm:p-8">
          <h2 className="font-heading text-2xl font-bold text-white">Latest Submission</h2>
          <p className="mt-2 text-sm text-slate-200">
            After anchoring, transaction hash is saved to backend for future audit linkage.
          </p>

          {result ? (
            <div className="mt-5 space-y-3 rounded-2xl border border-emerald-200/30 bg-emerald-400/10 p-4 text-sm text-emerald-100">
              <p>
                <strong>Leaf Hash:</strong> {result.leaf_hash}
              </p>
              <p>
                <strong>Merkle Root:</strong> {result.merkle_root}
              </p>
              <p>
                <strong>Tx Hash:</strong> {result.tx_hash}
              </p>
              {result.structured_claim && (
                <p>
                  <strong>Structured Claim:</strong>{" "}
                  {`dx=${result.structured_claim.diagnosis_code}, cat=${result.structured_claim.category_code}, lab=${result.structured_claim.lab_code}, value=${result.structured_claim.lab_value}`}
                </p>
              )}
              <a
                href={explorerLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex rounded-full border border-emerald-100/40 px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] text-emerald-50 hover:bg-emerald-100/15"
              >
                View on Sepolia Etherscan
              </a>
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-white/20 bg-white/5 p-4 text-sm text-slate-200">
              No anchored record yet in this session.
            </div>
          )}
        </aside>

        <aside className="panel rounded-3xl p-6 shadow-glow sm:p-8">
          <h2 className="font-heading text-2xl font-bold text-white">Selective Audit (Patient)</h2>
          <p className="mt-2 text-sm text-slate-200">
            Monitor selective disclosure activity for selected patient wallet.
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-300">
              Claim Type
              <select
                value={selectiveClaimFilter}
                onChange={(event) => setSelectiveClaimFilter(event.target.value)}
                className="mt-1 rounded-xl border border-white/20 bg-slate-950/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-200/70"
              >
                {SELECTIVE_CLAIM_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-slate-300">
              Status
              <select
                value={selectiveStatusFilter}
                onChange={(event) => setSelectiveStatusFilter(event.target.value)}
                className="mt-1 rounded-xl border border-white/20 bg-slate-950/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-200/70"
              >
                {SELECTIVE_STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => void refreshSelectiveAuditLogs()}
              disabled={!normalizedAuditPatientAddress || isLoadingSelectiveAudit}
              className="rounded-full border border-cyan-200/60 bg-cyan-300/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.08em] text-cyan-100 hover:bg-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoadingSelectiveAudit ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          <p className="mt-3 text-xs text-slate-300 break-all">
            Patient: {normalizedAuditPatientAddress || "No valid wallet selected"}
          </p>

          {selectiveAuditError && (
            <div className="mt-3 rounded-xl border border-red-200/40 bg-red-500/10 p-3 text-sm text-red-100">
              {selectiveAuditError}
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-white/10 text-left text-xs">
              <thead className="bg-slate-900/35 text-slate-200">
                <tr>
                  <th className="px-3 py-2 font-semibold">Created</th>
                  <th className="px-3 py-2 font-semibold">Claim</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-slate-100">
                {selectiveAuditLogs.map((logItem) => {
                  const badge = getSelectiveAuditStatusBadge(logItem.status, logItem.valid);

                  return (
                    <tr key={logItem.id}>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-300">{logItem.created_at}</td>
                      <td className="px-3 py-2 text-slate-100">{logItem.claim_type}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                        {logItem.nullifier_used && (
                          <span className="ml-2 inline-flex rounded-full bg-amber-300/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-amber-100">
                            replay blocked
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-300">
                        {formatEpochTimestamp(logItem.expires_at)}
                      </td>
                    </tr>
                  );
                })}

                {selectiveAuditLogs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-slate-300">
                      {normalizedAuditPatientAddress
                        ? "No selective logs found for current filters."
                        : "Select a valid patient wallet to load logs."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </section>
  );
}
