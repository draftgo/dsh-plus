import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCloudAccess } from '../../plugins/link/src/cloud-access.mjs';
import { openStore } from '../../plugins/link/src/pairing/store.mjs';
import { loadIdentity } from '../../plugins/link/src/transport/tls.mjs';
import { listen as listenLink, validateConfig } from '../../plugins/link/src/transport/server.mjs';
import { createWorkbench } from '../../plugins/link/src/transport/workbench.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.DSH_NGINX_BINARY || '/www/server/nginx/sbin/nginx';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (port, path, { method = 'GET', headers = {}, data } = {}) => new Promise((resolve, reject) => {
  const payload = data === undefined ? undefined : JSON.stringify(data);
  const req = request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: { host: 'cloud.test', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, response => {
    const chunks = []; response.on('data', value => chunks.push(value));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject); req.end(payload);
});

test('real Nginx guards all paths, preserves owner bootstrap and fails closed', { skip: !existsSync(binary) && 'Set DSH_NGINX_BINARY to an Nginx with auth_request' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cloud-proxy-'));
  let service, backend, nginx, port;
  try {
    service = await createCloudAccess(join(directory, 'state'), {
      env: { DSH_LINK_CLOUD_ORIGIN: 'https://cloud.test', DSH_LINK_CLOUD_AUTH_PORT: '0' },
      probe: async () => { const result = await call(port, '/__dsh_access/login'); return new Response(result.body, { status: result.status, headers: result.headers }); },
    });
    const key = 'isolated-test-access-key-2026';
    let backendHits = 0;
    backend = createServer((req, res) => {
      backendHits++;
      if (req.url === '/') { res.writeHead(401); res.end('owner login required'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    });
    const backendPort = await listen(backend);
    const reservation = createServer(); port = await listen(reservation); await close(reservation);
    const sample = (await readFile(join(root, 'plugins/link/config/nginx-cloud-access.example.conf'), 'utf8')).replaceAll('cloud.example.com', 'cloud.test').replaceAll('48722', String(service.port));
    await writeFile(join(directory, 'access.conf'), sample);
    await mkdir(join(directory, 'body')); await mkdir(join(directory, 'logs'));
    const bootstrap = join(root, 'plugins/link/config/nginx-cloud-bootstrap.example.conf');
    await writeFile(join(directory, 'nginx.conf'), `pid ${directory}/nginx.pid;
error_log ${directory}/error.log;
events {}
http { ${existsSync('/www/server/nginx/lib/lua/resty/core.lua') ? 'lua_package_path "/www/server/nginx/lib/lua/?.lua;;";' : ''} access_log off; client_body_temp_path ${directory}/body;
 server { listen 127.0.0.1:${port}; server_name cloud.test;
 include ${directory}/access.conf;
 location = / { proxy_pass http://127.0.0.1:${backendPort}; proxy_set_header Host $host; proxy_intercept_errors on; error_page 401 = @dsh_bootstrap; }
 location @dsh_bootstrap { include ${bootstrap}; rewrite ^ /?token=isolated-owner-fixture break; proxy_pass http://127.0.0.1:${backendPort}; proxy_set_header Host $host; }
 location /mobile { allow all; proxy_pass http://127.0.0.1:${backendPort}; }
 location /link/ { allow all; proxy_pass http://127.0.0.1:${backendPort}; }
 location / { proxy_pass http://127.0.0.1:${backendPort}; }
 }
}`);
    nginx = spawn(binary, ['-p', directory + '/', '-c', join(directory, 'nginx.conf'), '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; nginx.stderr.on('data', value => { stderr += value; });
    const exited = once(nginx, 'exit');
    for (let i = 0; i < 100; i++) {
      if (nginx.exitCode !== null) throw Error('Isolated Nginx failed: ' + stderr);
      try { if ((await call(port, '/__dsh_access/login')).status === 200) break; } catch {}
      if (i === 99) throw Error('Isolated Nginx not ready');
      await delay(20);
    }
    assert.equal(await service.checkReady(true), true, 'login proxy reaches the current auth instance');
    await service.manage({ operation: 'enable', key });
    for (const path of ['/', '/api/commander', '/events', '/plugins/client.js', '/link/', '/mobile', '/mobile/app.js', '/socket']) {
      const response = await call(port, path);
      assert.equal(response.status, 401, path + ' rejects anonymous access');
      assert(!response.body.includes('<html'), path + ' does not convert API failure into HTML');
    }
    assert.equal(backendHits, 0, 'owner bootstrap cannot bypass the access gate');
    assert.equal((await call(port, '/__dsh_access/check')).status, 404, 'auth subrequest is internal');
    const navigation = await call(port, '/', { headers: { 'sec-fetch-mode': 'navigate' } });
    assert.equal(navigation.status, 303); assert(navigation.headers.location.includes('/__dsh_access/login?next=/'));
    assert.equal((await call(port, '/api/commander', { headers: { 'sec-fetch-mode': 'navigate' } })).status, 401, 'API path stays JSON even with a navigation header');
    const query = '/link/?device=one%20two&view=chat';
    const next = await call(port, query, { headers: { 'sec-fetch-mode': 'navigate' } });
    assert.equal(next.status, 303);
    const loginPage = await call(port, new URL(next.headers.location, 'https://cloud.test').pathname + new URL(next.headers.location, 'https://cloud.test').search);
    assert(loginPage.body.includes(query), 'login retains the complete query and percent encoding');
    const forged = await call(port, '/__dsh_access/session', { method: 'POST', headers: { origin: 'https://evil.test', 'x-dsh-access': '1' }, data: { key } });
    assert.equal(forged.status, 403);
    const login = await call(port, '/__dsh_access/session', { method: 'POST', headers: { origin: 'https://cloud.test', 'x-dsh-access': '1' }, data: { key, next: '/link/?a=1&b=2' } });
    assert.equal(login.status, 200); assert.equal(JSON.parse(login.body).next, '/link/?a=1&b=2');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    for (const path of ['/', '/api/commander', '/events', '/plugins/client.js', '/link/', '/mobile/app.js']) assert.equal((await call(port, path, { headers: { cookie } })).status, 200, path + ' admits current access session');
    await service.manage({ operation: 'rotate', key: key + '-rotated' });
    assert.equal((await call(port, '/api/commander', { headers: { cookie } })).status, 401, 'rotation invalidates old sessions');
    await service.manage({ operation: 'disable' });
    assert.equal((await call(port, '/api/commander')).status, 200, 'explicit disabling restores access');
    await service.manage({ operation: 'enable', key });
    const before = backendHits; await service.close();
    assert.equal((await call(port, '/api/commander')).status, 500, 'auth outage fails closed');
    assert.equal(backendHits, before);
    nginx.kill('SIGQUIT'); await exited; nginx = undefined;
  } finally {
    if (nginx && nginx.exitCode === null) { const exit = once(nginx, 'exit'); nginx.kill('SIGTERM'); await exit; }
    await service?.close(); if (backend?.listening) await close(backend);
    await rm(directory, { recursive: true, force: true });
  }
});

test('real Nginx delegates only Link routes to paired-device auth while owner remains protected', { timeout: 30_000, skip: !existsSync(binary) && 'Set DSH_NGINX_BINARY to an Nginx with auth_request' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-device-proxy-'));
  let service, backend, nginx, link, store, port;
  try {
    service = await createCloudAccess(join(directory, 'access'), {
      env: { DSH_LINK_CLOUD_ORIGIN: 'https://cloud.test', DSH_LINK_CLOUD_AUTH_PORT: '0' },
      probe: async () => { const result = await call(port, '/__dsh_access/login'); return new Response(result.body, { status: result.status, headers: result.headers }); },
    });
    const state = join(directory, 'state'), web = join(directory, 'web'), frontend = join(directory, 'frontend');
    await mkdir(web); await mkdir(frontend);
    await writeFile(join(web, 'index.html'), '<html><body>pair a device</body></html>');
    await writeFile(join(frontend, 'index.html'), '<html><head></head><body>paired workbench</body></html>');
    store = await openStore(state);
    const identity = await loadIdentity(state);
    const ctx = { connection: { createPeer: () => ({ dispose() {} }) }, webServer: { renderIndex: html => html } };
    const workbench = createWorkbench(ctx, store, { workbenchRoot: frontend, webRoot: pathToFileURL(web + '/') });
    link = await listenLink({ identity, store, workbench, config: validateConfig({ enabled: true, host: '127.0.0.1', port: 0, publicUrl: 'https://cloud.test' }, store.state), webRoot: pathToFileURL(web + '/'), dispatch: () => ({ ok: true }), onError() {} });
    let ownerHits = 0;
    backend = createServer((_req, res) => { ownerHits++; res.end('owner'); });
    const ownerPort = await listen(backend), reservation = createServer(); port = await listen(reservation); await close(reservation);
    const access = (await readFile(join(root, 'plugins/link/config/nginx-cloud-access.example.conf'), 'utf8')).replaceAll('cloud.example.com', 'cloud.test').replaceAll('48722', String(service.port));
    const routes = (await readFile(join(root, 'plugins/link/config/nginx.example.conf'), 'utf8')).replaceAll('48721', String(link.port)).replaceAll('/absolute/commander-data/link/host-cert.pem', join(state, 'host-cert.pem'));
    await writeFile(join(directory, 'access.conf'), access); await writeFile(join(directory, 'link.conf'), routes);
    await mkdir(join(directory, 'body')); await mkdir(join(directory, 'logs'));
    await writeFile(join(directory, 'nginx.conf'), `pid ${directory}/nginx.pid;
error_log ${directory}/error.log;
events {}
http { ${existsSync('/www/server/nginx/lib/lua/resty/core.lua') ? 'lua_package_path "/www/server/nginx/lib/lua/?.lua;;";' : ''} access_log off; client_body_temp_path ${directory}/body;
 server { listen 127.0.0.1:${port}; server_name cloud.test;
 include ${directory}/access.conf;
 include ${directory}/link.conf;
 location / { proxy_pass http://127.0.0.1:${ownerPort}; }
 }
}`);
    nginx = spawn(binary, ['-p', directory + '/', '-c', join(directory, 'nginx.conf'), '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; nginx.stderr.on('data', value => { stderr += value; });
    for (let i = 0; i < 100; i++) {
      if (nginx.exitCode !== null) throw Error('Isolated Nginx failed: ' + stderr);
      try { if ((await call(port, '/__dsh_access/login')).status === 200) break; } catch {}
      if (i === 99) throw Error('Isolated Nginx not ready');
      await delay(20);
    }
    await service.manage({ operation: 'enable', key: 'test-only-owner-access-key' });
    assert.equal((await call(port, '/link/')).status, 200, 'anonymous visitors may only see pairing UI');
    assert.equal((await call(port, '/link/workbench/api/session/get', { method: 'POST', data: {} })).status, 401);
    assert.equal((await call(port, '/link/api/commander-link', { method: 'POST', data: {} })).status, 404);
    assert.equal((await call(port, '/link/api/workbench', { method: 'POST', data: {} })).status, 401);
    for (const path of ['/', '/api/commander-link', '/api/commander-devices', '/plugins/app.js', '/mobile']) assert.equal((await call(port, path)).status, 401, path);
    assert.equal(ownerHits, 0);
    const code = store.begin();
    const pair = await call(port, '/link/api/pair', { method: 'POST', data: { code: code.code, name: 'my phone' } });
    assert.equal(pair.status, 200);
    const pending = JSON.parse(pair.body);
    const poll = () => call(port, '/link/api/pair/status', { method: 'POST', data: pending });
    assert.equal(JSON.parse((await poll()).body).status, 'pending');
    await store.decide(pending.requestId, true);
    const approved = JSON.parse((await poll()).body), headers = { authorization: 'Bearer ' + approved.token };
    const enter = await call(port, '/link/api/workbench', { method: 'POST', headers, data: {} });
    assert.equal(enter.status, 200, 'paired token works without an owner access session');
    const cookie = enter.headers['set-cookie'][0].split(';')[0];
    assert.equal((await call(port, '/link/workbench/', { headers: { cookie } })).status, 200);
    for (const path of ['/', '/api/commander-link']) assert.equal((await call(port, path, { headers: { cookie, ...headers } })).status, 401, 'device identity never bypasses owner auth');
    for (const path of ['/link/workbench/api/commander-link', '/link/workbench/api/commander-devices']) assert.equal((await call(port, path, { method: 'POST', headers: { cookie, origin: 'https://cloud.test' }, data: { action: 'status' } })).status, 403, 'device cannot reach owner pairing/SSH management');
    await service.manage({ operation: 'rotate', key: 'test-only-owner-access-key-rotated' });
    assert.equal((await call(port, '/link/workbench/', { headers: { cookie } })).status, 200, 'owner key rotation does not invalidate paired-device identity');
    await store.revoke(approved.deviceId);
    assert.equal((await call(port, '/link/api/workbench', { method: 'POST', headers, data: {} })).status, 401);
    assert.equal((await call(port, '/link/workbench/api/session/get', { method: 'POST', headers: { cookie }, data: {} })).status, 401);
    assert.equal(ownerHits, 0);
  } finally {
    if (nginx && nginx.exitCode === null) { const exit = once(nginx, 'exit'); nginx.kill('SIGTERM'); await exit; }
    await link?.close(); await store?.flush(); await service?.close(); if (backend?.listening) await close(backend);
    await rm(directory, { recursive: true, force: true });
  }
});
