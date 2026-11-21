const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('../modules/proxy-network');
const proxy = require('../modules/proxy');

const TOML = 'config-version = "2.7"\nbind = "0.0.0.0:25565"\nplayer-info-forwarding-mode = "NONE"\n\n[servers]\nlobby = "127.0.0.1:30066"\ntry = [\n    "lobby"\n]\n\n[forced-hosts]\n"lobby.example.com" = [\n    "lobby"\n]\n\n[advanced]\ncompression-threshold = 256\n';
const PAPER = '_version: 29\nproxies:\n  bungee-cord:\n    online-mode: true\n  velocity:\n    enabled: false\n    online-mode: true\n    secret: \'\'\n';

function rig({ started = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnet-'));
  const make = (name, extra) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    if (started) fs.writeFileSync(path.join(dir, 'config', 'paper-global.yml'), PAPER);
    fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=x\nonline-mode=true\n');
    return { name, dir, loader: 'paper', mcVersion: '1.21.1', port: 25566, ...extra };
  };
  const proxyDir = path.join(root, 'proxy');
  fs.mkdirSync(proxyDir);
  fs.writeFileSync(path.join(proxyDir, 'velocity.toml'), TOML);
  fs.writeFileSync(path.join(proxyDir, 'forwarding.secret'), 'sharedsecret');
  return { root, proxyDir, make };
}

test('only Paper and Purpur from 1.19 are set up automatically', () => {
  assert.strictEqual(net.backendSupport({ loader: 'paper', mcVersion: '1.21.1' }).supported, true);
  assert.strictEqual(net.backendSupport({ loader: 'purpur', mcVersion: '26.1.2' }).supported, true);
  assert.match(net.backendSupport({ loader: 'paper', mcVersion: '1.18.2' }).reason, /1\.19/);
  assert.match(net.backendSupport({ loader: 'fabric', mcVersion: '1.21.1' }).reason, /forwarding mod/);
  assert.match(net.backendSupport({ loader: 'velocity', mcVersion: '3.4.0' }).reason, /proxy/);
});

test('linking writes the proxy and the server files with one shared secret', () => {
  const t = rig();
  const survival = t.make('survival', { port: 25566 });
  const creative = t.make('creative', { port: 25567 });
  const r = net.apply(t.proxyDir, [survival, creative], { servers: ['survival', 'creative'], tryOrder: ['creative'], forcedHosts: { 'play.example.com': ['survival'] } });
  assert.deepStrictEqual([r.errors, r.changed.sort(), r.proxyChanged], [[], ['creative', 'survival'], true]);
  const toml = fs.readFileSync(path.join(t.proxyDir, 'velocity.toml'), 'utf8');
  assert.deepStrictEqual(proxy.readServers(toml), { servers: [{ name: 'survival', host: '127.0.0.1', port: 25566 }, { name: 'creative', host: '127.0.0.1', port: 25567 }], tryOrder: ['creative'] });
  assert.strictEqual(proxy.readForwardingMode(toml), 'modern');
  assert.match(toml, /"play\.example\.com" = \["survival"\]/);
  assert.deepStrictEqual(proxy.readPaperVelocity(fs.readFileSync(path.join(survival.dir, 'config', 'paper-global.yml'), 'utf8')), { enabled: true, secret: 'sharedsecret' });
  const props = fs.readFileSync(path.join(survival.dir, 'server.properties'), 'utf8');
  assert.match(props, /online-mode=false/);
  assert.match(props, /server-ip=127\.0\.0\.1/);
});

test('applying twice changes nothing the second time', () => {
  const t = rig();
  const a = t.make('a');
  net.apply(t.proxyDir, [a], { servers: ['a'] });
  const again = net.apply(t.proxyDir, [a], { servers: ['a'] });
  assert.deepStrictEqual([again.changed, again.proxyChanged, again.errors], [[], false, []]);
});

test('unlinking restores the server and removes it from the proxy', () => {
  const t = rig();
  const a = t.make('a');
  const b = t.make('b', { port: 25567 });
  net.apply(t.proxyDir, [a, b], { servers: ['a', 'b'] });
  const r = net.apply(t.proxyDir, [a, b], { servers: ['a'] });
  assert.deepStrictEqual(r.changed, ['b']);
  assert.strictEqual(proxy.readPaperVelocity(fs.readFileSync(path.join(b.dir, 'config', 'paper-global.yml'), 'utf8')).enabled, false);
  const props = fs.readFileSync(path.join(b.dir, 'server.properties'), 'utf8');
  assert.match(props, /online-mode=true/);
  assert.match(props, /server-ip=\n/);
  assert.deepStrictEqual(proxy.readServers(fs.readFileSync(path.join(t.proxyDir, 'velocity.toml'), 'utf8')).servers.map((s) => s.name), ['a']);
});

test('a server that never ran, an unsupported one and an unknown one are reported and skipped', () => {
  const t = rig({ started: false });
  const fresh = t.make('fresh');
  const fabric = t.make('fabric', { loader: 'fabric' });
  const r = net.apply(t.proxyDir, [fresh, fabric], { servers: ['fresh', 'fabric', 'ghost'] });
  assert.deepStrictEqual(r.errors.map((e) => e.name).sort(), ['fabric', 'fresh', 'ghost']);
  assert.match(r.errors.find((e) => e.name === 'fresh').error, /start this server once/);
  assert.deepStrictEqual(proxy.readServers(fs.readFileSync(path.join(t.proxyDir, 'velocity.toml'), 'utf8')).servers, []);
  assert.ok(!/online-mode=false/.test(fs.readFileSync(path.join(fresh.dir, 'server.properties'), 'utf8')), 'nothing was changed on the server that failed');
});

test('describe shows links, the try order and drift after a port change', () => {
  const t = rig();
  const a = t.make('a', { port: 25566 });
  const b = t.make('b', { port: 25567 });
  assert.strictEqual(net.describe(t.proxyDir, [a, b]).backends.every((x) => !x.linked), true);
  net.apply(t.proxyDir, [a, b], { servers: ['a'], tryOrder: ['a'] });
  let state = net.describe(t.proxyDir, [a, b]);
  assert.deepStrictEqual(state.backends.map((x) => [x.name, x.linked, x.outOfSync]), [['a', true, false], ['b', false, false]]);
  assert.deepStrictEqual([state.tryOrder, state.port, state.ready], [['a'], 25565, true]);
  state = net.describe(t.proxyDir, [{ ...a, port: 25600 }, b]);
  assert.strictEqual(state.backends[0].outOfSync, true);
});

test('a proxy that never started cannot be configured yet', () => {
  const t = rig();
  fs.unlinkSync(path.join(t.proxyDir, 'velocity.toml'));
  assert.throws(() => net.apply(t.proxyDir, [], { servers: [] }), /start it once/);
  assert.strictEqual(net.describe(t.proxyDir, []).ready, false);
});
