const test = require('node:test');
const assert = require('node:assert');
const p = require('../modules/proxy');

// Shape of a velocity.toml as Velocity 3.4 writes it.
const TOML = `# Config version. Do not change this
config-version = "2.7"

# bind
bind = "0.0.0.0:25565"

motd = "<#09add3>A Velocity Server"

# Should we forward IP addresses and other data to backend servers?
player-info-forwarding-mode = "NONE"
forwarding-secret-file = "forwarding.secret"

[servers]
# Configure your servers here.
lobby = "127.0.0.1:30066"
factions = "127.0.0.1:30067"

# In what order we should try servers when a player logs in or is kicked from a server.
try = [
    "lobby"
]

[forced-hosts]
# Configure your forced hosts here.
"lobby.example.com" = [
    "lobby"
]
"factions.example.com" = [
    "factions"
]

[advanced]
compression-threshold = 256
`;

test('the bind port is read and changed without touching other keys', () => {
  assert.strictEqual(p.readBindPort(TOML), 25565);
  const out = p.withBindPort(TOML, 25570);
  assert.strictEqual(p.readBindPort(out), 25570);
  assert.match(out, /bind = "0\.0\.0\.0:25570"/);
  assert.match(out, /motd = "<#09add3>A Velocity Server"/);
  assert.strictEqual(p.withBindPort('motd = "x"\n[servers]\n', 25566).split('\n')[1], 'bind = "0.0.0.0:25566"');
});

test('the forwarding mode is set at the top level only', () => {
  const out = p.withForwardingMode(TOML, 'modern');
  assert.strictEqual(p.readForwardingMode(out), 'modern');
  assert.strictEqual(out.split('player-info-forwarding-mode').length, 2);
});

test('servers and the try order replace the default sections', () => {
  const out = p.withServers(TOML, [{ name: 'survival', host: '127.0.0.1', port: 25566 }, { name: 'creative', host: '127.0.0.1', port: 25567 }], ['creative', 'survival', 'gone']);
  assert.deepStrictEqual(p.readServers(out), {
    servers: [{ name: 'survival', host: '127.0.0.1', port: 25566 }, { name: 'creative', host: '127.0.0.1', port: 25567 }],
    tryOrder: ['creative', 'survival'],
  });
  assert.ok(!out.includes('factions = '), 'the sample servers are gone');
  assert.match(out, /\[forced-hosts\]/);
  assert.match(out, /\[advanced\]\ncompression-threshold = 256/, 'later sections stay intact');
});

test('forced hosts keep only known servers and are rewritten whole', () => {
  const servers = p.withServers(TOML, [{ name: 'survival', host: '127.0.0.1', port: 25566 }], ['survival']);
  const out = p.withForcedHosts(servers, { 'play.example.com': ['survival'], 'old.example.com': ['gone'] }, ['survival']);
  assert.match(out, /"play\.example\.com" = \["survival"\]/);
  assert.ok(!out.includes('old.example.com') && !out.includes('lobby.example.com'));
  assert.match(out, /\[advanced\]/);
  assert.throws(() => p.withForcedHosts(servers, { 'bad host': ['survival'] }, ['survival']), /invalid host/);
});

test('server names and addresses are validated', () => {
  assert.throws(() => p.withServers(TOML, [{ name: 'a b', host: '127.0.0.1', port: 1 }], []), /invalid server name/);
  assert.throws(() => p.withServers(TOML, [{ name: 'a', host: '127.0.0.1"\n[x]', port: 1 }], []), /invalid address/);
  assert.throws(() => p.withServers(TOML, [{ name: 'a', host: '127.0.0.1', port: 70000 }], []), /invalid address/);
});

test('a section that does not exist yet is added', () => {
  const out = p.withServers('bind = "0.0.0.0:25565"\n', [{ name: 'a', host: '127.0.0.1', port: 25566 }], ['a']);
  assert.deepStrictEqual(p.readServers(out).servers, [{ name: 'a', host: '127.0.0.1', port: 25566 }]);
});

test('Windows line endings are kept', () => {
  const crlf = TOML.replace(/\n/g, '\r\n');
  const out = p.withServers(p.withBindPort(crlf, 25570), [{ name: 'a', host: '127.0.0.1', port: 25566 }], ['a']);
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF appeared');
  assert.strictEqual(p.readBindPort(out), 25570);
});

const PAPER = `# Paper Global Configuration
_version: 29
proxies:
  bungee-cord:
    online-mode: true
  proxy-protocol: false
  velocity:
    enabled: false
    online-mode: true
    secret: ''
timings:
  enabled: true
`;

test('Paper velocity forwarding is enabled with the secret and nothing else changes', () => {
  const out = p.withPaperVelocity(PAPER, { secret: 'abc123' });
  assert.deepStrictEqual(p.readPaperVelocity(out), { enabled: true, secret: 'abc123' });
  assert.match(out, /bungee-cord:\n {4}online-mode: true/);
  assert.match(out, /timings:\n {2}enabled: true/);
  assert.deepStrictEqual(p.readPaperVelocity(p.withPaperVelocity(out, { secret: 'abc123', enabled: false })), { enabled: false, secret: 'abc123' });
  assert.strictEqual(p.withPaperVelocity('nothing: here\n', { secret: 'x' }), null);
});

test('a server behind the proxy listens locally without Mojang login, and is restored when unlinked', () => {
  const on = p.withBackendProperties('motd=hi\nonline-mode=true\nserver-ip=\n', { behind: true });
  assert.match(on, /online-mode=false/);
  assert.match(on, /server-ip=127\.0\.0\.1/);
  assert.match(on, /motd=hi/);
  const off = p.withBackendProperties(on, { behind: false });
  assert.match(off, /online-mode=true/);
  assert.match(off, /server-ip=\n/);
});

test('new secrets are random and URL safe', () => {
  const a = p.newSecret();
  assert.match(a, /^[A-Za-z0-9_-]{12}$/);
  assert.notStrictEqual(a, p.newSecret());
});
