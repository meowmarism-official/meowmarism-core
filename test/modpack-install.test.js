const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installModpack, httpDownload, META_FILE } = require('../modules/modpack-install');
const { makeZip } = require('../test-support/zip-write');

const sha = (s) => crypto.createHash('sha512').update(s).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meow-inst-'));

// A pack whose downloads are served from `remote` (url -> content).
function build({ files = {}, overrides = {}, serverOverrides = {}, extra = {} } = {}) {
  const remote = new Map();
  const list = Object.entries(files).map(([p, content]) => {
    const url = `https://cdn.modrinth.com/data/x/${p.replace(/\//g, '_')}`;
    remote.set(url, content);
    return { path: p, hashes: { sha512: sha(content) }, downloads: [url], fileSize: Buffer.byteLength(content) };
  });
  const entries = { 'modrinth.index.json': JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '4.12', name: 'Pack', files: list, dependencies: { minecraft: '1.21.1', neoforge: '21.1.5' } }) };
  for (const [p, c] of Object.entries(overrides)) entries[`overrides/${p}`] = c;
  for (const [p, c] of Object.entries(serverOverrides)) entries[`server-overrides/${p}`] = c;
  Object.assign(entries, extra);
  const calls = [];
  const download = async (url, dest) => {
    calls.push(url);
    if (!remote.has(url)) throw new Error('404');
    fs.writeFileSync(dest, remote.get(url));
  };
  return { mrpack: makeZip(entries), remote, download, calls, list };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[`${path.relative(dir, p)}/`] = ''; walk(p); }
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
function instance() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=old');
  fs.writeFileSync(path.join(dir, 'run.sh'), 'original launcher');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'a.cfg'), 'old config');
  return dir;
}
const install = (b, dir, extra = {}) => installModpack({ mrpack: b.mrpack, instanceDir: dir, download: b.download, source: { projectId: 'p1', versionId: 'v1', packVersion: '4.12' }, ...extra });

test('downloads, overrides and server overrides land in the instance and the source is recorded', async () => {
  const dir = tmp();
  const b = build({ files: { 'mods/a.jar': 'jar-a', 'mods/b.jar': 'jar-b' }, overrides: { 'config/x.cfg': 'x' }, serverOverrides: { 'config/y.cfg': 'y' } });
  const r = await install(b, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'a.jar'), 'utf8'), 'jar-a');
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'b.jar'), 'utf8'), 'jar-b');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'x.cfg'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'y.cfg'), 'utf8'), 'y');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
  assert.deepEqual(meta.source, { type: 'modrinth-modpack', projectId: 'p1', versionId: 'v1', packVersion: '4.12' });
  assert.deepEqual([meta.minecraft, meta.loader, meta.loaderVersion], ['1.21.1', 'neoforge', '21.1.5']);
  assert.ok(meta.installedAt);
  assert.equal(r.files, 4);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.meowmarism-modpack.') && n !== META_FILE), [], 'no staging leftovers');
});

test('an override beats a download at the same path, and the download is never fetched', async () => {
  const dir = tmp();
  const b = build({ files: { 'config/a.cfg': 'downloaded', 'mods/a.jar': 'jar' }, overrides: { 'config/a.cfg': 'override' } });
  await install(b, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'a.cfg'), 'utf8'), 'override');
  assert.ok(!b.calls.some((u) => u.endsWith('config_a.cfg')));
});

test('a server override beats a normal override at the same path', async () => {
  const dir = tmp();
  await install(build({ overrides: { 'config/a.cfg': 'client' }, serverOverrides: { 'config/a.cfg': 'server' } }), dir);
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'a.cfg'), 'utf8'), 'server');
});

test('a failing first URL falls back to the second', async () => {
  const dir = tmp();
  const content = 'jar';
  const good = 'https://cdn.modrinth.com/data/x/good.jar';
  const mrpack = makeZip({ 'modrinth.index.json': JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'P', versionId: '1', dependencies: { minecraft: '1.21.1' },
    files: [{ path: 'mods/a.jar', hashes: { sha512: sha(content) }, fileSize: 3, downloads: ['https://cdn.modrinth.com/data/x/dead.jar', good] }] }) });
  const tried = [];
  await installModpack({ mrpack, instanceDir: dir, download: async (url, dest) => { tried.push(url); if (url !== good) throw new Error('gone'); fs.writeFileSync(dest, content); } });
  assert.equal(tried.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'a.jar'), 'utf8'), content);
});

test('a wrong checksum or size aborts and leaves the folder untouched', async () => {
  for (const tamper of [(c) => 'jar-X', (c) => c + 'more']) {
    const dir = instance();
    const before = snapshot(dir);
    const b = build({ files: { 'mods/a.jar': 'jar-a', 'mods/b.jar': 'jar-b' } });
    for (const [url, content] of b.remote) if (url.endsWith('mods_b.jar')) b.remote.set(url, tamper(content));
    await assert.rejects(install(b, dir), /checksum mismatch|size mismatch/);
    assert.deepEqual(snapshot(dir), before);
  }
});

