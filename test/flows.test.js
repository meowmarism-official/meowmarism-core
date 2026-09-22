const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scheduler = require('../modules/scheduler');
const { runTask } = require('../modules/schedule-run');
const { createBackups } = require('../modules/backup');

const unix = { skip: process.platform === 'win32' ? 'needs GNU tar' : false };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meow-flow-'));
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (p) => fs.readFileSync(p, 'utf8');

// ---- backup and restore on a small fake world

function backupSetup(files) {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) write(path.join(dir, name), text);
  const lines = [];
  const commands = [];
  const deps = {
    broadcast: (line) => lines.push(line),
    broadcastEvent: () => {},
    pushTimeline: () => {},
    runtime: { isReady: () => false, isRunning: () => false, command: (c) => commands.push(c), stopAndWait: async () => {} },
  };
  const api = createBackups({ SERVER_DIR: dir, WORLD_DIR: path.join(dir, 'world'), BACKUP_DIR: path.join(dir, 'backups'), panelConfig: { backupMinFreeGB: 0 } });
  return { dir, api, deps, lines, commands };
}

test('backup then restore brings the original world back', unix, async () => {
  const s = backupSetup({ 'world/level.dat': 'original level', 'world/region/r.0.0.mca': 'chunk data', 'server.properties': 'level-name=world\n' });
  assert.equal(await s.api.createBackup('test', s.deps), true);
  const [backup] = s.api.listBackups();
  assert.ok(backup, 'a backup file exists');
  write(path.join(s.dir, 'world/level.dat'), 'damaged');
  fs.rmSync(path.join(s.dir, 'world/region'), { recursive: true });
  await s.api.restoreBackup(backup.name, s.deps);
  assert.equal(read(path.join(s.dir, 'world/level.dat')), 'original level');
  assert.equal(read(path.join(s.dir, 'world/region/r.0.0.mca')), 'chunk data');
  assert.ok(fs.readdirSync(s.dir).some((n) => n.startsWith('world.pre-restore-')), 'the damaged world is kept aside');
});

test('a Paper world with Nether and End is backed up and restored as a whole', unix, async () => {
  const s = backupSetup({ 'server.properties': 'level-name=survival\n', 'survival/level.dat': 'overworld', 'survival_nether/DIM-1/x': 'nether', 'survival_the_end/DIM1/x': 'end' });
  assert.equal(await s.api.createBackup('test', s.deps), true);
  for (const n of ['survival', 'survival_nether', 'survival_the_end']) fs.rmSync(path.join(s.dir, n), { recursive: true });
  await s.api.restoreBackup(s.api.listBackups()[0].name, s.deps);
  assert.equal(read(path.join(s.dir, 'survival/level.dat')), 'overworld');
  assert.equal(read(path.join(s.dir, 'survival_nether/DIM-1/x')), 'nether');
  assert.equal(read(path.join(s.dir, 'survival_the_end/DIM1/x')), 'end');
});

test('a backup of a running server flushes the world first and turns saving back on', unix, async () => {
  const s = backupSetup({ 'world/level.dat': 'x' });
  s.deps.runtime.isReady = () => true;
  await s.api.createBackup('test', s.deps);
  assert.deepEqual(s.commands, ['save-off', 'save-all flush', 'save-on']);
});

test('a failed restore rolls the previous world back', unix, async () => {
  const s = backupSetup({ 'world/level.dat': 'keep me' });
  await s.api.createBackup('test', s.deps);
  const [backup] = s.api.listBackups();
  fs.writeFileSync(path.join(s.dir, 'backups', backup.name), 'this is not an archive');
  write(path.join(s.dir, 'world/level.dat'), 'current world');
  await assert.rejects(s.api.restoreBackup(backup.name, s.deps));
  assert.equal(read(path.join(s.dir, 'world/level.dat')), 'current world');
});

test('a backup name cannot point outside the backup folder', async () => {
  const s = backupSetup({ 'world/level.dat': 'x' });
  await assert.rejects(s.api.restoreBackup('../../etc/passwd', s.deps), /invalid backup name/);
});

// ---- scheduler with an injected clock

const at = (hh, mm, day = 15) => new Date(2026, 8, day, hh, mm, 0).getTime();
const task = (over) => ({ id: 'a', name: 't', enabled: true, createdAt: at(0, 0, 1), lastRunAt: null, trigger: { type: 'daily', time: '04:00' }, action: { type: 'backup' }, ...over });

test('scheduler: a daily task is due after its time and only once', () => {
  assert.equal(scheduler.isDue(task(), at(3, 59)), false);
  assert.equal(scheduler.isDue(task(), at(4, 0)), true);
  assert.equal(scheduler.isDue(task({ lastRunAt: at(4, 0) }), at(4, 5)), false);
  assert.equal(scheduler.isDue(task(), at(4, 30)), false, 'too late: the grace period is over');
});

