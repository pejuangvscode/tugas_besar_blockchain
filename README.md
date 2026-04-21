# Sovereign Medical Records DApp

A full-stack decentralized application for **sovereign, encrypted medical records** on Ethereum. Patients retain cryptographic ownership of their health data; doctors anchor integrity proofs on-chain; third parties can verify records without ever accessing plaintext.

**Live deployment:**
- Frontend: https://raphamedical.vercel.app
- Backend API: https://raphamedical.fly.dev
- Smart Contract (Sepolia): `0x1e325e9243dc886026342d8628A4465bdB50d46C`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                        FRONTEND                         │
│   React 18 + Vite + Tailwind + ethers.js + snarkjs     │
│                                                         │
│  /doctor  →  Create records, anchor Merkle root        │
│  /patient →  Decrypt, verify, share records            │
│  /verifier→  Verify integrity from shared link/QR      │
└──────────────┬────────────────────┬────────────────────┘
               │ HTTP REST          │ ethers.js
               ▼                    ▼
┌──────────────────────┐   ┌───────────────────────────┐
│    BACKEND (FastAPI) │   │  ETHEREUM SEPOLIA          │
│    PostgreSQL        │   │                            │
│                      │   │  MedicalRecordRegistry     │
│  - Encrypted records │   │  - anchorRoot()            │
│  - Merkle proofs     │   │  - getRoot()               │
│  - Wallet roles      │   │                            │
│  - ZK claim audit    │   │  SelectiveDisclosure       │
│  - SMT snapshots     │   │  VerifierManager           │
└──────────────────────┘   │  - submitSelectiveClaim()  │
                           │  - Nullifier replay guard  │
                           └───────────────────────────┘
```

**Cryptographic stack:**
- Record storage: `AES-256-GCM` (key = `SHA256(patient_wallet_address)`)
- Integrity: `SHA-256 Merkle tree` anchored on-chain
- Authentication: `EIP-712` typed-data signatures (doctor + patient)
- ZK proofs: `Groth16` with `Circom 2.1.6` + `snarkjs`, Poseidon hashing

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Variables](#environment-variables)
3. [Smart Contract Module](#1-smart-contract-module)
4. [Backend Module](#2-backend-module-fastapi)
5. [Frontend Module](#3-frontend-module-react)
6. [Circuits & ZK Artifacts](#4-circuits--zk-artifacts)
7. [Selective Disclosure](#5-selective-disclosure)
8. [Database Schema](#database-schema)
9. [API Reference](#api-reference)
10. [Security & Design Notes](#security--design-notes)
11. [User Flows](#user-flows)
12. [Deployment](#deployment)

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 20 |
| Python | ≥ 3.11 |
| Docker + Docker Compose | Any recent version |
| `circom` | 2.1.6 (for circuit builds) |
| MetaMask | Browser extension |

---

## Environment Variables

### Root `.env`

```env
# Sepolia RPC (Alchemy, Infura, etc.)
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<YOUR_KEY>

# Wallet used for deployments
DEPLOYER_PRIVATE_KEY=<your-private-key>

# Deployed contract addresses
CONTRACT_ADDRESS=0x1e325e9243dc886026342d8628A4465bdB50d46C
SELECTIVE_MANAGER_ADDRESS=<deployed-manager-address>

# Optional: base Groth16 verifier addresses (if pre-deployed)
HAS_CATEGORY_GROTH16_VERIFIER_ADDRESS=
LAB_IN_RANGE_GROTH16_VERIFIER_ADDRESS=
NO_DISEASE_GROTH16_VERIFIER_ADDRESS=

# Optional: manager owner if different from deployer
SELECTIVE_OWNER_ADDRESS=
```

### `backend/.env`

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/medrecords
CONTRACT_ADDRESS=0x1e325e9243dc886026342d8628A4465bdB50d46C
SELECTIVE_MANAGER_ADDRESS=<deployed-manager-address>
SEPOLIA_CHAIN_ID=11155111
FRONTEND_ORIGIN=http://localhost:5173
```

### `frontend/.env`

```env
VITE_BACKEND_URL=http://localhost:8000
VITE_CONTRACT_ADDRESS=0x1e325e9243dc886026342d8628A4465bdB50d46C
VITE_SELECTIVE_MANAGER_ADDRESS=<deployed-manager-address>
```

---

## 1) Smart Contract Module

### Contracts

#### `MedicalRecordRegistry.sol`
Core registry for anchoring patient Merkle roots on-chain.

