#!/usr/bin/env node
// Build the offline bundle that ships inside OpenMontage Studio, for THIS OS/arch:
//
//   vendor/<os>-<arch>/
//     runtime/python/      portable CPython 3.12 (python-build-standalone)
//     runtime/node/        Node.js 22 LTS (node, npm, npx)
//     runtime/bin/         ffmpeg + ffprobe
//     wheels/              every Python wheel OpenMontage needs (offline install)
//     engine/              OpenMontage source + remotion-composer/node_modules
//     models/              faster-whisper model for offline voice input (OM_BUNDLE_STT_MODEL=small|none)
//     bundle.json          versions + engine commit
//
// Usage: node scripts/bundle-engine.js [--force]
// Needs internet once. Run it on each target OS (wheels and binaries are platform specific).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = 'calesthio/OpenMontage';
const PY_MINOR = '3.12';
const NODE_MAJOR = 'v22';
const FORCE = process.argv.includes('--force');

const OS = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
const ARCH = process.arch; // arm64 | x64
const IS_WIN = process.platform === 'win32';
const OUT = path.join(__dirname, '..', 'vendor', `${OS}-${ARCH}`);
const RT = path.join(OUT, 'runtime');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'om-bundle-'));

const log = (...a) => console.log('[bundle]', ...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

async function get(url, asJson) {
  const headers = { 'User-Agent': 'openmontage-studio-bundler' };
  if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers, redirect: 'follow' });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return asJson ? r.json() : Buffer.from(await r.arrayBuffer());
}

async function download(url, file) {
  log('↓', url);
  fs.writeFileSync(file, await get(url));
  log('  ', (fs.statSync(file).size / 1048576).toFixed(1), 'MB');
  return file;
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // bsdtar (macOS, Windows 10+) handles .zip too; GNU tar handles .tar.gz/.tar.xz
  sh('tar', ['-xf', archive, '-C', dest]);
}

// ---------------- Python ----------------
async function python() {
  const dir = path.join(RT, 'python');
  if (fs.existsSync(pyBin()) && !FORCE) return log('python: present');
  const triple = {
    'mac-arm64': 'aarch64-apple-darwin', 'mac-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win-x64': 'x86_64-pc-windows-msvc', 'win-arm64': 'aarch64-pc-windows-msvc',
  }[`${OS}-${ARCH}`];
  const rel = await get('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', true);
  const re = new RegExp(`^cpython-${PY_MINOR.replace('.', '\\.')}\\.\\d+\\+\\d+-${triple}-install_only\\.tar\\.gz$`);
  const asset = rel.assets.find(a => re.test(a.name));
  if (!asset) throw new Error(`No python-build-standalone asset for ${triple} in ${rel.tag_name}`);
  const f = await download(asset.browser_download_url, path.join(TMP, asset.name));
  fs.rmSync(dir, { recursive: true, force: true });
  extract(f, RT); // archive root is python/
  log('python:', asset.name);
}
function pyBin() { return IS_WIN ? path.join(RT, 'python', 'python.exe') : path.join(RT, 'python', 'bin', 'python3'); }

// ---------------- Node ----------------
async function node() {
  const dir = path.join(RT, 'node');
  if (fs.existsSync(nodeBin()) && !FORCE) return log('node: present');
  const idx = await get('https://nodejs.org/dist/index.json', true);
  const v = idx.find(x => x.version.startsWith(NODE_MAJOR + '.')).version;
  const plat = { mac: 'darwin', linux: 'linux', win: 'win' }[OS];
  const name = `node-${v}-${plat}-${ARCH}`;
  const f = await download(`https://nodejs.org/dist/${v}/${name}.${IS_WIN ? 'zip' : 'tar.gz'}`, path.join(TMP, name + (IS_WIN ? '.zip' : '.tar.gz')));
  extract(f, TMP);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(path.join(TMP, name), dir);
  log('node:', v);
}
function nodeBin() { return IS_WIN ? path.join(RT, 'node', 'node.exe') : path.join(RT, 'node', 'bin', 'node'); }
function npmCli() { return IS_WIN ? path.join(RT, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js') : path.join(RT, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'); }
function npm(args, cwd) { sh(nodeBin(), [npmCli(), ...args], { cwd, env: bundleEnv() }); }
function bundleEnv() {
  const sep = IS_WIN ? ';' : ':';
  const bins = [IS_WIN ? path.join(RT, 'node') : path.join(RT, 'node', 'bin'), path.join(RT, 'bin')];
  return { ...process.env, PATH: bins.join(sep) + sep + process.env.PATH };
}

// ---------------- ffmpeg / ffprobe ----------------
async function ffmpeg() {
  const bin = path.join(RT, 'bin');
  const exe = IS_WIN ? '.exe' : '';
  if (fs.existsSync(path.join(bin, 'ffmpeg' + exe)) && fs.existsSync(path.join(bin, 'ffprobe' + exe)) && !FORCE) return log('ffmpeg: present');
  fs.mkdirSync(bin, { recursive: true });
  const work = path.join(TMP, 'ff');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"ff","private":true}');
  npm(['install', 'ffmpeg-static', 'ffprobe-static', '--no-audit', '--no-fund', '--ignore-scripts'], work);
  // ffmpeg-static fetches its binary in an install script (blocked by npm 12) — run it ourselves.
  sh(nodeBin(), ['install.js'], { cwd: path.join(work, 'node_modules', 'ffmpeg-static'), env: bundleEnv() });
  const ffm = require(path.join(work, 'node_modules', 'ffmpeg-static'));
  const ffp = require(path.join(work, 'node_modules', 'ffprobe-static')).path;
  fs.copyFileSync(ffm, path.join(bin, 'ffmpeg' + exe));
  fs.copyFileSync(ffp, path.join(bin, 'ffprobe' + exe));
  if (!IS_WIN) { fs.chmodSync(path.join(bin, 'ffmpeg'), 0o755); fs.chmodSync(path.join(bin, 'ffprobe'), 0o755); }
  log('ffmpeg:', execFileSync(path.join(bin, 'ffmpeg' + exe), ['-version']).toString().split('\n')[0]);
}

