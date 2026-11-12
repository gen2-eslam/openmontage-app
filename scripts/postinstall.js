// Runs after `npm install`. Newer npm versions skip dependency install scripts,
// so Electron's binary download (and native rebuilds) may never happen. Do it here.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');

function electronOk() {
  try {
    const p = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
    return fs.existsSync(path.join(electronDir, 'dist', p));
  } catch { return false; }
}

if (fs.existsSync(electronDir) && !electronOk()) {
  console.log('[postinstall] Downloading the Electron binary…');
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], { cwd: electronDir, stdio: 'inherit' });
  console.log(electronOk() ? '[postinstall] Electron ready.' : '[postinstall] Electron download did not complete.');
} else if (electronOk()) {
  console.log('[postinstall] Electron binary present.');
}

// node-pty (optional interactive terminal) must match Electron's ABI. Best-effort only.
if (fs.existsSync(path.join(root, 'node_modules', 'node-pty')) && !process.env.OM_SKIP_REBUILD) {
  try {
    const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
    if (fs.existsSync(bin)) {
      console.log('[postinstall] Rebuilding native modules for Electron (node-pty)…');
      execFileSync(bin, ['install-app-deps'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    }
  } catch (e) {
    console.log('[postinstall] node-pty rebuild skipped — the in-app terminal will be disabled. (' + e.message.split('\n')[0] + ')');
  }
}