| Function | Access | Description |
|----------|--------|-------------|
| `anchorRoot(merkleRoot, patientAddress)` | Authorized doctors | Anchor a new Merkle root for a patient |
| `getRoot(patientAddress)` | Public | Retrieve latest anchored root |
| `addAuthorizedDoctor(doctor)` | Owner | Authorize a doctor wallet |
| `removeAuthorizedDoctor(doctor)` | Owner | Deauthorize a doctor wallet |

Events: `RootAnchored`, `DoctorAuthorizationUpdated`

#### `SelectiveDisclosureVerifierManager.sol`
Manages per-claim-type Groth16 verifiers and on-chain claim registration.

| Claim Type | ID | Description |
|------------|-----|-------------|
| `HAS_CATEGORY` | 1 | Prove patient has records in a medical category |
| `LAB_IN_RANGE` | 2 | Prove lab value is within a range (without revealing it) |
| `NO_DISEASE` | 3 | Prove patient has no record for a disease code (Sparse Merkle Tree) |

Security: nullifier-based replay protection, claim expiry, root consistency check against registry.

#### `Groth16VerifierAdapter.sol`
Adapter that translates snarkjs-encoded proof bytes into the Groth16 verifier ABI (9 public signals).

### Install & Test

```bash
npm install
npm run compile
npm run test
```

### Deploy to Sepolia

1. Copy `.env.example` to `.env` and fill `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY`.
2. Deploy the main registry:

```bash
npm run deploy:sepolia
```

3. Copy the output address into all three `.env` files:
   - Root `.env` → `CONTRACT_ADDRESS`
   - `backend/.env` → `CONTRACT_ADDRESS`
   - `frontend/.env` → `VITE_CONTRACT_ADDRESS`

### Deploy Selective Disclosure Contracts (Optional)

1. Ensure `CONTRACT_ADDRESS` points to the deployed `MedicalRecordRegistry`.
2. Optionally set `SELECTIVE_OWNER_ADDRESS` if the manager owner differs from the deployer.
3. Optionally pre-fill base Groth16 verifier addresses if already deployed.
4. Deploy:

```bash
npm run deploy:selective:sepolia
```

The script outputs `SELECTIVE_MANAGER_ADDRESS` and optional adapter addresses. Update all three `.env` files accordingly. If `SELECTIVE_OWNER_ADDRESS` differs from the deployer, the owner must call `setVerifier` manually to bind adapters.

---

## 2) Backend Module (FastAPI)

### Local Setup

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\Activate.ps1

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### Start PostgreSQL (Docker)

From the project root:

```bash
docker compose up -d postgres
```

This starts a PostgreSQL 16 container (`medrecords-postgres`) on port `5432` with:
- User: `user`, Password: `pass`, Database: `medrecords`

### Run the API Server

