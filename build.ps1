# OpenMontage Studio — build the Windows installer (run in PowerShell)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "Node.js 18+ is required: https://nodejs.org"; exit 1 }
Write-Host "Node $(node -v)"
npm install --no-audit --no-fund
node scripts/check.js
npx electron-builder --win
Write-Host "Done. Installer is in dist\"
