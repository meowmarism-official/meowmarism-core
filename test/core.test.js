const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { createFiles } = require('../modules/files');
const { createBackups } = require('../modules/backup');
const scheduler = require('../modules/scheduler');
const { createLoginLimiter } = require('../modules/ratelimit');
const { createUsersApi } = require('../modules/users-api');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meow-core-'));

test('files: paths cannot escape the root', () => {
  const root = tmp();
  const files = createFiles({ root });
  assert.equal(files.safePath('../outside'), null);
  assert.equal(files.safePath('/etc/passwd'), null);
  assert.ok(files.safePath('sub/file.txt'));
});

test('files: symlinks pointing outside the root are rejected', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const outside = tmp();
  fs.symlinkSync(outside, path.join(root, 'link'));
  const files = createFiles({ root });
  assert.equal(files.safePath('link/secret'), null);
});

test('files: a failed upload leaves the existing file untouched', async () => {
  const root = tmp();
  const dest = path.join(root, 'server.properties');
  fs.writeFileSync(dest, 'keep=me');
  const files = createFiles({ root });
  const req = new Readable({ read() {} });
  const result = new Promise((resolve) => files.receiveUpload(req, dest, (err) => resolve(err)));
  req.push('partial');
  req.emit('aborted');
  const err = await result;
  assert.ok(err);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'keep=me');
  assert.deepEqual(fs.readdirSync(root), ['server.properties']);
});

test('files: a finished upload replaces the file atomically', async () => {
  const root = tmp();
  const dest = path.join(root, 'a.txt');
  fs.writeFileSync(dest, 'old');
  const files = createFiles({ root });
  const req = Readable.from([Buffer.from('new content')]);
  await new Promise((resolve, reject) => files.receiveUpload(req, dest, (err) => (err ? reject(err) : resolve())));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new content');
  assert.deepEqual(fs.readdirSync(root), ['a.txt']);
});

function backupsFor(dir) {
  return createBackups({ SERVER_DIR: dir, WORLD_DIR: path.join(dir, 'world'), BACKUP_DIR: path.join(dir, 'backups'), panelConfig: {} });
}

test('backup: uses level-name and finds the Paper Nether and End folders', () => {
  const dir = tmp();
  for (const n of ['survival', 'survival_nether', 'survival_the_end', 'world']) fs.mkdirSync(path.join(dir, n));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=x\nlevel-name=survival\n');
  const api = backupsFor(dir);
  assert.equal(api.levelName(), 'survival');
  assert.deepEqual(api.worldDirNames(), ['survival', 'survival_nether', 'survival_the_end']);
});

test('backup: defaults to world and ignores unsafe level names', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'world'));
  const api = backupsFor(dir);
  assert.equal(api.levelName(), 'world');
  assert.deepEqual(api.worldDirNames(), ['world']);
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=../../etc\n');
  assert.equal(api.levelName(), 'world');
});

test('scheduler: every action maps to the permission it needs', () => {
  assert.equal(scheduler.ACTION_CAP.command, 'console');
  assert.equal(scheduler.ACTION_CAP.restart, 'power');
  assert.equal(scheduler.ACTION_CAP.backup, 'backups');
});

test('login limiter: locks after repeated failures and forgets old entries', () => {
  let t = 1000;
  const limiter = createLoginLimiter(() => t);
  for (let i = 0; i < 6; i++) limiter.fail('1.2.3.4', 'alice');
  assert.equal(limiter.check('1.2.3.4', 'alice').allowed, false);
  assert.equal(limiter.check('1.2.3.4', 'bob').allowed, true);
  limiter.success('1.2.3.4', 'alice');
  assert.equal(limiter.check('1.2.3.4', 'alice').allowed, true);
});

