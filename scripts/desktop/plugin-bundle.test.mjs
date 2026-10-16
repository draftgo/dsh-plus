import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializePluginProfile, stagePluginBundle } from './plugin-bundle.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, put };
}

test('published plugin payload excludes development/private files and contains its required dependency closure', t => {
  const { root, put } = fixture(t);
  const manifest = { name: '@dowork/commander', version: '0.1.0', type: 'module', files: ['src', 'lib', 'voice', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { 'fixture-required': '1.0.0' }, devDependencies: { 'fixture-dev': '1.0.0' }, optionalDependencies: { 'fixture-linux': '1.0.0' } };
  put('plugin/package.json', manifest);
  for (const name of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'voice/src/plugin.mjs', 'cordis.patch.yml']) put(`plugin/${name}`, 'fixture');
  put('plugin/private-credentials.txt', 'do-not-package');
  for (const name of ['fixture-required', 'fixture-dev', 'fixture-linux']) {
    put(`plugin/node_modules/${name}/package.json`, { name, version: '1.0.0', ...(name === 'fixture-linux' ? { os: ['linux'] } : {}) });
    put(`plugin/node_modules/${name}/index.js`, 'export default true;');
  }
  const staged = stagePluginBundle({ runtime: join(root, 'runtime'), plugin: join(root, 'plugin'), platform: 'win32', arch: 'x64' });
  assert.deepEqual(staged.dependencies, ['fixture-required']);
  assert.deepEqual(staged.omittedOptionalDependencies, ['fixture-linux']);
  assert.equal(existsSync(join(staged.destination, 'private-credentials.txt')), false);
  assert.equal(existsSync(join(staged.destination, 'node_modules/fixture-dev')), false);
  assert.equal(existsSync(join(staged.destination, 'node_modules/fixture-required/index.js')), true);
  assert.throws(() => stagePluginBundle({ runtime: join(root, 'runtime'), plugin: join(root, 'plugin') }), /already exists/u);
});

const officialRoot = resolve(import.meta.dirname, '../../deepseek-harness');
const officialBoot = join(officialRoot, 'packages/boot/app-boot/lib/index.js');
test('official profile loader resolves the preinstalled Plus bundle and respects later user disable', { skip: !existsSync(officialBoot) }, async t => {
  const { root, put } = fixture(t);
  const modules = join(root, 'resources/app.asar/dsh/node_modules');
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true });
  for (const [name, source] of [
    ['dsh-app-boot', 'packages/boot/app-boot'], ['dsh-home-paths', 'packages/util/home-paths'],
    ['dsh', 'apps/cli'],
  ]) symlinkSync(join(officialRoot, source), join(modules, '@deepseek-ai', name), 'junction');
  put('resources/app.asar/dsh/node_modules/@dowork/commander/package.json', { name: '@dowork/commander', version: '0.1.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } });
  put('resources/app.asar/dsh/node_modules/@dowork/commander/cordis.patch.yml', "- insert:\n    - id: commander\n      name: '@dowork/commander'\n");
  const profile = join(root, 'home/profiles/desktop');
  put('home/profiles/desktop/package.json', { private: true, dependencies: { 'kept-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dowork/commander'] } } });
  put('home/profiles/desktop/cordis.patch.yml', '[]\n');
  put('resources/app.asar/dsh/node_modules/@dowork/dsh-plus-desktop/package.json', { name: '@dowork/dsh-plus-desktop', version: '0.1.0', dependencies: { '@dowork/commander': '0.1.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
  put('resources/app.asar/dsh/node_modules/@dowork/dsh-plus-desktop/cordis.patch.yml', readFileSync(join(modules, '@dowork/commander/cordis.patch.yml'), 'utf8'));
  const options = { resources: join(root, 'resources'), profile };
  assert.equal((await initializePluginProfile(options)).enrolled, true);
  const boot = await import(pathToFileURL(officialBoot).href);
  const loaded = boot.loadProfileDirectory('dsh', profile, join(modules, '@deepseek-ai/dsh/package.json'));
  assert.equal(loaded.skippedBundles.length, 0);
  const plus = loaded.layers.find(layer => layer.packageName === '@dowork/dsh-plus-desktop');
  assert.ok(plus, 'official loader selected the preinstalled Commander');
  assert.equal(plus.patches[0].insert[0].id, 'commander');
  const resolution = await boot.createRuntimeResolution({ installAnchor: join(modules, '@deepseek-ai/dsh/package.json'), profile: loaded, home: join(root, 'home') });
  assert.ok(resolution.entries.some(entry => entry.name === '@dowork/commander'), 'official runtime resolution supplies the plugin');
  const manifestPath = join(profile, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.dependencies['kept-plugin'], '1.0.0');
  assert.equal(manifest.dsh.profile.bundles.includes('@dowork/commander'), false, 'existing direct bundle is migrated without inserting Commander twice');
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== '@dowork/dsh-plus-desktop');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal((await initializePluginProfile(options)).enrolled, false);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).dsh.profile.bundles, manifest.dsh.profile.bundles);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n');
  assert.equal(existsSync(join(profile, 'lock')), false);
});

test('an active profile lock blocks installation before configuration changes', async t => {
  if (!existsSync(officialBoot)) { t.skip('official built packages are unavailable'); return; }
  const { root, put } = fixture(t);
  const modules = join(root, 'runtime/node_modules/@deepseek-ai'); mkdirSync(modules, { recursive: true });
  symlinkSync(join(officialRoot, 'packages/boot/app-boot'), join(modules, 'dsh-app-boot'), 'junction');
  symlinkSync(join(officialRoot, 'packages/util/home-paths'), join(modules, 'dsh-home-paths'), 'junction');
  put('runtime/node_modules/@dowork/commander/package.json', { name: '@dowork/commander', version: '0.1.0' });
  put('runtime/node_modules/@dowork/dsh-plus-desktop/package.json', { name: '@dowork/dsh-plus-desktop', version: '0.1.0' });
  put('profile/lock', `${process.pid}\n`);
  await assert.rejects(initializePluginProfile({ runtime: join(root, 'runtime'), profile: join(root, 'profile') }), /busy/u);
  assert.equal(existsSync(join(root, 'profile/package.json')), false);
});
