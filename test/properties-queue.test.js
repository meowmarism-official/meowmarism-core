const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProperties } = require('../modules/properties');

function setup({ running }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'props-queue-'));
  const file = path.join(dir, 'server.properties');
  const queueFile = path.join(dir, 'panel-queued-settings.json');
  fs.writeFileSync(file, 'pvp=true\nmax-players=20\nmotd=hello\nwhite-list=false\n');
  const state = { running, commands: [] };
  const props = createProperties({ file, queueFile, isRunning: () => state.running, command: (c) => state.commands.push(c) });
  const fileText = () => fs.readFileSync(file, 'utf8');
  return { dir, file, queueFile, state, props, fileText };
}

test('a restart setting changed on a running server is queued, not written', () => {
  const t = setup({ running: true });
  const state = t.props.apply({ 'max-players': 50 });
  assert.match(t.fileText(), /^max-players=20$/m);
  assert.deepStrictEqual(state.queued['max-players'], { value: 50, active: 20 });
  assert.strictEqual(state.values['max-players'], 50);
  assert.ok(state.pendingRestart.includes('max-players'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(t.queueFile, 'utf8')), { 'max-players': 50 });
});

test('the queue survives a panel restart', () => {
  const t = setup({ running: true });
  t.props.apply({ pvp: false });
  const again = createProperties({ file: t.file, queueFile: t.queueFile, isRunning: () => true, command: () => {} });
  assert.strictEqual(again.state().queued.pvp.value, false);
});

test('applyQueued writes the queue into server.properties and empties it', () => {
  const t = setup({ running: true });
  t.props.apply({ 'max-players': 50, pvp: false });
  const result = t.props.applyQueued();
  assert.strictEqual(result.count, 2);
  assert.match(t.fileText(), /^max-players=50$/m);
  assert.match(t.fileText(), /^pvp=false$/m);
  assert.deepStrictEqual(t.props.state().queued, {});
  assert.strictEqual(fs.existsSync(t.queueFile), false);
  assert.strictEqual(t.props.applyQueued().count, 0);
});

test('setting a queued value back to the active one drops it from the queue', () => {
  const t = setup({ running: true });
  t.props.apply({ 'max-players': 50 });
  t.props.apply({ 'max-players': 20 });
  assert.deepStrictEqual(t.props.state().queued, {});
});

test('a stopped server writes straight away and clears an older queued value', () => {
  const t = setup({ running: true });
  t.props.apply({ 'max-players': 50 });
  t.state.running = false;
  const state = t.props.apply({ 'max-players': 30 });
  assert.match(t.fileText(), /^max-players=30$/m);
  assert.deepStrictEqual(state.queued, {});
});

test('live settings and the MOTD-style text settings keep their own paths', () => {
  const t = setup({ running: true });
  t.props.apply({ 'white-list': true });
  assert.match(t.fileText(), /^white-list=true$/m);
  assert.deepStrictEqual(t.state.commands, ['whitelist on']);
  assert.deepStrictEqual(t.props.state().queued, {});
});

test('discardQueued removes one key or everything', () => {
  const t = setup({ running: true });
  t.props.apply({ 'max-players': 50, pvp: false });
  assert.deepStrictEqual(Object.keys(t.props.discardQueued(['pvp']).queued), ['max-players']);
  assert.deepStrictEqual(t.props.discardQueued().queued, {});
  assert.strictEqual(fs.existsSync(t.queueFile), false);
  assert.match(t.fileText(), /^pvp=true$/m);
});

test('without a queue file the old behaviour stays: write at once and mark restart pending', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'props-legacy-'));
  const file = path.join(dir, 'server.properties');
  fs.writeFileSync(file, 'max-players=20\n');
  const props = createProperties({ file, isRunning: () => true, command: () => {} });
  const state = props.apply({ 'max-players': 50 });
  assert.match(fs.readFileSync(file, 'utf8'), /^max-players=50$/m);
  assert.ok(state.pendingRestart.includes('max-players'));
  assert.deepStrictEqual(state.queued, {});
});

test('an invalid value is refused before anything is queued', () => {
  const t = setup({ running: true });
  assert.throws(() => t.props.apply({ 'max-players': -5 }));
  assert.deepStrictEqual(t.props.state().queued, {});
});
