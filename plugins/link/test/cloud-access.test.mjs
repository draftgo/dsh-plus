import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCloudAccess } from '../src/cloud-access.mjs';
import { mountLink } from '../src/index.mjs';
import { request, createServer } from 'node:http';
import { runInNewContext } from 'node:vm';

const KEY = 'test-only-long-access-key';
const callService = (port, path, { method = 'GET', data, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: { host: 'cloud.test', ...(data ? { origin: 'https://cloud.test', 'content-type': 'application/json', 'x-dsh-access': '1', 'content-length': Buffer.byteLength(JSON.stringify(data)) } : {}), ...headers } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
  }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
});
async function fixture(t, env = { DSH_LINK_CLOUD_ORIGIN: 'https://cloud.test', DSH_LINK_CLOUD_AUTH_PORT: '0' }, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'link-cloud-access-'));
  const service = await createCloudAccess(directory, { env, probe: async () => callService(service.port, '/__dsh_access/login'), ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (path, options) => callService(service.port, path, options);
  return { directory, service, call };
}
test('unconfigured service cannot enable and never starts an implicit listener', async t => {
  const f = await fixture(t, {}); assert.equal(f.service.status().configured, false);
  await assert.rejects(f.service.manage({ operation: 'enable', key: KEY }), /未配置/);
});
test('private scrypt persistence, login, CSRF, redirect, rotate, logout and disable', async t => {
  const f = await fixture(t); assert.equal(f.service.status().configured, true);
  assert.equal((await f.call('/__dsh_access/check')).status, 204);
  await f.service.manage({ operation: 'enable', key: KEY });
  const file = join(f.directory, 'cloud-access.json'), saved = await readFile(file, 'utf8');
  assert(!saved.includes(KEY)); assert.match(saved, /"hash"/); assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await f.call('/__dsh_access/check')).status, 401);
  assert.equal((await f.call('/__dsh_access/session', { method: 'POST', data: { key: KEY }, headers: { origin: 'https://evil.test', 'x-forwarded-origin': 'https://cloud.test' } })).status, 403);
  assert.equal((await f.call('/__dsh_access/check', { headers: { host: 'evil.test', 'x-forwarded-host': 'cloud.test' } })).status, 403);
  assert.equal((await f.call('/__dsh_access/session', { method: 'POST', data: { key: KEY }, headers: { 'x-dsh-access': '' } })).status, 403);
  const login = await f.call('/__dsh_access/session', { method: 'POST', data: { key: KEY, next: '//evil.test' } });
  assert.equal(login.status, 200); assert.equal((await login.json()).next, '/');
  const cookie = login.headers.get('set-cookie');
  for (const attr of ['__Host-dsh_access=', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert(cookie.includes(attr));
  assert.equal((await f.call('/__dsh_access/check', { headers: { cookie: cookie.split(';')[0] } })).status, 204);
  await f.service.manage({ operation: 'rotate', key: KEY + '-rotated' });
  assert.equal((await f.call('/__dsh_access/check', { headers: { cookie: cookie.split(';')[0] } })).status, 401);
  const owner = f.service.sessionCookie().split(';')[0];
  assert.equal((await f.call('/__dsh_access/check', { headers: { cookie: owner } })).status, 204);
  assert.equal((await f.call('/__dsh_access/session', { method: 'DELETE', data: {}, headers: { cookie: owner } })).status, 200);
  assert.equal((await f.call('/__dsh_access/check', { headers: { cookie: owner } })).status, 401);
  await f.service.manage({ operation: 'disable' }); assert.equal((await f.call('/__dsh_access/check')).status, 204);
  await f.service.manage({ operation: 'enable', key: KEY });
  assert.equal((await f.call('/__dsh_access/check', { headers: { cookie: owner } })).status, 401);
});
test('login CSP, body bounds and wrong-key rate limits ignore spoofed client IPs', async t => {
  const f = await fixture(t); await f.service.manage({ operation: 'enable', key: KEY });
  const page = await f.call('/__dsh_access/login?next=%3C/script%3E');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert((await page.text()).includes('type="password"'));
  assert.equal((await f.call('/__dsh_access/session', { method: 'POST', data: { key: 'x'.repeat(5000) } })).status, 413);
  for (let i = 0; i < 5; i++) assert.equal((await f.call('/__dsh_access/session', { method: 'POST', data: { key: 'incorrect-key-long-enough' }, headers: { 'x-forwarded-for': '192.0.2.' + i } })).status, 401);
  assert.equal((await f.call('/__dsh_access/session', { method: 'POST', data: { key: KEY }, headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 429);
});
test('restart retains enabled key and rejects old browser sessions', async t => {
  const f = await fixture(t); await f.service.manage({ operation: 'enable', key: KEY });
  const old = f.service.sessionCookie().split(';')[0]; await f.service.close();
  const next = await createCloudAccess(f.directory, { env: { DSH_LINK_CLOUD_ORIGIN: 'https://cloud.test', DSH_LINK_CLOUD_AUTH_PORT: '0' } }); t.after(() => next.close());
  const check = await callService(next.port, '/__dsh_access/check', { headers: { cookie: old } }); assert.equal(check.status, 401); assert.equal(next.status().enabled, true);
});
test('owner admin issues a current cloud Cookie without returning keys, independently of Link', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-cloud-admin-')), routes = [];
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register(value) { routes.push(value); return () => {}; } } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory, env: { DSH_LINK_CLOUD_ORIGIN: 'https://cloud.test', DSH_LINK_CLOUD_AUTH_PORT: String(port) }, cloudProbe: async () => callService(port, '/__dsh_access/login') });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const route = routes.find(value => value.path === '/api/commander-link');
  const response = await route.fetch(new Request('http://dsh.internal/api/commander-link', { method: 'POST', headers: { origin: 'https://cloud.test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cloud-access', operation: 'enable', key: KEY }) }));
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /__Host-dsh_access=/);
  const value = await response.json(); assert.equal(value.enabled, false); assert.equal(value.cloudAccess.enabled, true); assert(!JSON.stringify(value).includes(KEY));
  const result = await link.admin({ action: 'cloud-access', operation: 'rotate', key: KEY + '-two' }); assert.equal(result.cloudAccess.enabled, true);
});
test('login redirects remain local and browser pairing fragments survive authentication', async t => {
  const f = await fixture(t); await f.service.manage({ operation: 'enable', key: KEY });
  for (const next of ['//evil.test', '/%2f%2fevil.test', '/%5cevil.test', '/x%09evil', '/x%0aevil', '/__dsh_access/login', '/%zz']) {
    const response = await f.call('/__dsh_access/session', { method: 'POST', data: { key: KEY, next } }); assert.equal((await response.json()).next, '/');
  }
  for (const [query, expected] of [['?next=%2Flink%2F', '/link/'], ['?next=/link/?a=1&b=%25done', '/link/?a=1&b=%25done'], ['?next=/link/?q=%3C/script%3E', '/link/?q=%3C/script%3E']]) {
    const response = await f.call('/__dsh_access/login' + query), html = await response.text();
    const script = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];
    let submit, destination, submitted; const form = { elements: { key: { value: KEY } }, addEventListener(_type, fn) { submit = fn; } };
    const location = { origin: 'https://cloud.test', hash: '#code=pair-code', replace(value) { destination = value; } };
    runInNewContext(script, { URL, document: { querySelector(selector) { return selector === 'form' ? form : {}; } }, location, fetch: async (_url, input) => { submitted = JSON.parse(input.body); return { ok: true, async json() { return { next: submitted.next }; } }; } });
    await submit({ preventDefault() {} }); assert.equal(submitted.next, expected); assert.equal(destination, 'https://cloud.test' + expected + '#code=pair-code');
  }
});

