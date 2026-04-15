# Sovereign Medical Records DApp

A full-stack decentralized app for sovereign medical records with:

- React + Vite + Tailwind + ethers.js + MetaMask
- FastAPI + PostgreSQL
- Ethereum Sepolia smart contract anchoring
- Merkle integrity proofs
- zk-SNARK client-side certificate generation with Circom + snarkjs

## 1) Smart Contract Module

### Install and test

```bash
npm install
npm run compile
npm run test
```

### Deploy to Sepolia

1. Copy `.env.example` to `.env` in project root.
2. Set `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY`.
3. Deploy:

```bash
npm run deploy:sepolia
```

4. Copy deployed address into:
- `.env` as `CONTRACT_ADDRESS`
- `frontend/.env` as `VITE_CONTRACT_ADDRESS`
- `backend/.env` as `CONTRACT_ADDRESS`

### Deploy Selective Disclosure Contracts (Optional, for new selective flow)

Use this only when enabling selective disclosure claim verification.

1. Ensure `CONTRACT_ADDRESS` (or `REGISTRY_ADDRESS`) points to deployed `MedicalRecordRegistry`.
2. (Optional) Set `SELECTIVE_OWNER_ADDRESS` if manager owner is not the deployer wallet.
3. (Optional) Set base Groth16 verifier addresses if already deployed:
   - `HAS_CATEGORY_GROTH16_VERIFIER_ADDRESS`
   - `LAB_IN_RANGE_GROTH16_VERIFIER_ADDRESS`
   - `NO_DISEASE_GROTH16_VERIFIER_ADDRESS`
4. Deploy selective contracts:

```bash
npm run deploy:selective:sepolia
```

Deployment output includes:
- `SELECTIVE_MANAGER_ADDRESS`
- optional adapter addresses per claim type

If `SELECTIVE_OWNER_ADDRESS` differs from deployer address, adapter binding (`setVerifier`) must be executed by owner wallet.

After deployment, update runtime envs/secrets as needed:
- Root `.env`: keep `CONTRACT_ADDRESS`, add `SELECTIVE_MANAGER_ADDRESS`
- `backend/.env`: keep `CONTRACT_ADDRESS`, add `SELECTIVE_MANAGER_ADDRESS`
- `frontend/.env`: keep `VITE_CONTRACT_ADDRESS`, add `VITE_SELECTIVE_MANAGER_ADDRESS` (if frontend integration uses manager)

## 2) Backend Module (FastAPI)

### Setup

```bash
cd backend
python -m venv .venv
. .venv/Scripts/Activate.ps1
pip install -r requirements.txt
```

### Run with local Postgres (Docker)

From project root:

```bash
docker compose up -d postgres
```

### Run API

```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

API docs:
- http://localhost:8000/docs

### Deploy Backend via GitHub to Fly.io

1. Edit [backend/fly.toml](backend/fly.toml) and set `app` to your Fly app name.
2. Create a Fly API token:
   - `fly tokens create deploy`
3. Add repository secret in GitHub:
   - Name: `FLY_API_TOKEN`
   - Value: your Fly deploy token
4. Set Fly runtime secrets (once) so backend can boot in production:
   - `fly secrets set DATABASE_URL=...`
   - `fly secrets set CONTRACT_ADDRESS=...`
   - `fly secrets set SEPOLIA_CHAIN_ID=11155111`
   - `fly secrets set FRONTEND_ORIGIN=https://your-vercel-domain.vercel.app`
5. Commit and push to `main`.
6. GitHub Actions workflow [.github/workflows/deploy-backend-fly.yml](.github/workflows/deploy-backend-fly.yml) will deploy backend automatically.

The workflow deploys only when backend files or the workflow file itself changes.

## 3) Frontend Module (React)

### Setup and run

```bash
cd frontend
npm install
npm run dev
```

Open:
- http://localhost:5173

Available UI pages:
- `/doctor` → Doctor Page (create record, anchor Merkle root, quick patient list)
- `/patient` → Patient Page (load/decrypt records, integrity verify, share package as JSON/QR/link)
- `/verifier` → Third-Party Verifier Page (single flow: verify from patient shared link)

