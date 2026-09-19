#!/usr/bin/env node
// Copies this core version into a product repo: node scripts/sync.js ../meowmarism-lite
// The product commits the result, so its release tarball is complete without any submodule.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const target = process.argv[2];
if (!target || !fs.existsSync(path.join(target, 'panel'))) {
  console.error('usage: node scripts/sync.js <product repo folder containing panel/>');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const dest = path.join(path.resolve(target), 'panel', 'core');
const SOURCES = ['brand', 'tokens'];

fs.rmSync(dest, { recursive: true, force: true });
const files = [];
function copy(rel) {
  const from = path.join(root, rel);
  if (fs.statSync(from).isDirectory()) { for (const f of fs.readdirSync(from)) copy(path.join(rel, f)); return; }
  fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
  fs.copyFileSync(from, path.join(dest, rel));
  files.push(rel.split(path.sep).join('/'));
}
SOURCES.forEach(copy);

let commit = null;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); } catch (_) {}
const version = require(path.join(root, 'package.json')).version;
fs.writeFileSync(path.join(path.resolve(target), 'core.lock'), JSON.stringify({ core: 'meowmarism-core', version, commit, files }, null, 2) + '\n');
console.log(`synced meowmarism-core ${version}${commit ? ' (' + commit.slice(0, 7) + ')' : ''}: ${files.length} files -> ${dest}`);
