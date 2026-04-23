import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSearchParams } from "react-router-dom";
import jsQR from "jsqr";

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
    return String(value);
  }

  return parsed.toLocaleString();
}

function formatWorkflowValue(value, fallback = "-") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return fallback;
  }

  return normalized
    .split(/[_\-\.\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeAddressOrThrow(rawAddress) {
  if (!rawAddress || !rawAddress.trim()) {
    throw new Error("Patient wallet address is required in certificate.");
  }

  try {
    return ethers.getAddress(rawAddress.trim());
  } catch {
    throw new Error("Patient wallet address in certificate is invalid.");
  }
}

function extractTokenFromInput(rawInput) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) {
    throw new Error("Certificate link or token is required.");
  }

  if (trimmed.startsWith("SMR1.")) {
    return trimmed;
  }

  try {
    const parsedUrl = new URL(trimmed, window.location.origin);
    const token = parsedUrl.searchParams.get("token");

    if (token && token.trim()) {
      return token.trim();
    }
  } catch {
    // Fall through and show standard invalid input error.
  }

  throw new Error("Invalid certificate link or token format.");
}

function normalizeCertificatePayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") {
    throw new Error("Certificate payload must be an object.");
  }

  const patientAddress = normalizeAddressOrThrow(rawPayload.patient_address || "");
  const leafHash = String(rawPayload.leaf_hash || "").trim();

  if (!leafHash) {
    throw new Error("Certificate payload is missing leaf_hash.");
  }

  const merkleProof = Array.isArray(rawPayload.merkle_proof) ? rawPayload.merkle_proof : [];
  if (!merkleProof.length) {
    throw new Error("Certificate payload is missing merkle_proof.");
  }

  return {
    ...rawPayload,
    patient_address: patientAddress,
    leaf_hash: leafHash,
    merkle_proof: merkleProof,
  };
}

function loadImageElementFromFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Unable to read uploaded image."));
    };

    image.src = objectUrl;
  });
}

function drawImageToCanvas(image, maxDimension = 0) {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;

  if (!naturalWidth || !naturalHeight) {
    throw new Error("Invalid QR image dimensions.");
  }

  let targetWidth = naturalWidth;
  let targetHeight = naturalHeight;

  if (maxDimension > 0) {
    const largest = Math.max(naturalWidth, naturalHeight);
    if (largest > maxDimension) {
      const ratio = maxDimension / largest;
      targetWidth = Math.max(1, Math.round(naturalWidth * ratio));
      targetHeight = Math.max(1, Math.round(naturalHeight * ratio));
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Unable to read image pixels for QR decoding.");
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  return canvas;
}

function cropCanvasFromCenter(sourceCanvas, cropRatio = 1) {
  const safeCropRatio = Math.min(1, Math.max(0.4, cropRatio));
  if (safeCropRatio >= 0.999) {
    return sourceCanvas;
  }

  const cropWidth = Math.max(1, Math.round(sourceCanvas.width * safeCropRatio));
  const cropHeight = Math.max(1, Math.round(sourceCanvas.height * safeCropRatio));
  const sourceX = Math.max(0, Math.floor((sourceCanvas.width - cropWidth) / 2));
  const sourceY = Math.max(0, Math.floor((sourceCanvas.height - cropHeight) / 2));

  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return sourceCanvas;
  }

  context.drawImage(
    sourceCanvas,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  return canvas;
}

function cropCanvasRegion(sourceCanvas, leftRatio, topRatio, widthRatio, heightRatio) {
  const normalizedWidthRatio = Math.min(1, Math.max(0.2, widthRatio));
  const normalizedHeightRatio = Math.min(1, Math.max(0.2, heightRatio));
  const normalizedLeftRatio = Math.min(1, Math.max(0, leftRatio));
  const normalizedTopRatio = Math.min(1, Math.max(0, topRatio));

  const cropWidth = Math.max(1, Math.round(sourceCanvas.width * normalizedWidthRatio));
  const cropHeight = Math.max(1, Math.round(sourceCanvas.height * normalizedHeightRatio));
  const maxSourceX = Math.max(0, sourceCanvas.width - cropWidth);
  const maxSourceY = Math.max(0, sourceCanvas.height - cropHeight);
  const sourceX = Math.min(maxSourceX, Math.round(sourceCanvas.width * normalizedLeftRatio));
  const sourceY = Math.min(maxSourceY, Math.round(sourceCanvas.height * normalizedTopRatio));

  if (
    sourceX === 0 &&
    sourceY === 0 &&
    cropWidth === sourceCanvas.width &&
    cropHeight === sourceCanvas.height
  ) {
    return sourceCanvas;
  }

  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return sourceCanvas;
  }

  context.drawImage(
    sourceCanvas,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  return canvas;
}

function rotateCanvas(sourceCanvas, angleDegrees = 0) {
  const normalizedAngle = ((angleDegrees % 360) + 360) % 360;
  if (!normalizedAngle) {
    return sourceCanvas;
  }

  const isQuarterTurn = normalizedAngle === 90 || normalizedAngle === 270;
  const canvas = document.createElement("canvas");
  canvas.width = isQuarterTurn ? sourceCanvas.height : sourceCanvas.width;
  canvas.height = isQuarterTurn ? sourceCanvas.width : sourceCanvas.height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return sourceCanvas;
  }

  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((normalizedAngle * Math.PI) / 180);
  context.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);

  return canvas;
}

