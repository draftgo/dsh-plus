import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_UPDATE_CONFIG, normalizeUpdateConfig, releaseDownloadUrl, resolveUpdateUrl,
  fetchVerifiedRelease, fetchUpdateBytes, validateReleaseManifest, compareVersions,
  isNewerVersion, isEngineCompatible, verifyArtifact,
} from '../shared/update-feed.mjs';
import { createUpdateManifest } from '../../../scripts/desktop/create-update-manifest.mjs';

const { publicKey: publicObject, privateKey } = generateKeyPairSync('ed25519');
const publicKey = publicObject.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const artifact = Buffer.from('test signed plugin archive');
const manifest = () => ({ schemaVersion: 1, version: '0.1.2', engine: { min: '0.2.1-alpha.3', max: '0.2.1-alpha.3' }, plugin: { version: '0.1.2', url: releaseDownloadUrl('dsh-plus-0.1.2-plugin.tar.gz', 'plugin-v0.1.2'), sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.byteLength } });
function feed(data = manifest(), transform) {
  const bytes = Buffer.from(JSON.stringify(data));
  const signature = sign(null, bytes, privateKey).toString('base64');
  return async url => new Response(url.endsWith('.sig') ? signature : transform ? transform(bytes) : bytes);
}

test('default source uses domestic mirror and selected source never silently changes', () => {
  const url = releaseDownloadUrl('dsh-plus-update.json');
  assert.equal(resolveUpdateUrl(url), `https://ghfast.top/${url}`);
  assert.deepEqual(normalizeUpdateConfig(), DEFAULT_UPDATE_CONFIG);
  assert.equal(resolveUpdateUrl(url, { source: 'github', mirrorUrl: 'invalid ignored field' }), url);
  assert.equal(resolveUpdateUrl(url, { source: 'custom', mirrorUrl: 'https://mirror.example/proxy' }), `https://mirror.example/proxy/${url}`);
});

test('source and artifact URLs reject credentials, injected URLs and unsafe basenames', () => {
  for (const mirrorUrl of ['http://mirror.example', 'https://user:pass@mirror.example', 'https://mirror.example/?key=secret', 'https://mirror.example/#token']) {
    assert.throws(() => normalizeUpdateConfig({ source: 'custom', mirrorUrl }), { code: 'UPDATE_SOURCE' });
  }
  assert.throws(() => normalizeUpdateConfig({ source: 'custom' }), { code: 'UPDATE_SOURCE' });
  for (const url of ['https://github.com/other/repo/releases/download/v1/x.tar.gz', 'https://evil.example/x.tar.gz', 'https://github.com/draftgo/dsh-plus/releases/download/v1/../../evil', 'https://github.com/draftgo/dsh-plus/releases/download/v1/%2e%2e.tar.gz', 'https://github.com/draftgo/dsh-plus/releases/download/v1/x.tar.gz?token=secret']) {
    assert.throws(() => resolveUpdateUrl(url), { code: 'UPDATE_URL' });
  }
});

test('manifest is authenticated before parsing and validates app independently', async () => {
  const data = manifest();
  data.app = { version: '0.1.0', url: releaseDownloadUrl('DSH-Plus-Setup.exe', 'v0.1.0') };
  const requested = [];
  const fetcher = feed(data);
  assert.deepEqual(await fetchVerifiedRelease({ publicKey, fetcher: url => { requested.push(url); return fetcher(url); } }), data);
  assert.deepEqual(requested, [
    'https://ghfast.top/https://github.com/draftgo/dsh-plus/releases/download/plugin-updates/dsh-plus-update.json',
    'https://ghfast.top/https://github.com/draftgo/dsh-plus/releases/download/plugin-updates/dsh-plus-update.json.sig',
  ]);
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: feed(data, bytes => Buffer.from(bytes.toString().replace('0.1.2', '0.1.3'))) }), { code: 'UPDATE_SIGNATURE' });
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  await assert.rejects(fetchVerifiedRelease({ publicKey: other, fetcher: feed() }), { code: 'UPDATE_SIGNATURE' });
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: async () => new Response('unsigned') }), { code: 'UPDATE_SIGNATURE' });
  const invalid = Buffer.from('{not json');
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: async url => new Response(url.endsWith('.sig') ? sign(null, invalid, privateKey).toString('base64') : invalid) }), { code: 'UPDATE_MANIFEST' });
});

test('signed manifests still require valid versions, ranges, size, hash and origin', async () => {
  for (const mutate of [
    data => { data.schemaVersion = 2; },
    data => { data.plugin.version = '0.1.3'; },
    data => { data.engine.max = '0.1.0'; },
    data => { data.plugin.url = 'https://evil.example/payload.tar.gz'; },
    data => { data.plugin.url = releaseDownloadUrl('payload.exe', 'v1'); },
    data => { data.plugin.size = 0; },
    data => { data.plugin.sha256 = 'bad'; },
    data => { data.version = data.plugin.version = '01.2.3'; },
    data => { data.notes = 'x'.repeat(16_385); },
  ]) {
    const data = manifest(); mutate(data);
    assert.throws(() => validateReleaseManifest(data));
    await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: feed(data) }));
  }
});

