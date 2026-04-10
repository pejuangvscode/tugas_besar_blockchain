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
4. Commit and push to `main`.
5. GitHub Actions workflow [ .github/workflows/deploy-backend-fly.yml ](.github/workflows/deploy-backend-fly.yml) will deploy backend automatically.

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

## API Endpoints

- `POST /records/create`
- `GET /records/{patient_address}`
- `POST /records/verify`
- `PATCH /records/merkle_root/tx_hash`

## Security/Design Notes

- Encryption key derivation: `SHA256(patient_wallet_address)`
- Cipher: `AES-256-GCM`
- Database stores encrypted JSON only
- Merkle root anchored on Sepolia by authorized doctor wallets
- EIP-712 signatures enforced in backend for doctor and patient auth
- ZK certificate proves Poseidon relationship for private preimage knowledge

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
```
