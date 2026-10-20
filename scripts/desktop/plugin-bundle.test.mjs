import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializePluginProfile, stagePluginBundle } from './plugin-bundle.mjs';
import { getInstallState, releaseBundleName } from '../../plugins/commander/shared/plugin-install.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, put };
}

test('published plugin payload excludes development/private files and contains its required dependency closure', t => {
  const { root, put } = fixture(t);
  const manifest = { name: 'dsh-plus', version: '0.1.0', type: 'module', files: ['src', 'lib', 'voice', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { 'fixture-required': '1.0.0' }, devDependencies: { 'fixture-dev': '1.0.0' }, optionalDependencies: { 'fixture-linux': '1.0.0' } };
  put('plugin/package.json', manifest);
  for (const name of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'voice/src/plugin.mjs', 'cordis.patch.yml']) put(`plugin/${name}`, 'fixture');
  put('plugin/private-credentials.txt', 'do-not-package');
  for (const name of ['fixture-required', 'fixture-dev', 'fixture-linux']) {
    put(`plugin/node_modules/${name}/package.json`, { name, version: '1.0.0', ...(name === 'fixture-linux' ? { os: ['linux'] } : {}) });
    put(`plugin/node_modules/${name}/index.js`, 'export default true;');
  }
  const staged = stagePluginBundle({ runtime: join(root, 'runtime'), plugin: join(root, 'plugin'), platform: 'win32', arch: 'x64' });
  assert.equal(existsSync(join(root, 'runtime/node_modules/dsh-plus')), false, 'the sealed runtime contains no Plus package');
  assert.ok(existsSync(join(staged.directory, 'release.json')));
  const wrapper = JSON.parse(readFileSync(join(staged.directory, 'node_modules', staged.bundle, 'package.json')));
  assert.equal(wrapper.exports['./locale/*.json'], './locale/*.json');
  assert.equal(JSON.parse(readFileSync(join(staged.directory, 'node_modules', staged.bundle, 'locale/en.json'))).meta.title, 'DSH-Plus');
  assert.deepEqual(staged.dependencies, ['fixture-required']);
  assert.deepEqual(staged.omittedOptionalDependencies, ['fixture-linux']);
  assert.equal(existsSync(join(staged.destination, 'private-credentials.txt')), false);
  assert.equal(existsSync(join(staged.destination, 'node_modules/fixture-dev')), false);
  assert.equal(existsSync(join(staged.destination, 'node_modules/fixture-required/index.js')), true);
  assert.throws(() => stagePluginBundle({ runtime: join(root, 'runtime'), plugin: join(root, 'plugin') }), /already exists/u);
});

const officialRoot = resolve(import.meta.dirname, '../../deepseek-harness');
test('SSH optional build-machine addons never enter desktop plugin releases', t => {
  const { root, put } = fixture(t);
  put('plugin/package.json', { name: 'dsh-plus', version: '0.1.0', files: ['src', 'lib', 'voice', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { ssh2: '1.17.0' } });
  for (const name of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'voice/src/plugin.mjs', 'cordis.patch.yml']) put('plugin/' + name, 'fixture');
  put('plugin/node_modules/ssh2/package.json', { name: 'ssh2', version: '1.17.0', optionalDependencies: { 'cpu-features': '0.0.10' } });
  put('plugin/node_modules/ssh2/lib/index.js', 'module.exports = {};');
  put('plugin/node_modules/ssh2/lib/protocol/crypto.js', 'module.exports = {};');
  put('plugin/node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node', 'wrong-node-abi');
  put('plugin/node_modules/ssh2/lib/protocol/crypto/build/Release/obj.target/sshcrypto.node', 'wrong-node-abi');
  put('plugin/node_modules/cpu-features/package.json', { name: 'cpu-features', version: '0.0.10' });
  put('plugin/node_modules/cpu-features/build/Release/cpufeatures.node', 'wrong-node-abi');
  const staged = stagePluginBundle({ plugin: join(root, 'plugin'), output: join(root, 'seed') });
  const ssh = join(staged.destination, 'node_modules/ssh2');
  assert.ok(existsSync(join(ssh, 'lib/protocol/crypto.js')));
  assert.equal(existsSync(join(ssh, 'lib/protocol/crypto/build')), false);
  assert.equal(existsSync(join(ssh, 'node_modules/cpu-features')), false);
  assert.deepEqual(staged.omittedOptionalDependencies, ['cpu-features']);
});

