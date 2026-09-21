const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, 'helpers', 'update-runner.js');
const OLD_VERSION = '0.3.8.2';
const NEW_VERSION = '0.3.9';

// The updater swaps folders and extracts with tar, so these flows need a Unix host.
const unix = { skip: process.platform === 'win32' ? 'needs a Unix host' : false };

const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (p) => fs.readFileSync(p, 'utf8');

const server = (label) => `const http = require('http');\nhttp.createServer((q, r) => { r.writeHead(200); r.end('${label}'); }).listen(Number(process.env.CONTROLLER_PORT) || 0, '127.0.0.1');\n`;
const CONTROLLERS = {
  old: server('OLD'),
  ok: server('NEW'),
  crash: 'process.exit(1);\n',
  syntax: 'const = ;\n',
};

// One world per test: an install folder with the old panel, a HOME for the updater state, a TMPDIR to spot leftovers.
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-upd-'));
  const w = { root, install: path.join(root, 'install'), home: path.join(root, 'home'), tmp: path.join(root, 'tmp'), hookLog: path.join(root, 'hooks.log') };
  for (const d of [w.install, w.home, w.tmp]) fs.mkdirSync(d, { recursive: true });
  write(path.join(w.install, 'package.json'), JSON.stringify({ name: 'meowmarism-test', version: OLD_VERSION }));
  write(path.join(w.install, 'panel', 'controller.js'), CONTROLLERS.old);
  write(path.join(w.install, 'panel', 'lib', 'util.js'), 'module.exports = 1;\n');
  write(path.join(w.install, 'panel', 'data.txt'), 'old data');
  fs.writeFileSync(w.hookLog, '');
  return w;
}

// A release tarball like GitHub's: one top-level folder with package.json and panel/.
function tarball(w, { controller = 'ok', packageJson = true, panel = true, truncate = false, name = 'release.tar.gz' } = {}) {
  const src = path.join(w.root, 'src-' + name);
  const top = path.join(src, 'meowmarism-test-' + NEW_VERSION);
  if (packageJson) write(path.join(top, 'package.json'), JSON.stringify({ name: 'meowmarism-test', version: NEW_VERSION }));
  if (panel) {
    write(path.join(top, 'panel', 'controller.js'), CONTROLLERS[controller]);
    write(path.join(top, 'panel', 'lib', 'util.js'), 'module.exports = 2;\n');
  } else write(path.join(top, 'README.md'), 'no panel here');
  const out = path.join(w.root, name);
  const r = spawnSync('tar', ['-czf', out, '-C', src, 'meowmarism-test-' + NEW_VERSION]);
  assert.equal(r.status, 0, String(r.stderr));
  if (truncate) fs.writeFileSync(out, fs.readFileSync(out).subarray(0, Math.floor(fs.statSync(out).size / 2)));
  return out;
}

function env(w, extra = {}) {
  return { ...process.env, HOME: w.home, USERPROFILE: w.home, TMPDIR: w.tmp, INSTALL_DIR: w.install, HOOK_LOG: w.hookLog, MEOW_UPDATE_TAG: 'v' + NEW_VERSION, MEOW_CONFIRM_MS: '200', ...extra };
}

function run(w, mode, extra = {}) {
  const r = spawnSync(process.execPath, [RUNNER, mode], { env: env(w, extra), encoding: 'utf8', timeout: 90000 });
  const lines = String(r.stdout).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const result = lines.find((l) => 'error' in l);
  return { code: r.status, error: result ? result.error : null, first: lines[0], stderr: String(r.stderr) };
}

function fetchBody(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Starts the installed panel for real and returns what it answers, or null when it does not run.
async function serves(w) {
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(w.install, 'panel', 'controller.js')], { env: { ...process.env, CONTROLLER_PORT: String(port) }, stdio: 'ignore' });
  let body = null;
  for (let i = 0; i < 20 && body === null; i++) { await new Promise((r) => setTimeout(r, 150)); body = await fetchBody(port); }
  child.kill();
  return body;
}

const listing = (w) => fs.readdirSync(w.install).sort();
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = read(f); } };
  walk(dir);
  return out;
};

// The invariant: the install is completely the old version, untouched and running, with nothing left behind.
async function assertOldIntact(w, before) {
  assert.deepEqual(listing(w), ['package.json', 'panel'], `leftovers next to the panel: ${listing(w).join(', ')}`);
  assert.deepEqual(snapshot(w.install), before, 'the installed files changed');
  assert.equal(JSON.parse(read(path.join(w.install, 'package.json'))).version, OLD_VERSION);
  assert.equal(await serves(w), 'OLD', 'the old version does not run any more');
  assert.deepEqual(fs.readdirSync(w.tmp), [], 'temporary folders were left in TMPDIR');
}

