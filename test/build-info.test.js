const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getBuildInfo } = require('../modules/build-info');

const gitOk = spawnSync('git', ['--version']).status === 0 && process.platform !== 'win32';
const opts = { skip: gitOk ? false : 'needs git on a Unix host' };
const git = (dir, ...args) => { const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-build-'));
  git(dir, 'init', '-q');
  write(path.join(dir, 'package.json'), JSON.stringify({ version: '0.3.8.3' }));
  write(path.join(dir, 'panel', 'build.json'), '{"commit":"$Format:%h$"}\n');
  write(path.join(dir, '.gitattributes'), 'panel/build.json export-subst\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('a git checkout is a dev build and reports its commit', opts, () => {
  const dir = repo();
  const info = getBuildInfo(dir);
  assert.equal(info.channel, 'dev');
  assert.equal(info.version, '0.3.8.3');
  assert.equal(info.label, '0.3.8.3-dev');
  assert.equal(info.commit, git(dir, 'rev-parse', '--short=8', 'HEAD'));
});

test('two commits of the same version are told apart', opts, () => {
  const dir = repo();
  const first = getBuildInfo(dir).commit;
  write(path.join(dir, 'panel', 'x.js'), '1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'second');
  assert.notEqual(getBuildInfo(dir).commit, first);
});

test('a checkout exactly at a tag is a release', opts, () => {
  const dir = repo();
  git(dir, 'tag', 'v0.3.8.3');
  const info = getBuildInfo(dir);
  assert.equal(info.channel, 'release');
  assert.equal(info.label, '0.3.8.3');
});

test('a release archive carries its commit and counts as a release', opts, () => {
  const dir = repo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-archive-'));
  const archive = path.join(out, 'a.tar');
  git(dir, 'archive', '-o', archive, 'HEAD');
  assert.equal(spawnSync('tar', ['-xf', archive, '-C', out]).status, 0);
  const info = getBuildInfo(out);
  assert.equal(info.channel, 'release');
  assert.match(info.commit, /^[0-9a-f]{7,}$/);
  assert.equal(info.label, '0.3.8.3');
  assert.ok(git(dir, 'rev-parse', 'HEAD').startsWith(info.commit));
});

test('without git and without a stamp it is a dev build with no commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-build-plain-'));
  write(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3.4' }));
  write(path.join(dir, 'panel', 'build.json'), '{"commit":"$Format:%h$"}');
  assert.deepEqual(getBuildInfo(dir), { version: '1.2.3.4', channel: 'dev', commit: null, core: null, label: '1.2.3.4-dev' });
});

test('the core version comes from panel/core/core.json and is shortened to 8 characters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-core-info-'));
  write(path.join(dir, 'package.json'), JSON.stringify({ version: '0.3.10' }));
  write(path.join(dir, 'panel', 'core', 'core.json'), JSON.stringify({ version: '0.0.12', commit: 'abcdef0123456789abcdef0123456789abcdef01' }));
  assert.deepEqual(getBuildInfo(dir).core, { version: '0.0.12', commit: 'abcdef01' });
});

test('a missing or odd core.json means no core info and never breaks the build info', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-core-info-'));
  write(path.join(dir, 'package.json'), JSON.stringify({ version: '0.3.10' }));
  assert.equal(getBuildInfo(dir).core, null);
  write(path.join(dir, 'panel', 'core', 'core.json'), '{not json');
  assert.equal(getBuildInfo(dir).core, null);
  write(path.join(dir, 'panel', 'core', 'core.json'), JSON.stringify({ version: '0.0.12', commit: 'not a hash' }));
  assert.deepEqual(getBuildInfo(dir).core, { version: '0.0.12', commit: null });
  assert.equal(getBuildInfo(dir).version, '0.3.10');
});
