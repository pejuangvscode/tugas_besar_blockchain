import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

import { useMetaMask } from "../hooks/useMetaMask";
import { createRecord, updateMerkleRootTxHash } from "../services/api";
import { getBrowserProvider, getRegistryContract } from "../services/contract";
import { buildCreateRecordTypedData, signTypedData } from "../services/eip712";

function truncateAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const PATIENT_BOOK_STORAGE_KEY = "smr.patientBook.v1";

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
  const [patientAddress, setPatientAddress] = useState("");
  const [patientLabel, setPatientLabel] = useState("");
  const [rawText, setRawText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [bookMessage, setBookMessage] = useState("");
  const [result, setResult] = useState(null);
  const [patientBook, setPatientBook] = useState(() => loadPatientBook());

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

  useEffect(() => {
    persistPatientBook(patientBook);
  }, [patientBook]);

  const explorerLink = useMemo(() => {
    if (!result?.tx_hash) return "";
    return `https://sepolia.etherscan.io/tx/${result.tx_hash}`;
  }, [result]);

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

    try {
      setIsSubmitting(true);

      const normalizedPatient = ethers.getAddress(patientAddress.trim());
      const nonce = `${Date.now()}`;
      const typedData = buildCreateRecordTypedData({
        patientAddress: normalizedPatient,
        doctorAddress: account,
        rawText,
        nonce,
      });

      const signature = await signTypedData(account, typedData);

      const createResponse = await createRecord({
        patient_address: normalizedPatient,
        raw_text: rawText,
        doctor_address: account,
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
      });

      const fallbackLabel = patientLabel.trim() || `Patient ${truncateAddress(normalizedPatient)}`;
      setPatientBook((previous) =>
        upsertPatientBookEntry(previous, normalizedPatient, fallbackLabel)
      );
      setBookMessage(`Saved ${fallbackLabel} to quick patient list.`);

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
    setPatientAddress(entry.address);
    setPatientLabel(entry.label);
    setBookMessage(`Selected ${entry.label}.`);
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

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-100">Patient Wallet</span>
            <input
              list="saved-patient-addresses"
              value={patientAddress}
              onChange={(event) => setPatientAddress(event.target.value)}
              placeholder="0x..."
              className="w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
              required
            />
            <datalist id="saved-patient-addresses">
              {patientBook.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {entry.label}
                </option>
              ))}
            </datalist>
          </label>

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

      <aside className="panel rounded-3xl p-6 shadow-glow sm:p-8 animate-fadeInUp">
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
    </section>
  );
}