const hooks = (w) => read(w.hookLog).split('\n').filter(Boolean);
const marker = (w) => path.join(w.home, '.meowmarism-test-update-pending.json');
const resultFile = (w) => path.join(w.home, '.meowmarism-test-update-result.json');

test('version logic: three and four number versions compare correctly', () => {
  const { isNewer, newestFirst, parseTag } = require('../modules/updater');
  assert.equal(isNewer('v0.3.8.3', '0.3.8.2'), true);
  assert.equal(isNewer('v0.3.9', '0.3.8.2'), true);
  assert.equal(isNewer('v0.3.8.2', '0.3.8.2'), false);
  assert.equal(isNewer('v0.3.8.1', '0.3.8.2'), false);
  assert.equal(isNewer('v0.3.8', '0.3.8.2'), false);
  assert.equal(isNewer('v0.10.0', '0.9.9.9'), true);
  assert.equal(isNewer('v1.0.0', '0.99.99.99'), true);
  assert.equal(isNewer('latest', '0.3.8.2'), false);
  assert.deepEqual(parseTag('v0.3.8.2'), [0, 3, 8, 2]);
  assert.deepEqual(parseTag('0.3.9'), [0, 3, 9, 0]);
  assert.deepEqual(['v0.3.8', 'v0.3.8.2', 'v0.3.9', 'v0.3.8.10'].sort(newestFirst), ['v0.3.9', 'v0.3.8.10', 'v0.3.8.2', 'v0.3.8']);
});

test('a valid update installs the new panel and package.json, keeps the old ones until it runs healthily, then cleans up', unix, async () => {
  const w = world();
  const tar = tarball(w);
  const r = run(w, 'update', { MEOW_UPDATE_TARBALL: tar });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.error, null, 'the update reported success by restarting, not by an error');
  assert.equal(r.first.started, true);
  assert.equal(r.first.second, false, 'a second update request while one runs is refused');
  assert.deepEqual(hooks(w), ['stop'], 'servers were stopped once and not started again by the updater');
  assert.equal(JSON.parse(read(path.join(w.install, 'package.json'))).version, NEW_VERSION);
  assert.equal(await serves(w), 'NEW');
  assert.equal(read(path.join(w.install, 'panel', 'lib', 'util.js')), 'module.exports = 2;\n');
  assert.deepEqual(listing(w), ['package.json', 'package.json.old', 'panel', 'panel.old'], 'the old version is kept for the rollback');
  assert.equal(JSON.parse(read(marker(w))).to, 'v' + NEW_VERSION);
  assert.deepEqual(fs.readdirSync(w.tmp), [], 'the download folder was removed');

  const boot = run(w, 'boot', { WAIT_MS: '900' });
  assert.equal(boot.code, 0);
  assert.deepEqual(listing(w), ['package.json', 'panel'], 'after a healthy run the old version is removed');
  assert.equal(fs.existsSync(marker(w)), false);
  assert.equal(await serves(w), 'NEW');
  fs.rmSync(w.root, { recursive: true, force: true });
});

test('a release with a syntax error is refused before anything is touched', unix, async () => {
  const w = world();
  const before = snapshot(w.install);
  const r = run(w, 'update', { MEOW_UPDATE_TARBALL: tarball(w, { controller: 'syntax' }) });
  assert.match(r.error, /syntax check/);
  assert.deepEqual(hooks(w), [], 'servers were not stopped for a release that never installs');
  await assertOldIntact(w, before);
  fs.rmSync(w.root, { recursive: true, force: true });
});