function buildQrFocusCanvases(baseCanvas) {
  return [
    baseCanvas,
    cropCanvasFromCenter(baseCanvas, 0.92),
    cropCanvasFromCenter(baseCanvas, 0.8),
    cropCanvasRegion(baseCanvas, 0, 0, 0.68, 0.68),
    cropCanvasRegion(baseCanvas, 0.32, 0, 0.68, 0.68),
    cropCanvasRegion(baseCanvas, 0, 0.32, 0.68, 0.68),
    cropCanvasRegion(baseCanvas, 0.32, 0.32, 0.68, 0.68),
  ];
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function cloneImageData(imageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function toGrayscale(imageData) {
  const output = cloneImageData(imageData);
  const data = output.data;

  for (let index = 0; index < data.length; index += 4) {
    const luminance = Math.round(
      data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114
    );
    data[index] = luminance;
    data[index + 1] = luminance;
    data[index + 2] = luminance;
  }

  return output;
}

function applyContrast(imageData, contrastFactor = 1.7) {
  const output = cloneImageData(imageData);
  const data = output.data;
  const normalizedContrast = Math.max(0.1, contrastFactor);

  for (let index = 0; index < data.length; index += 4) {
    data[index] = clampByte((data[index] - 128) * normalizedContrast + 128);
    data[index + 1] = clampByte((data[index + 1] - 128) * normalizedContrast + 128);
    data[index + 2] = clampByte((data[index + 2] - 128) * normalizedContrast + 128);
  }

  return output;
}

function applyThreshold(imageData, threshold = 140) {
  const output = toGrayscale(imageData);
  const data = output.data;

  for (let index = 0; index < data.length; index += 4) {
    const value = data[index] >= threshold ? 255 : 0;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  return output;
}

function decodeImageDataWithJsQr(imageData) {
  try {
    const decoded = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth",
    });
    return String(decoded?.data || "").trim();
  } catch {
    return "";
  }
}

function decodeCanvasWithJsQr(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return "";
  }

  const baseImageData = context.getImageData(0, 0, canvas.width, canvas.height);

  const decodeAttempts = [
    baseImageData,
    toGrayscale(baseImageData),
    applyContrast(baseImageData, 2),
    applyContrast(toGrayscale(baseImageData), 2.3),
    applyThreshold(baseImageData, 125),
    applyThreshold(baseImageData, 150),
  ];

  for (const candidate of decodeAttempts) {
    const decodedText = decodeImageDataWithJsQr(candidate);
    if (decodedText) {
      return decodedText;
    }
  }

  return "";
}