test('users api: changing a password or removing an account ends its sessions', () => {
  const revoked = [];
  const store = {
    findUser: (name) => (name === 'owner' ? { username: 'owner', role: 'owner', settings: {} } : { username: 'bob', role: 'member', settings: {} }),
    setPassword: () => true,
    deleteMember: () => true,
    listUsers: () => [],
  };
  const api = createUsersApi({ store, session: () => ({ username: 'owner', role: 'owner' }), revokeSessions: (u) => revoked.push(u) });
  const call = (method, url, body) => new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: {} });
    const res = { writeHead() {}, end: () => resolve() };
    api.handle(req, res, new URL(url, 'http://localhost'));
  });
  return call('POST', '/api/users/bob/password', { password: 'longenough1' })
    .then(() => call('DELETE', '/api/users/bob'))
    .then(() => assert.deepEqual(revoked, ['bob', 'bob']));
});

test('updater: understands three and four number versions', () => {
  const { isNewer, newestFirst } = require('../modules/updater');
  assert.equal(isNewer('v0.1.8.1', '0.1.8'), true);
  assert.equal(isNewer('v0.1.9', '0.1.8.1'), true);
  assert.equal(isNewer('v0.1.8', '0.1.8'), false);
  assert.equal(isNewer('v0.1.8', '0.1.8.1'), false);
  assert.equal(isNewer('v0.1.10', '0.1.9'), true);
  assert.equal(isNewer('garbage', '0.1.8'), false);
  assert.deepEqual(['v0.1.8', 'v0.1.8.2', 'v0.1.8.1', 'v0.1.7'].sort(newestFirst), ['v0.1.8.2', 'v0.1.8.1', 'v0.1.8', 'v0.1.7']);
});

test('startup timer: counts from the start request to ready', async () => {
  const { createStartupTimers } = require('../modules/startup-timer');
  const timers = createStartupTimers();
  timers.begin('a');
  await new Promise((r) => setTimeout(r, 30));
  const ms = timers.ready('a', 5);
  assert.ok(ms >= 25 && ms < 1000, String(ms));
  assert.equal(timers.ready('a', 5), ms);
  timers.stopped('a');
  assert.equal(timers.info('a').readyAt, null);
  assert.equal(timers.ready('b', 7000), 7000);
});

test('server icon: accepts only 64x64 PNGs and can be reset', () => {
  const { createServerIcon } = require('../modules/server-icon');
  const dir = tmp();
  const def = path.join(dir, 'default.png');
  const png = (w, h) => {
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b.toString('base64');
  };
  fs.writeFileSync(def, 'default');
  const icon = createServerIcon({ dir, defaultIcon: def });
  assert.throws(() => icon.apply({ png: 'not a png' }), /not a PNG/);
  assert.throws(() => icon.apply({ png: png(32, 32) }), /64x64/);
  assert.equal(icon.apply({ png: png(64, 64) }), 'changed');
  assert.equal(icon.exists(), true);
  assert.equal(icon.apply({ reset: true }), 'reset to the meowmarism icon');
  assert.equal(fs.readFileSync(icon.file, 'utf8'), 'default');
});

test('files: a path behind a symlink that does not exist yet is rejected too', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const outside = tmp();
  fs.symlinkSync(outside, path.join(root, 'link'));
  const files = createFiles({ root });
  assert.equal(files.safePath('link/new/deep/file.txt'), null);
  assert.ok(files.safePath('plain/new/file.txt'));
});

test('withServerPort replaces or appends only the port line', () => {
  const { withServerPort } = require('../modules/properties');
  assert.equal(withServerPort('motd=hi\nserver-port=1111\nmax-players=7\n', 25565), 'motd=hi\nserver-port=25565\nmax-players=7\n');
  assert.equal(withServerPort('motd=hi\r\nserver-port=1111\r\nmax-players=7\r\n', 25610), 'motd=hi\r\nserver-port=25610\r\nmax-players=7\r\n');
  assert.equal(withServerPort('motd=hi', 25565), 'motd=hi\nserver-port=25565\n');
  assert.equal(withServerPort('', 25565), 'server-port=25565\n');
  assert.equal(withServerPort('x=1\nquery.port=1111\n', 25565), 'x=1\nquery.port=1111\nserver-port=25565\n');
});
