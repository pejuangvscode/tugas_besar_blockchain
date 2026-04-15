const API_BASE_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || "API request failed");
  }

  return payload;
}

export function createRecord(data) {
  return request("/records/create", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function getPatientRecords(patientAddress, signature, nonce) {
  const params = new URLSearchParams({ signature, nonce });
  return request(`/records/${patientAddress}?${params.toString()}`, {
    method: "GET",
  });
}

export function verifyRecord(payload) {
  return request("/records/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateMerkleRootTxHash(payload) {
  return request("/records/merkle_root/tx_hash", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function getWalletRole(walletAddress) {
  return request(`/roles/${walletAddress}`, {
    method: "GET",
  });
}

export function upsertWalletRole(payload) {
  return request("/roles/upsert", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
