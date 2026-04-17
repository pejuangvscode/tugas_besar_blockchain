import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

import { useMetaMask } from "../hooks/useMetaMask";
import { getPatientRecords } from "../services/api";
import { getBrowserProvider, getRegistryContract } from "../services/contract";
import { decryptRawText } from "../services/crypto";
import { buildPatientAccessTypedData, signTypedData } from "../services/eip712";
import { verifyMerkleProofInBrowser } from "../services/merkle";
import { encodeVerificationToken } from "../services/verificationToken";
import { downloadCertificateJson, generateMedicalProof } from "../services/zkp";

function truncateAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const BLUE_BUTTON_CLASS =
  "rounded-full border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-blue-50 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

const BLUE_OUTLINE_BUTTON_CLASS =
  "rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60";

const BLUE_TINY_BUTTON_CLASS =
  "rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60";

const HEADER_SELECT_ACTION_CLASS =
  "rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-700 transition hover:bg-blue-400/10 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-500 disabled:hover:bg-transparent";

const BLUE_ACTION_PRIMARY_BUTTON_CLASS =
  "inline-flex w-full items-center justify-center rounded-xl border border-blue-600 bg-blue-600 px-4 py-2.5 text-sm font-semibold text-blue-50 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

const BLUE_ACTION_MENU_ITEM_CLASS =
  "mt-1 flex w-full items-center justify-between rounded-xl border border-transparent px-3 py-2 text-left text-sm font-semibold text-blue-700 transition hover:border-blue-100 hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:border-transparent disabled:hover:bg-transparent";

const ACTION_META_CLASS =
  "text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400";

function buildInsuranceWorkflowContext({ patientWallet, proverWallet }) {
  return {
    certificate_issuer_role: "patient",
    prover_role: "hospital",
    verifier_role: "insurance",
    certificate_issuer_wallet: patientWallet || "",
    prover_wallet: proverWallet || "",
    intended_use: "insurance-claim-review",
  };
}

