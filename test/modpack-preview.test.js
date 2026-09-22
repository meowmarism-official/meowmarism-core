const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createModpackPreview } = require('../modules/modpack-preview');
const { makeZip } = require('../test-support/zip-write');

const HASH = crypto.createHash('sha512').update('jar').digest('hex');
const pack = makeZip({
  'modrinth.index.json': JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: '4.12', name: 'ATM',
    files: [{ path: 'mods/a.jar', hashes: { sha512: HASH }, downloads: ['https://cdn.modrinth.com/data/x/a.jar'], fileSize: 3 }],
    dependencies: { minecraft: '1.21.1', neoforge: '21.1.5' },
  }),
  'overrides/run.sh': 'x',
});
const version = { id: 'v1', projectId: 'p1', versionNumber: '4.12', file: { url: 'https://cdn.modrinth.com/data/p1/v1/atm.mrpack', filename: 'atm.mrpack', size: pack.length, sha512: 'z' } };

const noEnvironments = async () => ({});

function setup(request = noEnvironments) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-prev-'));
  const calls = { version: 0, download: 0 };
  const api = { getVersion: async (id) => { calls.version++; if (id !== 'v1') throw new Error('no such version'); return version; } };
  const download = async (url, dest) => { calls.download++; fs.writeFileSync(dest, pack); };
  return { preview: createModpackPreview({ api, download, tmpRoot, request }).preview, calls, tmpRoot };
}

test('a version is described without installing anything', async () => {
  const { preview, tmpRoot } = setup();
  const s = await preview('v1');
  assert.deepEqual([s.name, s.minecraft, s.loader, s.loaderVersion, s.modCount, s.downloadBytes], ['ATM', '1.21.1', 'neoforge', '21.1.5', 1, 3]);
  assert.deepEqual(s.skipped, ['run.sh']);
  assert.equal(s.memory.recommendedMB, 3072);
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the downloaded pack is removed again');
});

test('previews are cached per version', async () => {
  const { preview, calls } = setup();
  await preview('v1');
  await preview('v1');
  assert.deepEqual(calls, { version: 1, download: 1 });
});

test('a failing download or a broken pack leaves nothing behind', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-prev-'));
  const api = { getVersion: async () => version };
  await assert.rejects(createModpackPreview({ api, request: noEnvironments, download: async () => { throw new Error('checksum mismatch'); }, tmpRoot }).preview('v1'), /checksum mismatch/);
  await assert.rejects(createModpackPreview({ api, request: noEnvironments, download: async (u, dest) => fs.writeFileSync(dest, 'not a zip at all, just text'), tmpRoot }).preview('v1'), /modpack rejected/);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test('mods Modrinth calls client-only are left out of the summary, with the reason visible', async () => {
  const asked = [];
  const { preview } = setup(async (method, url, body) => { asked.push(url); return { [HASH]: { environment: 'client_only' } }; });
  const s = await preview('v1');
  assert.deepEqual(s.environmentSkipped, [{ path: 'mods/a.jar', environment: 'client_only' }]);
  assert.equal(s.environmentSkippedCount, 1);
  assert.equal(s.modCount, 0, 'the skipped mod is not counted');
  assert.equal(s.downloadBytes, 0);
  assert.equal(s.managedCount, 1, 'run.sh is still reported as managed by Meowmarism');
  assert.ok(s.skipped.includes('mods/a.jar'));
  assert.equal(asked.length, 1);
});

test('a failing Modrinth lookup does not fail the preview', async () => {
  const { preview } = setup(async () => { throw new Error('offline'); });
  const s = await preview('v1');
  assert.equal(s.modCount, 1);
  assert.equal(s.environmentLookupFailed, true);
  assert.deepEqual(s.environmentSkipped, []);
});
