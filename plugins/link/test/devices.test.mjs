import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { openDeviceRegistry, normalizeTarget } from '../src/devices/registry.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createDeviceProxy } from '../src/devices/proxy.mjs';
import { remoteJson } from '../src/devices/remote.mjs';
import { createDeviceCenter, parsePairingUri } from '../src/devices/center.mjs';
import { WebSocket, WebSocketServer } from 'ws';

const temp = async t => { const directory = await mkdtemp(join(tmpdir(), 'dsh-devices-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };
test('pairing accepts full cloud HTTPS links and existing pinned Link URIs', () => {
  const cloud = parsePairingUri('https://cloud.example/link/#code=one-use');
  assert.equal(cloud.target.url, 'https://cloud.example'); assert.equal(cloud.target.pin, ''); assert.equal(cloud.code, 'one-use');
  const pin = Buffer.alloc(32, 1).toString('base64');
  const local = parsePairingUri('dshlink://pair?' + new URLSearchParams({ url: 'https://127.0.0.1:17770', pin, code: 'local-code' }));
  assert.equal(local.target.pin, pin); assert.equal(local.code, 'local-code');
  for (const uri of ['http://cloud.example/link/#code=x', 'https://u:p@cloud.example/link/#code=x', 'https://cloud.example/other/#code=x', 'https://cloud.example/link/?token=x#code=x', 'https://cloud.example/link/#code=x&code=y', 'https://cloud.example/link/#code=x&token=y', 'https://cloud.example/link/']) assert.throws(() => parsePairingUri(uri));
});
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
test('device center exposes only explicit local host administration fields', async t => {
  const calls = [], directory = await temp(t);
  const center = await createDeviceCenter({ directory, webRoot: new URL('../dist/web/', import.meta.url), managerFactory: () => null, hostAdmin: async input => { calls.push(input); return { enabled: true }; } });
  t.after(() => center.close());
  assert.equal((await center.api({ action: 'list' })).capabilities.hostAdmin, true);
  for (const [action, expected] of [['hostStatus', 'status'], ['hostConfigure', 'configure'], ['hostPairing', 'pairing'], ['hostConfirm', 'confirm'], ['hostReject', 'reject'], ['hostRevoke', 'revoke']]) {
    assert.deepEqual(await center.api({ action, id: 'device', enabled: true, mode: 'lan', token: 'forbidden', operation: 'shell' }), { enabled: true });
    assert.equal(calls.at(-1).action, expected); assert.equal(calls.at(-1).token, undefined); assert.equal(calls.at(-1).operation, undefined);
  }
  assert.deepEqual(calls[0], { action: 'status' });
  assert.deepEqual(calls[1], { action: 'configure', enabled: true });
  assert.deepEqual(calls[2], { action: 'pairing', mode: 'lan' });
  await assert.rejects(center.api({ action: 'cloud-access' }), /不支持 SSH/);
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
  const publicProxy = await createDeviceProxy(target, { parentOrigin: 'https://owner.test', publicOrigin: 'https://work.test', publicPrefix: '/p/cloud-route' });
  t.after(() => publicProxy.close());
  const publicEntry = new URL(await publicProxy.enter());
  assert.equal(publicEntry.origin, 'https://work.test'); assert.equal(publicEntry.pathname, '/p/cloud-route/enter');
  const publicLogin = await fetch(publicProxy.origin + '/enter' + publicEntry.search, { redirect: 'manual' });
  const publicLocation = publicLogin.headers.get('location'); assert.match(publicLocation, /^\/p\/cloud-route\/s\//);
  const publicPage = await fetch(publicProxy.origin + publicLocation.slice('/p/cloud-route'.length));
  assert.match(await publicPage.text(), /href="\/p\/cloud-route\/s\//);
  assert.equal((await fetch(proxy.origin + '/link/workbench/')).status, 403);
  for (let i = 0; i < 18; i++) { const repeated = await fetch(await proxy.enter(), { redirect: 'manual' }); assert.equal(repeated.headers.get('location'), path); }
  assert.equal((await fetch(proxy.origin + path)).status, 200, 'retained workbench survives repeated host selection');
  const prefix = path.split('/link/workbench/')[0]; const ws = new WebSocket(proxy.origin.replace('http:', 'ws:') + prefix + '/socket', { origin: proxy.origin }); t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const ready = new Set(); const complete = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('multiplex timeout')), 5000); ws.on('message', raw => { const frame = JSON.parse(raw); if (frame.type === 'data' && frame.value.type === 'ready') ready.add(frame.id); if (ready.size === 8) { clearTimeout(timer); resolve(); } }); });
  for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ type: 'open', id: 'stream-' + i, body: { id: 'stream-' + i, endpoint: 'state', payload: {} } }));
  await complete; assert.equal(ready.size, 8);
});