Wallet role routing:
- User connects wallet first.
- App reads wallet role from backend (`doctor`, `patient`, `verifier`).
- User is redirected automatically to role page.
- If wallet has no role yet, app shows a one-time role selection and stores it in database.

## 4) Circuit + ZK Artifacts

### Requirements

- `circom` installed globally
- Node.js + npm

### Build artifacts and copy to frontend

```powershell
cd circuits
./build.ps1
```

This produces and copies:
- `frontend/public/zk/medical_proof.wasm`
- `frontend/public/zk/medical_proof_final.zkey`
- `frontend/public/zk/verification_key.json`

## 5) Selective Disclosure Blueprint (New)

This repository now includes implementation-ready selective disclosure design artifacts:

- Blueprint spec: `docs/selective-disclosure-blueprint.md`
   - Exact private/public signal model
   - Commitment and nullifier strategy
   - Contract verification flow template
- API examples: `docs/selective-disclosure-api-examples.json`
   - Prove/verify request-response payload templates
- Solidity template: `contracts/SelectiveDisclosureVerifierManager.sol`
   - Claim-type verifier dispatch
   - Root consistency check against `MedicalRecordRegistry`
   - Nullifier replay protection
- Groth16 adapter template: `contracts/Groth16VerifierAdapter.sol`
   - Adapts snarkjs-style proof bytes into fixed Groth16 verifier ABI

Selective circuit skeleton compile (R1CS + SYM):

```powershell
cd circuits
./build-selective.ps1
```

## API Endpoints

- `POST /records/create`
- `GET /records/{patient_address}`
- `GET /records/public/{patient_address}`
- `POST /records/verify`
- `PATCH /records/merkle_root/tx_hash`
- `POST /selective-disclosure/prove` (stub)
- `POST /selective-disclosure/verify` (stub)

## Security/Design Notes

- Encryption key derivation: `SHA256(patient_wallet_address)`
- Cipher: `AES-256-GCM`
- Database stores encrypted JSON only
- Merkle root anchored on Sepolia by authorized doctor wallets
- EIP-712 signatures enforced in backend for doctor and patient auth
- ZK certificate proves Poseidon relationship for private preimage knowledge

## Third-Party Verification Use Case (Insurance / External Party)

This project also supports a practical verification scenario for third parties (for example insurance companies or external auditors) with patient consent.

### Goal

Allow third parties to verify that patient data commitment is valid and untampered, without requiring full trust in backend storage.

### Verification package (shared by patient)

- `patient_address`
- `leaf_hash`
- `merkle_proof`
- `merkle_root`
- `tx_hash` (recommended for audit)
- Optional: `zk_certificate.json` for additional off-chain ZKP validation

### How to use in UI

1. Patient opens `/patient` and loads records.
2. Patient clicks `Show QR Token`.
3. Third party scans QR (or opens shared verifier link).
4. Verifier page auto-loads package from URL token.
5. Third party clicks `Verify Package`.
6. App checks on-chain root via smart contract `getRoot(patient)` and validates Merkle proof.

### Validation logic

1. Third party calls `getRoot(patient_address)` from smart contract.
2. Compare returned `onChainRoot` with shared `merkle_root`.
3. Verify Merkle proof using `leaf_hash`, `merkle_proof`, and `onChainRoot`.
4. Mark result as `VALID` only if both root comparison and proof verification pass.
5. Optionally validate `zk_certificate.json` using `verification_key.json` for extra cryptographic assurance.

### Privacy note

For integrity verification, third party does not need full plaintext medical records. Patient can share minimum data required for proof validation.

## Database DDL (PostgreSQL)

```sql
CREATE TABLE medical_records (
  id SERIAL PRIMARY KEY,
  patient_address TEXT NOT NULL,
  doctor_address TEXT NOT NULL,
  encrypted_data TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  merkle_proof JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE merkle_roots (
  id SERIAL PRIMARY KEY,
  patient_address TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  tx_hash TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE wallet_roles (
   id SERIAL PRIMARY KEY,
   wallet_address TEXT NOT NULL UNIQUE,
   role TEXT NOT NULL,
   created_at TIMESTAMP DEFAULT NOW(),
   updated_at TIMESTAMP DEFAULT NOW()
);
```