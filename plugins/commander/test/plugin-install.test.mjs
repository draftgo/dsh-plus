import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import { prepareRelease, activateRelease, rollbackRelease, getInstallState, releaseBundleName } from '../shared/plugin-install.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plus-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, value) => { file = join(root, file); await mkdir(dirname(file), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const profile = join(root, 'profile'), releases = join(profile, '.dsh-plus/releases');
  await put('profile/package.json', { name: 'test-profile', private: true, dependencies: { kept: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  await put('profile/cordis.patch.yml', '# keep user config\n');
  const seed = async (version, shared = []) => {
    const prefix = `seed-${version}`;
    await put(`${prefix}/release.json`, { schemaVersion: 1, version, platform: process.platform, arch: process.arch, shared });
    await put(`${prefix}/node_modules/dsh-plus/package.json`, { name: 'dsh-plus', version, type: 'module', main: './src/plugin.mjs' });
    for (const file of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'voice/src/plugin.mjs', 'cordis.patch.yml']) await put(`${prefix}/node_modules/dsh-plus/${file}`, 'export default true;');
    const bundleName = releaseBundleName(version);
    await put(`${prefix}/node_modules/${bundleName}/package.json`, { name: bundleName, version, dependencies: { 'dsh-plus': version }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
    await put(`${prefix}/node_modules/${bundleName}/cordis.patch.yml`, '[]\n');
    const directory = join(root, prefix), archive = join(root, `${version}.tar.gz`);
    await tar.c({ file: archive, cwd: directory, gzip: true }, ['release.json', 'node_modules']);
    return { archive, directory, root: releases, version };
  };
  return { root, releases, profile, put, seed };
}

test('complete archive installs offline, activates atomically and rolls back with settings and app version preserved', async t => {
  const { profile, seed } = await fixture(t);
  const first = await prepareRelease(await seed('0.1.0'));
  assert.equal((await getInstallState(profile)).managed, false, 'preparation does not change activation');
  let state = await activateRelease({ profile, release: first, enabled: true, appVersion: '0.1.0' });
  assert.equal(state.enabled, true);
  const wrapperRequire = createRequire(await realpath(join(profile, 'node_modules', state.bundleName, 'package.json')));
  assert.equal(await realpath(wrapperRequire.resolve('dsh-plus')), await realpath(join(first.pluginPath, 'src/plugin.mjs')));
  const second = await prepareRelease(await seed('0.1.1'));
  state = await activateRelease({ profile, release: second });
  assert.equal(state.version, '0.1.1');
  assert.equal(state.appVersion, '0.1.0', 'plugin updates do not change the installed app version');
  assert.equal(state.previous.version, '0.1.0');
  const manifest = JSON.parse(await readFile(join(profile, 'package.json')));
  assert.equal(manifest.dependencies.kept, '1.0.0');
  assert.equal(Object.hasOwn(manifest.dependencies, first.bundleName), false);
  assert.equal(manifest.dsh.profile.bundles.includes(first.bundleName), false);
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '# keep user config\n');
  state = await rollbackRelease({ profile });
  assert.equal(state.version, '0.1.0');
  assert.equal(state.previous.version, '0.1.1');
  assert.equal(state.enabled, true);
});

test('disabled plugin remains disabled during upgrade and rollback', async t => {
  const { profile, seed } = await fixture(t);
  await activateRelease({ profile, release: await prepareRelease(await seed('0.1.0')), enabled: false });
  await activateRelease({ profile, release: await prepareRelease(await seed('0.1.1')) });
  assert.equal((await getInstallState(profile)).enabled, false);
  assert.equal((await rollbackRelease({ profile })).enabled, false);
});

test('activation coordinates with official plugin-manager writers and preserves their completed changes', async t => {
  const { profile, seed } = await fixture(t);
  const release = await prepareRelease(await seed('0.1.0'));
  const atomic = await import('@deepseek-ai/dsh-atomic-write');
  const filename = join(profile, 'package.json');
  let activating, completed = false;
  await atomic.withFileLock(filename, async () => {
    activating = activateRelease({ profile, release, enabled: true }).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(completed, false, 'activation waits for the official writer lock');
    const manifest = JSON.parse(await readFile(filename));
    manifest.dependencies.concurrent = '2.0.0';
    await atomic.writeFileAtomic(filename, JSON.stringify(manifest), { mode: 0o600 });
  });
  await activating;
  assert.equal(JSON.parse(await readFile(filename)).dependencies.concurrent, '2.0.0');
});

test('shared services link to matching official runtime and conflicting old sealed Plus is refused', async t => {
  const { root, profile, seed, put } = await fixture(t);
  const runtime = join(root, 'runtime');
  await put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', { name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' });
  const options = await seed('0.1.0', [{ name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' }]);
  const release = await prepareRelease({ ...options, runtime });
  assert.equal(await realpath(join(release.directory, 'node_modules/@deepseek-ai/dsh-llm')), await realpath(join(runtime, 'node_modules/@deepseek-ai/dsh-llm')));
  await put('runtime/node_modules/dsh-plus/package.json', { name: 'dsh-plus', version: '0.0.1' });
  await assert.rejects(prepareRelease({ ...await seed('0.1.1'), runtime }), /新版应用/);
  assert.equal((await getInstallState(profile)).managed, false);
});

test('rollback revalidates shared-service compatibility before changing the active version', async t => {
  const { root, profile, seed, put } = await fixture(t);
  const runtime = join(root, 'runtime');
  const shared = [{ name: '@deepseek-ai/dsh-llm', version: '0.2.1-alpha.3' }];
  await put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', { name: shared[0].name, version: shared[0].version });
  await activateRelease({ profile, release: await prepareRelease({ ...await seed('0.1.0', shared), runtime }), enabled: true });
  await activateRelease({ profile, release: await prepareRelease({ ...await seed('0.1.1', shared), runtime }) });
  await put('runtime/node_modules/@deepseek-ai/dsh-llm/package.json', { name: shared[0].name, version: '0.2.2' });
  await assert.rejects(rollbackRelease({ profile, runtime }), /版本不兼容/);
  assert.equal((await getInstallState(profile)).version, '0.1.1');
});

test('unsafe archive entries and links are rejected before extraction without changing profile', async t => {
  const { root, releases, profile, seed, put } = await fixture(t);
  const options = await seed('0.1.0');
  const before = await readFile(join(profile, 'package.json'), 'utf8');
  await symlink(root, join(options.directory, 'node_modules/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await tar.c({ file: options.archive, cwd: options.directory, gzip: true }, ['release.json', 'node_modules']);
  await assert.rejects(prepareRelease(options), /链接/);
  await put('escape.txt', 'outside allowed payload');
  await tar.c({ file: options.archive, cwd: root, gzip: true }, ['escape.txt']);
  await assert.rejects(prepareRelease(options), /非插件文件/);
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), before);
  assert.deepEqual(await readdir(releases), []);
});

test('invalid and wrong-platform archives cannot activate and rollback requires a previous release', async t => {
  const { profile, seed, put, releases } = await fixture(t);
  const options = await seed('0.1.0');
  await put('seed-0.1.0/release.json', { schemaVersion: 1, version: '0.1.0', platform: process.platform === 'win32' ? 'linux' : 'win32' });
  await tar.c({ file: options.archive, cwd: options.directory, gzip: true }, ['release.json', 'node_modules']);
  await assert.rejects(prepareRelease(options), /当前系统/);
  assert.deepEqual(await readdir(releases), []);
  await assert.rejects(prepareRelease({ ...options, version: '../0.1.0' }));
  await assert.rejects(rollbackRelease({ profile }), /没有可回退/);
});