export default function PatientDashboard() {
  const [records, setRecords] = useState([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [verificationStatus, setVerificationStatus] = useState({});
  const [isGeneratingCertificates, setIsGeneratingCertificates] = useState(false);
  const [isExportingPackages, setIsExportingPackages] = useState(false);
  const [shareQr, setShareQr] = useState(null);
  const [isPreparingQr, setIsPreparingQr] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState({
    isOpen: false,
    title: "",
    message: "",
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
  });

  const confirmResolverRef = useRef(null);
  const qrSectionRef = useRef(null);
  const actionMenuRef = useRef(null);

  const { account, connectWallet, switchWalletAccount, isConnecting, walletError } = useMetaMask();

  const stats = useMemo(
    () => ({
      total: records.length,
      verified: Object.values(verificationStatus).filter((status) => status === "valid").length,
    }),
    [records.length, verificationStatus]
  );

  const selectedRecords = useMemo(() => {
    if (selectedRecordIds.length === 0) {
      return [];
    }

    const selectedSet = new Set(selectedRecordIds);
    return records.filter((record) => selectedSet.has(record.id));
  }, [records, selectedRecordIds]);

  const selectedPrimaryRecord = selectedRecords[0] || null;

  const selectedRecordStatus = selectedPrimaryRecord
    ? verificationStatus[selectedPrimaryRecord.id] || "unknown"
    : "unknown";

  const isAnySelectedChecking = selectedRecords.some(
    (record) => verificationStatus[record.id] === "checking"
  );

  const allSelected = records.length > 0 && selectedRecordIds.length === records.length;

  useEffect(() => {
    if (shareQr && qrSectionRef.current) {
      qrSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [shareQr]);

  useEffect(() => {
    return () => {
      if (confirmResolverRef.current) {
        confirmResolverRef.current(false);
        confirmResolverRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isActionMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target)) {
        setIsActionMenuOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setIsActionMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isActionMenuOpen]);

  const requestConfirmation = ({
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
  }) => {
    if (typeof window === "undefined") {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmDialog({
        isOpen: true,
        title,
        message,
        confirmLabel,
        cancelLabel,
      });
    });
  };

  const closeConfirmation = (approved) => {
    setConfirmDialog((previous) => ({ ...previous, isOpen: false }));

    if (confirmResolverRef.current) {
      confirmResolverRef.current(approved);
      confirmResolverRef.current = null;
    }
  };

  const loadRecords = async () => {
    if (!account) {
      setErrorMessage("Connect patient wallet first.");
      return;
    }

    try {
      setIsLoading(true);
      setErrorMessage("");

      const nonce = `${Date.now()}`;
      const typedData = buildPatientAccessTypedData({ patientAddress: account, nonce });
      const signature = await signTypedData(account, typedData);

      const response = await getPatientRecords(account, signature, nonce);

      const decryptedRecords = await Promise.all(
        (response.records || []).map(async (record) => {
          let decryptedText = "";
          let decryptError = "";

          try {
            decryptedText = await decryptRawText(record.encrypted_data, account);
          } catch (error) {
            decryptedText = "[Unable to decrypt with current wallet]";
            decryptError = error?.message || "Decrypt failed";
          }

          return {
            ...record,
            decrypted_text: decryptedText,
            decrypt_error: decryptError,
          };
        })
      );

      setRecords(decryptedRecords);
      setSelectedRecordIds(decryptedRecords[0]?.id ? [decryptedRecords[0].id] : []);
      setVerificationStatus({});
      setShareQr(null);
      setCopyStatus("");
      setIsActionMenuOpen(false);

      const failedDecryptCount = decryptedRecords.filter((record) => record.decrypt_error).length;
      if (failedDecryptCount > 0) {
        setErrorMessage(
          `${failedDecryptCount} record(s) could not be decrypted with the connected wallet.`
        );
      }
    } catch (error) {
      setErrorMessage(error?.message || "Failed to load patient records.");
    } finally {
      setIsLoading(false);
    }
  };

  const verifyIntegrity = async (record) => {
    try {
      setVerificationStatus((prev) => ({ ...prev, [record.id]: "checking" }));

      const provider = await getBrowserProvider();
      const contract = getRegistryContract(provider);
      const onChainRoot = await contract.getRoot(account);

      const valid = verifyMerkleProofInBrowser(
        record.leaf_hash,
        record.merkle_proof || [],
        onChainRoot
      );

      setVerificationStatus((prev) => ({ ...prev, [record.id]: valid ? "valid" : "invalid" }));
    } catch (error) {
      setVerificationStatus((prev) => ({ ...prev, [record.id]: "invalid" }));
      setErrorMessage(error?.message || "Merkle verification failed.");
    }
  };

  const generateZkCertificate = async (record) => {
    const workflow = buildInsuranceWorkflowContext({
      patientWallet: account,
      proverWallet: record.doctor_address,
    });

    const certificate = await generateMedicalProof(record.decrypted_text, record.leaf_hash, {
      workflow,
      metadata: {
        record_id: record.id,
      },
    });

    downloadCertificateJson(`patient-certificate-record-${record.id}.json`, certificate);
  };

  const getOnChainRootForAccount = async () => {
    const provider = await getBrowserProvider();
    const contract = getRegistryContract(provider);
    return contract.getRoot(account);
  };

  const buildVerificationPackage = (record, onChainRoot) => {
    const workflow = buildInsuranceWorkflowContext({
      patientWallet: account,
      proverWallet: record.doctor_address,
    });

    return {
      package_version: "1.1",
      generated_at: new Date().toISOString(),
      patient_address: account,
      doctor_address: record.doctor_address,
      record_id: record.id,
      leaf_hash: record.leaf_hash,
      merkle_proof: record.merkle_proof || [],
      merkle_root: onChainRoot,
      contract_address: import.meta.env.VITE_CONTRACT_ADDRESS || "",
      chain_id: Number(import.meta.env.VITE_SEPOLIA_CHAIN_ID || 11155111),
      tx_hash: record.tx_hash || "",
      workflow,
    };
  };

  const exportVerificationPackage = async (record) => {
    const onChainRoot = await getOnChainRootForAccount();
    const verificationPackage = buildVerificationPackage(record, onChainRoot);

    downloadCertificateJson(
      `insurance-verification-package-record-${record.id}.json`,
      verificationPackage
    );
  };

  const prepareVerificationQr = async (record) => {
    try {
      setIsPreparingQr(true);
      setCopyStatus("");
      setErrorMessage("");

      const onChainRoot = await getOnChainRootForAccount();
      const verificationPackage = buildVerificationPackage(record, onChainRoot);
      const token = encodeVerificationToken(verificationPackage);
      const verifierUrl = new URL("/verifier", window.location.origin);
      verifierUrl.searchParams.set("token", token);

      const qrImageDataUrl = await QRCode.toDataURL(verifierUrl.toString(), {
        width: 280,
        margin: 1,
        errorCorrectionLevel: "M",
      });

      setShareQr({
        recordId: record.id,
        token,
        verifierUrl: verifierUrl.toString(),
        qrImageDataUrl,
      });
    } catch (error) {
      setErrorMessage(error?.message || "Failed to generate share QR.");
    } finally {
      setIsPreparingQr(false);
    }
  };

  const copyQrToken = async () => {
    if (!shareQr?.token) return;

    try {
      await navigator.clipboard.writeText(shareQr.token);
      setCopyStatus("Token copied. Paste it in Insurance Verifier page.");
    } catch {
      setCopyStatus("Unable to access clipboard. Copy token manually from the text box.");
    }
  };

  const copyVerifierLink = async () => {
    if (!shareQr?.verifierUrl) return;

    try {
      await navigator.clipboard.writeText(shareQr.verifierUrl);
      setCopyStatus("Insurance verifier link copied. Open it on insurer device.");
    } catch {
      setCopyStatus("Unable to access clipboard. Copy insurance verifier link manually.");
    }
  };

  const downloadQrImage = async () => {
    if (!shareQr?.qrImageDataUrl) return;

    const approved = await requestConfirmation({
      title: "Download QR PNG",
      message: `You are about to download QR PNG for record #${shareQr.recordId}.`,
      confirmLabel: "Download",
      cancelLabel: "Cancel",
    });
    if (!approved) {
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = shareQr.qrImageDataUrl;
    anchor.download = `verification-qr-record-${shareQr.recordId}.png`;
    anchor.click();
  };

  const toggleRecordSelection = (recordId) => {
    setSelectedRecordIds((previous) =>
      previous.includes(recordId)
        ? previous.filter((id) => id !== recordId)
        : [...previous, recordId]
    );
    setShareQr(null);
    setCopyStatus("");
  };

  const handleSelectAllRecords = () => {
    setSelectedRecordIds(records.map((record) => record.id));
    setShareQr(null);
    setCopyStatus("");
  };

  const handleClearSelection = () => {
    setSelectedRecordIds([]);
    setShareQr(null);
    setCopyStatus("");
  };

  const toggleActionMenu = () => {
    setIsActionMenuOpen((previous) => !previous);
  };

  const runMenuAction = async (handler) => {
    await handler();
    setIsActionMenuOpen(false);
  };

  const verifySelectedRecords = async () => {
    if (!selectedRecords.length) {
      setErrorMessage("Select at least one record first.");
      return;
    }

    try {
      setErrorMessage("");
      setVerificationStatus((prev) => {
        const draft = { ...prev };
        for (const record of selectedRecords) {
          draft[record.id] = "checking";
        }
        return draft;
      });

      const provider = await getBrowserProvider();
      const contract = getRegistryContract(provider);
      const onChainRoot = await contract.getRoot(account);

      const nextStatuses = {};
      for (const record of selectedRecords) {
        const valid = verifyMerkleProofInBrowser(
          record.leaf_hash,
          record.merkle_proof || [],
          onChainRoot
        );
        nextStatuses[record.id] = valid ? "valid" : "invalid";
      }

      setVerificationStatus((prev) => ({ ...prev, ...nextStatuses }));
    } catch (error) {
      setErrorMessage(error?.message || "Merkle verification failed.");
      setVerificationStatus((prev) => {
        const draft = { ...prev };
        for (const record of selectedRecords) {
          if (draft[record.id] === "checking") {
            draft[record.id] = "invalid";
          }
        }
        return draft;
      });
    }
  };

  const generateSelectedCertificates = async () => {
    if (!selectedRecords.length) {
      setErrorMessage("Select at least one record first.");
      return;
    }

    const approved = await requestConfirmation({
      title: "Generate Patient Certificate",
      message: `Download patient-issued certificate for ${selectedRecords.length} selected record(s)?`,
      confirmLabel: "Generate & Download",
      cancelLabel: "Cancel",
    });
    if (!approved) {
      return;
    }

    try {
      setIsGeneratingCertificates(true);
      setErrorMessage("");

      let failedCount = 0;
      for (const record of selectedRecords) {
        try {
          await generateZkCertificate(record);
        } catch {
          failedCount += 1;
        }
      }

      if (failedCount > 0) {
        setErrorMessage(`${failedCount} patient certificate(s) failed to generate.`);
      }
    } catch (error) {
      setErrorMessage(
        error?.message ||
          "Unable to create patient certificate. Ensure circuit artifacts exist in frontend/public/zk."
      );
    } finally {
      setIsGeneratingCertificates(false);
    }
  };

  const exportSelectedPackages = async () => {
    if (!selectedRecords.length) {
      setErrorMessage("Select at least one record first.");
      return;
    }

    const approved = await requestConfirmation({
      title: "Export Insurance Package",
      message: `Download insurance verification package for ${selectedRecords.length} selected record(s)?`,
      confirmLabel: "Export & Download",
      cancelLabel: "Cancel",
    });
    if (!approved) {
      return;
    }

    try {
      setIsExportingPackages(true);
      setErrorMessage("");

      const onChainRoot = await getOnChainRootForAccount();

      let failedCount = 0;
      for (const record of selectedRecords) {
        try {
          const verificationPackage = buildVerificationPackage(record, onChainRoot);
          downloadCertificateJson(
            `insurance-verification-package-record-${record.id}.json`,
            verificationPackage
          );
        } catch {
          failedCount += 1;
        }
      }

      if (failedCount > 0) {
        setErrorMessage(`${failedCount} insurance package(s) failed to export.`);
      }
    } catch (error) {
      setErrorMessage(error?.message || "Failed to export insurance verification package.");
    } finally {
      setIsExportingPackages(false);
    }
  };

  const showQrForSelection = async () => {
    if (selectedRecords.length !== 1) {
      setErrorMessage("Select exactly one record to show QR token.");
      return;
    }

    await prepareVerificationQr(selectedRecords[0]);
  };

  return (
    <section className="space-y-6 animate-fadeInUp">
      <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
        <h1 className="font-heading text-3xl font-bold text-white">Patient</h1>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={connectWallet}
            disabled={isConnecting}
            className={BLUE_BUTTON_CLASS}
          >
            {account ? `Connected: ${truncateAddress(account)}` : "Connect MetaMask"}
          </button>

          {account && (
            <button
              type="button"
              onClick={switchWalletAccount}
              className={BLUE_OUTLINE_BUTTON_CLASS}
            >
              Switch Wallet
            </button>
          )}

          <button
            type="button"
            onClick={loadRecords}
            disabled={!account || isLoading}
            className={BLUE_OUTLINE_BUTTON_CLASS}
          >
            {isLoading ? "Loading..." : "Load My Records"}
          </button>
        </div>

        {(walletError || errorMessage) && (
          <div className="mt-4 rounded-xl border border-red-200/40 bg-red-500/10 p-3 text-sm text-red-100">
            {walletError || errorMessage}
          </div>
        )}
      </article>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel rounded-2xl p-5 shadow-glow">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-300">Total Records</p>
          <p className="mt-2 font-heading text-4xl font-bold text-white">{stats.total}</p>
        </div>
        <div className="panel rounded-2xl p-5 shadow-glow">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-300">Verified Integrity</p>
          <p className="mt-2 font-heading text-4xl font-bold">{stats.verified}</p>
        </div>
      </div>

      <article className="panel rounded-3xl p-5 shadow-glow">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-300">Record Actions</p>
            {selectedRecords.length > 0 ? (
              <div className="mt-2 space-y-1 text-sm text-slate-200">
                <p>{selectedRecords.length} record(s) selected.</p>
                {selectedPrimaryRecord && (
                  <>
                    <p>
                      Primary record #{selectedPrimaryRecord.id} from doctor{" "}
                      {truncateAddress(selectedPrimaryRecord.doctor_address)}
                    </p>
                    <p className="text-xs text-slate-300">
                      Integrity status:{" "}
                      {selectedRecordStatus === "unknown"
                        ? "Not verified"
                        : selectedRecordStatus.toUpperCase()}
                    </p>
                  </>
                )}
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-300">
                Select one or more rows from the table to enable batch actions.
              </p>
            )}
          </div>

          <div className="w-full max-w-sm lg:max-w-xs">
            <div className="relative" ref={actionMenuRef}>
              <button
                type="button"
                onClick={toggleActionMenu}
                className={`${BLUE_ACTION_PRIMARY_BUTTON_CLASS} justify-between gap-3`}
              >
                <span>Action</span>
                <span className="text-xs font-bold uppercase tracking-[0.08em]">
                  {isActionMenuOpen ? "Close" : "Open"}
                </span>
              </button>

              {isActionMenuOpen && (
                <div className="absolute right-0 z-20 mt-2 w-full rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
                  <p className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500">
                    Batch Actions
                  </p>

                  <button
                    type="button"
                    onClick={() => void runMenuAction(verifySelectedRecords)}
                    disabled={!selectedRecords.length || isAnySelectedChecking}
                    className={BLUE_ACTION_MENU_ITEM_CLASS}
                  >
                    <span>{isAnySelectedChecking ? "Checking..." : "Verify Integrity"}</span>
                    <span className={ACTION_META_CLASS}>check</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void runMenuAction(generateSelectedCertificates)}
                    disabled={!selectedRecords.length || isGeneratingCertificates}
                    className={BLUE_ACTION_MENU_ITEM_CLASS}
                  >
                    <span>{isGeneratingCertificates ? "Generating..." : "Generate Patient Certificate"}</span>
                    <span className={ACTION_META_CLASS}>zk</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void runMenuAction(exportSelectedPackages)}
                    disabled={!selectedRecords.length || isExportingPackages}
                    className={BLUE_ACTION_MENU_ITEM_CLASS}
                  >
                    <span>{isExportingPackages ? "Exporting..." : "Export Insurance Package"}</span>
                    <span className={ACTION_META_CLASS}>json</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void runMenuAction(showQrForSelection)}
                    disabled={selectedRecords.length !== 1 || isPreparingQr}
                    className={BLUE_ACTION_MENU_ITEM_CLASS}
                  >
                    <span>{isPreparingQr ? "Preparing..." : "Show Insurance QR Token"}</span>
                    <span className={ACTION_META_CLASS}>qr</span>
                  </button>
                </div>
              )}
            </div>

          </div>
        </div>
      </article>

      <article className="panel overflow-hidden rounded-3xl shadow-glow">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-white/10 text-left text-sm">
            <thead className="bg-slate-900/35 text-slate-200">
              <tr>
                <th className="w-48 px-4 py-3 font-semibold align-top">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span>Select</span>
                      <span className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-300">
                        {selectedRecordIds.length}/{records.length}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={handleSelectAllRecords}
                        disabled={records.length === 0 || allSelected}
                        className={HEADER_SELECT_ACTION_CLASS}
                      >
                        Select All
                      </button>
                      <span className="text-slate-500">/</span>
                      <button
                        type="button"
                        onClick={handleClearSelection}
                        disabled={selectedRecordIds.length === 0}
                        className={HEADER_SELECT_ACTION_CLASS}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                </th>
                <th className="px-4 py-3 font-semibold">Created</th>
                <th className="px-4 py-3 font-semibold">Doctor</th>
                <th className="px-4 py-3 font-semibold">Decrypted Record</th>
                <th className="px-4 py-3 font-semibold">Integrity Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {records.map((record) => {
                const status = verificationStatus[record.id] || "unknown";
                const isSelected = selectedRecordIds.includes(record.id);
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
                        className="h-4 w-4 accent-blue-600 cursor-pointer"
                        aria-label={`Select record ${record.id}`}
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300">{record.created_at}</td>
                    <td className="px-4 py-3 text-xs text-slate-200">
                      {truncateAddress(record.doctor_address)}
                    </td>
                    <td className="max-w-xl px-4 py-3 text-sm leading-relaxed text-slate-100">
                      {record.decrypted_text}
                      {record.decrypt_error && (
                        <p className="mt-2 text-xs text-red-200">Decrypt detail: {record.decrypt_error}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p className="mt-1 text-xs font-semibold uppercase tracking-[0.08em]">
                        {status === "checking" && "Checking..."}
                        {status === "valid" && "Valid"}
                        {status === "invalid" && "Invalid"}
                        {status === "unknown" && "Not verified"}
                      </p>
                    </td>
                  </tr>
                );
              })}

              {records.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-300">
                    No records loaded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      {shareQr && (
        <article ref={qrSectionRef} className="panel rounded-3xl p-6 shadow-glow sm:p-8">
          <h2 className="font-heading text-2xl font-bold text-white">Insurance Share QR</h2>
          <p className="mt-2 text-sm text-slate-200">
            Patient issues this certificate token to insurer. Scanning it opens the insurance
            verifier page with package data attached.
          </p>

          <div className="mt-5 grid gap-6 lg:grid-cols-[300px_1fr]">
            <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
              <img
                src={shareQr.qrImageDataUrl}
                alt="Verification QR"
                className="mx-auto h-64 w-64 rounded-xl border border-white/10 bg-white p-2"
              />
              <p className="mt-3 text-center text-xs text-slate-300">Record #{shareQr.recordId}</p>
            </div>

            <div>
              <p className="text-sm font-semibold text-slate-100">Insurance Verifier Link</p>
              <textarea
                readOnly
                value={shareQr.verifierUrl}
                className="mt-2 min-h-20 w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-xs text-slate-200"
              />

              <p className="text-sm font-semibold text-slate-100">Verification Token</p>
              <textarea
                readOnly
                value={shareQr.token}
                className="mt-2 min-h-40 w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-xs text-slate-200"
              />

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={copyVerifierLink}
                  className={BLUE_TINY_BUTTON_CLASS}
                >
                  Copy Insurance Link
                </button>

                <a
                  href={shareQr.verifierUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={BLUE_TINY_BUTTON_CLASS}
                >
                  Open Insurance Link
                </a>

                <button
                  type="button"
                  onClick={copyQrToken}
                  className={BLUE_TINY_BUTTON_CLASS}
                >
                  Copy Token
                </button>

                <button
                  type="button"
                  onClick={downloadQrImage}
                  className={BLUE_TINY_BUTTON_CLASS}
                >
                  Download QR PNG
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShareQr(null);
                    setCopyStatus("");
                  }}
                  className={BLUE_TINY_BUTTON_CLASS}
                >
                  Close
                </button>
              </div>

              {copyStatus && <p className="mt-3 text-xs text-cyan-100">{copyStatus}</p>}
            </div>
          </div>
        </article>
      )}

      {confirmDialog.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-900">{confirmDialog.title}</h3>
            <p className="mt-2 text-sm text-slate-600">{confirmDialog.message}</p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => closeConfirmation(false)}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                {confirmDialog.cancelLabel}
              </button>
              <button
                type="button"
                onClick={() => closeConfirmation(true)}
                className="rounded-xl border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
