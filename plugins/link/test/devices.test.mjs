import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { openDeviceRegistry, normalizeTarget } from '../src/devices/registry.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createDeviceProxy } from '../src/devices/proxy.mjs';
import { remoteJson } from '../src/devices/remote.mjs';
import { createDeviceCenter } from '../src/devices/center.mjs';
import { WebSocket } from 'ws';

const temp = async t => { const directory = await mkdtemp(join(tmpdir(), 'dsh-devices-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };
test('connections preserve credentials independently and removing one never removes another', async t => {
  const directory = await temp(t), store = await openDeviceRegistry(directory);
  const a = await store.upsert({ name: 'A', url: 'https://a.test', token: 'secret-a' });
  const b = await store.upsert({ name: 'B', url: 'https://b.test', token: 'secret-b' });
  await store.select(a.id); await store.rename(b.id, '电脑 B');
  assert.equal(store.get(a.id).token, 'secret-a'); assert.equal(store.get(b.id).token, 'secret-b');
  assert.equal(JSON.stringify(store.list()).includes('secret-'), false);
  await store.remove(a.id); assert.equal(store.list().activeId, 'local'); assert.equal(store.get(b.id).name, '电脑 B');
  const restored = await openDeviceRegistry(directory); assert.equal(restored.get(b.id).status, 'unknown');
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'connections.json'))).mode & 0o777, 0o600);
});
test('target rejects insecure addresses, embedded credentials and malformed pins', () => {
  for (const url of ['http://a.test', 'https://u:p@a.test', 'https://a.test/path', 'https://a.test/?token=bad']) assert.throws(() => normalizeTarget({ url }));
  assert.throws(() => normalizeTarget({ url: 'https://a.test', pin: 'invalid' }));
});
test('local centre requires one-use entry and same-origin JSON, without third-party cookies', async t => {
  const directory = await temp(t);
  const center = await createDeviceCenter({ directory, webRoot: new URL('../dist/web/', import.meta.url), managerFactory: () => null }); t.after(() => center.close());
  const entry = center.launch('http://127.0.0.1:12345').url;
  const unauthorized = await fetch(center.origin + '/api/devices', { method: 'POST' }); assert.equal(unauthorized.status, 401);
  const login = await fetch(entry, { redirect: 'manual' }); assert.equal(login.status, 303); const base = new URL(login.headers.get('location'), center.origin);
  assert.equal((await fetch(entry)).status, 401);
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /device-config.js/);
  const call = (origin, body) => fetch(new URL('api/devices', base), { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await call('http://evil.test', { action: 'list' })).status, 403);
  const result = await (await call(center.origin, { action: 'list' })).json(); assert.equal(result.devices[0].id, 'local'); assert.equal(result.capabilities.ssh, false);
});
test('pinned TLS proxy isolates credentials, rewrites base and multiplexes persistent streams', async t => {
  const directory = await temp(t), identity = await loadIdentity(directory); let authenticated = 0;
  const server = createServer({ key: identity.key, cert: identity.cert }, async (req, res) => {
    if (req.url === '/link/api/workbench') { assert.equal(req.headers.authorization, 'Bearer private-token'); authenticated++; res.writeHead(200, { 'set-cookie': 'dsh_link_workbench=private-cookie; HttpOnly; Secure; Path=/link/workbench/' }); res.end(JSON.stringify({ url: '/link/workbench/' })); return; }
    assert.equal(req.headers.cookie, 'dsh_link_workbench=private-cookie'); assert.equal(req.headers.authorization, undefined);
    if (req.url.endsWith('/remote/open')) { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write('{"type":"ready"}\n'); const interval = setInterval(() => res.write('{"type":"heartbeat"}\n'), 200); res.on('close', () => clearInterval(interval)); return; }
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'set-cookie': 'should-not-escape=1' }); res.end('<html><head><base href="/link/workbench/"></head><body>ok</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const target = { url: 'https://127.0.0.1:' + server.address().port, pin: identity.pin, token: 'private-token' };
  await assert.rejects(remoteJson({ ...target, pin: Buffer.alloc(32, 1).toString('base64') }, '/link/api/workbench', {}), /指纹/); assert.equal(authenticated, 0);
  const proxy = await createDeviceProxy(target, { parentOrigin: 'http://127.0.0.1:4444' }); t.after(() => proxy.close());
  const login = await fetch(await proxy.enter(), { redirect: 'manual' }), path = login.headers.get('location');
  const response = await fetch(proxy.origin + path); assert.equal(response.headers.get('set-cookie'), null); assert.match(await response.text(), /href="\/s\/[A-Za-z0-9_-]+\/link\/workbench\//);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors http:\/\/127.0.0.1:4444 dsh-app:/);
  assert.equal((await fetch(proxy.origin + '/link/workbench/')).status, 403);
  for (let i = 0; i < 18; i++) { const repeated = await fetch(await proxy.enter(), { redirect: 'manual' }); assert.equal(repeated.headers.get('location'), path); }
  assert.equal((await fetch(proxy.origin + path)).status, 200, 'retained workbench survives repeated host selection');
  const prefix = path.split('/link/workbench/')[0]; const ws = new WebSocket(proxy.origin.replace('http:', 'ws:') + prefix + '/socket', { origin: proxy.origin }); t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const ready = new Set(); const complete = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('multiplex timeout')), 5000); ws.on('message', raw => { const frame = JSON.parse(raw); if (frame.type === 'data' && frame.value.type === 'ready') ready.add(frame.id); if (ready.size === 8) { clearTimeout(timer); resolve(); } }); });
  for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ type: 'open', id: 'stream-' + i, body: { id: 'stream-' + i, endpoint: 'state', payload: {} } }));
  await complete; assert.equal(ready.size, 8);
});
