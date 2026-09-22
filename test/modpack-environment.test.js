const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { inspectMrpack } = require('../modules/modpack');
const { resolveEnvironments } = require('../modules/modpack-environment');
const { installModpack } = require('../modules/modpack-install');
const { makeZip } = require('../test-support/zip-write');

const sha = (s) => crypto.createHash('sha512').update(s).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meow-env-'));

// files: { path: { content, env? } } where env is the pack's own env.server value
function pack(files, extra = {}) {
  const remote = new Map();
  const list = Object.entries(files).map(([p, { content, env }]) => {
    const url = `https://cdn.modrinth.com/data/x/${p.replace(/\//g, '_')}`;
    remote.set(url, content);
    return { path: p, hashes: { sha512: sha(content) }, downloads: [url], fileSize: Buffer.byteLength(content), ...(env ? { env: { client: 'required', server: env } } : {}) };
  });
  const mrpack = makeZip({ 'modrinth.index.json': JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'P', files: list, dependencies: { minecraft: '1.21.1', fabric: undefined, 'fabric-loader': '0.16.9' } }), ...extra });
  return { mrpack, inspected: inspectMrpack(mrpack), remote };
}
// A fake Modrinth: answers version_files from a hash -> environment table and records every call.
function modrinth(table, { fail = false } = {}) {
  const calls = [];
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    if (fail) throw new Error('Modrinth answered 503');
    const out = {};
    for (const h of body.hashes) if (h in table) out[h] = { environment: table[h] };
    return out;
  };
  return { request, calls };
}
const API = 'https://api.modrinth.com/v2';
const envOf = (content, environment) => [sha(content), environment];

test('client_only and singleplayer_only mods are left out, everything else stays', async () => {
  const p = pack({
    'mods/client.jar': { content: 'c' }, 'mods/single.jar': { content: 's' }, 'mods/both.jar': { content: 'b' }, 'mods/server.jar': { content: 'sv' },
    'mods/dedicated.jar': { content: 'd' }, 'mods/serveropt.jar': { content: 'so' }, 'mods/clientopt.jar': { content: 'co' }, 'mods/either.jar': { content: 'e' }, 'mods/either2.jar': { content: 'e2' },
    'mods/unknown.jar': { content: 'u' }, 'mods/missing.jar': { content: 'm' }, 'mods/weird.jar': { content: 'w' },
  });
  const m = modrinth(Object.fromEntries([
    envOf('c', 'client_only'), envOf('s', 'singleplayer_only'), envOf('b', 'client_and_server'), envOf('sv', 'server_only'), envOf('d', 'dedicated_server_only'),
    envOf('so', 'server_only_client_optional'), envOf('co', 'client_only_server_optional'), envOf('e', 'client_or_server'), envOf('e2', 'client_or_server_prefers_both'),
    envOf('u', 'unknown'), envOf('w', 'something_new'),
  ]));
  const logs = [];
  const { inspected, report } = await resolveEnvironments(p.inspected, { request: m.request, log: (l) => logs.push(l) });
  assert.deepEqual(inspected.files.map((f) => f.path).sort(), ['mods/both.jar', 'mods/clientopt.jar', 'mods/dedicated.jar', 'mods/either.jar', 'mods/either2.jar', 'mods/missing.jar', 'mods/server.jar', 'mods/serveropt.jar', 'mods/unknown.jar', 'mods/weird.jar']);
  assert.deepEqual(report.skipped.map((s) => [s.path, s.environment]).sort(), [['mods/client.jar', 'client_only'], ['mods/single.jar', 'singleplayer_only']]);
  assert.deepEqual(inspected.skipped.filter((s) => s.source === 'modrinth').map((s) => s.path).sort(), ['mods/client.jar', 'mods/single.jar']);
  assert.ok(logs.includes('Skipping client.jar: client-only according to Modrinth'));
  assert.ok(logs.includes('Skipping single.jar: singleplayer-only according to Modrinth'));
  assert.ok(logs.includes('Keeping clientopt.jar: server support is optional'));
  assert.ok(logs.includes('Could not determine environment for unknown.jar, keeping pack declaration'));
  assert.ok(logs.includes('Could not determine environment for missing.jar, keeping pack declaration'), 'a hash Modrinth does not know is kept');
  assert.ok(logs.includes('Could not determine environment for weird.jar, keeping pack declaration'), 'a future environment value is kept');
  assert.ok(!logs.some((l) => /both\.jar|server\.jar|dedicated|either/.test(l)), 'plain server-capable mods are not chatty');
});

test('counts follow the decision and the input is not changed', async () => {
  const p = pack({ 'mods/client.jar': { content: 'cccc' }, 'mods/keep.jar': { content: 'kk' } }, { 'overrides/mods/extra.jar': 'x' });
  const before = JSON.stringify(p.inspected);
  const { inspected } = await resolveEnvironments(p.inspected, { request: modrinth(Object.fromEntries([envOf('cccc', 'client_only')])).request });
  assert.equal(JSON.stringify(p.inspected), before);
  assert.equal(p.inspected.modCount, 3);
  assert.equal(inspected.modCount, 2, 'the skipped mod no longer counts; the override jar does');
  assert.equal(inspected.downloadBytes, p.inspected.downloadBytes - 4);
});

