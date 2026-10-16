import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