test('readiness proves the exact configured HTTPS route and enable never trusts a cached success', async t => {
  let service, calls = 0, mode = 'good';
  const f = await fixture(t, undefined, { probe: async (url, options) => {
    calls++; assert.equal(String(url), 'https://cloud.test/__dsh_access/login'); assert.equal(options.redirect, 'manual'); assert(options.signal);
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.test' } });
    const actual = await callService(service.port, '/__dsh_access/login');
    if (mode === 'other-origin') return { status: 200, url: 'https://evil.test/__dsh_access/login', headers: actual.headers };
    return actual;
  } }); service = f.service;
  assert.equal(service.status().ready, false); await service.checkReady(); assert.equal(service.status().ready, true);
  const cachedCalls = calls; service.status(); service.status(); assert.equal(calls, cachedCalls);
  mode = 'redirect'; await assert.rejects(service.manage({ operation: 'enable', key: KEY }), /登录入口暂不可用/); assert.equal(service.status().enabled, false); assert.equal(calls, cachedCalls + 1);
  mode = 'other-origin'; assert.equal(await service.checkReady(true), false);
  mode = 'good'; await service.manage({ operation: 'enable', key: KEY }); assert.equal(service.status().enabled, true);
});

test('a wrong instance challenge rejects readiness without writing the key', async t => {
  const f = await fixture(t, undefined, { probe: async () => new Response('', { headers: { 'x-dsh-cloud-ready': 'forged-instance' } }) });
  await assert.rejects(f.service.manage({ operation: 'enable', key: KEY }), /登录入口暂不可用/);
  await assert.rejects(readFile(join(f.directory, 'cloud-access.json')), { code: 'ENOENT' });
});

