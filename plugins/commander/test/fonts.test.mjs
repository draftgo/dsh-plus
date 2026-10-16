import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountFonts } from '../src/fonts.mjs';

test('font routes expose only hashed WOFF2 subsets with private immutable caching', async () => {
  const routes = [], disposers = [];
  await mountFonts({ effect(fn) { disposers.push(fn()); }, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } });
  const manifest = JSON.parse(await readFile(new URL('../assets/fonts/manifest.json', import.meta.url), 'utf8'));
  assert.equal(routes.length, manifest.length);
  assert(routes.every(r => r.path.startsWith('/api/commander-fonts/fangyuan-') && r.path.endsWith('.woff2')));
  const response = await routes[0].fetch();
  assert.equal(response.headers.get('content-type'), 'font/woff2');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
  assert.equal(bytes.length, manifest[0].bytes);
  for (const dispose of disposers) dispose();
});