test('a release with the wrong layout is refused', unix, async () => {
  for (const options of [{ panel: false }, { packageJson: false }]) {
    const w = world();
    const before = snapshot(w.install);
    const r = run(w, 'update', { MEOW_UPDATE_TARBALL: tarball(w, options) });
    assert.match(r.error, /unexpected release layout/, JSON.stringify(options));
    assert.deepEqual(hooks(w), []);
    await assertOldIntact(w, before);
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a broken or incomplete download leaves no half installed state', unix, async () => {
  const w = world();
  const before = snapshot(w.install);
  const r = run(w, 'update', { MEOW_UPDATE_TARBALL: tarball(w, { truncate: true }) });
  assert.match(r.error, /could not extract|layout|syntax/);
  assert.deepEqual(hooks(w), []);
  await assertOldIntact(w, before);
  fs.rmSync(w.root, { recursive: true, force: true });
});

test('a new version that fails its start test is rolled back at once and the servers come back', unix, async () => {
  const w = world();
  const before = snapshot(w.install);
  const r = run(w, 'update', { MEOW_UPDATE_TARBALL: tarball(w, { controller: 'crash' }) });
  assert.match(r.error, /failed its start test/);
  assert.deepEqual(hooks(w), ['stop', 'restore:token-1'], 'the servers that were stopped are given back');
  await assertOldIntact(w, before);
  assert.equal(JSON.parse(read(resultFile(w))).rolledBack, true, 'the rollback is reported');
  assert.equal(fs.existsSync(marker(w)), false, 'no boot marker for an update that never went live');
  fs.rmSync(w.root, { recursive: true, force: true });
});

test('a new version that keeps crashing on startup is rolled back after the boot limit', unix, async () => {
  const w = world();
  const before = snapshot(w.install);
  // The probe passes (the version answers), but once installed it crashes: simulate by swapping in a crashing controller after the update.
  run(w, 'update', { MEOW_UPDATE_TARBALL: tarball(w) });
  assert.equal(await serves(w), 'NEW');
  write(path.join(w.install, 'panel', 'controller.js'), CONTROLLERS.crash);
  for (let boot = 1; boot <= 3; boot++) {
    const r = run(w, 'boot', { WAIT_MS: '50' });
    assert.equal(r.code, 0, `boot ${boot} still runs the new version`);
    assert.equal(JSON.parse(read(marker(w))).boots, boot);
  }
  const fourth = run(w, 'boot', { WAIT_MS: '50' });
  assert.equal(fourth.code, 1, 'the fourth boot rolls back and exits so the service manager starts the old version');
  assert.equal(fs.existsSync(marker(w)), false);
  assert.equal(JSON.parse(read(resultFile(w))).rolledBack, true);
  assert.equal(JSON.parse(read(path.join(w.install, 'package.json'))).version, OLD_VERSION);
  assert.equal(await serves(w), 'OLD');
  assert.deepEqual(snapshot(path.join(w.install, 'panel')), Object.fromEntries(Object.entries(before).filter(([k]) => k.startsWith('panel' + path.sep)).map(([k, v]) => [k.slice(6), v])));
  assert.equal(fs.existsSync(path.join(w.install, 'package.json.old')), false);
  fs.rmSync(w.root, { recursive: true, force: true });
});

test('wherever the installation fails, the old version is complete and running, or the new one is', unix, async () => {
  const dry = world();
  run(dry, 'update', { MEOW_UPDATE_TARBALL: tarball(dry), OPS_FILE: path.join(dry.root, 'ops') });
  const total = Number(read(path.join(dry.root, 'ops')));
  assert.ok(total >= 8, `expected at least 8 file operations, saw ${total}`);
  fs.rmSync(dry.root, { recursive: true, force: true });

  const problems = [];
  for (let at = 1; at <= total; at++) {
    const w = world();
    const before = snapshot(w.install);
    const r = run(w, 'update', { MEOW_UPDATE_TARBALL: tarball(w), FAULT_AT: String(at) });
    try {
      if (r.error) {
        await assertOldIntact(w, before);
        const h = hooks(w);
        assert.ok(h.length === 0 || (h.length === 2 && h[0] === 'stop' && h[1] === 'restore:token-1'), `servers: ${h.join()}`);
      } else {
        assert.equal(JSON.parse(read(path.join(w.install, 'package.json'))).version, NEW_VERSION, 'reported success, so the new package.json');
        assert.equal(await serves(w), 'NEW', 'reported success, so the new panel');
      }
    } catch (err) {
      problems.push(`fault at operation ${at}: ${err.message.split('\n')[0]}`);
    }
    fs.rmSync(w.root, { recursive: true, force: true });
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('wherever the rollback itself fails, the install is never left without a working panel', unix, async () => {
  const dry = world();
  run(dry, 'update', { MEOW_UPDATE_TARBALL: tarball(dry, { controller: 'crash' }), OPS_FILE: path.join(dry.root, 'ops') });
  const total = Number(read(path.join(dry.root, 'ops')));
  fs.rmSync(dry.root, { recursive: true, force: true });

  const problems = [];
  for (let at = 1; at <= total; at++) {
    const w = world();
    run(w, 'update', { MEOW_UPDATE_TARBALL: tarball(w, { controller: 'crash' }), FAULT_AT: String(at) });
    try {
      const pkg = JSON.parse(read(path.join(w.install, 'package.json'))).version;
      const ctrl = fs.existsSync(path.join(w.install, 'panel', 'controller.js')) ? read(path.join(w.install, 'panel', 'controller.js')) : null;
      assert.ok(ctrl !== null, 'the panel folder is gone');
      const isOld = ctrl === CONTROLLERS.old && pkg === OLD_VERSION;
      const isNew = ctrl === CONTROLLERS.crash && pkg === NEW_VERSION;
      assert.ok(isOld || isNew, `mixed state: package.json ${pkg}, controller ${ctrl.slice(0, 20)}`);
    } catch (err) {
      problems.push(`fault at operation ${at}: ${err.message.split('\n')[0]}`);
    }
    fs.rmSync(w.root, { recursive: true, force: true });
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