// ---------------- OpenMontage engine ----------------
async function engine() {
  const dir = path.join(OUT, 'engine');
  const commit = await get(`https://api.github.com/repos/${REPO}/commits/HEAD`, true);
  const sha = commit.sha;
  const meta = readMeta();
  if (fs.existsSync(path.join(dir, 'AGENT_GUIDE.md')) && meta.engine && meta.engine.sha === sha && !FORCE) { log('engine: up to date', sha.slice(0, 7)); return meta.engine; }
  const f = await download(`https://codeload.github.com/${REPO}/tar.gz/${sha}`, path.join(TMP, 'engine.tar.gz'));
  const x = path.join(TMP, 'engine');
  extract(f, x);
  const top = path.join(x, fs.readdirSync(x)[0]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(top, dir);
  log('engine:', sha.slice(0, 7), commit.commit.committer.date);
  return { sha, date: commit.commit.committer.date, repo: REPO };
}

async function remotion() {
  const rc = path.join(OUT, 'engine', 'remotion-composer');
  if (!fs.existsSync(path.join(rc, 'package.json'))) return;
  log('remotion-composer: npm install');
  npm(['install', '--no-audit', '--no-fund'], rc);
  const esb = path.join(rc, 'node_modules', 'esbuild', 'install.js');
  if (fs.existsSync(esb)) { try { sh(nodeBin(), [esb], { cwd: path.dirname(esb), env: bundleEnv() }); } catch { log('esbuild install.js skipped'); } }
  // Pre-download the headless Chrome that Remotion renders with, so the first render works offline.
  try { sh(nodeBin(), [path.join(rc, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'), 'browser', 'ensure'], { cwd: rc, env: bundleEnv() }); }
  catch { log('remotion browser ensure skipped (will download on first render)'); }
}

// ---------------- Python wheels (offline install on first launch) ----------------
async function wheels() {
  const dir = path.join(OUT, 'wheels');
  const req = path.join(OUT, 'engine', 'requirements.txt');
  fs.mkdirSync(dir, { recursive: true });
  log('pip download → wheels/');
  sh(pyBin(), ['-m', 'pip', 'download', '--only-binary=:all:', '--prefer-binary', '-d', dir, '-r', req, 'piper-tts', 'faster-whisper', 'edge-tts', 'mcp', 'pip', 'setuptools', 'wheel'], { env: bundleEnv() });
  // Some packages publish only sdists — build wheels for anything pip couldn't fetch as binary.
  log('wheels:', fs.readdirSync(dir).length, 'files');
}

// ---------------- Whisper model for offline voice input ----------------
async function sttModel() {
  const name = process.env.OM_BUNDLE_STT_MODEL || 'small';
  if (name === 'none') return null;
  const dest = path.join(OUT, 'models', 'faster-whisper-' + name);
  if (fs.existsSync(path.join(dest, 'model.bin')) && !FORCE) { log('whisper model: present', name); return name; }
  const venv = path.join(TMP, 'hfvenv');
  sh(pyBin(), ['-m', 'venv', venv]);
  const vpy = IS_WIN ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  sh(vpy, ['-m', 'pip', 'install', '-q', 'huggingface_hub']);
  fs.mkdirSync(dest, { recursive: true });
  log('whisper model: downloading', name);
  sh(vpy, ['-c', `from huggingface_hub import snapshot_download; snapshot_download("Systran/faster-whisper-${name}", local_dir=${JSON.stringify(dest)})`]);
  fs.rmSync(path.join(dest, '.cache'), { recursive: true, force: true });
  return name;
}

function readMeta() { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'bundle.json'), 'utf8')); } catch { return {}; } }

(async () => {
  if (!OS) throw new Error('Unsupported platform ' + process.platform);
  log('target', `${OS}-${ARCH}`, '→', OUT);
  fs.mkdirSync(RT, { recursive: true });
  await python();
  await node();
  await ffmpeg();
  const eng = await engine();
  await remotion();
  try { await wheels(); }
  catch (e) {
    // fall back to allowing source builds for the odd sdist-only package
    log('binary-only download failed, retrying with sdists allowed:', e.message);
    sh(pyBin(), ['-m', 'pip', 'wheel', '-w', path.join(OUT, 'wheels'), '-r', path.join(OUT, 'engine', 'requirements.txt'), 'piper-tts'], { env: bundleEnv() });
  }
  let stt = null;
  try { stt = await sttModel(); } catch (e) { log('whisper model skipped:', e.message); }
  const pyv = execFileSync(pyBin(), ['--version']).toString().trim();
  const nodev = execFileSync(nodeBin(), ['--version']).toString().trim();
  const meta = { builtAt: new Date().toISOString(), target: `${OS}-${ARCH}`, python: pyv, node: nodev, engine: eng, sttModel: stt };
  fs.writeFileSync(path.join(OUT, 'bundle.json'), JSON.stringify(meta, null, 2));
  fs.rmSync(TMP, { recursive: true, force: true });
  log('✅ bundle ready:', JSON.stringify(meta));
})().catch((e) => { console.error('[bundle] ✗', e.message); process.exit(1); });
