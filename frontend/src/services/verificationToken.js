const TOKEN_PREFIX = "SMR1";

function base64UrlEncode(rawText) {
  const utf8 = new TextEncoder().encode(rawText);
  let binary = "";

  utf8.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(base64Url) {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(base64Url.length / 4) * 4,
    "="
  );

  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

export function encodeVerificationToken(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Verification payload must be an object.");
  }

  const serialized = JSON.stringify(payload);
  const encoded = base64UrlEncode(serialized);
  return `${TOKEN_PREFIX}.${encoded}`;
}

export function decodeVerificationToken(token) {
  if (!token || typeof token !== "string") {
    throw new Error("Verification token is required.");
  }

  const trimmed = token.trim();
  const expectedPrefix = `${TOKEN_PREFIX}.`;

  if (!trimmed.startsWith(expectedPrefix)) {
    throw new Error("Invalid token prefix. Expected SMR1.");
  }

  const encoded = trimmed.slice(expectedPrefix.length);
  if (!encoded) {
    throw new Error("Verification token is empty.");
  }

  const decoded = base64UrlDecode(encoded);

  try {
    return JSON.parse(decoded);
  } catch {
    throw new Error("Verification token payload is not valid JSON.");
  }
}
