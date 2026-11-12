// Quick sanity check: syntax of every source file + agent parser smoke test.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(path.join(__dirname, '..', 'src'));
for (const f of files) execFileSync(process.execPath, ['--check', f]);
const { makeParser } = require('../src/main/agents');
const ev = [];
makeParser('claude-stream', e => ev.push(e))(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
if (ev[0].text !== 'ok') throw new Error('parser broken');
console.log(`✓ ${files.length} files OK`);