const officialBoot = join(officialRoot, 'packages/boot/app-boot/lib/index.js');
test('official profile loader resolves the preinstalled Plus bundle and respects later user disable', { skip: !existsSync(officialBoot) }, async t => {
  const { root, put } = fixture(t);
  const modules = join(root, 'resources/app.asar/dsh/node_modules');
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true });
  for (const [name, source] of [
    ['dsh-app-boot', 'packages/boot/app-boot'], ['dsh-home-paths', 'packages/util/home-paths'],
    ['dsh', 'apps/cli'],
  ]) symlinkSync(join(officialRoot, source), join(modules, '@deepseek-ai', name), 'junction');
  seedFixture(put, 'resources/dsh-plus/seed');
  const profile = join(root, 'home/profiles/desktop');
  put('home/profiles/desktop/package.json', { private: true, dependencies: { 'kept-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dowork/commander'] } } });
  put('home/profiles/desktop/cordis.patch.yml', '[]\n');
  const options = { resources: join(root, 'resources'), profile };
  assert.equal((await initializePluginProfile(options)).enrolled, true);
  const boot = await import(pathToFileURL(officialBoot).href);
  const loaded = boot.loadProfileDirectory('dsh', profile, join(modules, '@deepseek-ai/dsh/package.json'));
  assert.equal(loaded.skippedBundles.length, 0);
  const state = await getInstallState(profile);
  const plus = loaded.layers.find(layer => layer.packageName === state.bundleName);
  assert.ok(plus, 'official loader selected the profile-local Plus bundle');
  assert.equal(plus.patches[0].insert[0].id, 'commander');
  const resolution = await boot.createRuntimeResolution({ installAnchor: join(modules, '@deepseek-ai/dsh/package.json'), profile: loaded, home: join(root, 'home') });
  assert.ok(resolution.entries.some(entry => entry.name === 'dsh-plus'), 'official runtime resolution supplies the plugin');
  const manifestPath = join(profile, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.dependencies['kept-plugin'], '1.0.0');
  assert.equal(manifest.dsh.profile.bundles.includes('@dowork/commander'), false, 'legacy direct bundle is migrated without inserting Commander twice');
  assert.equal(manifest.dsh.profile.bundles.includes('dsh-plus'), false);
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== state.bundleName);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal((await initializePluginProfile(options)).enrolled, false);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).dsh.profile.bundles, manifest.dsh.profile.bundles);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n');
  assert.equal(existsSync(join(profile, 'lock')), false);
});