async function decodeQrWithBarcodeDetector(image) {
  const BarcodeDetectorCtor = typeof window !== "undefined" ? window.BarcodeDetector : undefined;
  if (!BarcodeDetectorCtor) {
    return "";
  }

  try {
    const detector = new BarcodeDetectorCtor({ formats: ["qr_code"] });
    const directDetections = await detector.detect(image);
    const directResult = String(directDetections?.[0]?.rawValue || "").trim();
    if (directResult) {
      return directResult;
    }

    const resizedCanvas = drawImageToCanvas(image, 2048);
    const focusCanvases = buildQrFocusCanvases(resizedCanvas);

    for (const candidateCanvas of focusCanvases) {
      const detections = await detector.detect(candidateCanvas);
      const decodedText = String(detections?.[0]?.rawValue || "").trim();
      if (decodedText) {
        return decodedText;
      }
    }

    for (const angle of [90, 180, 270]) {
      const rotatedCanvas = rotateCanvas(resizedCanvas, angle);
      const detections = await detector.detect(rotatedCanvas);
      const decodedText = String(detections?.[0]?.rawValue || "").trim();
      if (decodedText) {
        return decodedText;
      }
    }

    return "";
  } catch {
    return "";
  }
}

function decodeQrWithJsQr(image) {
  const sizeAttempts = [2048, 1536, 1024, 768, 512];

  for (const maxDimension of sizeAttempts) {
    try {
      const baseCanvas = drawImageToCanvas(image, maxDimension);
      const focusCanvases = buildQrFocusCanvases(baseCanvas);

      for (const candidateCanvas of focusCanvases) {
        const decodedText = decodeCanvasWithJsQr(candidateCanvas);
        if (decodedText) {
          return decodedText;
        }
      }

      const rotatedCandidates = focusCanvases.slice(0, 3);
      for (const angle of [90, 180, 270]) {
        for (const candidateCanvas of rotatedCandidates) {
          const rotatedCanvas = rotateCanvas(candidateCanvas, angle);
          const decodedText = decodeCanvasWithJsQr(rotatedCanvas);
          if (decodedText) {
            return decodedText;
          }
        }
      }
    } catch {
      // Continue to next decoding strategy.
    }
  }

  return "";
}

async function decodeQrWithZxing(image) {
  try {
    const { BrowserQRCodeReader } = await import("@zxing/browser");
    const sizeAttempts = [2048, 1536, 1024];
    const rotationAngles = [0, 90, 180, 270];

    const reader = new BrowserQRCodeReader();
    try {
      for (const maxDimension of sizeAttempts) {
        let baseCanvas;
        try {
          baseCanvas = drawImageToCanvas(image, maxDimension);
        } catch {
          continue;
        }

        const focusCanvases = buildQrFocusCanvases(baseCanvas);

        for (const angle of rotationAngles) {
          const angleCandidates = angle === 0 ? focusCanvases : focusCanvases.slice(0, 3);

          for (const candidateCanvas of angleCandidates) {
            const workingCanvas = angle ? rotateCanvas(candidateCanvas, angle) : candidateCanvas;
            const imageUrl = workingCanvas.toDataURL("image/png");

            try {
              const result = await reader.decodeFromImageUrl(imageUrl);
              const decodedText = String(result?.getText?.() || "").trim();
              if (decodedText) {
                return decodedText;
              }
            } catch {
              // Continue to the next candidate image.
            }
          }
        }
      }

      return "";
    } finally {
      reader.reset();
    }
  } catch {
    return "";
  }
}

async function decodeQrFromImageFile(file) {
  const image = await loadImageElementFromFile(file);

  const barcodeDetectorResult = await decodeQrWithBarcodeDetector(image);
  if (barcodeDetectorResult) {
    return barcodeDetectorResult;
  }

  const jsQrResult = decodeQrWithJsQr(image);
  if (jsQrResult) {
    return jsQrResult;
  }

  const zxingResult = await decodeQrWithZxing(image);
  if (zxingResult) {
    return zxingResult;
  }

  throw new Error(
    "QR code was not detected in the uploaded image. Try a clearer/cropped QR image or paste certificate link/token manually."
  );
}

const PRIMARY_ACTION_CLASS =
  "rounded-full border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-blue-50 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

const SECONDARY_ACTION_CLASS =
  "rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60";

