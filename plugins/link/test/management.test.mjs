import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mountLink } from '../src/index.mjs';

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
