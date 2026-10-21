import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mountLink } from '../src/index.mjs';

test('device launch supports local and Desktop owners but reports the cloud carrier limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-device-entry-'));
  const routes = [];
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: value => { routes.push(value); return () => {}; } } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const route = routes.find(value => value.path === '/api/commander-devices');
  const launch = (origin, parentOrigin = origin) => route.fetch(new Request(origin + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch', parentOrigin }) }));
  const unsupported = await launch('https://cloud.example');
  assert.equal(unsupported.status, 409);
  assert.equal(unsupported.headers.get('cache-control'), 'no-store');
  const denied = await unsupported.json();
  assert.equal(denied.code, 'CLOUD_DEVICE_GATEWAY_REQUIRED');
  assert.equal(denied.url, undefined);
  assert.match(denied.error, /本机小角/);
  assert.equal((await launch('https://cloud.example', 'http://127.0.0.1:8080')).status, 409, 'browser-supplied parent does not disguise the cloud origin');
  assert.equal((await launch('https://cloud.example', 'dsh-app://app')).status, 409, 'a Desktop label cannot disguise the cloud carrier');
  for (const [origin, parent] of [['http://127.0.0.1:8080', undefined], ['http://localhost:8080', undefined], ['http://[::1]:8080', undefined], ['http://127.0.0.1:8080', 'dsh-app://app'], ['http://127.0.0.1:8080', 'dsh-app://localhost']]) {
    const response = await launch(origin, parent);
    assert.equal(response.status, 200);
    const target = new URL((await response.json()).url);
    assert.equal(target.hostname, '127.0.0.1');
    assert.equal(target.pathname, '/enter');
    const entry = await fetch(target, { redirect: 'manual' });
    assert.equal(entry.status, 303);
    assert.equal((await fetch(target, { redirect: 'manual' })).status, 401);
  }
  for (const [headers, parentOrigin, expected] of [
    [{ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }, 'http://127.0.0.1:8080', 200],
    [{ host: '127.0.0.1:8080' }, 'dsh-app://app', 200],
    [{ host: 'cloud.example', origin: 'https://cloud.example' }, 'http://localhost:8080', 409],
    [{ host: '127.0.0.1:8080', origin: 'https://cloud.example' }, 'dsh-app://app', 409],
  ]) {
    const response = await route.fetch(new Request('http://dsh.internal' + route.path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch', parentOrigin }) }));
    assert.equal(response.status, expected, 'official bridge synthetic URL uses admitted browser Origin or carrier Host');
    if (response.ok) {
      const entry = await fetch((await response.json()).url, { redirect: 'manual' });
      const base = new URL(entry.headers.get('location'), 'http://127.0.0.1');
      const centerUrl = new URL(entry.url);
      const config = await (await fetch(centerUrl.origin + base.pathname + 'device-config.js')).text();
      assert(config.includes(JSON.stringify(parentOrigin)), 'the center trusts the actual parent, never dsh.internal');
      const api = action => fetch(centerUrl.origin + base.pathname + 'api/devices', { method: 'POST', headers: { origin: centerUrl.origin, 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      assert.equal((await (await api('list')).json()).capabilities.hostAdmin, true);
      assert.equal((await (await api('hostStatus')).json()).enabled, false);
    }
  }
  const summary = await route.fetch(new Request('http://127.0.0.1:8080' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'devices' }) }));
  assert.equal(summary.status, 200);
  assert.deepEqual((await summary.json()).devices, [{ id: 'local', name: '本机', kind: 'local', status: 'online' }]);
  const cloudSummary = await route.fetch(new Request('https://cloud.example' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'devices' }) }));
  assert.equal(cloudSummary.status, 409);
});

