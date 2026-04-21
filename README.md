# RAPHA Medical - Sovereign Medical Records DApp

RAPHA Medical adalah aplikasi hybrid Web2 + Web3 untuk rekam medis terenkripsi dengan jaminan integritas on-chain.

Project ini menggabungkan:
- Frontend React (Doctor, Patient, Insurance Verifier)
- Backend FastAPI + PostgreSQL (penyimpanan terenkripsi, Merkle proof, audit)
- Smart contract Solidity di Ethereum Sepolia (anchoring Merkle root)
- Zero-knowledge proof (Groth16) untuk sertifikat berbagi data secara privat

## Ringkasan Alur

1. Doctor membuat record medis untuk patient.
2. Backend mengenkripsi data (AES-256-GCM), menghitung leaf hash, dan membangun Merkle tree.
3. Doctor meng-anchoring Merkle root ke contract `MedicalRecordRegistry` di Sepolia.
4. Patient memuat record miliknya, dekripsi di browser, lalu verifikasi integritas terhadap root on-chain.
5. Patient dapat menghasilkan paket verifikasi (link/QR/token) dan sertifikat ZKP untuk insurance verifier.
6. Verifier memverifikasi paket dengan membandingkan proof terhadap root on-chain.

## Fitur Utama

### Doctor (`/doctor`)
- Input raw medical text + structured claim (diagnosis/category/lab).
- Sign request dengan EIP-712.
- Create encrypted record via backend.
- Anchor latest Merkle root ke Sepolia.
- Simpan tx hash anchoring ke backend.

### Patient (`/patient`)
- Load record dengan auth EIP-712.
- Dekripsi data secara client-side.
- Verifikasi Merkle proof terhadap `getRoot(patient)` di contract.
- Generate patient certificate (Groth16, client-side).
- Export verification package dan generate QR/link/token untuk verifier.

### Insurance Verifier (`/verifier`)
- Load certificate/package dari token, link, atau QR image.
- Ambil root terbaru on-chain (read-only provider).
- Verifikasi integritas package (Merkle proof + root match).

## Tech Stack

- Frontend: React 18, Vite 5, Tailwind CSS, ethers v6, snarkjs, circomlibjs
- Backend: FastAPI, SQLAlchemy 2, psycopg2, cryptography, eth-account
- Database: PostgreSQL (lokal via Docker, production di Supabase)
- Smart Contract: Solidity 0.8.24, Hardhat
- ZKP: Circom 2.1.6, Groth16, snarkjs

## Struktur Project

```text
.
|- contracts/
|  |- MedicalRecordRegistry.sol
|  |- SelectiveDisclosureVerifierManager.sol
|  |- Groth16VerifierAdapter.sol
|- scripts/
|  |- deploy.js
|  |- deploy-selective.js
|- test/
|  |- MedicalRecordRegistry.test.js
|- backend/
|  |- main.py
|  |- routes/
|  |  |- records.py
|  |  |- roles.py
|  |  |- selective_disclosure.py
|  |- services/
|  |  |- auth.py
|  |  |- crypto.py
|  |  |- merkle.py
|  |- models/database.py
|  |- schema.sql
|  |- Dockerfile
|  |- fly.toml
|- frontend/
|  |- src/
|  |  |- pages/
|  |  |  |- DoctorDashboard.jsx
|  |  |  |- PatientDashboard.jsx
|  |  |  |- ThirdPartyVerifierPage.jsx
|  |  |- services/
|  |  |  |- api.js
|  |  |  |- contract.js
|  |  |  |- crypto.js
|  |  |  |- merkle.js
|  |  |  |- eip712.js
|  |  |  |- zkp.js
|  |- public/zk/
|- circuits/
|  |- medical_proof.circom
|  |- build.ps1
|  |- build-selective.ps1
|- docker-compose.yml
|- hardhat.config.js
```

## Prerequisites

- Node.js >= 20
- Python >= 3.11
- Docker + Docker Compose (untuk PostgreSQL lokal)
- MetaMask extension
- (Opsional) Circom 2.1.6 jika ingin rebuild artefak ZKP

## Environment Variables

Gunakan nilai yang konsisten antara frontend dan backend untuk `CONTRACT_ADDRESS` dan chain ID.

### Root `.env` (Hardhat / deploy scripts)

```env
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your_key
DEPLOYER_PRIVATE_KEY=your_private_key

# Dipakai oleh deploy-selective.js (fallback)
CONTRACT_ADDRESS=0x...
REGISTRY_ADDRESS=0x...

# Optional selective deployment
SELECTIVE_OWNER_ADDRESS=0x...
HAS_CATEGORY_GROTH16_VERIFIER_ADDRESS=0x...
LAB_IN_RANGE_GROTH16_VERIFIER_ADDRESS=0x...
NO_DISEASE_GROTH16_VERIFIER_ADDRESS=0x...
```