test('close cancels queued enable work, is idempotent and forbids future sessions', async t => {
  let release, probingStarted; const started = new Promise(resolve => { probingStarted = resolve; });
  const f = await fixture(t, undefined, { probe: () => { probingStarted(); return new Promise(resolve => { release = resolve; }); } });
  const enabling = f.service.manage({ operation: 'enable', key: KEY }); await started;
  const first = f.service.close(), second = f.service.close(); assert.equal(first, second);
  assert.throws(() => f.service.sessionCookie(), /不可用/);
  await assert.rejects(f.service.manage({ operation: 'disable' }), /已关闭/);
  release(new Response('', { headers: { 'x-dsh-cloud-ready': 'expired-instance' } }));
  await assert.rejects(enabling, /登录入口暂不可用/); await first;
  assert.equal(f.service.status().configured, false); assert.equal(f.service.status().ready, false);
  await assert.rejects(readFile(join(f.directory, 'cloud-access.json')), { code: 'ENOENT' });
});

test('corrupt cloud persistence keeps owner management registered but rejects every cloud auth check', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-cloud-corrupt-')), routes = [];
  await writeFile(join(directory, 'cloud-access.json'), '{broken', { mode: 0o600 });
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register(value) { routes.push(value); return () => {}; } } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory, env: { DSH_LINK_CLOUD_ORIGIN: 'https://cloud.test', DSH_LINK_CLOUD_AUTH_PORT: String(port) } });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  assert(routes.some(route => route.path === '/api/commander-link')); assert.match(link.status().cloudAccess.error, /配置损坏/);
  assert.equal((await callService(port, '/__dsh_access/check')).status, 503);
  await assert.rejects(link.admin({ action: 'cloud-access', operation: 'disable' }), /配置损坏/);
  const closing = link.close(); await assert.rejects(link.admin({ action: 'configure', enabled: true }), /已关闭/); await closing;
});

test('login script JSON escapes literal closing-script markup and preserves its data', async () => {
  const source = await readFile(new URL('../src/cloud-access.mjs', import.meta.url), 'utf8');
  const payload = '/?next=</script><script>alert(1)</script>';
  const html = runInNewContext(source.slice(source.indexOf('function loginPage(')) + ';loginPage("test-nonce", payload)', { payload });
  assert.equal((html.match(/<script\b/g) || []).length, 1); assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert(html.includes(String.fromCharCode(92) + 'u003c/script>'));
  const script = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];
  let submit, submitted; const form = { elements: { key: { value: KEY } }, addEventListener(_type, fn) { submit = fn; } };
  runInNewContext(script, { URL, document: { querySelector(selector) { return selector === 'form' ? form : {}; } }, location: { origin: 'https://cloud.test', hash: '', replace() {} }, fetch: async (_url, input) => { submitted = JSON.parse(input.body); return { ok: true, async json() { return { next: submitted.next }; } }; } });
  await submit({ preventDefault() {} }); assert.equal(submitted.next, payload);
});

test('a busy auth port fails safely and close never disturbs its existing listener', async t => {
  const blocker = createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'link-cloud-busy-'));
  t.after(async () => { await new Promise(resolve => blocker.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const service = await createCloudAccess(directory, { env: { DSH_LINK_CLOUD_ORIGIN: 'https://cloud.test', DSH_LINK_CLOUD_AUTH_PORT: String(blocker.address().port) } });
  assert.equal(service.status().configured, false); assert.match(service.status().error, /端口不可用/); assert.equal(service.port, undefined);
  await assert.rejects(service.manage({ operation: 'enable', key: KEY }), /端口不可用/);
  await service.close(); await service.close(); assert.equal(blocker.listening, true);
});
