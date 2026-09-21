const test = require('node:test');
const assert = require('node:assert');

const { recommendMemory } = require('../modules/modpack-memory');

test('a large NeoForge pack gets 8 GB, with 6 GB as the minimum', () => {
  const r = recommendMemory({ minecraft: '1.21.1', loader: 'neoforge', modCount: 421, downloadBytes: 1.8 * 1024 ** 3 });
  assert.deepEqual(r.reason, { baseMB: 2048, loaderMB: 768, modsMB: 5052, packSizeMB: 184 });
  assert.equal(r.recommendedMB, 8192);
  assert.equal(r.minimumMB, 6144);
});

test('small packs stay small and never drop below 2 GB', () => {
  const fabric = recommendMemory({ minecraft: '1.21.1', loader: 'fabric', modCount: 40, downloadBytes: 100 * 1024 ** 2 });
  assert.equal(fabric.recommendedMB, 3072);
  assert.equal(fabric.minimumMB, 2560);
  const empty = recommendMemory({ minecraft: '1.21.1', loader: 'vanilla', modCount: 0, downloadBytes: 0 });
  assert.equal(empty.recommendedMB, 2048);
  assert.equal(empty.minimumMB, 2048);
});

test('the recommendation grows with the mod count and is bounded', () => {
  const at = (modCount) => recommendMemory({ minecraft: '1.21.1', loader: 'forge', modCount, downloadBytes: 0 }).recommendedMB;
  assert.ok(at(50) < at(150) && at(150) < at(300));
  assert.equal(recommendMemory({ minecraft: '1.21.1', loader: 'forge', modCount: 5000, downloadBytes: 50 * 1024 ** 3 }).recommendedMB, 10240);
  assert.ok(at(5000) <= 16384);
});

test('values are multiples of 512 MB and the minimum never exceeds the recommendation', () => {
  for (const modCount of [0, 1, 37, 99, 210, 421, 900]) {
    for (const loader of ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']) {
      const r = recommendMemory({ minecraft: '1.20.1', loader, modCount, downloadBytes: modCount * 3 * 1024 ** 2 });
      assert.equal(r.recommendedMB % 512, 0);
      assert.equal(r.minimumMB % 512, 0);
      assert.ok(r.minimumMB <= r.recommendedMB && r.minimumMB >= 2048);
    }
  }
});

test('old Minecraft versions need a little less, and bad input falls back to defaults', () => {
  assert.equal(recommendMemory({ minecraft: '1.12.2', loader: 'forge', modCount: 0 }).reason.baseMB, 1536);
  assert.equal(recommendMemory({ minecraft: '1.21.1', loader: 'forge', modCount: 0 }).reason.baseMB, 2048);
  const odd = recommendMemory({ modCount: 'x', downloadBytes: -5 });
  assert.equal(odd.recommendedMB, 2048);
  assert.deepEqual(recommendMemory().reason, { baseMB: 2048, loaderMB: 0, modsMB: 0, packSizeMB: 0 });
});
