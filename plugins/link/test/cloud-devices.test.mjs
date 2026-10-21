import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudDeviceGateway } from '../src/devices/cloud-gateway.mjs';
import { createDeviceCenter } from '../src/devices/center.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { mountLink } from '../src/index.mjs';

test('cloud gateway routes only registered paths and isolates owner credentials', async t => {
  const upstream = createServer((req, res) => { res.setHeader('set-cookie', 'owner=leak'); res.end(JSON.stringify({ path: req.url, headers: req.headers })); });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data))));
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const gateway = await createCloudDeviceGateway({ ownerOrigin: 'https://owner.test', workbenchOrigin: 'https://work.test', port, getCenter: async () => ({ origin: 'http://127.0.0.1:' + upstream.address().port }) }); t.after(() => gateway.close());
  const proxy = { origin: 'http://127.0.0.1:' + upstream.address().port, async close() {} };
  const registered = gateway.registerProxy(); registered.attach(proxy);
  const get = (path, host, origin) => new Promise((resolve, reject) => { const req = request('http://127.0.0.1:' + port + path, { headers: { host, cookie: 'owner=secret', authorization: 'Bearer private', ...(origin ? { origin } : {}) } }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); }); req.on('error', reject); req.end(); });
  const owner = await get('/devices/s/session/api/devices', 'owner.test', 'https://owner.test');
  assert.equal(owner.status, 200); assert.equal(JSON.parse(owner.body).path, '/s/session/api/devices');
  assert.equal(JSON.parse(owner.body).headers.cookie, undefined); assert.equal(owner.headers['set-cookie'], undefined);
  assert.equal((await get('/devices/s/session/', 'work.test')).status, 403);
  assert.equal((await get('/devices/s/session/', 'owner.test', 'https://work.test')).status, 403);
  assert.equal((await get('/p/invalid/enter', 'work.test')).status, 403);
  const remote = await get(registered.prefix + '/s/private/link/workbench/', 'work.test', 'https://work.test');
  assert.equal(remote.status, 200); assert.equal(JSON.parse(remote.body).path, '/s/private/link/workbench/');
  assert.equal(JSON.parse(remote.body).headers.authorization, undefined);
  const ws = new WebSocket('ws://127.0.0.1:' + port + registered.prefix + '/s/private/socket', { origin: 'https://work.test', headers: { host: 'work.test' } });
  t.after(() => ws.terminate()); await once(ws, 'open');
  ws.send('stream-frame'); assert.equal(String((await once(ws, 'message'))[0]), 'stream-frame'); ws.terminate();
  await proxy.close(); assert.equal((await get(registered.prefix + '/enter', 'work.test')).status, 403);
});

test('cloud centre returns same-origin entry and refuses unreachable loopback workspaces', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-center-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const center = await createDeviceCenter({ directory, webRoot: new URL('../dist/web/', import.meta.url), managerFactory: () => null, publicOrigin: 'https://owner.test' }); t.after(() => center.close());
  assert.match(center.launch('https://owner.test').url, /^https:\/\/owner.test\/devices\/enter\?ticket=/);
  await assert.rejects(center.api({ action: 'select', deviceId: 'saved' }), /独立 HTTPS/);
});

test('configured cloud owner launch serves the full centre through the fixed gateway', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-launch-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const routes = [];
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: route => { routes.push(route); return () => {}; } } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory, env: { DSH_LINK_CLOUD_ORIGIN: 'https://owner.test', DSH_LINK_CLOUD_AUTH_PORT: '0', DSH_LINK_DEVICE_GATEWAY_PORT: String(port) }, cloudProbe: async () => new Response('', { status: 503 }) });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const route = routes.find(item => item.path === '/api/commander-devices');
  const response = await route.fetch(new Request('http://dsh.internal/api/commander-devices', { method: 'POST', headers: { host: 'owner.test', origin: 'https://owner.test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch' }) }));
  assert.equal(response.status, 200); const target = new URL((await response.json()).url); assert.equal(target.origin, 'https://owner.test');
  const send = (path, method = 'GET', body) => new Promise((resolve, reject) => { const req = request('http://127.0.0.1:' + port + path, { method, headers: { host: 'owner.test', origin: 'https://owner.test', 'content-type': 'application/json' } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text })); }); req.on('error', reject); req.end(body); });
  const entry = await send(target.pathname + target.search); assert.equal(entry.status, 303); assert.match(entry.headers.location, /^\/devices\/s\//);
  const page = await send(entry.headers.location); assert.equal(page.status, 200); assert.match(page.body, /device-config.js/);
  const list = await send(entry.headers.location + 'api/devices', 'POST', JSON.stringify({ action: 'list' })); assert.equal(list.status, 200); assert.equal(JSON.parse(list.body).capabilities.hostAdmin, true);
});