test('semver ordering respects prerelease, numeric identifiers and exact engine range', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let index = 1; index < versions.length; index++) assert.equal(isNewerVersion(versions[index], versions[index - 1]), true);
  assert.equal(compareVersions('1.0.0+first', '1.0.0+second'), 0);
  assert.equal(isNewerVersion('0.1.1', '0.1.2'), false);
  assert.equal(isEngineCompatible('0.2.1-alpha.3', manifest().engine), true);
  assert.equal(isEngineCompatible('0.2.1-alpha.4', manifest().engine), false);
  assert.equal(isEngineCompatible('0.2.0', { min: '0.2.1-alpha.3' }), false);
  for (const version of ['1.0', 'v1.0.0', '1.0.0-01', '1.0.0-', '1.0.0+']) assert.throws(() => compareVersions(version, '1.0.0'));
});

test('network failures retain source and bound metadata length, timeout and redirects', async () => {
  const url = releaseDownloadUrl('dsh-plus-update.json');
  const calls = [];
  await assert.rejects(fetchUpdateBytes(url, { config: { source: 'github' }, fetcher: async target => { calls.push(target); throw Error('offline'); } }), { code: 'UPDATE_NETWORK' });
  assert.deepEqual(calls, [url]);
  await assert.rejects(fetchUpdateBytes(url, { fetcher: async () => new Response('x', { headers: { 'content-length': '262145' } }) }), { code: 'UPDATE_SIZE' });
  await assert.rejects(fetchUpdateBytes(url, { maxBytes: 3, fetcher: async () => new Response('1234') }), { code: 'UPDATE_SIZE' });
  await assert.rejects(fetchUpdateBytes(url, { timeoutMs: 10, fetcher: async () => new Promise(() => {}) }), { code: 'UPDATE_TIMEOUT' });
  await assert.rejects(fetchUpdateBytes(url, { fetcher: async () => new Response(null, { status: 404 }) }), { code: 'UPDATE_HTTP' });
  for (const location of ['http://github.com/x', 'https://evil.example/file', 'https://user:secret@github.com/x', 'https://github.com:8443/x']) {
    await assert.rejects(fetchUpdateBytes(url, { fetcher: async () => new Response(null, { status: 302, headers: { location } }) }), { code: 'UPDATE_REDIRECT' });
  }
  await assert.rejects(fetchUpdateBytes(url, { fetcher: async () => new Response(null, { status: 302, headers: { location: url } }) }), { code: 'UPDATE_REDIRECT' });
  let requests = 0;
  const bytes = await fetchUpdateBytes(url, { fetcher: async () => ++requests === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a/file?signature=test' } }) : new Response('ok') });
  assert.equal(bytes.toString(), 'ok');
});

test('plugin bytes must match signed size and SHA256', () => {
  assert.equal(verifyArtifact(artifact, manifest().plugin), artifact);
  assert.throws(() => verifyArtifact(Buffer.from('short'), manifest().plugin), { code: 'UPDATE_SIZE' });
  const corrupt = Buffer.from(artifact); corrupt[0] ^= 1;
  assert.throws(() => verifyArtifact(corrupt, manifest().plugin), { code: 'UPDATE_HASH' });
});

test('release generator signs exact output and rejects a mismatched publishing key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-plus-update-'));
  try {
    const pluginPath = path.join(dir, 'dsh-plus-0.1.2-plugin.tar.gz');
    await writeFile(pluginPath, artifact);
    const options = { pluginPath, outDir: dir, version: '0.1.2', engineVersion: '0.2.1-alpha.3', privateKey: privatePem, publicKey };
    assert.deepEqual(await createUpdateManifest(options), manifest());
    const bytes = await readFile(path.join(dir, 'dsh-plus-update.json'));
    const sig = await readFile(path.join(dir, 'dsh-plus-update.json.sig'));
    assert.deepEqual(await fetchVerifiedRelease({ publicKey, fetcher: async url => new Response(url.endsWith('.sig') ? sig : bytes) }), manifest());
    const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    await assert.rejects(createUpdateManifest({ ...options, publicKey: wrong }), /不匹配/);
    await assert.rejects(createUpdateManifest({ ...options, privateKey: undefined }), /缺少/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('missing metadata is a channel readiness state; missing signatures and missing artifacts remain failures', async () => {
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: async () => new Response(null, { status: 404 }) }), { code: 'UPDATE_UNPUBLISHED' });
  const valid = feed();
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: url => url.endsWith('.sig') ? new Response(null, { status: 404 }) : valid(url) }), { code: 'UPDATE_HTTP', httpStatus: 404 });
  await assert.rejects(fetchVerifiedRelease({ publicKey, fetcher: async () => new Response(null, { status: 403 }) }), { code: 'UPDATE_HTTP', httpStatus: 403 });
  await assert.rejects(fetchUpdateBytes(manifest().plugin.url, { fetcher: async () => new Response(null, { status: 404 }) }), { code: 'UPDATE_HTTP', httpStatus: 404 });
});