```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

API docs available at: http://localhost:8000/docs

### Run Everything via Docker

```bash
docker compose up -d
```

This starts both `postgres` and the `medrecords-backend` container (port `8000`).

---

## 3) Frontend Module (React)

### Setup & Run

```bash
cd frontend
npm install
npm run dev
```

Open: http://localhost:5173

### Pages

| Route | Role | Description |
|-------|------|-------------|
| `/doctor` | Doctor | Create encrypted records, anchor Merkle root, manage patient list |
| `/patient` | Patient | Decrypt records, verify integrity, generate share packages (JSON/QR/link) |
| `/verifier` | Verifier | Verify integrity from a patient-shared link or QR code |

### Wallet Role Routing

1. User connects MetaMask wallet.
2. App queries backend for the wallet's role.
3. Redirects automatically to the role-specific page.
4. New wallets see a one-time role selection screen; the role is persisted in the database.

### Key Frontend Services

| File | Description |
|------|-------------|
| `services/api.js` | Axios HTTP client for backend |
| `services/contract.js` | Smart contract calls via ethers.js v6 |
| `services/crypto.js` | AES-256-GCM encrypt/decrypt |
| `services/zkp.js` | ZK proof generation (snarkjs) |
| `services/merkle.js` | Merkle tree build and proof verification |
| `services/eip712.js` | EIP-712 typed-data signing |
| `services/verificationToken.js` | Encode/decode share links |

---

## 4) Circuits & ZK Artifacts

### Requirements

- `circom` 2.1.6 installed globally
- Node.js + npm

### Build Basic Proof Artifacts

```powershell
cd circuits
./build.ps1
```

Compiles `medical_proof.circom` and copies artifacts to:
- `frontend/public/zk/medical_proof.wasm`
- `frontend/public/zk/medical_proof_final.zkey`
- `frontend/public/zk/verification_key.json`

### Build Selective Disclosure Circuits (R1CS + SYM)

```powershell
cd circuits
./build-selective.ps1
```

Compiles:
- `selective_disclosure/has_category.circom`
- `selective_disclosure/lab_in_range.circom`

### Proving System Details

- Scheme: **Groth16**
- Powers of Tau: `powersOfTau28_hez_final_14.ptau`
- Hash function: **Poseidon** (via circomlibjs)
- Merkle tree depth: **20**
- Public signals: **9** — `[claimType, claimKeyA, claimKeyB, claimKeyC, root, patientCommitment, verifierScope, expiresAt, nullifier]`

---

## 5) Selective Disclosure

### Overview

Patients can generate ZK proofs for specific claims about their health data without revealing the underlying records.

### Claim Types

**`HAS_CATEGORY` (ID: 1)**
> Prove: "I have at least one medical record in category X"
- Private inputs: record data, Merkle path
- Public outputs: category hash, Merkle root, patient commitment, nullifier

**`LAB_IN_RANGE` (ID: 2)**
> Prove: "My lab value is between A and B"
- Private inputs: lab value, record data, Merkle path
- Public outputs: range bounds (hashed), Merkle root, patient commitment, nullifier

**`NO_DISEASE` (ID: 3)** *(planned)*
> Prove: "I have no record for disease code X" using Sparse Merkle Tree non-membership proof.

### Design Artifacts

| File | Description |
|------|-------------|
| `docs/selective-disclosure-blueprint.md` | Full specification: signals, commitments, nullifier strategy, security checklist |
| `docs/selective-disclosure-api-examples.json` | Prove/verify request-response payload examples |
| `contracts/SelectiveDisclosureVerifierManager.sol` | On-chain claim verifier dispatcher |
| `contracts/Groth16VerifierAdapter.sol` | snarkjs-to-Groth16-ABI adapter |

---

## Database Schema

```sql
-- Encrypted patient records with Merkle proofs
CREATE TABLE medical_records (
    id              SERIAL PRIMARY KEY,
    patient_address TEXT      NOT NULL,
    doctor_address  TEXT      NOT NULL,
    encrypted_data  TEXT      NOT NULL,
    leaf_hash       TEXT      NOT NULL,
    merkle_proof    JSONB,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- On-chain anchored Merkle roots
CREATE TABLE merkle_roots (
    id              SERIAL PRIMARY KEY,
    patient_address TEXT      NOT NULL,
    merkle_root     TEXT      NOT NULL,
    tx_hash         TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- One-time wallet role assignments
CREATE TABLE wallet_roles (
    id              SERIAL PRIMARY KEY,
    wallet_address  TEXT      NOT NULL UNIQUE,
    role            TEXT      NOT NULL,   -- 'doctor' | 'patient' | 'verifier'
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- Audit log for selective disclosure claims
CREATE TABLE selective_claim_audit_logs (
    id              SERIAL PRIMARY KEY,
    patient_address TEXT,
    claim_type      INT,
    nullifier       TEXT,
    tx_hash         TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Replay protection: consumed nullifiers
CREATE TABLE selective_nullifier_used (
    nullifier       TEXT PRIMARY KEY,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Sparse Merkle Tree snapshots for NO_DISEASE proofs
CREATE TABLE no_disease_smt_snapshots (
    id              SERIAL PRIMARY KEY,
    patient_address TEXT NOT NULL,
    root            TEXT NOT NULL,
    snapshot        JSONB,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE no_disease_smt_leaf_index (
    id              SERIAL PRIMARY KEY,
    patient_address TEXT NOT NULL,
    disease_code    TEXT NOT NULL,
    leaf_index      INT  NOT NULL
);

CREATE TABLE no_disease_smt_proof_cache (
    id              SERIAL PRIMARY KEY,
    patient_address TEXT NOT NULL,
    disease_code    TEXT NOT NULL,
    proof           JSONB,
    created_at      TIMESTAMP DEFAULT NOW()
);
```

---

## API Reference

### Records

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/records/create` | EIP-712 (doctor) | Create an encrypted medical record |
| `GET` | `/records/{patient_address}` | EIP-712 (patient) | Retrieve decrypted records for a patient |
| `GET` | `/records/public/{patient_address}` | None | Public Merkle verification package |
| `POST` | `/records/verify` | None | Verify a Merkle proof against on-chain root |
| `PATCH` | `/records/merkle_root/tx_hash` | EIP-712 (doctor) | Link an anchored TX hash to a Merkle root |

### Roles

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/roles/{wallet_address}` | None | Get the role for a wallet address |
| `POST` | `/roles` | EIP-712 | Set wallet role (one-time, irreversible) |

### Selective Disclosure

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/selective-disclosure/prove` | EIP-712 (patient) | Generate a ZK proof for a selective claim |
| `POST` | `/selective-disclosure/verify` | None | Verify a ZK proof off-chain |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check (returns `{"status": "ok"}`) |

Interactive docs: http://localhost:8000/docs

---

## Security & Design Notes

### Encryption

- **Key derivation:** `SHA256(lowercase(patient_wallet_address))`
- **Cipher:** AES-256-GCM (authenticated encryption)
- **Storage:** Database stores only ciphertext — plaintext never persists server-side

### Integrity

- Records are hashed as Merkle leaves
- Doctor anchors the Merkle root on-chain via `anchorRoot()`
- Any tamper in the off-chain database invalidates the Merkle proof
- Third parties verify by calling `getRoot(patient)` on-chain and re-running the proof

### Authentication

- All write operations require **EIP-712 typed-data signatures**
- Backend verifies signatures via `eth-account`
- Replay protection via nonces

### Zero-Knowledge Proofs

- Poseidon-based commitment: `commitment = Poseidon(patientAddress, secret)`
- Nullifier per claim: `nullifier = Poseidon(commitment, claimType, nonce)`
- Claims include expiry timestamp and verifier scope — proofs cannot be reused across verifiers

### Privacy

- Third-party verifiers receive only: `patient_address`, `leaf_hash`, `merkle_proof`, `merkle_root`, `tx_hash`
- Full plaintext never required for integrity verification
- Optional `zk_certificate.json` provides additional cryptographic assurance without revealing record contents

---

## User Flows

### Doctor

1. Connect wallet → set role as `doctor`
2. Fill out patient record form and submit (EIP-712 signature)
3. Backend encrypts and stores record; returns leaf hash + Merkle proof
4. When ready, click **Anchor Merkle Root** to send `anchorRoot()` on-chain
5. Backend stores the TX hash linked to the root

### Patient

1. Connect wallet → set role as `patient`
2. Load records (backend decrypts and returns plaintext)
3. Click **Verify Integrity** → app fetches on-chain root and validates Merkle proof
4. Click **Show QR Token** or **Copy Share Link** to produce a verification package
5. Optionally generate a **ZK Certificate** for privacy-preserving sharing

### Third-Party Verifier

1. Receive share link or scan QR code from patient
2. Open `/verifier` — app auto-loads the verification package from URL token
3. Click **Verify Package**
4. App calls `getRoot(patient_address)` on-chain and validates Merkle proof
5. Result: `VALID` (root matches + proof valid) or `INVALID`
6. Optionally validate `zk_certificate.json` for extra assurance

---

## Deployment

### Frontend (Vercel)

1. Connect the repository to Vercel.
2. Set root directory to `frontend`.
3. Add environment variables (`VITE_BACKEND_URL`, `VITE_CONTRACT_ADDRESS`, `VITE_SELECTIVE_MANAGER_ADDRESS`).
4. Push to `main` — Vercel deploys automatically.

### Backend (Fly.io via GitHub Actions)

1. Edit `backend/fly.toml` — set `app` to your Fly app name.
2. Create a Fly deploy token: `fly tokens create deploy`
3. Add `FLY_API_TOKEN` as a GitHub repository secret.
4. Set Fly runtime secrets:

```bash
fly secrets set DATABASE_URL=postgresql://...
fly secrets set CONTRACT_ADDRESS=0x...
fly secrets set SELECTIVE_MANAGER_ADDRESS=0x...
fly secrets set SEPOLIA_CHAIN_ID=11155111
fly secrets set FRONTEND_ORIGIN=https://your-app.vercel.app
```

5. Push to `main` — GitHub Actions workflow (`.github/workflows/deploy-backend-fly.yml`) deploys automatically when backend files change.

### Database (Supabase / Any PostgreSQL)

Set `DATABASE_URL` to any PostgreSQL 14+ connection string. The backend uses SQLAlchemy with `create_all()` on startup — tables are created automatically.

For production, Supabase (AWS ap-southeast-1) is recommended. Paste the pooler connection string as `DATABASE_URL`.
