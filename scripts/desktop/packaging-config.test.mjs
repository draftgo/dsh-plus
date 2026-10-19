import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import config from './electron-builder.config.mjs';

test('external seed explicitly includes root node_modules with the official packaging convention', () => {
  const seed = config.extraResources.find(item => item.to === 'dsh-plus/seed');
  const modules = config.extraResources.find(item => item.to === 'dsh-plus/seed/node_modules');
  assert.ok(seed);
  assert.equal(modules.from, `${seed.from}/node_modules`);
  assert.deepEqual(modules.filter, ['**/*']);
  assert.equal(typeof config.afterPack, 'function');
});

test('application version stays independent of plugin-only releases', async () => {
  const app = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  assert.equal(config.extraMetadata.version, app.version);
  assert.equal(config.artifactName, `xiaojiao-${app.version}-win-x64-setup.exe`);
});


test('小角 display naming preserves installed application identity and update channel', () => {
  assert.equal(config.productName, '小角');
  assert.equal(config.executableName, '小角');
  assert.equal(config.nsis.shortcutName, '小角');
  assert.equal(config.nsis.uninstallDisplayName, '小角 ${version}');
  assert.equal(config.appId, 'cn.draftgo.dshplus');
  assert.equal(config.extraMetadata.name, 'dsh-plus-desktop');
  assert.equal(config.extraMetadata.dshDesktopUpdateChannel, 'latest');
  assert.deepEqual(config.protocols[0].schemes, ['dsh']);
  assert.match(config.publish[0].url, /releases\/download\/app-updates\/$/);
});
