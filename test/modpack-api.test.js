const test = require('node:test');
const assert = require('node:assert');

const { createModpackApi } = require('../modules/modpack-api');

const SERVER_FACET = ['client_and_server', 'server_only', 'server_only_client_optional', 'dedicated_server_only', 'client_only_server_optional', 'client_or_server', 'client_or_server_prefers_both'].map((e) => `environment:${e}`);
const API = 'https://api.modrinth.com/v2';
function fake(answers) {
  const calls = [];
  const request = async (method, url) => {
    calls.push(url);
    const key = Object.keys(answers).find((k) => url.startsWith(`${API}${k}`));
    if (!key) throw new Error(`unexpected request ${url}`);
    return typeof answers[key] === 'function' ? answers[key](url) : answers[key];
  };
  return { api: createModpackApi({ request }), calls };
}
const version = (over = {}) => ({
  id: 'v1', project_id: 'p1', environment: 'client_and_server', name: 'Pack 1.0', version_number: '1.0', version_type: 'release', game_versions: ['1.21.1'], loaders: ['neoforge', 'mrpack'],
  date_published: '2026-01-01', downloads: 5,
  files: [{ primary: true, filename: 'pack.mrpack', url: 'https://cdn.modrinth.com/data/p1/versions/v1/pack.mrpack', size: 1234, hashes: { sha512: 'a'.repeat(128) } }],
  ...over,
});

test('search asks for server-capable modpacks and maps the hits', async () => {
  const { api, calls } = fake({ '/search': { total_hits: 1, hits: [{ project_id: 'p1', slug: 'atm', title: 'ATM', description: 'd', icon_url: 'https://cdn.modrinth.com/i.png', author: 'a', downloads: 9, follows: 2, display_categories: ['neoforge'], versions: ['1.21.1'], date_modified: 'x' }] } });
  const r = await api.searchModpacks({ query: 'all the mods', loader: 'neoforge', mcVersion: '1.21.1', sort: 'downloads', offset: 20 });
  assert.equal(r.total, 1);
  assert.deepEqual([r.hits[0].id, r.hits[0].title, r.hits[0].icon, r.hits[0].mcVersions], ['p1', 'ATM', 'https://cdn.modrinth.com/i.png', ['1.21.1']]);
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('query'), 'all the mods');
  assert.equal(url.searchParams.get('index'), 'downloads');
  assert.equal(url.searchParams.get('offset'), '20');
  assert.deepEqual(JSON.parse(url.searchParams.get('facets')), [['project_type:modpack'], SERVER_FACET, ['categories:neoforge'], ['versions:1.21.1']]);
});

test('search ignores unknown sorts and loaders and rejects odd Minecraft versions', async () => {
  const { api, calls } = fake({ '/search': { hits: [] } });
  await api.searchModpacks({ sort: 'evil', loader: 'nope', offset: -5 });
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('index'), 'relevance');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.deepEqual(JSON.parse(url.searchParams.get('facets')), [['project_type:modpack'], SERVER_FACET]);
  await assert.rejects(api.searchModpacks({ mcVersion: '1.21"]],["x' }), /invalid Minecraft version/);
});

test('getModpack returns details and refuses other project types and odd ids', async () => {
  const { api } = fake({ '/project/atm': { id: 'p1', slug: 'atm', title: 'ATM', project_type: 'modpack', description: 'd', game_versions: ['1.21.1'], loaders: ['neoforge', 'mrpack'], server_side: 'required' }, '/project/sodium': { project_type: 'mod' } });
  const p = await api.getModpack('atm');
  assert.deepEqual([p.id, p.loaders, p.serverSide], ['p1', ['neoforge'], 'required']);
  await assert.rejects(api.getModpack('sodium'), /not a modpack/);
  await assert.rejects(api.getModpack('../users'), /invalid modpack id/);
});

test('getVersions offers only versions with a verifiable .mrpack on the Modrinth CDN', async () => {
  const bad = [
    version({ id: 'nofile', files: [] }),
    version({ id: 'clientonly', environment: 'client_only' }),
    version({ id: 'single', environment: 'singleplayer_only' }),
    version({ id: 'unknown', environment: 'unknown' }),
    version({ id: 'noenv', environment: undefined }),
    version({ id: 'nohash', files: [{ primary: true, filename: 'a.mrpack', url: 'https://cdn.modrinth.com/a.mrpack', size: 1, hashes: {} }] }),
    version({ id: 'otherhost', files: [{ primary: true, filename: 'a.mrpack', url: 'https://evil.example/a.mrpack', size: 1, hashes: { sha512: 'a'.repeat(128) } }] }),
    version({ id: 'http', files: [{ primary: true, filename: 'a.mrpack', url: 'http://cdn.modrinth.com/a.mrpack', size: 1, hashes: { sha512: 'a'.repeat(128) } }] }),
    version({ id: 'zip', files: [{ primary: true, filename: 'a.zip', url: 'https://cdn.modrinth.com/a.zip', size: 1, hashes: { sha512: 'a'.repeat(128) } }] }),
  ];
  const { api, calls } = fake({ '/project/p1/version': [version(), ...bad] });
  const list = await api.getVersions('p1', { loader: 'neoforge', mcVersion: '1.21.1' });
  assert.deepEqual(list.map((v) => v.id), ['v1']);
  assert.equal(list[0].environment, 'client_and_server');
  assert.deepEqual(list[0].file, { url: 'https://cdn.modrinth.com/data/p1/versions/v1/pack.mrpack', filename: 'pack.mrpack', size: 1234, sha512: 'a'.repeat(128) });
  assert.deepEqual(list[0].loaders, ['neoforge']);
  const url = new URL(calls[0]);
  assert.deepEqual(JSON.parse(url.searchParams.get('loaders')), ['neoforge']);
  assert.deepEqual(JSON.parse(url.searchParams.get('game_versions')), ['1.21.1']);
});

test('getVersion returns one installable version or refuses', async () => {
  const { api } = fake({ '/version/v1': version(), '/version/v2': version({ files: [] }) });
  assert.equal((await api.getVersion('v1')).versionNumber, '1.0');
  await assert.rejects(api.getVersion('v2'), /no installable modpack file/);
});
