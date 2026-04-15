import { useMemo, useState } from "react";
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

export default function PatientDashboard() {
  const [records, setRecords] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [verificationStatus, setVerificationStatus] = useState({});
  const [zkBusyRecordId, setZkBusyRecordId] = useState(null);
  const [packageBusyRecordId, setPackageBusyRecordId] = useState(null);
  const [shareQr, setShareQr] = useState(null);
  const [isPreparingQr, setIsPreparingQr] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  const { account, connectWallet, switchWalletAccount, isConnecting, walletError } = useMetaMask();

  const stats = useMemo(
    () => ({
      total: records.length,
      verified: Object.values(verificationStatus).filter((status) => status === "valid").length,
    }),
    [records.length, verificationStatus]
  );

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
      setVerificationStatus({});
      setShareQr(null);

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
    try {
      setZkBusyRecordId(record.id);
      setErrorMessage("");

      const certificate = await generateMedicalProof(record.decrypted_text, record.leaf_hash);
      downloadCertificateJson(`zk-certificate-record-${record.id}.json`, certificate);
    } catch (error) {
      setErrorMessage(
        error?.message ||
          "Unable to create ZK certificate. Ensure circuit artifacts exist in frontend/public/zk."
      );
    } finally {
      setZkBusyRecordId(null);
    }
  };

  const getOnChainRootForAccount = async () => {
    const provider = await getBrowserProvider();
    const contract = getRegistryContract(provider);
    return contract.getRoot(account);
  };

  const buildVerificationPackage = (record, onChainRoot) => ({
    package_version: "1.0",
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
  });

  const exportVerificationPackage = async (record) => {
    try {
      setPackageBusyRecordId(record.id);
      setErrorMessage("");

      const onChainRoot = await getOnChainRootForAccount();
      const verificationPackage = buildVerificationPackage(record, onChainRoot);

      downloadCertificateJson(`verification-package-record-${record.id}.json`, verificationPackage);
    } catch (error) {
      setErrorMessage(error?.message || "Failed to export verification package.");
    } finally {
      setPackageBusyRecordId(null);
    }
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
      setCopyStatus("Token copied. Paste it in Third-Party Verifier page.");
    } catch {
      setCopyStatus("Unable to access clipboard. Copy token manually from the text box.");
    }
  };

  const copyVerifierLink = async () => {
    if (!shareQr?.verifierUrl) return;

    try {
      await navigator.clipboard.writeText(shareQr.verifierUrl);
      setCopyStatus("Verifier link copied. Open it on third-party device.");
    } catch {
      setCopyStatus("Unable to access clipboard. Copy verifier link manually.");
    }
  };

  const downloadQrImage = () => {
    if (!shareQr?.qrImageDataUrl) return;

    const anchor = document.createElement("a");
    anchor.href = shareQr.qrImageDataUrl;
    anchor.download = `verification-qr-record-${shareQr.recordId}.png`;
    anchor.click();
  };

  return (
    <section className="space-y-6 animate-fadeInUp">
      <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
        <h1 className="font-heading text-3xl font-bold text-white">Patient Page</h1>
        <p className="mt-2 text-sm text-slate-200">
          Authenticate with wallet signature, decrypt your records locally, and verify data integrity
          against on-chain Merkle roots. You can also export a verification package for insurers or
          third-party reviewers.
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

          <button
            type="button"
            onClick={loadRecords}
            disabled={!account || isLoading}
            className="rounded-full border border-white/30 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60"
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
          <p className="mt-2 font-heading text-4xl font-bold text-emerald-200">{stats.verified}</p>
        </div>
      </div>

      <article className="panel overflow-hidden rounded-3xl shadow-glow">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-white/10 text-left text-sm">
            <thead className="bg-slate-900/35 text-slate-200">
              <tr>
                <th className="px-4 py-3 font-semibold">Created</th>
                <th className="px-4 py-3 font-semibold">Doctor</th>
                <th className="px-4 py-3 font-semibold">Decrypted Record</th>
                <th className="px-4 py-3 font-semibold">Integrity</th>
                <th className="px-4 py-3 font-semibold">ZK Certificate</th>
                <th className="px-4 py-3 font-semibold">Third-Party Package</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {records.map((record) => {
                const status = verificationStatus[record.id] || "unknown";
                return (
                  <tr key={record.id} className="align-top text-slate-100">
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
                      <button
                        type="button"
                        onClick={() => verifyIntegrity(record)}
                        className="rounded-full border border-cyan-200/50 bg-cyan-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] text-cyan-100 hover:bg-cyan-300/20"
                      >
                        Verify Integrity
                      </button>
                      <p className="mt-2 text-xs">
                        {status === "checking" && "Checking..."}
                        {status === "valid" && "VALID"}
                        {status === "invalid" && "INVALID"}
                        {status === "unknown" && "Not verified"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => generateZkCertificate(record)}
                        disabled={zkBusyRecordId === record.id}
                        className="rounded-full border border-orange-200/60 bg-orange-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] text-orange-100 hover:bg-orange-300/20 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {zkBusyRecordId === record.id ? "Generating..." : "Generate ZK Certificate"}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => exportVerificationPackage(record)}
                          disabled={packageBusyRecordId === record.id}
                          className="rounded-full border border-emerald-200/60 bg-emerald-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] text-emerald-100 hover:bg-emerald-300/20 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {packageBusyRecordId === record.id
                            ? "Exporting..."
                            : "Export Verification Package"}
                        </button>

                        <button
                          type="button"
                          onClick={() => prepareVerificationQr(record)}
                          disabled={isPreparingQr}
                          className="rounded-full border border-violet-200/60 bg-violet-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] text-violet-100 hover:bg-violet-300/20 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {isPreparingQr ? "Preparing..." : "Show QR Token"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {records.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-300">
                    No records loaded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      {shareQr && (
        <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
          <h2 className="font-heading text-2xl font-bold text-white">Third-Party Share QR</h2>
          <p className="mt-2 text-sm text-slate-200">
            Share this QR code to insurers or other reviewers. Scanning it opens the verifier page
            with the token attached, so they can load verification data instantly.
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
              <p className="text-sm font-semibold text-slate-100">Verifier Link</p>
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
                  className="rounded-full border border-violet-200/60 bg-violet-300/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.08em] text-violet-100 hover:bg-violet-300/20"
                >
                  Copy Verifier Link
                </button>

                <a
                  href={shareQr.verifierUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-cyan-200/60 bg-cyan-300/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.08em] text-cyan-100 hover:bg-cyan-300/20"
                >
                  Open Verifier Link
                </a>

                <button
                  type="button"
                  onClick={copyQrToken}
                  className="rounded-full border border-white/40 bg-white/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.08em] text-white hover:bg-white/20"
                >
                  Copy Token
                </button>

                <button
                  type="button"
                  onClick={downloadQrImage}
                  className="rounded-full border border-emerald-200/60 bg-emerald-300/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.08em] text-emerald-100 hover:bg-emerald-300/20"
                >
                  Download QR PNG
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShareQr(null);
                    setCopyStatus("");
                  }}
                  className="rounded-full border border-white/30 bg-white/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.08em] text-white hover:bg-white/20"
                >
                  Close
                </button>
              </div>

              {copyStatus && <p className="mt-3 text-xs text-cyan-100">{copyStatus}</p>}
            </div>
          </div>
        </article>
      )}
    </section>
  );
}
