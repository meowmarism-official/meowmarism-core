const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { inspectMrpack, buildInstallPlan, verifyDownload } = require('../modules/modpack');
const { openZip } = require('../modules/zip-read');
const { makeZip } = require('../test-support/zip-write');

const HASH = crypto.createHash('sha512').update('jar').digest('hex');
const file = (p, extra = {}) => ({ path: p, hashes: { sha512: HASH, sha1: 'x' }, downloads: [`https://cdn.modrinth.com/data/abc/versions/1/${path.basename(p)}`], fileSize: 3, ...extra });
const pack = (over = {}, entries = {}) => makeZip({
  'modrinth.index.json': JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Test Pack',
    files: [file('mods/a.jar')], dependencies: { minecraft: '1.21.1', neoforge: '21.1.5' }, ...over,
  }),
  ...entries,
});
const rejects = (buf, re) => assert.throws(() => inspectMrpack(buf), re || /modpack rejected/);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meow-pack-'));

test('valid packs for every loader are described', () => {
  for (const [key, loader] of [['fabric-loader', 'fabric'], ['neoforge', 'neoforge'], ['forge', 'forge'], ['quilt-loader', 'quilt']]) {
    const i = inspectMrpack(pack({ dependencies: { minecraft: '1.21.1', [key]: '0.16.0' } }));
    assert.deepEqual([i.minecraft, i.loader, i.loaderVersion, i.name, i.versionId], ['1.21.1', loader, '0.16.0', 'Test Pack', '1.0']);
    assert.equal(i.modCount, 1);
    assert.equal(i.downloadBytes, 3);
  }
});

test('loader rules: one loader at most, Minecraft required, unknown keys ignored', () => {
  rejects(pack({ dependencies: { minecraft: '1.21.1', forge: '1', neoforge: '2' } }), /more than one loader/);
  rejects(pack({ dependencies: { neoforge: '2' } }), /Minecraft version/);
  const i = inspectMrpack(pack({ dependencies: { minecraft: '1.21.1', 'future-loader': '9', fabric_api: '1' } }));
  assert.equal(i.loader, 'vanilla');
});

test('the index must be present, valid and of a known format', () => {
  rejects(makeZip({ 'other.txt': 'x' }), /modrinth.index.json is missing/);
  rejects(makeZip({ 'modrinth.index.json': '{nope' }), /valid JSON/);
  rejects(pack({ formatVersion: 2 }), /format version/);
  rejects(pack({ game: 'terraria' }), /Minecraft pack/);
  rejects(Buffer.from('not a zip at all, just text'), /not a zip/);
});

test('server support: unsupported files are left out, optional and required stay', () => {
  const i = inspectMrpack(pack({ files: [
    file('mods/client.jar', { env: { client: 'required', server: 'unsupported' } }),
    file('mods/opt.jar', { env: { client: 'optional', server: 'optional' } }),
    file('mods/req.jar', { env: { client: 'required', server: 'required' } }),
    file('mods/none.jar'),
  ] }));
  assert.deepEqual(i.files.map((f) => f.path), ['mods/opt.jar', 'mods/req.jar', 'mods/none.jar']);
  assert.equal(i.files[0].optional, true);
  assert.deepEqual(i.skipped, [{ path: 'mods/client.jar', reason: 'client only' }]);
  const plan = buildInstallPlan(i, tmp());
  assert.ok(!plan.downloads.some((d) => d.path === 'mods/client.jar'));
});

test('unsafe file paths reject the whole pack', () => {
  for (const bad of ['../evil.jar', 'mods/../../evil.jar', '/etc/passwd', 'C:\\evil', '\\evil', 'mods\\evil.jar', 'mods//x.jar', './x.jar', '']) {
    rejects(pack({ files: [file(bad)] }), /unsafe path/);
  }
});

test('unsafe override paths reject the whole pack', () => {
  rejects(pack({}, { 'overrides/../evil.txt': 'x' }), /unsafe path/);
  rejects(pack({}, { 'server-overrides/a/../../evil.txt': 'x' }), /unsafe path/);
  rejects(pack({}, { 'overrides/C:\\evil.txt': 'x' }), /unsafe path/);
});

