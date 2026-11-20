const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApiTokens, SCOPES, allowsInstance, hasScope } = require('../modules/api-tokens');
const { createEventHub, diffStatus } = require('../modules/api-events');
const { createWebhooks, verifySignature } = require('../modules/api-webhooks');

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'api-')), name);

test('a created token verifies, and only its hash is on disk', () => {
  const file = tmp('tokens.json');
  const tokens = createApiTokens({ file });
  const made = tokens.create({ name: 'bot', scopes: ['read', 'power'] });
  assert.match(made.token, /^mmk_[a-f0-9]{16}_[A-Za-z0-9_-]{32}$/);
  const secret = made.token.split('_').slice(2).join('_');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(secret), 'the secret is not stored');
  const checked = tokens.verify(made.token);
  assert.strictEqual(checked.name, 'bot');
  assert.deepStrictEqual(checked.scopes, ['read', 'power']);
  assert.ok(!('hash' in checked));
  assert.strictEqual(hasScope(checked, 'power'), true);
  assert.strictEqual(hasScope(checked, 'files'), false);
});

test('wrong, malformed and revoked tokens are refused', () => {
  const tokens = createApiTokens({ file: tmp('tokens.json') });
  const made = tokens.create({ name: 'bot', scopes: ['read'] });
  assert.strictEqual(tokens.verify(made.token.slice(0, -1) + (made.token.endsWith('A') ? 'B' : 'A')), null);
  assert.strictEqual(tokens.verify('nonsense'), null);
  assert.strictEqual(tokens.verify(''), null);
  assert.strictEqual(tokens.verify(undefined), null);
  assert.strictEqual(tokens.revoke(made.id), true);
  assert.strictEqual(tokens.verify(made.token), null);
  assert.strictEqual(tokens.revoke(made.id), false);
});

test('tokens expire, remember their last use and survive a restart', () => {
  const file = tmp('tokens.json');
  let clock = 1000000;
  const tokens = createApiTokens({ file, now: () => clock });
  const made = tokens.create({ name: 'short', scopes: ['read'], expiresInDays: 1 });
  assert.ok(tokens.verify(made.token));
  assert.strictEqual(tokens.list()[0].lastUsedAt, clock);
  const again = createApiTokens({ file, now: () => clock });
  assert.ok(again.verify(made.token), 'the token is still known after a reload');
  clock += 2 * 86400000;
  assert.strictEqual(again.verify(made.token), null, 'expired');
});

test('token input is checked', () => {
  const tokens = createApiTokens({ file: tmp('tokens.json') });
  assert.throws(() => tokens.create({ name: '', scopes: ['read'] }), /name/);
  assert.throws(() => tokens.create({ name: 'x', scopes: [] }), /scope/);
  assert.throws(() => tokens.create({ name: 'x', scopes: ['root'] }), /unknown scope/);
  assert.throws(() => tokens.create({ name: 'x', scopes: ['read'], instances: 'a' }), /instances/);
  assert.throws(() => tokens.create({ name: 'x', scopes: ['read'], expiresInDays: 0 }), /expiry/);
  assert.ok(Object.keys(SCOPES).includes('events'));
});

test('an instance list limits a token, an empty one does not', () => {
  const tokens = createApiTokens({ file: tmp('tokens.json') });
  const all = tokens.verify(tokens.create({ name: 'a', scopes: ['read'] }).token);
  const some = tokens.verify(tokens.create({ name: 'b', scopes: ['read'], instances: ['survival'] }).token);
  assert.strictEqual(allowsInstance(all, 'anything'), true);
  assert.strictEqual(allowsInstance(some, 'survival'), true);
  assert.strictEqual(allowsInstance(some, 'creative'), false);
});

