const test = require('node:test');
const assert = require('node:assert');
const { isImportantCreateLine } = require('../modules/create-log');

test('modpack environment decisions and loader/error messages are important', () => {
  for (const line of [
    'Skipping CraftPresence-2.2.3+1.20.1.jar: client-only according to Modrinth',
    'Keeping FancyMenu.jar: server support is optional',
    'Using NeoForge 21.1.251',
    'Could not ask Modrinth about 3 mods (Modrinth answered 503), keeping the pack declaration',
    'Could not determine environment for xyz.jar, keeping pack declaration',
    'Forge 99.9.9 is not available for Minecraft 1.20.1.',
    'checksum mismatch for mods/a.jar',
    'size mismatch for mods/a.jar',
    'no working download for mods/a.jar',
    'port 25599 is in use, using 25600 instead',
    'the new version failed its start test',
    'the core update was rolled back',
  ]) assert.equal(isImportantCreateLine(line), true, line);
});

test('ordinary installer chatter is not important', () => {
  for (const line of [
    'Patching net/minecraft/client/model/geom/ModelLayers 1/1',
    'Extracting 20 override files…',
    'Downloading 8 files (50110859 bytes)…',
    'Moving files into place…',
    'The server installed successfully',
    '[00:00:01] [Server thread/INFO]: Starting minecraft server version 1.21.1',
  ]) assert.equal(isImportantCreateLine(line), false, line);
});

test('handles odd input without throwing', () => {
  assert.equal(isImportantCreateLine(''), false);
  assert.equal(isImportantCreateLine(undefined), false);
  assert.equal(isImportantCreateLine(null), false);
});