function seedFixture(put, prefix) {
  const bundleName = releaseBundleName('0.1.0');
  put(`${prefix}/release.json`, { schemaVersion: 1, version: '0.1.0', platform: process.platform, arch: process.arch, shared: [] });
  put(`${prefix}/node_modules/dsh-plus/package.json`, { name: 'dsh-plus', version: '0.1.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } });
  for (const file of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'voice/src/plugin.mjs']) put(`${prefix}/node_modules/dsh-plus/${file}`, 'export default true;');
  const patch = "- insert:\n    - id: commander\n      name: 'dsh-plus'\n";
  put(`${prefix}/node_modules/dsh-plus/cordis.patch.yml`, patch);
  put(`${prefix}/node_modules/${bundleName}/package.json`, { name: bundleName, displayName: 'DSH-Plus', version: '0.1.0', type: 'module', dependencies: { 'dsh-plus': '0.1.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
  put(`${prefix}/node_modules/${bundleName}/cordis.patch.yml`, patch);
}

function enrollmentFixture(t) {
  const { root, put } = fixture(t);
  const modules = join(root, 'runtime/node_modules/@deepseek-ai'); mkdirSync(modules, { recursive: true });
  symlinkSync(join(officialRoot, 'packages/boot/app-boot'), join(modules, 'dsh-app-boot'), 'junction');
  symlinkSync(join(officialRoot, 'packages/util/home-paths'), join(modules, 'dsh-home-paths'), 'junction');
  seedFixture(put, 'seed');
  return { root, put, options: { runtime: join(root, 'runtime'), seed: join(root, 'seed'), profile: join(root, 'profile') } };
}

const enrollmentOptions = { skip: !existsSync(officialBoot) };
test('old enrollment migrates physically into profile while preserving enabled and disabled choices', enrollmentOptions, async t => {
  for (const enabled of [false, true]) {
    const { root, put, options } = enrollmentFixture(t);
    put('profile/.dsh-plus-enrolled.json', { schemaVersion: 1, package: '@dowork/commander', version: '0.1.0' });
    put('profile/package.json', { private: true, dependencies: { '@dowork/commander': '0.1.0', 'kept-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...(enabled ? ['@dowork/dsh-plus-desktop'] : [])] } } });
    assert.equal((await initializePluginProfile(options)).reason, 'migrated');
    const state = await getInstallState(options.profile);
    assert.equal(state.enabled, enabled);
    assert.equal(state.appVersion, '0.1.0');
    const manifest = JSON.parse(readFileSync(join(root, 'profile/package.json'), 'utf8'));
    assert.equal(manifest.dependencies['kept-plugin'], '1.0.0');
    assert.equal(manifest.dependencies['@dowork/commander'], undefined);
    assert.equal(manifest.dependencies['dsh-plus'], undefined);
    assert.ok(manifest.dependencies[state.bundleName].startsWith('link:'));
    assert.equal(existsSync(join(options.profile, 'node_modules', state.bundleName, 'package.json')), true);
    assert.equal((await initializePluginProfile(options)).reason, 'already-enrolled');
    assert.equal(existsSync(join(root, 'profile/lock')), false);
  }
});

test('old sealed runtime cannot claim to support overriding its in-box Plus package', enrollmentOptions, async t => {
  const { put, options } = enrollmentFixture(t);
  put('runtime/node_modules/dsh-plus/package.json', { name: 'dsh-plus', version: '0.1.0' });
  await assert.rejects(initializePluginProfile(options), /新版桌面应用/);
});

test('reinstall refreshes app version and moved shared-runtime links without downgrading or enabling a disabled plugin', enrollmentOptions, async t => {
  const { root, put, options } = enrollmentFixture(t);
  const service = { name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' };
  put('seed/release.json', { schemaVersion: 1, version: '0.1.0', platform: process.platform, arch: process.arch, shared: [service] });
  put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', service);
  await initializePluginProfile(options);
  const manifestPath = join(options.profile, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.dsh.plusInstall.appVersion = '0.0.9';
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== manifest.dsh.plusInstall.bundleName);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const moved = join(root, 'moved-runtime/node_modules/@deepseek-ai');
  mkdirSync(moved, { recursive: true });
  symlinkSync(join(officialRoot, 'packages/boot/app-boot'), join(moved, 'dsh-app-boot'), 'junction');
  symlinkSync(join(officialRoot, 'packages/util/home-paths'), join(moved, 'dsh-home-paths'), 'junction');
  put('moved-runtime/node_modules/@deepseek-ai/dsh-llm/package.json', service);
  rmSync(join(root, 'runtime/node_modules/@deepseek-ai/dsh-llm'), { recursive: true });
  const result = await initializePluginProfile({ ...options, runtime: join(root, 'moved-runtime') });
  assert.equal(result.version, '0.1.0');
  assert.equal(result.appVersion, '0.1.0');
  assert.equal(result.enabled, false);
  assert.equal(JSON.parse(readFileSync(join(result.directory, 'node_modules/@deepseek-ai/dsh-llm/package.json'))).version, service.version);
});

test('an active profile lock blocks installation before configuration changes', enrollmentOptions, async t => {
  const { root, put, options } = enrollmentFixture(t);
  const owner = `${process.pid}\n`;
  put('profile/lock', owner);
  await assert.rejects(initializePluginProfile(options), /busy/u);
  assert.equal(existsSync(join(root, 'profile/package.json')), false);
  assert.equal(readFileSync(join(root, 'profile/lock'), 'utf8'), owner);
});

test('a lock from a confirmed exited process is reclaimed and enrollment completes', enrollmentOptions, async t => {
  const { root, put, options } = enrollmentFixture(t);
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  put('profile/lock', `${exited.pid}\n`);
  const result = await initializePluginProfile(options);
  assert.equal(result.enrolled, true);
  const manifest = JSON.parse(readFileSync(join(root, 'profile/package.json'), 'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes(result.bundleName));
  assert.equal(existsSync(join(root, 'profile/lock')), false);
});

test('invalid lock owners and failed permission probes do not authorize lock removal', enrollmentOptions, async t => {
  const { root, put, options } = enrollmentFixture(t);
  for (const owner of ['', 'invalid', '0', '-1', '9007199254740992']) {
    put('profile/lock', owner);
    await assert.rejects(initializePluginProfile(options), /busy/u);
    assert.equal(readFileSync(join(root, 'profile/lock'), 'utf8'), owner);
  }
  put('profile/lock', `${process.pid}\n`);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
  await assert.rejects(initializePluginProfile(options), /busy/u);
  assert.equal(readFileSync(join(root, 'profile/lock'), 'utf8'), `${process.pid}\n`);
  assert.equal(existsSync(join(root, 'profile/package.json')), false);
});

test('directory and symlink lock entries are rejected without deleting their targets', enrollmentOptions, async t => {
  const { root, options } = enrollmentFixture(t);
  const lock = join(root, 'profile/lock');
  mkdirSync(lock, { recursive: true });
  await assert.rejects(initializePluginProfile(options), /not a regular file/u);
  assert.equal(existsSync(lock), true);
  rmSync(lock, { recursive: true });
  const target = join(root, 'lock-target'); mkdirSync(target);
  symlinkSync(target, lock, 'junction');
  await assert.rejects(initializePluginProfile(options), /not a regular file/u);
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(join(root, 'profile/package.json')), false);
});