test('the second download failing leaves nothing of the first behind', async () => {
  const dir = instance();
  const before = snapshot(dir);
  const b = build({ files: { 'mods/a.jar': 'jar-a', 'mods/b.jar': 'jar-b', 'mods/c.jar': 'jar-c' }, overrides: { 'config/new.cfg': 'n' } });
  for (const url of [...b.remote.keys()]) if (url.endsWith('mods_b.jar')) b.remote.delete(url);
  await assert.rejects(install(b, dir), /404/);
  assert.deepEqual(snapshot(dir), before);
});

test('launch files in the pack never replace the instance\'s own', async () => {
  const dir = instance();
  const b = build({ files: { 'mods/a.jar': 'jar', 'run.sh': 'evil' }, overrides: { 'run.sh': 'evil', 'user_jvm_args.txt': '-evil', 'libraries/x.jar': 'evil' }, serverOverrides: { 'panel-config.json': '{}' } });
  await install(b, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'run.sh'), 'utf8'), 'original launcher');
  for (const n of ['user_jvm_args.txt', 'panel-config.json', 'libraries']) assert.ok(!fs.existsSync(path.join(dir, n)), `${n} was not written`);
});

test('a symlink slipped in between planning and writing is refused', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp(), outside = tmp();
  const b = build({ files: { 'mods/a.jar': 'jar' } });
  const download = async (url, dest) => {
    fs.symlinkSync(outside, path.join(dir, 'mods'));
    fs.writeFileSync(dest, 'jar');
  };
  await assert.rejects(installModpack({ mrpack: b.mrpack, instanceDir: dir, download }), /leaves the instance folder/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('any single rename failing while moving files in restores the folder exactly', async () => {
  const b = build({ files: { 'mods/a.jar': 'jar-a', 'config/a.cfg': 'downloaded' }, overrides: { 'config/a.cfg': 'override', 'config/b.cfg': 'b' }, serverOverrides: { 'scripts/s.zs': 's' } });
  let renames = 0;
  const real = fs.renameSync;
  fs.renameSync = (...args) => { renames++; return real(...args); };
  try { await install(b, instance()); } finally { fs.renameSync = real; }
  const total = renames;
  assert.ok(total >= 6, `expected several renames, saw ${total}`);
  for (let failAt = 1; failAt <= total; failAt++) {
    const dir = instance();
    const before = snapshot(dir);
    let n = 0;
    fs.renameSync = (...args) => { if (++n === failAt) throw new Error(`injected rename failure ${failAt}`); return real(...args); };
    try { await assert.rejects(install(b, dir), /injected rename failure/); } finally { fs.renameSync = real; }
    assert.deepEqual(snapshot(dir), before, `folder restored after failing rename ${failAt}`);
  }
});

test('a write error while extracting overrides cleans up', async () => {
  const dir = instance();
  const before = snapshot(dir);
  const b = build({ files: { 'mods/a.jar': 'jar' }, overrides: { 'config/b.cfg': 'b' } });
  const real = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => { if (/[\\/]o\d+$/.test(String(file))) throw new Error('disk full'); return real(file, ...rest); };
  try { await assert.rejects(install(b, dir), /disk full/); } finally { fs.writeFileSync = real; }
  assert.deepEqual(snapshot(dir), before);
});

test('an override entry that cannot be unpacked aborts cleanly', async () => {
  const dir = instance();
  const before = snapshot(dir);
  const b = build({ files: { 'mods/a.jar': 'jar' }, overrides: { 'config/big.cfg': 'hello hello hello hello hello' } });
  let at = b.mrpack.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (at !== -1 && b.mrpack.toString('utf8', at + 46, at + 46 + 24) !== 'overrides/config/big.cfg') at = b.mrpack.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 1);
  assert.notEqual(at, -1);
  b.mrpack.writeUInt32LE(2, at + 24);
  await assert.rejects(install(b, dir));
  assert.deepEqual(snapshot(dir), before);
});

test('progress goes up to done', async () => {
  const seen = [];
  await install(build({ files: { 'mods/a.jar': 'jar-a' }, overrides: { 'config/x.cfg': 'x' } }), tmp(), { progress: (p) => seen.push(p) });
  assert.equal(seen[seen.length - 1].phase, 'done');
  assert.equal(seen[seen.length - 1].done, 2);
  assert.ok(seen.some((p) => p.phase === 'downloads') && seen.some((p) => p.phase === 'overrides'));
});

test('the default downloader refuses other hosts and plain http', async () => {
  const dest = path.join(tmp(), 'x');
  await assert.rejects(httpDownload('https://evil.example/a.jar', dest), /unexpected host/);
  await assert.rejects(httpDownload('http://cdn.modrinth.com/a.jar', dest), /unexpected host/);
  await assert.rejects(httpDownload('nonsense', dest), /invalid download URL/);
});