### `backend/.env`

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/medrecords
FRONTEND_ORIGIN=http://localhost:5173
CONTRACT_ADDRESS=0x...
SEPOLIA_CHAIN_ID=11155111
SELECTIVE_MANAGER_ADDRESS=0x...
```

Catatan:
- `FRONTEND_ORIGIN` bisa diisi lebih dari satu origin dengan format comma-separated.
- Backend memuat `backend/.env` terlebih dahulu, lalu root `.env` sebagai fallback.

### `frontend/.env`

```env
VITE_BACKEND_URL=http://localhost:8000
VITE_CONTRACT_ADDRESS=0x...
VITE_SEPOLIA_CHAIN_ID=11155111
VITE_SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your_key
```

## Menjalankan Project (Local)

### 1) Smart Contract Dependencies

```bash
npm install
```

### 2) Jalankan PostgreSQL (Docker)

```bash
docker compose up -d postgres
```

Default DB lokal:
- host: `localhost`
- port: `5432`
- user: `user`
- password: `pass`
- db: `medrecords`

### 3) Jalankan Backend

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\Activate.ps1

# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Backend docs: `http://localhost:8000/docs`

### 4) Jalankan Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend URL: `http://localhost:5173`

## Smart Contract Module

### Contract Utama

- `MedicalRecordRegistry.sol`
  - `anchorRoot(bytes32,address)`
  - `getRoot(address)`
  - `addAuthorizedDoctor(address)`
  - `removeAuthorizedDoctor(address)`

- `SelectiveDisclosureVerifierManager.sol`
  - Mengelola verifier per claim type
  - Menyimpan nullifier used (replay protection)
  - Validasi sinyal publik terhadap root on-chain

- `Groth16VerifierAdapter.sol`
  - Adapter proof snarkjs ke ABI verifier Groth16 9 public signals

### Compile, Test, Deploy

```bash
npm run compile
npm run test
npm run deploy:sepolia
```

Deploy selective manager (opsional):

```bash
npm run deploy:selective:sepolia
```

Penting:
- Doctor wallet harus di-authorize dulu oleh owner contract sebelum dapat memanggil `anchorRoot`.

## Backend API Ringkas

### Records

| Method | Endpoint | Keterangan |
|---|---|---|
| POST | `/records/create` | Buat encrypted record + hitung Merkle root/proof |
| GET | `/records/{patient_address}` | Ambil record patient (butuh query `signature` + `nonce`) |
| GET | `/records/public/{patient_address}` | Ambil package publik untuk verifikasi |
| POST | `/records/verify` | Verifikasi Merkle proof off-chain |
| PATCH | `/records/merkle_root/tx_hash` | Simpan tx hash anchoring |

### Roles

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/roles/wallet/{wallet_address}` | Ambil role wallet |
| GET | `/roles/patients` | Daftar wallet patient terdeteksi |
| POST | `/roles/upsert` | Set/update role wallet dengan EIP-712 |

### Selective Disclosure

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/selective-disclosure/audit` | Ambil audit log klaim selective disclosure |
| POST | `/selective-disclosure/prove` | Generate payload klaim selective disclosure |
| POST | `/selective-disclosure/verify` | Verifikasi payload selective disclosure |

### System

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/health` | Health check |

## Database

Schema SQL ada di:
- `backend/schema.sql`

ERD Mermaid ada di:
- `docs/database-erd.md`

Tabel utama yang digunakan aplikasi:
- `medical_records`
- `merkle_roots`
- `wallet_roles`
- `selective_claim_audit_logs`
- `selective_nullifier_used`
- `no_disease_smt_snapshots`
- `no_disease_smt_leaf_index`
- `no_disease_smt_proof_cache`

## ZKP Artifacts

Artefak yang dipakai frontend ada di:
- `frontend/public/zk/medical_proof.wasm`
- `frontend/public/zk/medical_proof_final.zkey`
- `frontend/public/zk/verification_key.json`

Rebuild artefak basic proof:

```powershell
cd circuits
./build.ps1
```

Compile selective circuits skeleton:

```powershell
cd circuits
./build-selective.ps1
```

Catatan:
- `selective_disclosure` circuits saat ini masih skeleton untuk iterasi.

## Deployment

### Frontend (Vercel)

- Root project di Vercel: `frontend`
- Build command: `npm run build`
- Pastikan env frontend sudah diset
- `frontend/vercel.json` sudah menangani SPA rewrite ke `index.html`

### Backend (Fly.io)

- Konfigurasi ada di `backend/fly.toml`
- CI deploy ada di `.github/workflows/deploy-backend-fly.yml`
- Workflow trigger saat push ke `main` pada path:
  - `backend/**`
  - `.github/workflows/deploy-backend-fly.yml`

Set secret GitHub:
- `FLY_API_TOKEN`

Set Fly runtime secrets minimal:
- `DATABASE_URL`
- `FRONTEND_ORIGIN`
- `CONTRACT_ADDRESS`
- `SEPOLIA_CHAIN_ID`
- (opsional) `SELECTIVE_MANAGER_ADDRESS`

## Catatan Implementasi Penting

- EIP-712 domain name: `SovereignMedicalRecords`
- Default chain ID: `11155111` (Sepolia)
- Kunci AES diturunkan dari `sha256(lowercase(patient_address))`
- Frontend verifier page sekarang fokus pada verifikasi package patient (token/link/QR)
- Endpoint selective disclosure `verify` masih melakukan validasi struktural/stub untuk flow saat ini

## Referensi Dokumentasi Internal

- Topologi sistem: `docs/system-topology-diagram.md`
- ERD database: `docs/database-erd.md`
- Blueprint selective disclosure: `docs/selective-disclosure-blueprint.md`
- Contoh payload selective disclosure API: `docs/selective-disclosure-api-examples.json`
