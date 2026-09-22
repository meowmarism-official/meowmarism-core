// versionInfo(): product and core are compared as two separately versioned components, with a fake
// fetchText standing in for GitHub so no real network is needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUpdater } = require('../modules/updater');

const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

// installed: { version, coreVersion, coreCommit }. remote: { releaseTag, branchCoreVersion, branchCoreCommit, branchProductVersion }.
function setup(installed, remote) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-vi-'));
  write(path.join(dir, 'package.json'), JSON.stringify({ version: installed.version }));
  write(path.join(dir, 'panel', 'build.json'), JSON.stringify({ commit: 'abc1234' }));
  if (installed.coreVersion) write(path.join(dir, 'panel', 'core', 'core.json'), JSON.stringify({ version: installed.coreVersion, commit: installed.coreCommit }));

  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (url.includes('/releases?per_page=')) return JSON.stringify(remote.releaseTag ? [{ tag_name: remote.releaseTag, draft: false, prerelease: false }] : []);
    if (url.includes('/releases/tags/')) return JSON.stringify({ published_at: '2026-01-01T00:00:00Z' });
    if (url.endsWith('/HEAD/core.lock')) {
      if (!remote.branchCoreVersion) throw new Error('404');
      return JSON.stringify({ core: 'meowmarism-core', version: remote.branchCoreVersion, commit: remote.branchCoreCommit });
    }
    if (url.endsWith('/HEAD/package.json')) return JSON.stringify({ version: remote.branchProductVersion });
    throw new Error(`unexpected url ${url}`);
  };
  const updater = createUpdater({ repo: 'meowmarism-official/test', panelDir: path.join(dir, 'panel'), statePrefix: '.meow-vi-test', fetchText });
  return { updater, calls };
}

test('state 1: an older product with an up to date core reports a product update only', async () => {
  const { updater } = setup(
    { version: '0.3.10', coreVersion: '0.0.14', coreCommit: 'a'.repeat(40) },
    { releaseTag: 'v0.3.11', branchCoreVersion: '0.0.14', branchCoreCommit: 'a'.repeat(40), branchProductVersion: '0.3.11' },
  );
  const v = await updater.versionInfo(true);
  assert.equal(v.productUpdateAvailable, true);
  assert.equal(v.coreUpdateAvailable, false);
  assert.equal(v.updateAvailable, true);
  assert.equal(v.latestVersion, '0.3.11');
});

test('state 2: the same product version but a newer compatible core reports a core-only update', async () => {
  const { updater } = setup(
    { version: '0.3.10', coreVersion: '0.0.14', coreCommit: 'a'.repeat(40) },
    { releaseTag: 'v0.3.10', branchCoreVersion: '0.0.15', branchCoreCommit: 'b'.repeat(40), branchProductVersion: '0.3.10' },
  );
  const v = await updater.versionInfo(true);
  assert.equal(v.productUpdateAvailable, false);
  assert.equal(v.coreUpdateAvailable, true);
  assert.equal(v.updateAvailable, true, 'the sidebar/update pill must fire for a core-only update too');
  assert.deepEqual(v.latestCore, { version: '0.0.15', commit: 'b'.repeat(8) });
  assert.equal(v.core.version, '0.0.14', 'the installed core is unchanged by just checking');
});

test('state 3: both the product and the core are behind - one product update is offered, which brings its own vendored core', async () => {
  const { updater } = setup(
    { version: '0.3.9', coreVersion: '0.0.13', coreCommit: 'a'.repeat(40) },
    { releaseTag: 'v0.3.10', branchCoreVersion: '0.0.14', branchCoreCommit: 'b'.repeat(40), branchProductVersion: '0.3.10' },
  );
  const v = await updater.versionInfo(true);
  assert.equal(v.productUpdateAvailable, true);
  assert.equal(v.updateAvailable, true);
  // A single "Update now" takes the product path (selfUpdate), whose release tarball carries its own
  // panel/core/ + core.lock - see installRelease(), which copies the whole release/panel wholesale.
});

test('state 4: everything up to date shows no update at all', async () => {
  const { updater } = setup(
    { version: '0.3.10', coreVersion: '0.0.14', coreCommit: 'a'.repeat(40) },
    { releaseTag: 'v0.3.10', branchCoreVersion: '0.0.14', branchCoreCommit: 'a'.repeat(40), branchProductVersion: '0.3.10' },
  );
  const v = await updater.versionInfo(true);
  assert.equal(v.productUpdateAvailable, false);
  assert.equal(v.coreUpdateAvailable, false);
  assert.equal(v.updateAvailable, false);
});

test('a newer branch core is not offered while the branch also carries unreleased product changes', async () => {
  const { updater } = setup(
    { version: '0.3.10', coreVersion: '0.0.14', coreCommit: 'a'.repeat(40) },
    { releaseTag: 'v0.3.10', branchCoreVersion: '0.0.15', branchCoreCommit: 'b'.repeat(40), branchProductVersion: '0.3.10.1' },
  );
  const v = await updater.versionInfo(true);
  assert.equal(v.coreUpdateAvailable, false, 'a core-only swap would not be a like-for-like match for a diverged panel/');
  assert.equal(v.updateAvailable, false);
});

test('no core.json on a very old install never crashes versionInfo and reports no core update', async () => {
  const { updater } = setup(
    { version: '0.3.10' },
    { releaseTag: 'v0.3.10', branchCoreVersion: '0.0.15', branchCoreCommit: 'b'.repeat(40), branchProductVersion: '0.3.10' },
  );
  const v = await updater.versionInfo(true);
  assert.equal(v.core, null);
  assert.equal(v.coreUpdateAvailable, false);
});

test('GitHub being unreachable for the branch lookup leaves core update detection off, not crashed', async () => {
  const { updater } = setup(
    { version: '0.3.10', coreVersion: '0.0.14', coreCommit: 'a'.repeat(40) },
    { releaseTag: 'v0.3.10', branchCoreVersion: null, branchProductVersion: '0.3.10' },
  );
  const v = await updater.versionInfo(true);
  assert.equal(v.latestCore, null);
  assert.equal(v.coreUpdateAvailable, false);
  assert.equal(v.checkError, null, 'a missing core.lock on the branch is not a hard error, just no core update to offer');
});
