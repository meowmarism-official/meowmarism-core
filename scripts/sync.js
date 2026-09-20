#!/usr/bin/env node
// Copies this core version into a product or the website: node scripts/sync.js ../meowmarism-lite
//   - the legal files (LICENSE, CONTRIBUTOR-AGREEMENT.md, CONTRIBUTORS.md, BRAND-POLICY.md) go to the repository root
//     (the website repo gets WEBSITE-LICENSE.md as its LICENSE and no contributor files)
//   - with --assets, brand/, tokens/, modules/ and ui/ also go to panel/core/ (only for targets that have a panel/ folder)
// Edit the files here in core only. The products commit the copies so their release tarballs are complete without submodules.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LEGAL = ['LICENSE', 'CONTRIBUTOR-AGREEMENT.md', 'CONTRIBUTORS.md', 'BRAND-POLICY.md'];
const ASSET_DIRS = ['brand', 'tokens', 'modules', 'ui', 'lang'];
const root = path.resolve(__dirname, '..');

function syncTarget(targetArg, withAssets) {
  const target = path.resolve(targetArg);
  if (!fs.existsSync(target)) throw new Error(`not found: ${target}`);
  const files = [];

  const isWebsite = fs.existsSync(path.join(target, 'public')) && !fs.existsSync(path.join(target, 'panel'));
  for (const f of LEGAL) {
    if (isWebsite && (f === 'CONTRIBUTOR-AGREEMENT.md' || f === 'CONTRIBUTORS.md')) continue;
    const from = isWebsite && f === 'LICENSE' ? 'WEBSITE-LICENSE.md' : f;
    fs.copyFileSync(path.join(root, from), path.join(target, f));
    files.push(f);
  }

  if (isWebsite) {
    const legalDir = path.join(target, 'public', 'legal');
    fs.mkdirSync(legalDir, { recursive: true });
    for (const [from, to] of [['LICENSE', 'LICENSE.md'], ['WEBSITE-LICENSE.md', 'WEBSITE-LICENSE.md'], ['BRAND-POLICY.md', 'BRAND-POLICY.md']]) {
      fs.copyFileSync(path.join(root, from), path.join(legalDir, to));
      files.push(`public/legal/${to}`);
    }
  }

  if (withAssets && fs.existsSync(path.join(target, 'panel'))) {
    const dest = path.join(target, 'panel', 'core');
    fs.rmSync(dest, { recursive: true, force: true });
    const copy = (rel) => {
      const from = path.join(root, rel);
      if (fs.statSync(from).isDirectory()) { for (const f of fs.readdirSync(from)) copy(path.join(rel, f)); return; }
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.copyFileSync(from, path.join(dest, rel));
      files.push(`panel/core/${rel.split(path.sep).join('/')}`);
    };
    ASSET_DIRS.forEach(copy);
  }

  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); } catch (_) {}
  const version = require(path.join(root, 'package.json')).version;
  fs.writeFileSync(path.join(target, 'core.lock'), JSON.stringify({ core: 'meowmarism-core', version, commit, files }, null, 2) + '\n');
  console.log(`synced meowmarism-core ${version}${commit ? ' (' + commit.slice(0, 7) + ')' : ''} -> ${target} (${files.length} files)`);
}

const argv = process.argv.slice(2);
const withAssets = argv.includes('--assets');
const args = argv.filter((a) => a !== '--assets');
if (!args.length) {
  console.error('usage: node scripts/sync.js [--assets] <repo folder> [more repo folders...]');
  console.error('       node scripts/sync.js [--assets] --all   (every meowmarism-* repo next to this one that already has commits, except core)');
  process.exit(1);
}
const hasCommits = (dir) => { try { execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'ignore' }); return true; } catch (_) { return false; } };
const targets = args[0] === '--all'
  ? fs.readdirSync(path.dirname(root)).filter((d) => d.startsWith('meowmarism-') && d !== path.basename(root)).map((d) => path.join(path.dirname(root), d)).filter((d) => fs.existsSync(path.join(d, '.git')) && hasCommits(d))
  : args;
targets.forEach((t) => syncTarget(t, withAssets));
