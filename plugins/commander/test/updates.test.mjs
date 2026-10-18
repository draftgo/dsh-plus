import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createUpdates, mountUpdates } from '../src/updates.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const artifact = Buffer.from('verified plugin bytes');
  const manifest = { schemaVersion: 1, version: options.version || '0.1.3', engine: options.engine || { min: '1.2.3', max: '1.2.3' }, plugin: { version: options.version || '0.1.3', url: 'https://github.com/draftgo/dsh-plus/releases/download/plugin-v0.1.3/dsh-plus-0.1.3-plugin.tar.gz', size: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') } };
  const bytes = Buffer.from(JSON.stringify(manifest)), signature = sign(null, bytes, privateKey).toString('base64');
  const state = { managed: true, root: join(directory, 'releases'), version: '0.1.2', appVersion: '0.1.2', previous: '0.1.1', ...options.state };
  let activated = 0, busy = false, downloads = 0;
  const install = {
    getInstallState: async () => ({ ...state }),
    prepareRelease: async ({ archive, version }) => { assert.deepEqual(await readFile(archive), artifact); return { version }; },
    activateRelease: async ({ release }) => { activated++; state.version = release.version; },
    rollbackRelease: async () => { state.version = state.previous; },
  };
  const fetcher = async url => {
    if (options.httpStatus) return new Response(null, { status: options.httpStatus });
    if (url.endsWith('.sig')) return new Response(signature);
    if (url.endsWith('.json')) return new Response(bytes);
    downloads++;
    if (options.beforeDownload) await options.beforeDownload(() => { busy = true; });
    return new Response(options.corrupt ? 'wrong bytes' : artifact);
  };
  const service = await createUpdates({ directory, profile: directory, runtime: directory, version: '0.1.2', engineVersion: '1.2.3', publicKey: publicKey.export({ type: 'spki', format: 'pem' }), fetcher, install, installation: options.installation || 'desktop', isBusy: () => busy });
  t.after(() => service.close());
  return { service, directory, state, setBusy: value => { busy = value; }, activated: () => activated, downloads: () => downloads };
}

test('signed check, verified install, persistence and restart state form one complete update path', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.status()).config.source, 'mirror');
  await f.service.dispatch({ action: 'configure', source: 'custom', mirrorUrl: 'https://mirror.example.com/' });
  assert.equal(JSON.parse(await readFile(join(f.directory, 'updates.json'))).source, 'custom');
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  assert.equal((await f.service.status()).canInstall, true);
  await f.service.dispatch({ action: 'install' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(f.activated(), 1); assert.equal(status.restartRequired, true); assert.equal(status.current.plugin, '0.1.2'); assert.equal(status.current.app, '0.1.2');
  await assert.rejects(f.service.dispatch({ action: 'install' }), /重启/);
});

test('unmanaged installations and running tasks cannot mutate plugin versions', async t => {
  const f = await fixture(t, { state: { managed: false } });
  await assert.rejects(f.service.dispatch({ action: 'install' }), /先升级一次应用/);
  f.state.managed = true; f.setBusy(true);
  await assert.rejects(f.service.dispatch({ action: 'rollback' }), /任务/);
  assert.equal(f.downloads(), 0);
});

test('new tasks during download prevent activation and corrupted bytes never prepare', async t => {
  for (const options of [{ beforeDownload: busy => busy() }, { corrupt: true }]) {
    const f = await fixture(t, options);
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    await f.service.dispatch({ action: 'install' }); await f.service.settled();
    assert.equal(f.activated(), 0); assert.equal((await f.service.status()).phase, 'error');
  }
});

test('incompatible engine and stale release are never offered as installable', async t => {
  for (const options of [{ engine: { min: '2.0.0' } }, { version: '0.1.1' }]) {
    const f = await fixture(t, options);
    await f.service.dispatch({ action: 'check' }); await f.service.settled();
    assert.equal((await f.service.status()).canInstall, false);
    await assert.rejects(f.service.dispatch({ action: 'install' }));
    assert.equal(f.downloads(), 0);
  }
});

test('rollback selects saved previous version and requires restarting', async t => {
  const f = await fixture(t);
  await f.service.dispatch({ action: 'rollback' }); await f.service.settled();
  assert.equal(f.state.version, '0.1.1'); assert.equal((await f.service.status()).restartRequired, true);
});

test('concurrent install requests admit only one download', async t => {
  const f = await fixture(t);
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const results = await Promise.allSettled([f.service.dispatch({ action: 'install' }), f.service.dispatch({ action: 'install' })]);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  await f.service.settled(); assert.equal(f.downloads(), 1);
});

test('management route rejects cross-origin requests before parsing', async t => {
  let handler;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-route-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cleanups = [];
  const ctx = { get: () => undefined, effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); }, connection: { fetch: { register: route => { handler = route.fetch; return () => {}; } } } };
  const service = await mountUpdates(ctx, { store: { directory }, list: () => [] }); t.after(() => service.close());
  const response = await handler(new Request('https://host/api/commander/updates', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{"action":"rollback"}' }));
  assert.equal(response.status, 403);
});


test('source-deployed hosts report server management and unpublished channels without application migration instructions', async t => {
  const f = await fixture(t, { state: { managed: false }, installation: 'server', httpStatus: 404 });
  assert.equal((await f.service.status()).installation, 'server');
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.phase, 'unpublished'); assert.equal(status.error, '');
  assert.match(status.notice, /尚未就绪/); assert.equal(status.canInstall, false);
  await assert.rejects(f.service.dispatch({ action: 'install' }), /服务器部署管理/);
});

test('HTTP permission errors remain check failures instead of claiming no published version', async t => {
  const f = await fixture(t, { httpStatus: 403 });
  await f.service.dispatch({ action: 'check' }); await f.service.settled();
  const status = await f.service.status();
  assert.equal(status.phase, 'error'); assert.match(status.error, /403/); assert.equal(status.notice, '');
});