async function voiceProxy(t, { delay = 0 } = {}) {
  const directory = await temp(t), identity = await loadIdentity(directory), accepted = [], failures = [];
  const server = createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    assert.equal(req.url, '/link/api/workbench'); assert.equal(req.headers.authorization, 'Bearer private-token');
    res.writeHead(200, { 'set-cookie': 'dsh_link_workbench=voice-cookie; HttpOnly; Secure; Path=/link/workbench/' });
    res.end('{"url":"/link/workbench/"}');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/link/workbench/api/voice/realtime');
    assert.equal(req.headers.cookie, 'dsh_link_workbench=voice-cookie'); assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.origin, `https://127.0.0.1:${server.address().port}`);
    const upgrade = () => { if (socket.destroyed) return; wss.handleUpgrade(req, socket, head, ws => { accepted.push(ws); ws.on('error', () => {}); ws.on('message', (data, binary) => ws.send(data, { binary })); }); };
    if (delay) setTimeout(upgrade, delay); else upgrade();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = { url: 'https://127.0.0.1:' + server.address().port, pin: identity.pin, token: 'private-token' };
  const proxy = await createDeviceProxy(target, { parentOrigin: 'http://127.0.0.1:4444', onFailure: error => failures.push(error) });
  t.after(async () => { await proxy.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const login = await fetch(await proxy.enter(), { redirect: 'manual' }), prefix = login.headers.get('location').split('/link/workbench/')[0];
  const connect = (path = prefix + '/link/workbench/api/voice/realtime', options = {}) => new WebSocket(proxy.origin.replace('http:', 'ws:') + path, { origin: proxy.origin, ...options });
  return { proxy, accepted, failures, connect, prefix };
}

test('voice proxy forwards attach and binary PCM with pinned TLS and private remote cookie', async t => {
  const f = await voiceProxy(t), ws = f.connect(); t.after(() => ws.terminate()); await once(ws, 'open');
  for (const [payload, binary] of [[JSON.stringify({ type: 'attach', id: 'asr-1', ticket: 'one-use', callId: 'call-1' }), false], [Buffer.from([0, 255, 9, 0]), true]]) {
    const result = once(ws, 'message'); ws.send(payload, { binary }); const [data, isBinary] = await result;
    assert.deepEqual(data, Buffer.from(payload)); assert.equal(isBinary, binary);
  }
  assert.equal(f.accepted.length, 1);
  const closed = once(ws, 'close'); f.accepted[0].close(); await closed;
  const second = f.connect(); t.after(() => second.terminate()); await once(second, 'open');
  const reply = once(second, 'message'); second.send('ready'); await reply;
  const remoteClosed = once(f.accepted.at(-1), 'close'); second.close(); await remoteClosed;
  const third = f.connect(); t.after(() => third.terminate()); await once(third, 'open');
  const ended = once(third, 'close'); await f.proxy.close(); await ended;
});

test('voice proxy rejects invalid local session, Origin, Host and unlisted paths', async t => {
  const f = await voiceProxy(t);
  for (const [path, options] of [
    ['/link/workbench/api/voice/realtime', {}],
    ['/s/' + 'a'.repeat(43) + '/link/workbench/api/voice/realtime', {}],
    [f.prefix + '/link/workbench/api/voice/realtime', { origin: 'https://evil.example' }],
    [f.prefix + '/link/workbench/api/voice/realtime', { origin: undefined }],
    [f.prefix + '/link/workbench/api/voice/realtime', { headers: { host: 'evil.example' } }],
    [f.prefix + '/link/workbench/api/voice/other', {}],
  ]) await assert.rejects(once(f.connect(path, options), 'open'), /socket hang up/);
  assert.equal(f.accepted.length, 0);
});

test('voice proxy closes excessive preconnect backlog instead of accumulating audio', async t => {
  const f = await voiceProxy(t, { delay: 100 }), ws = f.connect(); t.after(() => ws.terminate()); await once(ws, 'open');
  const ended = once(ws, 'close');
  for (let i = 0; i < 41; i++) ws.send(Buffer.from([i]));
  await ended; assert.match(f.failures[0]?.message, /实时语音连接尚未就绪/);
});

test('relay deployment owner callback saves credentials without exposing them in jobs', async t => {
  const directory = await temp(t), calls = [];
  let options;
  const center = await createDeviceCenter({ directory, webRoot: new URL('../dist/web/', import.meta.url), hostAdmin: async value => { calls.push(value); return { relay: { connected: false } }; }, managerFactory: value => { options = value; return { close: async () => {}, relayProbe: async () => ({ fingerprint: 'SHA256:test' }), deployRelay: async () => { await value.onRelay({ url: 'https://relay.test:24680', token: 'private-relay-secret' }); return { jobId: 'job' }; }, manageRelay: async input => ({ operation: input.operation }) }; } });
  t.after(() => center.close());
  assert.equal((await center.api({ action: 'list' })).capabilities.relayDeploy, true);
  assert.deepEqual(await center.api({ action: 'relayDeploy' }), { jobId: 'job' });
  assert.deepEqual(calls[0], { action: 'relay-configure', url: 'https://relay.test:24680', token: 'private-relay-secret', enabled: true });
  await center.api({ action: 'hostRelayConfigure', enabled: false, operation: 'shell', password: 'discard' });
  assert.deepEqual(calls[1], { action: 'relay-configure', enabled: false });
});