test('plugin admin persists settings, advertises real TLS and separates public pairing trust', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-admin-'));
  let route;
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register(value) { route = value; return () => {}; } } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(route.path, '/api/commander-link');
  assert.equal(link.status().enabled, false);
  await assert.rejects(link.admin({ action: 'pairing' }), /启用/);
  const enabled = await link.admin({ action: 'configure', enabled: true, host: '127.0.0.1', port: 0, publicUrl: 'https://desk.example.com' });
  assert(enabled.port > 0); assert(enabled.enabled);
  const lan = await link.admin({ action: 'pairing', mode: 'lan' });
  assert(new URL(lan.uri).searchParams.get('pin'));
  assert.equal(new URL(lan.uri).searchParams.get('url'), `https://127.0.0.1:${enabled.port}`);
  const publicPair = await link.admin({ action: 'pairing', mode: 'public' });
  assert.equal(new URL(publicPair.uri).searchParams.get('pin'), '');
  assert(publicPair.webUrl.startsWith('https://desk.example.com/link/#code='));
  await assert.rejects(link.admin({ action: 'configure', port: -1 }), /端口/);
  assert.equal(link.status().enabled, true);
  await link.admin({ action: 'configure', enabled: false });
  assert.equal(link.status().enabled, false);
});

test('invalid relay configuration never disables direct Link or exposes the host secret', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-relay-admin-'));
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  const token = 'private-relay-secret-'.repeat(3);
  const link = await mountLink(ctx, { directory, env: { DSH_LINK_RELAY_URL: 'http://invalid.example', DSH_LINK_RELAY_TOKEN: token } });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const state = await link.admin({ action: 'configure', enabled: true, host: '127.0.0.1', port: 0 });
  assert.equal(state.enabled, true);
  assert.equal(state.relay.configured, true);
  assert.equal(state.relay.connected, false);
  assert(!JSON.stringify(state).includes(token));
  await assert.rejects(link.admin({ action: 'pairing', mode: 'relay' }), /尚未连接/);
  assert((await link.admin({ action: 'pairing', mode: 'lan' })).uri.startsWith('dshlink://pair?'));
  await link.admin({ action: 'configure', enabled: false });
  assert.equal(link.status().relay.connected, false);
});

test('quick enable preserves settings and pairing uses suitable addresses without loopback fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-discovery-'));
  const entry = address => ({ address, internal: false });
  let interfaces = {
    eth0: [entry('fe80::1'), entry('192.168.1.10')],
    'br-abcdef123456': [entry('172.19.0.1')],
    wlan0: [entry('10.0.0.8')],
  };
  t.mock.method(os, 'networkInterfaces', () => interfaces);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  const link = await mountLink(ctx, { directory });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  await link.admin({ action: 'configure', host: '0.0.0.0', port: 0, publicUrl: 'https://desk.example.com' });
  const status = await link.admin({ action: 'configure', enabled: true });
  assert.equal(status.host, '0.0.0.0');
  assert.equal(status.publicUrl, 'https://desk.example.com');
  assert.deepEqual(status.addresses, [`https://192.168.1.10:${status.port}`, `https://10.0.0.8:${status.port}`]);
  assert.equal((await link.admin({ action: 'pairing' })).url, status.addresses[0]);
  assert.equal((await link.admin({ action: 'pairing', address: status.addresses[1] })).url, status.addresses[1]);
  await assert.rejects(link.admin({ action: 'pairing', address: `https://172.19.0.1:${status.port}` }), /局域网地址无效/);
  interfaces = {};
  assert.deepEqual(link.status().addresses, []);
  await assert.rejects(link.admin({ action: 'pairing' }), /未找到可用的连接地址/);
  assert.equal((await link.admin({ action: 'pairing', mode: 'public' })).url, 'https://desk.example.com');
});

test('owner relay configuration persists separately without returning credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'link-relay-save-'));
  const ctx = { get: () => undefined, workspaceRegistry: { list: () => [] }, connection: { fetch: { register: () => () => {} } }, effect: fn => fn() };
  let link = await mountLink(ctx, { directory, env: {} });
  t.after(async () => { await link.close(); await rm(directory, { recursive: true, force: true }); });
  const token = 'owner-relay-credential-'.repeat(3);
  await assert.rejects(link.admin({ action: 'relay-configure', url: 'http://relay.example', token }), /HTTPS/);
  const value = await link.admin({ action: 'relay-configure', url: 'https://relay.example:48730', token, enabled: false });
  assert.equal(value.enabled, false);
  assert.equal(value.relay.configured, true);
  assert.equal(JSON.stringify(value).includes(token), false);
  await link.close(); link = await mountLink(ctx, { directory, env: { DSH_LINK_RELAY_URL: 'https://ignored.example' } });
  assert.equal(link.status().relay.url, 'https://relay.example:48730');
  assert.equal(link.status().relay.enabled, false);
});
