import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { openDeviceRegistry, normalizeRoutes } from '../src/devices/registry.mjs';
import { selectRoute } from '../src/devices/routes.mjs';
import { probeRemote, remoteJson } from '../src/devices/remote.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';

const pin = Buffer.alloc(32, 1).toString('base64');
const direct = { kind: 'direct', url: 'https://direct.test:17770', pin };
const relay = { kind: 'relay', url: 'https://relay.test' };
const target = { url: relay.url, pin: '', token: 'private-token', routes: [relay, direct] };

test('pairing routes are bounded, strict HTTPS trust records without extra secrets', () => {
  assert.deepEqual(normalizeRoutes([direct, relay]), [direct, relay]);
  assert.deepEqual(normalizeRoutes([{ ...direct, url: direct.url + '/' }])[0], direct);
  for (const value of [null, {}, Array(17).fill(direct), [{ ...direct, pin: '' }], [{ ...relay, pin }], [{ ...relay, pin: '' }], [{ ...direct, token: 'secret' }], [{ ...relay, password: 'secret' }], [{ ...relay, url: 'http://relay.test' }], [{ ...relay, url: 'https://u:p@relay.test' }], [{ ...relay, url: 'https://relay.test/path' }], [{ ...direct, kind: 'unknown' }]]) assert.throws(() => normalizeRoutes(value));
});

test('registry persists approved route records without leaking them to the device list', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = await openDeviceRegistry(directory);
  const device = await registry.upsert({ ...target, name: '电脑' });
  assert.deepEqual(registry.get(device.id).routes, target.routes);
  assert.equal(JSON.stringify(registry.list()).includes(pin), false);
  assert.equal(JSON.stringify(registry.list()).includes('private-token'), false);
  const restored = await openDeviceRegistry(directory);
  assert.deepEqual(restored.get(device.id).routes, target.routes);
  await assert.rejects(registry.upsert({ ...target, routes: [{ ...relay, token: 'forged' }] }));
  assert.equal((JSON.parse(await readFile(join(directory, 'connections.json'), 'utf8'))).devices.length, 1);
});

test('route selection prioritizes fixed-pin direct and only falls back for unreachable networks', async () => {
  const calls = [];
  const selected = await selectRoute(target, { probe: async candidate => calls.push(candidate) });
  assert.equal(selected.url, direct.url); assert.equal(selected.token, target.token);
  assert.deepEqual(calls, [{ url: direct.url, pin }]);
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']) {
    const calls = [];
    const selected = await selectRoute(target, { probe: async candidate => { calls.push(candidate); if (candidate.pin) throw Object.assign(new Error(code), { code }); } });
    assert.equal(selected.url, relay.url); assert.equal(selected.pin, '');
    assert.deepEqual(calls, [{ url: direct.url, pin }, { url: relay.url, pin: '' }]);
  }
});

test('active path is public runtime state, never persisted and cleared at restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-route-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = await openDeviceRegistry(directory);
  const device = await registry.upsert({ ...target, name: '电脑', currentPath: 'relay' });
  assert.equal(device.currentPath, null, 'input cannot claim an active connection');
  registry.markRoute(device.id, 'direct');
  assert.equal(registry.publicDevice(registry.get(device.id)).currentPath, 'direct');
  registry.markRoute(device.id, 'relay');
  assert.equal(registry.list().devices[1].currentPath, 'relay');
  assert.throws(() => registry.markRoute(device.id, 'unknown'));
  await registry.rename(device.id, '改名');
  const file = join(directory, 'connections.json'), persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(persisted.devices[0], 'currentPath'), false);
  persisted.devices[0].currentPath = 'relay';
  await writeFile(file, JSON.stringify(persisted));
  const restored = await openDeviceRegistry(directory);
  assert.equal(restored.list().devices[1].currentPath, null);
  await restored.rename(device.id, '再次改名');
  assert.equal((await readFile(file, 'utf8')).includes('currentPath'), false);
});

test('trust errors, HTTP authorization errors and cancellation never downgrade routes', async () => {
  for (const error of [Object.assign(new Error('pin mismatch'), { code: 'ERR_LINK_CERTIFICATE' }), Object.assign(new Error('bad cert'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), ...[401, 403].map(statusCode => Object.assign(new Error('denied'), { code: 'ECONNRESET', statusCode })), new Error('unknown')]) {
    let count = 0;
    await assert.rejects(selectRoute(target, { probe: async () => { count++; throw error; } }), value => value === error);
    assert.equal(count, 1);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(selectRoute(target, { signal: controller.signal, probe: async () => assert.fail('must not probe') }), { name: 'AbortError' });
  assert.equal((await selectRoute({ url: relay.url, token: 'legacy' }, { probe: async () => assert.fail('legacy is unchanged') })).token, 'legacy');
});

test('TLS-only selection verifies pins, rejects an untrusted relay and never sends HTTP credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-route-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await loadIdentity(directory);
  let requests = 0;
  const server = createServer({ key: identity.key, cert: identity.cert }, (req, res) => { requests++; res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"denied"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = 'https://127.0.0.1:' + server.address().port;
  await probeRemote({ url, pin: identity.pin });
  assert.equal(requests, 0);
  const selected = await selectRoute({ ...target, routes: [{ kind: 'direct', url, pin: identity.pin }, relay] });
  assert.equal(selected.url, url); assert.equal(requests, 0);
  await assert.rejects(selectRoute({ ...target, routes: [{ kind: 'direct', url, pin }, relay] }), { code: 'ERR_LINK_CERTIFICATE' });
  await assert.rejects(selectRoute({ ...target, routes: [{ kind: 'relay', url }] }), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  assert.equal(requests, 0);
  await assert.rejects(remoteJson(selected, '/link/api/rpc', { action: 'write' }), { statusCode: 403 });
  assert.equal(requests, 1, 'denied business requests are never replayed');
});
