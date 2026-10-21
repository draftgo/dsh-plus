import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { listen, validateConfig } from '../src/transport/server.mjs';
import { createRelayServer } from '../src/transport/relay-server.mjs';
import { createRelayHost } from '../src/transport/relay-host.mjs';
import { relayPathAllowed } from '../src/transport/relay-protocol.mjs';
import { createWorkbench } from '../src/transport/workbench.mjs';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
function request(port, path, { method = 'GET', body, token, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port, path, method, servername: 'localhost', ca: request.relayCert, headers: {
      host: `localhost:${port}`, origin: request.relayOrigin, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}), ...headers,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('relay binds one Link host and streams pairing, workbench, and voice only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-relay-'));
  const targetDir = join(directory, 'target'), relayDir = join(directory, 'relay'), workbenchRoot = join(directory, 'workbench');
  await mkdir(targetDir); await mkdir(relayDir); await mkdir(workbenchRoot);
  await writeFile(join(workbenchRoot, 'index.html'), '<!doctype html><html><head></head><body>real-workbench</body></html>');
  const targetIdentity = await loadIdentity(targetDir), relayIdentity = await loadIdentity(relayDir);
  const store = await openStore(join(directory, 'devices'));
  const relayPort = await freePort(), relayOrigin = `https://localhost:${relayPort}`;
  request.relayCert = relayIdentity.cert; request.relayOrigin = relayOrigin;
  const forwardedWorkbenchCookies = [];
  const ctx = {
    connection: {
      createPeer: () => ({ dispose: async () => {} }),
      createSharedFetchHandler: () => ({
        requestBodyMode: () => 'streaming',
        async fetch(request) {
          let uploaded = 0;
          if (request.body) for await (const chunk of request.body) uploaded += chunk.length;
          const data = Buffer.alloc(48 * 48 * 1024, 0x5a);
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }), { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-uploaded-bytes': String(uploaded) } });
        },
      }),
    },
    webServer: { renderIndex: html => html },
    clientModules: undefined,
    get: () => ({ acceptRealtimeSocket(ws) { ws.on('message', (data, binary) => ws.send(data, { binary })); } }),
  };
  const workbench = createWorkbench(ctx, store, { workbenchRoot });
  const handleWorkbench = workbench.handle;
  workbench.handle = (...args) => { forwardedWorkbenchCookies.push(args[0].headers.cookie || ''); return handleWorkbench(...args); };
  const linkConfig = validateConfig({ enabled: true, host: '127.0.0.1', port: 0 }, { enabled: false, host: '127.0.0.1', port: 0, publicUrl: '' });
  const linkServer = await listen({ identity: targetIdentity, config: linkConfig, webRoot: new URL('../dist/web/', import.meta.url), store, dispatch: async input => ({ action: input.action }), workbench, onError: () => {} });
  const token = 'relay-host-secret-with-at-least-32-bytes';
  const relayServer = await createRelayServer({ host: '127.0.0.1', port: relayPort, identity: relayIdentity, publicUrl: relayOrigin, token });
  const hostErrors = [];
  const host = createRelayHost({ relayUrl: relayOrigin, relayCa: relayIdentity.cert, token, target: { url: `https://127.0.0.1:${linkServer.port}`, pin: targetIdentity.pin }, onError: error => hostErrors.push(error.message) });
  t.after(async () => {
    await host.close(); await relayServer.close(); await linkServer.close(); await store.flush(); await rm(directory, { recursive: true, force: true });
    delete request.relayCert; delete request.relayOrigin;
  });
  for (let index = 0; index < 50 && !host.status().connected; index++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(host.status().connected, true);

  const pairing = store.begin();
  const requested = await request(relayPort, '/link/api/pair', { method: 'POST', body: JSON.stringify({ code: pairing.code, name: 'Relay phone' }), headers: { 'content-type': 'application/json' } });
  assert.equal(requested.status, 200, `${requested.body.toString()} host=${JSON.stringify(host.status())} errors=${hostErrors.join('|')}`);
  const pending = requested.body.toString();
  const pendingValue = JSON.parse(pending);
  await store.decide(pendingValue.requestId, true);
  const approval = await request(relayPort, '/link/api/pair/status', { method: 'POST', body: JSON.stringify(pendingValue), headers: { 'content-type': 'application/json' } });
  assert.equal(approval.status, 200);
  const approved = JSON.parse(approval.body), tokenValue = approved.token;
  const opened = await request(relayPort, '/link/api/workbench', { method: 'POST', token: tokenValue, body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(opened.status, 200);
  const cookie = (opened.headers['set-cookie']?.[0] || opened.headers['set-cookie']).split(';')[0];
  assert.match(cookie, /^dsh_link_workbench=/);
  const page = await request(relayPort, '/link/workbench/', { cookie: `${cookie}; dsh_owner=owner-secret` });
  assert.equal(page.status, 200); assert.match(page.body.toString(), /real-workbench/);
  assert.deepEqual(forwardedWorkbenchCookies, [cookie]);

  const payload = Buffer.alloc(1_500_000, 0x41);
  const streamed = await request(relayPort, '/link/workbench/api/stream/echo', { method: 'POST', body: payload, cookie, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers['x-uploaded-bytes'], String(payload.length));
  assert.equal(streamed.body.length, 48 * 48 * 1024);
  assert.equal(streamed.body[0], 0x5a);

  const voiceUrl = `wss://localhost:${relayPort}/link/workbench/api/voice/realtime`;
  const browser = new WebSocket(voiceUrl, { ca: relayIdentity.cert, origin: relayOrigin, headers: { host: `localhost:${relayPort}`, cookie }, perMessageDeflate: false });
  t.after(() => browser.terminate());
  await once(browser, 'open'); browser.send('voice-through-relay');
  const [voiceData, isBinary] = await once(browser, 'message');
  assert.equal(String(voiceData), 'voice-through-relay'); assert.equal(isBinary, false);

  assert.equal((await request(relayPort, '/api/commander-link')).status, 404);
  assert.equal((await request(relayPort, '/link/workbench/api/commander-link')).status, 404);
  assert.equal((await request(relayPort, '/link/workbench/api/admin')).status, 404);
  assert.equal((await request(relayPort, '/link/api/info', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal(relayPathAllowed('POST', '/link/workbench/api/commander-devices'), false);
  assert.equal(relayPathAllowed('GET', '/link/workbench/%2e%2e/api/commander-link'), false);
  assert.equal(relayPathAllowed('CONNECT', 'http://127.0.0.1:22'), false);

  await store.revoke(approved.deviceId); await workbench.revoke(approved.deviceId);
  assert.equal((await request(relayPort, '/link/api/workbench', { method: 'POST', token: tokenValue, body: '{}' })).status, 401);
  assert.equal((await request(relayPort, '/link/workbench/api/stream/echo', { method: 'POST', cookie, body: '{}' })).status, 401);
});

test('relay rejects excess voice upgrades without crashing and host close interrupts TLS handshake', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-relay-limit-'));
  await mkdir(join(directory, 'relay'));
  const identity = await loadIdentity(join(directory, 'relay'));
  const relayPort = await freePort(), origin = `https://localhost:${relayPort}`;
  request.relayCert = identity.cert; request.relayOrigin = origin;
  const relay = await createRelayServer({ host: '127.0.0.1', port: relayPort, identity, publicUrl: origin, token: 'relay-host-secret-with-at-least-32-bytes' });
  const control = new WebSocket(`wss://localhost:${relayPort}/__link/relay/control`, { ca: identity.cert, origin, headers: { host: `localhost:${relayPort}`, authorization: 'Bearer relay-host-secret-with-at-least-32-bytes' }, perMessageDeflate: false });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    control.terminate(); await relay.close(); await rm(directory, { recursive: true, force: true });
  });
  control.on('error', () => {});
  await once(control, 'open');
  let received = 0, resolveRequests;
  const allRequests = new Promise(resolve => { resolveRequests = resolve; });
  control.on('message', raw => {
    const input = JSON.parse(raw.toString());
    if (input.type === 'http') {
      const url = new URL('/__link/relay/data', origin); url.protocol = 'wss:';
      const data = new WebSocket(url, { ca: identity.cert, headers: { host: `localhost:${relayPort}`, authorization: 'Bearer ' + input.ticket }, perMessageDeflate: false });
      data.on('error', () => {}); data.once('open', () => data.close(1011, 'test drop'));
    } else if (input.type === 'voice' && ++received === 64) resolveRequests();
  });
  let timeout;
  const dropped = await Promise.race([
    request(relayPort, '/link/api/info'),
    new Promise(resolve => { timeout = setTimeout(() => resolve(undefined), 2_000); }),
  ]);
  clearTimeout(timeout);
  assert.equal(dropped?.status, 502, 'a closed data channel must end the pending HTTP response');
  for (let index = 0; index < 64; index++) {
    const client = new WebSocket(`wss://localhost:${relayPort}/link/workbench/api/voice/realtime`, { ca: identity.cert, origin, headers: { host: `localhost:${relayPort}` }, perMessageDeflate: false });
    client.on('error', () => {}); clients.push(client);
  }
  await allRequests;
  const overflow = new WebSocket(`wss://localhost:${relayPort}/link/workbench/api/voice/realtime`, { ca: identity.cert, origin, headers: { host: `localhost:${relayPort}` }, perMessageDeflate: false });
  clients.push(overflow);
  const status = await new Promise(resolve => {
    overflow.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
    overflow.on('error', () => {});
  });
  assert.equal(status, 429);

  const stalled = createNetServer(() => {});
  stalled.listen(0, '127.0.0.1'); await once(stalled, 'listening');
  const port = stalled.address().port;
  const host = createRelayHost({ relayUrl: `https://127.0.0.1:${port}`, token: 'relay-host-secret-with-at-least-32-bytes', target: { url: 'https://127.0.0.1:48721', pin: 'A'.repeat(43) + '=' } });
  await once(stalled, 'connection');
  const started = Date.now(); await host.close();
  assert.ok(Date.now() - started < 2_000, 'close should not wait for the TLS handshake timeout');
  await new Promise(resolve => stalled.close(resolve));
});

test('relay and host reject weak credentials and non-loopback upstreams', async () => {
  assert.throws(() => createRelayHost({ relayUrl: 'https://relay.example', token: 'short', target: { url: 'https://127.0.0.1:443', pin: 'x' } }));
  assert.throws(() => createRelayHost({ relayUrl: 'https://relay.example', token: 'relay-host-secret-with-at-least-32-bytes', target: { url: 'https://example.com', pin: 'A'.repeat(43) + '=' } }), /loopback/);
  const identity = { key: 'key', cert: 'cert' };
  await assert.rejects(createRelayServer({ host: '127.0.0.1', port: 48730, identity, publicUrl: 'http://relay.example', token: 'relay-host-secret-with-at-least-32-bytes' }), /HTTPS/);
});
