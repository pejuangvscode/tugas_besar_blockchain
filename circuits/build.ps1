$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  Write-Host "==> $Label"
  Invoke-Expression $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed: $Label"
  }
}

# Build Groth16 artifacts and copy them into frontend/public/zk.
Push-Location $PSScriptRoot

try {
  if (!(Test-Path "build")) {
    New-Item -ItemType Directory -Path "build" | Out-Null
  }

  if (!(Test-Path "..\frontend\public\zk")) {
    New-Item -ItemType Directory -Path "..\frontend\public\zk" -Force | Out-Null
  }

  Invoke-Step -Command "npm install" -Label "Install circuit dependencies"

  if (Test-Path "powersOfTau28_hez_final_14.ptau") {
    Remove-Item "powersOfTau28_hez_final_14.ptau" -Force
  }
  if (Test-Path "build\medical_proof_0000.zkey") {
    Remove-Item "build\medical_proof_0000.zkey" -Force
  }
  if (Test-Path "build\medical_proof_final.zkey") {
    Remove-Item "build\medical_proof_final.zkey" -Force
  }

  Invoke-Step -Command "npm run ptau" -Label "Generate prepared powers of tau (.ptau)"

  Invoke-Step -Command "npm run compile" -Label "Compile circom circuit"
  Invoke-Step -Command "npm run setup" -Label "Generate initial zkey"
  Invoke-Step -Command "npm run contribute" -Label "Contribute final zkey"
  Invoke-Step -Command "npm run export:vkey" -Label "Export verification key"

  if (!(Test-Path "build\medical_proof_js\medical_proof.wasm")) {
    throw "Missing artifact: build\\medical_proof_js\\medical_proof.wasm"
  }
  if (!(Test-Path "build\medical_proof_final.zkey")) {
    throw "Missing artifact: build\\medical_proof_final.zkey"
  }
  if (!(Test-Path "build\verification_key.json")) {
    throw "Missing artifact: build\\verification_key.json"
  }

  Copy-Item "build\medical_proof_js\medical_proof.wasm" "..\frontend\public\zk\medical_proof.wasm" -Force
  Copy-Item "build\medical_proof_final.zkey" "..\frontend\public\zk\medical_proof_final.zkey" -Force
  Copy-Item "build\verification_key.json" "..\frontend\public\zk\verification_key.json" -Force

  Write-Output "Circuit artifacts copied to frontend/public/zk"
}
finally {
  Pop-Location
}