test('the event hub numbers events, replays after an id and drops old ones', () => {
  const hub = createEventHub({ buffer: 3, now: () => 5 });
  const seen = [];
  const off = hub.subscribe((e) => seen.push(e.type));
  for (const type of ['a', 'b', 'c', 'd']) hub.publish(type, { instance: 'x' });
  assert.deepStrictEqual(seen, ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(hub.since(2).map((e) => e.type), ['c', 'd']);
  assert.deepStrictEqual(hub.since(0).map((e) => e.id), [2, 3, 4], 'the buffer keeps the last three');
  off();
  hub.publish('e');
  assert.strictEqual(seen.length, 4);
  assert.strictEqual(hub.size(), 0);
});

test('status snapshots become events, the first one only sets the baseline', () => {
  const off = { running: false, phase: 'offline', lagCount: 0, crashAt: null };
  assert.deepStrictEqual(diffStatus(null, off), []);
  const starting = { running: true, phase: 'starting', lagCount: 0, crashAt: null };
  const ready = { ...starting, phase: 'ready' };
  const stopping = { ...ready, phase: 'stopping' };
  assert.deepStrictEqual(diffStatus(off, starting).map((e) => e.type), ['server.starting']);
  assert.deepStrictEqual(diffStatus(starting, ready).map((e) => e.type), ['server.ready']);
  assert.deepStrictEqual(diffStatus(ready, stopping).map((e) => e.type), ['server.stopping']);
  assert.deepStrictEqual(diffStatus(stopping, off).map((e) => e.type), ['server.stopped']);
  assert.deepStrictEqual(diffStatus(ready, { ...off, crashAt: 99 }).map((e) => e.type), ['server.crashed']);
  assert.deepStrictEqual(diffStatus(ready, ready), []);
  const lagged = { ...ready, lagCount: 1, lag: { delayMs: 6720, ticksBehind: 134 } };
  assert.deepStrictEqual(diffStatus(ready, lagged), [{ type: 'server.lag', delayMs: 6720, ticksBehind: 134 }]);
});

function hooksRig(responses) {
  const calls = [];
  const queue = [...responses];
  const hooks = createWebhooks({
    file: tmp('hooks.json'), now: () => 1700000000000, backoffMs: [1, 1], wait: async () => {},
    post: async (url, req) => { calls.push({ url, ...req }); const next = queue.shift(); if (next instanceof Error) throw next; return { status: next ?? 200 }; },
  });
  return { hooks, calls };
}

test('a webhook is validated and its secret is shown only when it is created', () => {
  const { hooks } = hooksRig([]);
  assert.throws(() => hooks.add({ url: 'ftp://x/y' }), /http/);
  assert.throws(() => hooks.add({ url: 'nonsense' }), /not valid/);
  assert.throws(() => hooks.add({ url: 'http://user:pw@example.com/' }), /user name/);
  assert.throws(() => hooks.add({ url: 'http://example.com/', events: ['server.exploded'] }), /unknown event/);
  const made = hooks.add({ url: 'https://example.com/hook', events: ['server.ready'], name: 'chat' });
  assert.match(made.secret, /^whsec_/);
  assert.ok(!('secret' in hooks.list()[0]));
  assert.deepStrictEqual(hooks.list()[0].events, ['server.ready']);
});

test('an event is delivered signed to the hooks that want it', async () => {
  const { hooks, calls } = hooksRig([200, 200]);
  const wanted = hooks.add({ url: 'http://example.com/a', events: ['server.ready'] });
  hooks.add({ url: 'http://example.com/b', events: ['server.crashed'] });
  await hooks.deliver({ id: 1, at: 1, type: 'server.ready', instance: 'survival' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://example.com/a');
  assert.strictEqual(calls[0].headers['X-Meowmarism-Event'], 'server.ready');
  const { 'X-Meowmarism-Timestamp': ts, 'X-Meowmarism-Signature': sig } = calls[0].headers;
  assert.strictEqual(verifySignature(wanted.secret, ts, calls[0].body, sig), true);
  assert.strictEqual(verifySignature(wanted.secret, ts, calls[0].body + 'x', sig), false);
  assert.strictEqual(JSON.parse(calls[0].body).instance, 'survival');
  assert.strictEqual(hooks.list()[0].lastStatus, 200);
});

test('a failing receiver is retried, and a failure is counted until it works again', async () => {
  const { hooks, calls } = hooksRig([500, new Error('refused'), 503, 200]);
  hooks.add({ url: 'http://example.com/a' });
  await hooks.deliver({ id: 1, at: 1, type: 'server.lag' });
  assert.strictEqual(calls.length, 3, 'one try and two retries');
  assert.strictEqual(hooks.list()[0].failures, 1);
  await hooks.deliver({ id: 2, at: 2, type: 'server.lag' });
  assert.strictEqual(hooks.list()[0].failures, 0);
  assert.strictEqual(hooks.list()[0].lastStatus, 200);
});

test('a test delivery and removal work by id', async () => {
  const { hooks, calls } = hooksRig([200]);
  const made = hooks.add({ url: 'http://example.com/a', events: ['server.crashed'] });
  assert.strictEqual(await hooks.test(made.id), true);
  assert.strictEqual(calls[0].headers['X-Meowmarism-Event'], 'webhook.test');
  assert.strictEqual(await hooks.test('missing'), null);
  assert.strictEqual(hooks.remove(made.id), true);
  assert.deepStrictEqual(hooks.list(), []);
});

test('optional features are saved by name and survive a reload and a plain trust-proxy save', () => {
  const { createPanelSettings } = require('../modules/panel-settings');
  const file = tmp('settings.json');
  const settings = createPanelSettings({ file });
  assert.strictEqual(settings.feature('api'), false);
  settings.save({ ...settings.load(), features: { api: true, junk: 'yes' } });
  assert.strictEqual(settings.feature('api'), true);
  assert.deepStrictEqual(settings.load().features, { api: true });
  settings.save({ trustProxy: true });
  assert.strictEqual(createPanelSettings({ file }).feature('api'), true, 'a save without features keeps them');
  assert.strictEqual(createPanelSettings({ file }).load().trustProxy, true);
});

test('a token can be edited and renewed; renewing replaces the secret and keeps the settings', () => {
  let clock = 1000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apiedit-'));
  const tokens = createApiTokens({ file: path.join(dir, 't.json'), now: () => clock });
  const made = tokens.create({ name: 'bot', scopes: ['read'], expiresInDays: 30 });
  const edited = tokens.update(made.id, { name: 'bot2', scopes: ['read', 'power'], instances: ['a'] });
  assert.deepStrictEqual([edited.name, edited.scopes, edited.instances, edited.expiresAt], ['bot2', ['read', 'power'], ['a'], made.expiresAt]);
  assert.strictEqual(tokens.update(made.id, { expiresInDays: null }).expiresAt, null);
  assert.throws(() => tokens.update(made.id, { scopes: [] }), /scope/);
  assert.strictEqual(tokens.update('nope', {}), null);
  assert.ok(tokens.verify(made.token), 'the secret still works after an edit');
  clock = 5000;
  const renewed = tokens.renew(made.id);
  assert.notStrictEqual(renewed.token, made.token);
  assert.strictEqual(tokens.verify(made.token), null);
  assert.deepStrictEqual([tokens.verify(renewed.token).id, tokens.verify(renewed.token).renewedAt], [made.id, 5000]);
  assert.strictEqual(tokens.renew('nope'), null);
});
