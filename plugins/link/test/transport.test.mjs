import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as tlsRequest } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { listen, validateConfig } from '../src/transport/server.mjs';

function request(port, identity, path, { method = 'POST', body = {}, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = tlsRequest({ host: '127.0.0.1', port, path, method, servername: 'localhost', ca: identity.cert, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data));
      res.on('end', () => { const data = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(data); } catch { value = data; } resolve({ status: res.statusCode, value, headers: res.headers }); });
    }); req.on('error', reject); req.end(method === 'POST' ? JSON.stringify(body) : undefined);
  });
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'link-transport-'));
  const store = await openStore(directory), identity = await loadIdentity(directory);
  const config = validateConfig({ enabled: true, host: '127.0.0.1', port: 0, publicUrl: 'https://desk.example.com' }, store.state);
  Object.assign(store.state, config);
  const server = await listen({ identity, config, webRoot: new URL('../dist/web/', import.meta.url), store, dispatch: async (body, device) => ({ action: body.action, device: device.id }), onError: () => {} });
  t.after(async () => { await server.close(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, identity, server, call: (path, options) => request(server.port, identity, path, options) };
}
test('real TLS certificate identity is stable and matches the QR SPKI', async t => {
  const f = await setup(t);
  const again = await loadIdentity(f.directory);
  assert.equal(again.pin, f.identity.pin);
  const spki = new X509Certificate(f.identity.cert).publicKey.export({ type: 'spki', format: 'der' });
  assert.equal(f.identity.pin, createHash('sha256').update(spki).digest('base64'));
  const response = await f.call('/link/api/info', { method: 'GET' });
  assert.equal(response.status, 200); assert.equal(response.value.name, 'DSH Link');
  assert.equal(response.headers['cache-control'], 'no-store');
});
test('single-use pairing needs desktop approval and a secret poll token; devices survive restart and revoke', async t => {
  const f = await setup(t), pairing = f.store.begin();
  const pair = await f.call('/link/api/pair', { body: { code: pairing.code, name: 'Phone' } });
  assert.equal(pair.status, 200);
  const query = pair.value;
  assert.equal((await f.call('/link/api/pair', { body: { code: pairing.code, name: 'Replay' } })).status, 400);
  assert.equal((await f.call('/link/api/pair/status', { body: { ...query, pollToken: 'wrong' } })).status, 400);
  assert.equal((await f.call('/link/api/pair/status', { body: query })).value.status, 'pending');
  assert.equal((await f.call('/link/api/rpc', { body: { action: 'state' } })).status, 401);
  await f.store.decide(query.requestId, true);
  await assert.rejects(f.store.decide(query.requestId, true), /失效/);
  const approved = (await f.call('/link/api/pair/status', { body: query })).value;
  assert.equal(approved.status, 'approved');
  assert.equal((await f.call('/link/api/rpc', { token: approved.token, body: { action: 'state' } })).value.device, approved.deviceId);
  assert(!(await readFile(join(f.directory, 'devices.json'), 'utf8')).includes(approved.token));
  const reopened = await openStore(f.directory);
  assert.equal(reopened.authenticate(approved.token).id, approved.deviceId);
  await f.store.revoke(approved.deviceId);
  assert.equal((await f.call('/link/api/rpc', { token: approved.token })).status, 401);
  assert.equal((await f.call('/link/api/pair/status', { body: query })).status, 400);
});
test('cross-origin, forged Host, admin RPC, traversal and oversized bodies are blocked', async t => {
  const f = await setup(t);
  assert.equal((await f.call('/link/api/pair', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/link/api/info', { method: 'GET', headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await f.call('/api/commander-link')).status, 404);
  assert.equal((await f.call('/link/../../devices.json', { method: 'GET' })).status, 404);
  assert.equal((await f.call('/link/api/pair', { body: { name: 'x'.repeat(300_000) } })).status, 413);
  assert.equal((await f.call('/link/', { method: 'GET' })).status, 200);
});
test('public URL is strict HTTPS and listener settings validate before mutation', () => {
  const prior = { enabled: false, host: '0.0.0.0', port: 48721, publicUrl: '' };
  for (const publicUrl of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=x']) assert.throws(() => validateConfig({ publicUrl }, prior));
  assert.throws(() => validateConfig({ port: -1 }, prior));
  assert.throws(() => validateConfig({ host: 'user.example.com' }, prior));
  assert.equal(prior.publicUrl, '');
  assert.equal(validateConfig({ publicUrl: 'https://example.com/' }, prior).publicUrl, 'https://example.com');
});

test('reverse proxy example keeps workbench streams and uplinks unbuffered', async () => {
  const config = await readFile(new URL('../config/nginx.example.conf', import.meta.url), 'utf8');
  for (const directive of [
    'proxy_http_version 1.1;',
    'location = /link/workbench/api/voice/realtime {',
    'proxy_set_header Upgrade $http_upgrade;',
    'proxy_set_header Connection "upgrade";',
    'proxy_set_header Connection "";',
    'proxy_buffering off;',
    'proxy_request_buffering off;',
    'proxy_connect_timeout 10s;',
    'proxy_send_timeout 120s;',
    'proxy_read_timeout 120s;',
  ]) assert.match(config, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('listener timeouts allow high-latency mobile requests and keep-alive reuse', async t => {
  const f = await setup(t);
  assert.deepEqual(f.server.timeouts, { request: 60_000, headers: 15_000, keepAlive: 10_000 });
});
