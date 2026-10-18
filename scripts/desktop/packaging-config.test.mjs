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
  assert.equal(config.artifactName, `dsh-plus-${app.version}-win-x64-setup.exe`);
});
