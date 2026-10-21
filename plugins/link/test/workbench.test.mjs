import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { request as tlsRequest } from 'node:https';
import { connect as connectHttp2 } from 'node:http2';
import { once } from 'node:events';
import { WebSocket } from 'ws';
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
  const calls = [], opened = [], disposed = [], voiceSockets = [];
  const ctx = {
    get(name) { return name === 'voice' ? this.voice : undefined; },
    voice: { acceptRealtimeSocket(ws) { voiceSockets.push(ws); ws.on('message', (data, binary) => ws.send(data, { binary })); } },
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
  const f = { store, identity, workbench, server, calls, opened, disposed, ctx, voiceSockets };
  f.call = (path, options) => request(f, path, options);
  const pair = store.begin(), pending = store.request(pair.code, 'Workbench test');
  await store.decide(pending.requestId, true);
  const approved = store.poll(pending.requestId, pending.pollToken);
  f.token = approved.token; f.deviceId = approved.deviceId;
  t.after(async () => { await server.close(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  return f;
}

test('one HTTP/2 connection carries eight subscriptions plus session navigation and uplinks', { timeout: 20_000 }, async t => {
  const f = await setup(t), cookie = await login(f);
  const client = connectHttp2(`https://localhost:${f.server.port}`, { ca: f.identity.cert, lookup: (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4) });
  t.after(() => client.destroy());
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  assert.equal(client.socket.alpnProtocol, 'h2');
  const active = [];
  const streams = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const request = client.request({ ':method': 'POST', ':path': '/link/workbench/remote/open', cookie, 'content-type': 'application/json' });
    let buffer = '';
    request.setEncoding('utf8'); request.on('error', reject);
    request.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) resolve({ request, get text() { return buffer; } }); });
    request.end(JSON.stringify({ id: 'subscription-' + index, endpoint: 'fixture/echo', payload: { args: {} } }));
    active.push(request);
  })));
  t.after(() => { for (const request of active) request.close(); });
  assert.equal(f.opened.length, 8);
  const send = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const request = client.request({ ':method': 'POST', ':path': path, cookie, 'content-type': 'application/json', ...headers });
    let status, buffer = '';
    request.on('response', headers => { status = headers[':status']; });
    request.setEncoding('utf8'); request.on('data', chunk => { buffer += chunk; }); request.on('error', reject);
    request.on('end', () => resolve({ status, value: JSON.parse(buffer) })); request.end(JSON.stringify(body));
  });
  const navigation = await send('/link/workbench/api/session/get', { id: 'selected-session' });
  assert.equal(navigation.status, 200);
  assert.deepEqual(f.calls.at(-1).body, { id: 'selected-session' });
  const updates = await send('/link/workbench/api/commander-updates', { action: 'status' });
  assert.equal(updates.status, 200);
  const forged = await send('/link/workbench/api/session/get', {}, { ':authority': 'evil.example' });
  assert.equal(forged.status, 403);
  assert.equal((await send('/link/workbench/api/session/get', {}, { ':authority': `localhost:${f.server.port}`, host: 'evil.example' })).status, 403);
  assert.equal((await send('/link/workbench/api/session/get', {}, { origin: 'https://evil.example' })).status, 403);
  for (let index = 0; index < streams.length; index++) {
    assert.equal((await send('/link/workbench/remote/uplink', { id: 'subscription-' + index, type: 'item', value: { session: index } })).status, 200);
    const end = new Promise((resolve, reject) => { streams[index].request.once('end', resolve); streams[index].request.once('error', reject); });
    assert.equal((await send('/link/workbench/remote/uplink', { id: 'subscription-' + index, type: 'end' })).status, 200);
    await end;
    const frames = streams[index].text.trim().split('\n').map(JSON.parse);
    assert.deepEqual(frames, [{ type: 'ready' }, { type: 'item', value: { received: { session: index } } }, { type: 'end' }]);
  }
  assert.equal((await f.call('/link/api/info', { method: 'GET' })).status, 200, 'HTTP/1.1 clients remain compatible');
});
async function login(f) {
  const result = await f.call('/link/api/workbench', { token: f.token });
  assert.equal(result.status, 200); assert.equal(result.value.url, '/link/workbench/');
  const header = result.headers['set-cookie'][0];
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/link/workbench/']) assert(header.includes(flag));
  return header.split(';')[0];
}
function voiceSocket(f, cookie, options = {}) {
  return new WebSocket(`wss://127.0.0.1:${f.server.port}/link/workbench/api/voice/realtime`, { ca: f.identity.cert, servername: 'localhost', origin: `https://127.0.0.1:${f.server.port}`, headers: cookie ? { cookie } : {}, ...options });
}

test('realtime voice requires device cookie, authorized Host and same Origin before accepting', async t => {
  const f = await setup(t), cookie = await login(f);
  for (const [credentials, options, status] of [
    [undefined, {}, 401],
    ['dsh_link_workbench=forged', {}, 401],
    [cookie, { origin: 'https://evil.example' }, 403],
    [cookie, { origin: undefined }, 403],
    [cookie, { headers: { cookie, host: 'evil.example' } }, 403],
  ]) {
    const ws = voiceSocket(f, credentials, options);
    await assert.rejects(once(ws, 'open'), new RegExp('Unexpected server response: ' + status));
  }
  assert.equal(f.voiceSockets.length, 0);
  f.ctx.voice = undefined;
  await assert.rejects(once(voiceSocket(f, cookie), 'open'), /Unexpected server response: 503/);
});

test('realtime voice preserves text and binary and terminates on device revoke and workbench close', async t => {
  const f = await setup(t), cookie = await login(f), ws = voiceSocket(f, cookie);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  assert.equal(f.voiceSockets.length, 1);
  for (const [payload, binary] of [[JSON.stringify({ type: 'attach', id: 'asr-session', ticket: 'one-use', callId: 'call-1' }), false], [Buffer.from([0, 255, 32, 0]), true]]) {
    const result = once(ws, 'message'); ws.send(payload, { binary });
    const [data, isBinary] = await result;
    assert.deepEqual(data, Buffer.from(payload)); assert.equal(isBinary, binary);
  }
  const revoked = once(ws, 'close');
  await f.store.revoke(f.deviceId); await f.workbench.revoke(f.deviceId); await revoked;
  await assert.rejects(once(voiceSocket(f, cookie), 'open'), /Unexpected server response: 401/);
  const pair = f.store.begin(), pending = f.store.request(pair.code, 'Second device');
  await f.store.decide(pending.requestId, true); f.token = f.store.poll(pending.requestId, pending.pollToken).token;
  const second = voiceSocket(f, await login(f)); t.after(() => second.terminate()); await once(second, 'open');
  const ended = once(second, 'close'); await f.workbench.close(); await ended;
});

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
