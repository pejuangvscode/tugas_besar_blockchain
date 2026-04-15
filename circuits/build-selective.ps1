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

Push-Location $PSScriptRoot

try {
  if (!(Test-Path "build")) {
    New-Item -ItemType Directory -Path "build" | Out-Null
  }

  if (!(Test-Path "build\selective_disclosure")) {
    New-Item -ItemType Directory -Path "build\selective_disclosure" | Out-Null
  }

  Invoke-Step -Command "npm install" -Label "Install circuit dependencies"

  Invoke-Step `
    -Command "npx circom2 selective_disclosure/has_category.circom --r1cs --sym -o build -l ./node_modules -l ./selective_disclosure" `
    -Label "Compile has_category circuit"

  Invoke-Step `
    -Command "npx circom2 selective_disclosure/lab_in_range.circom --r1cs --sym -o build -l ./node_modules -l ./selective_disclosure" `
    -Label "Compile lab_in_range circuit"

  Write-Output "Selective disclosure circuit skeletons compiled to build/selective_disclosure"
}
finally {
  Pop-Location
}