test('files need a SHA-512, a size, a download and an allowed host', () => {
  rejects(pack({ files: [file('mods/a.jar', { hashes: {} })] }), /SHA-512/);
  rejects(pack({ files: [file('mods/a.jar', { hashes: { sha512: 'abc' } })] }), /SHA-512/);
  rejects(pack({ files: [file('mods/a.jar', { fileSize: undefined })] }), /size/);
  rejects(pack({ files: [file('mods/a.jar', { downloads: [] })] }), /no download/);
  rejects(pack({ files: [file('mods/a.jar', { fileSize: 600 * 1024 * 1024 })] }), /too large/);
  for (const url of ['https://evil.example/a.jar', 'http://cdn.modrinth.com/a.jar', 'https://cdn.modrinth.com.evil.example/a.jar', 'https://user:pw@cdn.modrinth.com/a.jar', 'ftp://cdn.modrinth.com/a', 'nonsense']) {
    rejects(pack({ files: [file('mods/a.jar', { downloads: [url] })] }), /host not allowed/);
  }
  const ok = inspectMrpack(pack({ files: [file('mods/a.jar', { downloads: ['https://github.com/x/y/releases/download/1/a.jar'] })] }));
  assert.equal(ok.files.length, 1);
});

test('duplicate paths, too many files and huge totals are rejected', () => {
  rejects(pack({ files: [file('mods/a.jar'), file('mods/a.jar')] }), /duplicate/);
  rejects(pack({ files: Array.from({ length: 5001 }, (_, n) => file(`mods/${n}.jar`)) }), /too many/);
  rejects(pack({ files: Array.from({ length: 20 }, (_, n) => file(`mods/${n}.jar`, { fileSize: 500 * 1024 * 1024 })) }), /download is too large/);
});

test('protected instance files are skipped, not written', () => {
  const i = inspectMrpack(pack({ files: [file('run.sh'), file('mods/a.jar')] }, { 'overrides/panel-config.json': '{}', 'overrides/config/a.cfg': 'x', 'server-overrides/user_jvm_args.txt': '-x' }));
  assert.deepEqual(i.files.map((f) => f.path), ['mods/a.jar']);
  assert.deepEqual(i.overrides.map((o) => o.path), ['config/a.cfg']);
  assert.deepEqual(i.skipped.map((s) => s.path).sort(), ['panel-config.json', 'run.sh', 'user_jvm_args.txt']);
});

test('server overrides win over normal overrides at the same path', () => {
  const i = inspectMrpack(pack({}, {
    'overrides/config/a.cfg': 'client', 'overrides/config/b.cfg': 'b', 'server-overrides/config/a.cfg': 'server', 'client-overrides/config/c.cfg': 'c',
  }));
  const plan = buildInstallPlan(i, tmp());
  const a = plan.overrides.filter((o) => o.path === 'config/a.cfg');
  assert.equal(a.length, 1);
  assert.equal(a[0].source, 'server-overrides');
  assert.equal(a[0].entry, 'server-overrides/config/a.cfg');
  assert.deepEqual(plan.overrides.map((o) => o.path).sort(), ['config/a.cfg', 'config/b.cfg']);
});

test('the plan holds absolute targets inside the instance and writes nothing', () => {
  const dir = tmp();
  const plan = buildInstallPlan(inspectMrpack(pack({}, { 'overrides/config/x.cfg': 'x' })), dir);
  assert.equal(plan.downloads[0].dest, path.join(dir, 'mods', 'a.jar'));
  assert.equal(plan.overrides[0].dest, path.join(dir, 'config', 'x.cfg'));
  assert.equal(plan.loader, 'neoforge');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a symlink that leaves the instance is refused when the plan is built', { skip: process.platform === 'win32' }, () => {
  const dir = tmp(), outside = tmp();
  fs.symlinkSync(outside, path.join(dir, 'mods'));
  assert.throws(() => buildInstallPlan(inspectMrpack(pack()), dir), /leaves the instance folder/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('downloads are checked against the declared size and SHA-512', () => {
  const entry = inspectMrpack(pack()).files[0];
  verifyDownload(entry, Buffer.from('jar'));
  assert.throws(() => verifyDownload(entry, Buffer.from('jaz')), /checksum mismatch/);
  assert.throws(() => verifyDownload(entry, Buffer.from('jar!')), /size mismatch/);
});

test('inspectMrpack reads a pack from a file path', () => {
  const dir = tmp(), p = path.join(dir, 'x.mrpack');
  fs.writeFileSync(p, pack());
  assert.equal(inspectMrpack(p).name, 'Test Pack');
});

test('reading a zip entry that lies about its size fails instead of over-reading', () => {
  const buf = makeZip({ 'a.txt': 'hello world hello world' });
  const central = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(2, central + 24);
  assert.throws(() => openZip(buf).read('a.txt'));
});
