function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
}

async function deriveAesKeyFromAddress(patientAddress) {
  const normalized = patientAddress.toLowerCase();
  const digestBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized)
  );

  return crypto.subtle.importKey("raw", digestBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptRawText(rawText, patientAddress) {
  const key = await deriveAesKeyFromAddress(patientAddress);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(rawText)
  );

  const encryptedBytes = new Uint8Array(encryptedBuffer);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const tag = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    alg: "AES-256-GCM",
    iv: uint8ArrayToBase64(iv),
    ciphertext: uint8ArrayToBase64(ciphertext),
    tag: uint8ArrayToBase64(tag),
  };
}

export async function decryptRawText(encryptedPayload, patientAddress) {
  const key = await deriveAesKeyFromAddress(patientAddress);
  const iv = base64ToUint8Array(encryptedPayload.iv);
  const ciphertext = base64ToUint8Array(encryptedPayload.ciphertext);
  const tag = base64ToUint8Array(encryptedPayload.tag);

  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: 128,
    },
    key,
    combined
  );

  return new TextDecoder().decode(decryptedBuffer);
}
