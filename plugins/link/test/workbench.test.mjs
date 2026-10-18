import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { request as tlsRequest } from 'node:https';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createWorkbench } from '../src/transport/workbench.mjs';
import { listen, validateConfig } from '../src/transport/server.mjs';

function request(f, path, { method = 'POST', body = {}, token, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = tlsRequest({ host: '127.0.0.1', port: f.server.port, path, method, servername: 'localhost', ca: f.identity.cert, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode, headers: res.headers, value }); });
    }); req.on('error', reject); req.end(method === 'POST' ? JSON.stringify(body) : undefined);
  });
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'link-workbench-'));
  const root = join(directory, 'frontend'), web = join(directory, 'link');
  await mkdir(root); await mkdir(web);
  await writeFile(join(root, 'index.html'), '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>');
  await writeFile(join(root, 'asset.js'), 'globalThis.sharedUI=true;');
  await writeFile(join(web, 'workbench.js'), 'globalThis.__DSH_LINK_WORKBENCH__=true;');
  await writeFile(join(directory, 'private.txt'), 'secret');
  await symlink(join(directory, 'private.txt'), join(root, 'escape.txt'));
  const store = await openStore(join(directory, 'state')), identity = await loadIdentity(directory);
  const calls = [], opened = [], disposed = [];
  const ctx = {
    connection: {
      createPeer(options) { return { principal: options.principal, id: 'peer-' + (calls.length + 1), async dispose() { disposed.push(this.id); } }; },
      createSharedFetchHandler(channel) { assert.equal(channel, '/api'); return { requestBodyMode() { return 'buffered'; }, async fetch(request, peer) { calls.push({ path: new URL(request.url).pathname, body: request.method === 'POST' ? await request.json() : null, peer, cookie: request.headers.get('cookie'), auth: request.headers.get('authorization') }); return Response.json({ ok: true, preset: 'same-host', voice: 'same-config' }); } }; },
    },
    webServer: { renderIndex(html) { return html.replace('<head>', '<head><script>globalThis.__DSH_BOOT__={entries:[]}</script><script src="/plugins/test.js"></script>'); } },
    clientModules: { async fetchBundle(request) { return new Response('globalThis.sharedPlugin=true;', { headers: { 'content-type': 'text/javascript' } }); } },
    typertGateway: { wireStream: { failure(error) { return { message: error.message, code: 'gateway/internal', details: {} }; }, async open(endpoint, payload, uplink, peer, signal) { opened.push({ endpoint, payload, peer, signal }); return { async *[Symbol.asyncIterator]() { if (endpoint === 'fixture/echo') for await (const item of uplink) yield { received: item }; else yield { sameUI: true }; } }; } } },
  };
  const workbench = createWorkbench(ctx, store, { workbenchRoot: root, webRoot: pathToFileURL(web + '/') });
  const config = validateConfig({ enabled: true, host: '127.0.0.1', port: 0 }, store.state);
  const server = await listen({ identity, config, webRoot: pathToFileURL(web + '/'), store, workbench, dispatch() {}, onError() {} });
  const f = { store, identity, workbench, server, calls, opened, disposed };
  f.call = (path, options) => request(f, path, options);
  const pair = store.begin(), pending = store.request(pair.code, 'Workbench test');
  await store.decide(pending.requestId, true);
  const approved = store.poll(pending.requestId, pending.pollToken);
  f.token = approved.token; f.deviceId = approved.deviceId;
  t.after(async () => { await server.close(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  return f;
}
async function login(f) {
  const result = await f.call('/link/api/workbench', { token: f.token });
  assert.equal(result.status, 200); assert.equal(result.value.url, '/link/workbench/');
  const header = result.headers['set-cookie'][0];
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/link/workbench/']) assert(header.includes(flag));
  return header.split(';')[0];
}

test('workbench requires approved device cookie, serves shared index and blocks owner device management', async t => {
  const f = await setup(t);
  assert.equal((await f.call('/link/api/workbench')).status, 401);
  assert.equal((await f.call('/link/workbench/', { method: 'GET' })).status, 303);
  assert.equal((await f.call('/link/workbench/api/session/list')).status, 401);
  const cookie = await login(f);
  const page = await f.call('/link/workbench/', { method: 'GET', cookie });
  assert.equal(page.status, 200); assert(page.value.includes('<base href="/link/workbench/">'));
  assert(page.value.includes('src="/link/workbench/workbench.js"')); assert(page.value.includes('src="/link/workbench/plugins/test.js"'));
  assert(page.headers['content-security-policy'].includes("'sha256-")); assert(!page.value.includes(f.token));
  assert.equal((await f.call('/link/workbench/asset.js', { method: 'GET', cookie })).status, 200);
  assert.equal((await f.call('/link/workbench/workbench.js', { method: 'GET', cookie })).status, 200);
  assert.equal((await f.call('/link/workbench/plugins/test.js', { method: 'GET', cookie })).status, 200);
  assert.deepEqual((await f.call('/link/workbench/open-in-app/apps', { method: 'GET', cookie })).value, { apps: [] });
  assert.equal((await f.call('/link/workbench/escape.txt', { method: 'GET', cookie })).status, 404);
  assert.equal((await f.call('/link/workbench/api/commander-link', { cookie, body: { action: 'configure', enabled: false } })).status, 403);
  assert.equal((await f.call('/api/commander', { cookie })).status, 404);
  assert.equal((await f.call('/link/workbench/api/voice', { cookie, headers: { origin: 'https://evil.example' } })).status, 403);
  for (const path of ['voice', 'commander/tooling', 'settings/get']) assert.equal((await f.call('/link/workbench/api/' + path, { cookie, body: { action: 'config' } })).status, 200);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/voice', '/api/commander/tooling', '/api/settings/get']);
  assert(f.calls.every(call => call.peer === f.calls[0].peer && call.peer.principal.kind === 'owner' && !call.cookie && !call.auth));
  await f.store.revoke(f.deviceId); await f.workbench.revoke(f.deviceId);
  assert.equal((await f.call('/link/workbench/api/voice', { cookie })).status, 401);
  assert.equal((await f.call('/link/workbench/asset.js', { method: 'GET', cookie })).status, 401);
  assert.equal(f.disposed.length, 1);
});

test('shared Gateway stream has ordered uplink, final frame and isolated peer', async t => {
  const f = await setup(t), cookie = await login(f);
  const streaming = new Promise((resolve, reject) => {
    const req = tlsRequest({ host: '127.0.0.1', port: f.server.port, path: '/link/workbench/remote/open', method: 'POST', ca: f.identity.cert, servername: 'localhost', headers: { cookie, 'content-type': 'application/json' } }, res => {
      let text = '', sent = false;
      res.on('data', async chunk => {
        text += chunk.toString();
        if (!sent && text.includes('"ready"')) {
          sent = true;
          try {
            await f.call('/link/workbench/remote/uplink', { cookie, body: { id: 'stream-1', type: 'item', value: { message: 'hello' } } });
            await f.call('/link/workbench/remote/uplink', { cookie, body: { id: 'stream-1', type: 'end' } });
          } catch (error) { reject(error); }
        }
      });
      res.on('error', reject); res.on('end', () => resolve(text.trim().split('\n').map(JSON.parse)));
    }); req.on('error', reject); req.end(JSON.stringify({ id: 'stream-1', endpoint: 'fixture/echo', payload: { args: {} } }));
  });
  const frames = await streaming;
  assert.deepEqual(frames, [{ type: 'ready' }, { type: 'item', value: { received: { message: 'hello' } } }, { type: 'end' }]);
  assert.equal(f.opened[0].endpoint, 'fixture/echo'); assert.equal(f.opened[0].peer.principal.kind, 'owner');
  assert.equal((await f.call('/link/workbench/remote/uplink', { cookie, body: { id: 'stream-1', type: 'item', value: 1 } })).status, 410);
});
