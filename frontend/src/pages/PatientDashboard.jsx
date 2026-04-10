import { useMemo, useState } from "react";

import { useMetaMask } from "../hooks/useMetaMask";
import { getPatientRecords } from "../services/api";
import { getBrowserProvider, getRegistryContract } from "../services/contract";
import { decryptRawText } from "../services/crypto";
import { buildPatientAccessTypedData, signTypedData } from "../services/eip712";
import { verifyMerkleProofInBrowser } from "../services/merkle";
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
          const decryptedText = await decryptRawText(record.encrypted_data, account);
          return {
            ...record,
            decrypted_text: decryptedText,
          };
        })
      );

      setRecords(decryptedRecords);
      setVerificationStatus({});
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

  return (
    <section className="space-y-6 animate-fadeInUp">
      <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
        <h1 className="font-heading text-3xl font-bold text-white">Patient Dashboard</h1>
        <p className="mt-2 text-sm text-slate-200">
          Authenticate with wallet signature, decrypt your records locally, and verify data integrity
          against on-chain Merkle roots.
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
    </section>
  );
}