test('a mod the pack already marks server: unsupported is skipped as before and never looked up', async () => {
  const p = pack({ 'mods/packclient.jar': { content: 'pc', env: 'unsupported' }, 'mods/other.jar': { content: 'o' } });
  assert.deepEqual(p.inspected.skipped, [{ path: 'mods/packclient.jar', reason: 'client only' }]);
  const m = modrinth({});
  const { inspected } = await resolveEnvironments(p.inspected, { request: m.request });
  assert.deepEqual(m.calls[0].body.hashes, [sha('o')], 'only the remaining mod is asked about');
  assert.equal(inspected.skipped.length, 1);
  const none = modrinth({});
  await resolveEnvironments(pack({ 'mods/only.jar': { content: 'x', env: 'unsupported' } }).inspected, { request: none.request });
  assert.equal(none.calls.length, 0, 'no request when nothing is left to check');
});

test('a failing Modrinth request keeps every mod and only says so', async () => {
  const p = pack({ 'mods/a.jar': { content: 'a' }, 'mods/b.jar': { content: 'b' } });
  const logs = [];
  const { inspected, report } = await resolveEnvironments(p.inspected, { request: modrinth({}, { fail: true }).request, log: (l) => logs.push(l) });
  assert.equal(inspected.files.length, 2);
  assert.equal(report.failed, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Could not ask Modrinth about 2 mods \(Modrinth answered 503\), keeping the pack declaration/);
});

test('only jar files directly in mods/ are checked, and identical hashes are asked once', async () => {
  const p = pack({
    'mods/a.jar': { content: 'a' }, 'mods/a-copy.jar': { content: 'a' }, 'mods/notes.txt': { content: 'n' }, 'config/a.toml': { content: 'cfg' },
    'resourcepacks/r.zip': { content: 'rp' }, 'shaderpacks/s.zip': { content: 'sh' }, 'datapacks/d.zip': { content: 'dp' }, 'mods/sub/deep.jar': { content: 'deep' },
  });
  const m = modrinth(Object.fromEntries([envOf('n', 'client_only'), envOf('cfg', 'client_only'), envOf('rp', 'client_only'), envOf('sh', 'client_only'), envOf('dp', 'client_only'), envOf('deep', 'client_only')]));
  const { inspected } = await resolveEnvironments(p.inspected, { request: m.request });
  assert.deepEqual(m.calls.map((c) => c.body.hashes), [[sha('a')]], 'one request with one hash for the two identical jars');
  assert.equal(inspected.files.length, 8, 'nothing else is filtered, even if Modrinth would call it client-only');
});

test('big packs are asked in batches of 100', async () => {
  const files = {};
  for (let i = 0; i < 250; i++) files[`mods/m${i}.jar`] = { content: `mod-${i}` };
  const p = pack(files);
  const m = modrinth({});
  await resolveEnvironments(p.inspected, { request: m.request });
  assert.deepEqual(m.calls.map((c) => c.body.hashes.length), [100, 100, 50]);
  assert.ok(m.calls.every((c) => c.method === 'POST' && c.url === `${API}/version_files` && c.body.algorithm === 'sha512'));
});

test('a failing batch only affects its own mods', async () => {
  const files = {};
  for (let i = 0; i < 150; i++) files[`mods/m${i}.jar`] = { content: `mod-${i}` };
  const p = pack(files);
  let n = 0;
  const request = async (m, u, body) => { n++; if (n === 2) throw new Error('boom'); return Object.fromEntries(body.hashes.map((h) => [h, { environment: 'client_only' }])); };
  const { inspected, report } = await resolveEnvironments(p.inspected, { request });
  assert.equal(inspected.files.length, 50, 'the first 100 were dropped, the failed batch of 50 is kept');
  assert.equal(report.failed, true);
});

test('nothing is downloaded to identify mods; skipped mods are never fetched by the installer', async () => {
  const p = pack({ 'mods/client.jar': { content: 'client' }, 'mods/keep.jar': { content: 'keep' } }, { 'overrides/config/x.cfg': 'x' });
  const { inspected } = await resolveEnvironments(p.inspected, { request: modrinth(Object.fromEntries([envOf('client', 'client_only')])).request });
  const fetched = [];
  const dir = tmp();
  await installModpack({ mrpack: p.mrpack, inspected, instanceDir: dir, download: async (url, dest) => { fetched.push(url); fs.writeFileSync(dest, p.remote.get(url)); } });
  assert.deepEqual(fetched, ['https://cdn.modrinth.com/data/x/mods_keep.jar']);
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'keep.jar')));
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'client.jar')));
});

test('the installer keeps its all-or-nothing behaviour after environment filtering', async () => {
  const p = pack({ 'mods/client.jar': { content: 'client' }, 'mods/a.jar': { content: 'a' }, 'mods/b.jar': { content: 'b' } }, { 'overrides/config/x.cfg': 'x' });
  const { inspected } = await resolveEnvironments(p.inspected, { request: modrinth(Object.fromEntries([envOf('client', 'client_only')])).request });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=old');
  const before = fs.readdirSync(dir).sort();
  await assert.rejects(installModpack({ mrpack: p.mrpack, inspected, instanceDir: dir, download: async (url, dest) => { if (url.endsWith('mods_b.jar')) throw new Error('404'); fs.writeFileSync(dest, p.remote.get(url)); } }), /404/);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});
