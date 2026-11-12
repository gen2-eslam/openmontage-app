#!/bin/zsh -l
# OpenMontage Studio — dev run: installs deps and starts the app, logging to logs/
cd "$(dirname "$0")"
mkdir -p logs
{
  echo "=== $(date) ==="
  echo "node: $(command -v node) $(node -v 2>&1)"
  echo "npm:  $(command -v npm) $(npm -v 2>&1)"
  echo "arch: $(uname -m)  macOS: $(sw_vers -productVersion 2>/dev/null)"
} > logs/env.log 2>&1
echo "▶ npm install…"
npm install --no-audit --no-fund > logs/install.log 2>&1
echo "install exit: $?" >> logs/install.log
node scripts/postinstall.js >> logs/install.log 2>&1
echo "postinstall exit: $?" >> logs/install.log
if [ ! -f "vendor/$( [ "$(uname)" = Darwin ] && echo mac || echo linux )-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/bundle.json" ]; then
  echo "▶ Building the offline engine bundle (first time only, a few minutes)…"
  node scripts/bundle-engine.js > logs/bundle.log 2>&1
  echo "bundle exit: $?" >> logs/bundle.log
fi
echo "▶ npm start (logs/start.log)…"
OM_DEBUG=1 npm start > logs/start.log 2>&1
echo "start exit: $?" >> logs/start.log
