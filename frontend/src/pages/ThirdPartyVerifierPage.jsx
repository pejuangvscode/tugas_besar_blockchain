import { useMemo, useState } from "react";
import { ethers } from "ethers";

import { getReadOnlyProvider, getRegistryContract } from "../services/contract";
import { verifyMerkleProofInBrowser } from "../services/merkle";
import { decodeVerificationToken } from "../services/verificationToken";
import { verifyMedicalCertificate } from "../services/zkp";

const PACKAGE_PLACEHOLDER = `{
  "patient_address": "0x...",
  "leaf_hash": "0x...",
  "merkle_proof": [
    { "position": "right", "hash": "0x..." }
  ],
  "merkle_root": "0x...",
  "tx_hash": "0x..."
}`;

function toLowerHex(value) {
  return String(value || "").toLowerCase();
}

function readJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${label} JSON.`);
  }
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
  const [tokenText, setTokenText] = useState("");
  const [packageText, setPackageText] = useState("");
  const [certificateText, setCertificateText] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [result, setResult] = useState(null);

  const summary = useMemo(() => {
    if (!result) return null;

    const checks = [];
    checks.push({
      label: "Merkle proof matches on-chain root",
      value: result.merkleProofValid,
    });

    if (result.claimedRootMatch !== null) {
      checks.push({
        label: "Claimed merkle_root matches on-chain root",
        value: result.claimedRootMatch,
      });
    }

    if (result.certificateVerified !== null) {
      checks.push({
        label: "ZK certificate verified",
        value: result.certificateVerified,
      });
    }

    return checks;
  }, [result]);

  const handleVerify = async () => {
    try {
      setIsVerifying(true);
      setErrorMessage("");
      setResult(null);

      let parsedPackage;
      if (packageText.trim()) {
        parsedPackage = readJson(packageText, "verification package");
      } else if (tokenText.trim()) {
        parsedPackage = decodeVerificationToken(tokenText);
      } else {
        throw new Error("Provide verification package JSON or token from QR.");
      }

      const pkg = normalizeVerificationPackage(parsedPackage);

      const provider = await getReadOnlyProvider();
      const contract = getRegistryContract(provider);
      const onChainRoot = await contract.getRoot(pkg.patient_address);

      const merkleProofValid = verifyMerkleProofInBrowser(
        pkg.leaf_hash,
        pkg.merkle_proof || [],
        onChainRoot
      );

      let claimedRootMatch = null;
      if (pkg.merkle_root) {
        claimedRootMatch = toLowerHex(pkg.merkle_root) === toLowerHex(onChainRoot);
      }

      let certificateVerified = null;
      if (certificateText.trim()) {
        const parsedCertificate = readJson(certificateText, "certificate");
        certificateVerified = await verifyMedicalCertificate(parsedCertificate);
      }

      const isValid =
        merkleProofValid &&
        (claimedRootMatch === null || claimedRootMatch === true) &&
        (certificateVerified === null || certificateVerified === true);

      setResult({
        isValid,
        patientAddress: pkg.patient_address,
        onChainRoot,
        claimedRoot: pkg.merkle_root || "",
        claimedRootMatch,
        merkleProofValid,
        certificateVerified,
        txHash: pkg.tx_hash || "",
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
          This page is designed for insurers or external reviewers to validate patient data integrity
          against on-chain Merkle roots. You can verify with just a verification package, and add an
          optional ZK certificate check.
        </p>

        <label className="mt-5 block">
          <span className="mb-2 block text-sm font-semibold text-slate-100">
            Verification Token from QR (Optional)
          </span>
          <textarea
            value={tokenText}
            onChange={(event) => setTokenText(event.target.value)}
            placeholder="SMR1.eyJwYXRpZW50X2FkZHJlc3MiOiIweC4uLiJ9"
            className="min-h-24 w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-xs text-white outline-none placeholder:text-slate-400 focus:border-violet-200/70"
          />

          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                try {
                  const decodedPackage = decodeVerificationToken(tokenText);
                  setPackageText(JSON.stringify(decodedPackage, null, 2));
                  setErrorMessage("");
                } catch (error) {
                  setErrorMessage(error?.message || "Failed to decode verification token.");
                }
              }}
              className="rounded-full border border-violet-200/60 bg-violet-300/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.08em] text-violet-100 hover:bg-violet-300/20"
            >
              Decode Token to JSON
            </button>

            <button
              type="button"
              onClick={() => {
                setTokenText("");
              }}
              className="rounded-full border border-white/25 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20"
            >
              Clear Token
            </button>
          </div>
        </label>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-100">
              Verification Package (JSON)
            </span>
            <textarea
              value={packageText}
              onChange={(event) => setPackageText(event.target.value)}
              placeholder={PACKAGE_PLACEHOLDER}
              className="min-h-64 w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-xs text-white outline-none placeholder:text-slate-400 focus:border-cyan-200/70"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-100">
              Optional ZK Certificate (JSON)
            </span>
            <textarea
              value={certificateText}
              onChange={(event) => setCertificateText(event.target.value)}
              placeholder='{"public_signals": [...], "proof": {...}}'
              className="min-h-64 w-full rounded-xl border border-white/20 bg-slate-950/40 px-4 py-3 text-xs text-white outline-none placeholder:text-slate-400 focus:border-orange-200/70"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleVerify}
            disabled={isVerifying}
            className="rounded-full bg-gradient-to-r from-cyan-300 to-orange-300 px-5 py-2 text-sm font-extrabold text-slate-950 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isVerifying ? "Verifying..." : "Verify Package"}
          </button>

          <button
            type="button"
            onClick={() => {
              setTokenText("");
              setPackageText("");
              setCertificateText("");
              setResult(null);
              setErrorMessage("");
            }}
            className="rounded-full border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
          >
            Reset
          </button>
        </div>

        {errorMessage && (
          <div className="mt-4 rounded-xl border border-red-200/40 bg-red-500/10 p-3 text-sm text-red-100">
            {errorMessage}
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
                {summary?.map((item) => (
                  <li key={item.label} className="flex items-center justify-between gap-3">
                    <span>{item.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                        item.value
                          ? "bg-emerald-300/20 text-emerald-100"
                          : "bg-red-300/20 text-red-100"
                      }`}
                    >
                      {item.value ? "pass" : "fail"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </article>
      )}
    </section>
  );
}