export default function ThirdPartyVerifierPage() {
  const [searchParams] = useSearchParams();

  const [shareInput, setShareInput] = useState("");
  const [uploadedQrName, setUploadedQrName] = useState("");

  const [verificationToken, setVerificationToken] = useState("");
  const [certificatePayload, setCertificatePayload] = useState(null);
  const [verificationResult, setVerificationResult] = useState(null);
  const [onChainRoot, setOnChainRoot] = useState("");

  const [isDecodingQr, setIsDecodingQr] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");
  const [infoMessage, setInfoMessage] = useState("");

  const loadCertificateFromSource = (rawInput, successMessage) => {
    const token = extractTokenFromInput(rawInput);
    const decodedPayload = decodeVerificationToken(token);
    const normalizedPayload = normalizeCertificatePayload(decodedPayload);

    setVerificationToken(token);
    setCertificatePayload(normalizedPayload);
    setVerificationResult(null);
    setOnChainRoot("");
    setErrorMessage("");
    setInfoMessage(successMessage || "Certificate loaded. Click Verify Certificate.");

    return normalizedPayload;
  };

  useEffect(() => {
    const tokenFromQuery = searchParams.get("token") || "";
    if (!tokenFromQuery) {
      return;
    }

    setShareInput(tokenFromQuery);
    try {
      loadCertificateFromSource(
        tokenFromQuery,
        "Certificate token from patient link detected. Click Verify Certificate."
      );
    } catch (error) {
      setErrorMessage(error?.message || "Failed to read certificate token from URL.");
    }
  }, [searchParams]);

  const handleLoadCertificate = () => {
    try {
      loadCertificateFromSource(shareInput, "Certificate loaded. Ready to verify.");
    } catch (error) {
      setErrorMessage(error?.message || "Failed to load certificate from input.");
    }
  };

  const handleQrUpload = async (event) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";

    if (!selectedFile) {
      return;
    }

    try {
      setIsDecodingQr(true);
      setUploadedQrName("");
      setErrorMessage("");
      setInfoMessage("");

      const detectedRawValue = await decodeQrFromImageFile(selectedFile);

      if (!detectedRawValue) {
        throw new Error("QR code was not detected in the uploaded image.");
      }

      setShareInput(detectedRawValue);
      setUploadedQrName(selectedFile.name);

      loadCertificateFromSource(
        detectedRawValue,
        `QR decoded from ${selectedFile.name}. Certificate is ready to verify.`
      );
    } catch (error) {
      setErrorMessage(error?.message || "Failed to decode QR image.");
    } finally {
      setIsDecodingQr(false);
    }
  };

  const handleVerifyCertificate = async () => {
    try {
      if (!certificatePayload) {
        throw new Error("Load patient certificate first.");
      }

      setIsVerifying(true);
      setErrorMessage("");
      setInfoMessage("");

      const provider = await getReadOnlyProvider();
      const contract = getRegistryContract(provider);
      const root = await contract.getRoot(certificatePayload.patient_address);
      setOnChainRoot(root);

      const isValid = verifyMerkleProofInBrowser(
        certificatePayload.leaf_hash,
        certificatePayload.merkle_proof || [],
        root
      );

      const packageRoot = String(certificatePayload.merkle_root || "").trim();
      const rootMatch = packageRoot
        ? toLowerHex(packageRoot) === toLowerHex(root)
        : null;

      setVerificationResult({
        valid: isValid,
        root_match: rootMatch,
        package_root: packageRoot || null,
        onchain_root: root,
        checked_at: new Date().toISOString(),
      });

      if (isValid) {
        setInfoMessage("Certificate verification passed. Data integrity is valid.");
      } else {
        setInfoMessage("Certificate verification failed. Merkle proof does not match on-chain root.");
      }
    } catch (error) {
      setErrorMessage(error?.message || "Certificate verification failed.");
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <section className="space-y-6 animate-fadeInUp">
      <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
        <h1 className="font-heading text-3xl font-bold text-white">Insurance Verification Page</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-200">
          Verifikator asuransi hanya menerima sertifikat dari pasien melalui QR code atau link,
          lalu melakukan verifikasi integritas.
        </p>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <label className="text-sm text-slate-200">
            Upload QR Code (Image)
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                void handleQrUpload(event);
              }}
              className="mt-1 block w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white file:mr-3 file:rounded-full file:border-0 file:bg-blue-200 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-blue-900"
            />
            {uploadedQrName && <p className="mt-1 text-xs text-slate-300">Loaded file: {uploadedQrName}</p>}
          </label>

          <label className="text-sm text-slate-200">
            Paste Certificate Link or Token
            <textarea
              value={shareInput}
              onChange={(event) => setShareInput(event.target.value)}
              placeholder="Paste patient verifier link (with ?token=...) or raw token SMR1..."
              className="mt-1 min-h-24 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs text-white outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-300/25"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleLoadCertificate}
            disabled={!shareInput.trim() || isDecodingQr}
            className={SECONDARY_ACTION_CLASS}
          >
            Load Certificate
          </button>

          <button
            type="button"
            onClick={() => {
              void handleVerifyCertificate();
            }}
            disabled={!certificatePayload || isVerifying}
            className={PRIMARY_ACTION_CLASS}
          >
            {isVerifying ? "Verifying..." : "Verify Certificate"}
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

      {certificatePayload && (
        <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
          <h2 className="font-heading text-2xl font-bold text-white">Loaded Certificate</h2>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-100">
              <p>
                <strong>Patient:</strong> {truncateAddress(certificatePayload.patient_address)}
              </p>
              <p className="mt-2 break-all">
                <strong>Leaf Hash:</strong> {certificatePayload.leaf_hash}
              </p>
              <p className="mt-2">
                <strong>Record ID:</strong> {certificatePayload.record_id ?? "-"}
              </p>
              <p className="mt-2">
                <strong>Generated:</strong> {formatTimestamp(certificatePayload.generated_at)}
              </p>
            </div>

            <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-100">
              <p>
                <strong>Package Root:</strong>
              </p>
              <p className="mt-1 break-all text-xs text-slate-200">
                {certificatePayload.merkle_root || "-"}
              </p>
              <p className="mt-2">
                <strong>Proof Steps:</strong> {certificatePayload.merkle_proof?.length || 0}
              </p>
              {verificationToken && (
                <p className="mt-2">
                  <strong>Token Prefix:</strong> {verificationToken.slice(0, 12)}...
                </p>
              )}
            </div>
          </div>

          {certificatePayload.workflow && typeof certificatePayload.workflow === "object" && (
            <div className="mt-4 rounded-2xl border border-white/15 bg-slate-900/30 p-4 text-xs text-slate-200">
              <p className="font-bold uppercase tracking-[0.08em] text-slate-300">Workflow Roles</p>
              <p className="mt-2">
                <strong>Issuer:</strong>{" "}
                {formatWorkflowValue(certificatePayload.workflow.certificate_issuer_role, "Patient")}
              </p>
              <p className="mt-1">
                <strong>Prover:</strong>{" "}
                {formatWorkflowValue(certificatePayload.workflow.prover_role, "Hospital")}
              </p>
              <p className="mt-1">
                <strong>Verifier:</strong>{" "}
                {formatWorkflowValue(certificatePayload.workflow.verifier_role, "Insurance")}
              </p>
            </div>
          )}
        </article>
      )}

      {verificationResult && (
        <article className="panel rounded-3xl p-6 shadow-glow sm:p-8">
          <h2 className="font-heading text-2xl font-bold text-white">Verification Result</h2>

          <p
            className={`mt-3 inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] ${
              verificationResult.valid
                ? "bg-emerald-300/20 text-emerald-100"
                : "bg-red-300/20 text-red-100"
            }`}
          >
            {verificationResult.valid ? "valid" : "invalid"}
          </p>

          <div className="mt-4 grid gap-4 text-sm text-slate-100 md:grid-cols-2">
            <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
              <p>
                <strong>Checked At:</strong> {formatTimestamp(verificationResult.checked_at)}
              </p>
              <p className="mt-2 break-all">
                <strong>On-chain Root:</strong> {verificationResult.onchain_root || onChainRoot || "-"}
              </p>
              <p className="mt-2 break-all">
                <strong>Package Root:</strong> {verificationResult.package_root || "-"}
              </p>
            </div>

            <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
              <p>
                <strong>Root Match:</strong>{" "}
                {verificationResult.root_match === null
                  ? "N/A"
                  : verificationResult.root_match
                    ? "Yes"
                    : "No"}
              </p>
              <p className="mt-2">
                <strong>Merkle Proof:</strong>{" "}
                {verificationResult.valid ? "Consistent with on-chain root" : "Not consistent"}
              </p>
            </div>
          </div>
        </article>
      )}
    </section>
  );
}
