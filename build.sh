#!/usr/bin/env bash
# OpenMontage Studio — build installers (macOS / Linux). Windows: use build.ps1
#   ./build.sh            → builds for the current OS
#   ./build.sh mac|linux|win|all
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "❌ Node.js 18+ is required: https://nodejs.org"; exit 1; }
echo "✅ Node $(node -v)"
echo "📦 Installing dependencies…"
npm install --no-audit --no-fund
node scripts/check.js
case "${1:-auto}" in
  mac)   npx electron-builder --mac ;;
  linux) npx electron-builder --linux ;;
  win)   npx electron-builder --win ;;
  all)   npx electron-builder --mac --linux --win ;;
  *)     npx electron-builder ;;
esac
echo "✅ Done. Installers are in dist/"