test('scheduler: interval tasks count from the last run', () => {
  const t = task({ trigger: { type: 'interval', everyMinutes: 30 }, lastRunAt: at(10, 0) });
  assert.equal(scheduler.isDue(t, at(10, 29)), false);
  assert.equal(scheduler.isDue(t, at(10, 30)), true);
  assert.equal(scheduler.nextRunAt(t, at(10, 5)), at(10, 30));
});

test('scheduler: weekly tasks only run on their days and disabled tasks never', () => {
  const day = new Date(at(4, 0)).getDay();
  assert.equal(scheduler.isDue(task({ trigger: { type: 'weekly', time: '04:00', days: [day] } }), at(4, 0)), true);
  assert.equal(scheduler.isDue(task({ trigger: { type: 'weekly', time: '04:00', days: [(day + 1) % 7] } }), at(4, 0)), false);
  assert.equal(scheduler.isDue(task({ enabled: false }), at(4, 0)), false);
  assert.equal(scheduler.nextRunAt(task({ enabled: false }), at(3, 0)), null);
});

test('scheduler: every action type runs what it says', () => {
  const calls = [];
  const runtime = {
    isRunning: () => true, start: () => calls.push('start'), stop: () => calls.push('stop'), restart: () => calls.push('restart'),
    command: (c) => { calls.push(`command:${c}`); return true; },
  };
  const ctx = { runtime, createBackup: (reason) => calls.push(`backup:${reason}`), restart: (sec) => calls.push(`restart-in:${sec}`), onError: () => {} };
  for (const action of [{ type: 'backup' }, { type: 'restart', warnSec: 0 }, { type: 'stop', warnSec: 0 }, { type: 'start' }, { type: 'command', command: 'say hi' }]) runTask(task({ action }), ctx);
  assert.ok(calls.some((c) => c.startsWith('backup')), calls.join());
  assert.ok(calls.some((c) => c.startsWith('restart')), calls.join());
  assert.ok(calls.includes('command:say hi'), calls.join());
});

test('scheduler: the capability an action needs is fixed', () => {
  const needs = { backup: 'backups', restart: 'power', stop: 'power', start: 'power', command: 'console' };
  assert.deepEqual(scheduler.ACTION_CAP, needs);
});

test('a failing world flush still turns saving back on and ends the backup', unix, async () => {
  const s = backupSetup({ 'world/level.dat': 'x' });
  s.deps.runtime.isReady = () => true;
  s.deps.runtime.command = (c) => { s.commands.push(c); if (c === 'save-all flush') throw new Error('rcon dropped'); };
  assert.equal(await s.api.createBackup('test', s.deps), false);
  assert.deepEqual(s.commands, ['save-off', 'save-all flush', 'save-on']);
  assert.equal(s.api.state.backupInProgress, false);
  assert.match(s.api.state.lastBackupError, /rcon dropped/);
  assert.ok(s.lines.some((l) => l.includes('backup failed')));
});

test('a failing save-off does not send save-on and ends the backup', unix, async () => {
  const s = backupSetup({ 'world/level.dat': 'x' });
  s.deps.runtime.isReady = () => true;
  s.deps.runtime.command = (c) => { s.commands.push(c); throw new Error('rcon down'); };
  assert.equal(await s.api.createBackup('test', s.deps), false);
  assert.deepEqual(s.commands, ['save-off']);
  assert.equal(s.api.state.backupInProgress, false);
});

test('reporting problems after the archive was written do not leave saving off or the backup running', unix, async () => {
  const s = backupSetup({ 'world/level.dat': 'x' });
  s.deps.runtime.isReady = () => true;
  s.deps.pushTimeline = () => { throw new Error('timeline broke'); };
  assert.equal(await s.api.createBackup('test', s.deps), true, 'the archive exists, so the backup counts');
  assert.equal(s.commands[s.commands.length - 1], 'save-on');
  assert.equal(s.api.state.backupInProgress, false);
  assert.equal(s.api.listBackups().length, 1);
});

test('a backup that cannot start a tar process ends cleanly', unix, async () => {
  const s = backupSetup({ 'world/level.dat': 'x' });
  s.deps.runtime.isReady = () => true;
  const saved = process.env.PATH;
  process.env.PATH = path.join(s.dir, 'no-such-bin');
  try { assert.equal(await s.api.createBackup('test', s.deps), false); } finally { process.env.PATH = saved; }
  assert.deepEqual(s.commands, ['save-off', 'save-all flush', 'save-on']);
  assert.equal(s.api.state.backupInProgress, false);
  assert.ok(s.api.state.lastBackupError);
});
