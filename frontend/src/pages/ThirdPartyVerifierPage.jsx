import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSearchParams } from "react-router-dom";

import { getReadOnlyProvider, getRegistryContract } from "../services/contract";
import { verifyMerkleProofInBrowser } from "../services/merkle";
import { decodeVerificationToken } from "../services/verificationToken";

function toLowerHex(value) {
  return String(value || "").toLowerCase();
}

function normalizeVerificationPackage(rawPackage) {
  if (!rawPackage || typeof rawPackage !== "object") {
    throw new Error("Verification package must be a JSON object.");
  }

  if (!rawPackage.patient_address || !rawPackage.leaf_hash) {
    throw new Error("Package must include patient_address and leaf_hash.");
  }

  const normalizedAddress = ethers.getAddress(rawPackage.patient_address);
  const proof = Array.isArray(rawPackage.merkle_proof) ? rawPackage.merkle_proof : [];

  return {
    ...rawPackage,
    patient_address: normalizedAddress,
    leaf_hash: rawPackage.leaf_hash,
    merkle_proof: proof,
  };
}

export default function ThirdPartyVerifierPage() {
  const [searchParams] = useSearchParams();
  const [verificationPackage, setVerificationPackage] = useState(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    const token = searchParams.get("token") || "";
    if (!token) {
      setVerificationPackage(null);
      setInfoMessage("No verification token found in this URL. Ask patient to share verifier QR link.");
      setErrorMessage("");
      return;
    }

    try {
      const decoded = decodeVerificationToken(token);
      const normalized = normalizeVerificationPackage(decoded);

      setVerificationPackage(normalized);
      setErrorMessage("");
      setInfoMessage("Verification package loaded from shared patient link.");
    } catch (error) {
      setVerificationPackage(null);
      setErrorMessage(error?.message || "Failed to decode verification token.");
      setInfoMessage("");
    }
  }, [searchParams]);

  const handleVerify = async () => {
    if (!verificationPackage) {
      return;
    }

    try {
      setIsVerifying(true);
      setErrorMessage("");
      setResult(null);

      const provider = await getReadOnlyProvider();
      const contract = getRegistryContract(provider);
      const onChainRoot = await contract.getRoot(verificationPackage.patient_address);

      const merkleProofValid = verifyMerkleProofInBrowser(
        verificationPackage.leaf_hash,
        verificationPackage.merkle_proof || [],
        onChainRoot
      );

      const claimedRoot = verificationPackage.merkle_root || "";
      const claimedRootMatch = claimedRoot
        ? toLowerHex(claimedRoot) === toLowerHex(onChainRoot)
        : null;

      const isValid = merkleProofValid && (claimedRootMatch === null || claimedRootMatch === true);

      setResult({
        isValid,
        patientAddress: verificationPackage.patient_address,
        onChainRoot,
        claimedRoot,
        claimedRootMatch,
        merkleProofValid,
        txHash: verificationPackage.tx_hash || "",
      });
    } catch (error) {
      setErrorMessage(error?.message || "Verification failed.");
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <section className="space-y-6 animate-fadeInUp">
      <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
        <h1 className="font-heading text-3xl font-bold text-white">Third-Party Verification Page</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-200">
          One simple flow: open patient shared verifier link, then click verify. No manual JSON paste.
        </p>

        <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-100">
          <p>
            <strong>Patient:</strong> {verificationPackage?.patient_address || "-"}
          </p>
          <p className="mt-2 break-all">
            <strong>Leaf Hash:</strong> {verificationPackage?.leaf_hash || "-"}
          </p>
          <p className="mt-2 break-all">
            <strong>Claimed Root:</strong> {verificationPackage?.merkle_root || "-"}
          </p>
          {verificationPackage?.tx_hash && (
            <p className="mt-2 break-all">
              <strong>Tx Hash:</strong> {verificationPackage.tx_hash}
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleVerify}
            disabled={isVerifying || !verificationPackage}
            className="rounded-full bg-gradient-to-r from-cyan-300 to-orange-300 px-5 py-2 text-sm font-extrabold text-slate-950 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isVerifying ? "Verifying..." : "Verify Package"}
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
      </article>

      {result && (
        <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
          <h2 className="font-heading text-2xl font-bold text-white">Verification Result</h2>
          <p
            className={`mt-3 inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.1em] ${
              result.isValid
                ? "border border-emerald-200/50 bg-emerald-400/10 text-emerald-100"
                : "border border-red-200/50 bg-red-500/10 text-red-100"
            }`}
          >
            {result.isValid ? "Valid" : "Invalid"}
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-100">
              <p>
                <strong>Patient:</strong> {result.patientAddress}
              </p>
              <p className="mt-2 break-all">
                <strong>On-chain Root:</strong> {result.onChainRoot}
              </p>
              {result.claimedRoot && (
                <p className="mt-2 break-all">
                  <strong>Claimed Root:</strong> {result.claimedRoot}
                </p>
              )}
              {result.txHash && (
                <p className="mt-2 break-all">
                  <strong>Tx Hash:</strong> {result.txHash}
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-100">
              <p className="mb-2 font-semibold">Checks</p>
              <ul className="space-y-2">
                <li className="flex items-center justify-between gap-3">
                  <span>Merkle proof matches on-chain root</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                      result.merkleProofValid
                        ? "bg-emerald-300/20 text-emerald-100"
                        : "bg-red-300/20 text-red-100"
                    }`}
                  >
                    {result.merkleProofValid ? "pass" : "fail"}
                  </span>
                </li>
                {result.claimedRootMatch !== null && (
                  <li className="flex items-center justify-between gap-3">
                    <span>Claimed root matches on-chain root</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                        result.claimedRootMatch
                          ? "bg-emerald-300/20 text-emerald-100"
                          : "bg-red-300/20 text-red-100"
                      }`}
                    >
                      {result.claimedRootMatch ? "pass" : "fail"}
                    </span>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </article>
      )}
    </section>
  );
}
