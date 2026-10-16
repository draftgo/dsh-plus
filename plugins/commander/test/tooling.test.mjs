import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTooling } from '../src/tooling.mjs';
import { Commander } from '../src/runtime.mjs';

test('owner tooling route reuses provider refs, protects writes and never exposes runtime secrets', async () => {
  const effects = [], routes = []; let applied = 0, stopped = false;
  const ctx = { effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose); }, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } };
  const installer = { list: async () => [{ id: 'codex' }], job: id => ({ id }), install: tool => ({ tool }), uninstall: tool => ({ tool }), cancel: id => ({ id }), close: async () => { stopped = true; } };
  const profiles = { list: async () => ({ profiles: [{ tool: 'codex', providerId: 'shared' }], backups: [{ id: 'backup', tool: 'codex' }] }), runtime: () => ({ env: { SECRET: 'never-expose' } }), save: async input => ({ tool: input.tool }), preview: async () => ({ revision: 'r', files: [] }), apply: async () => { applied++; return { backupId: 'backup' }; }, restore: async () => ({}), setBindings: async input => ({ bindings: { [input.providerId]: input.tools } }) };
  const commander = { sessions: new Map(), drivers: new Map(), connecting: new Map(), store: { directory: '/unused' } };
  const providers = { list: async () => [{ id: 'shared' }], models: async () => [{ id: 'model' }], resolve: async () => ({baseURL:'https://example.test/v1',apiKey:'server-only'}) };
  const { fetch } = await mountTooling(ctx, commander, providers, { installer, profiles });
  const request = (input, extra = {}) => new Request('http://test/api/commander/tooling', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) });
  assert.equal(routes[0].path, '/api/commander/tooling');
  const data = await (await fetch(request({ action: 'catalog' }))).json();
  assert.equal(data.tools[0].id, 'codex'); assert.equal(data.profiles[0].providerId, 'shared'); assert.doesNotMatch(JSON.stringify(data), /never-expose|SECRET/);
  assert.equal((await fetch(request({ action: 'catalog' }, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await fetch(request({ action: 'catalog' }, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await fetch(request({ action: 'saveProfile', tool: 'codex', overrides: { config: { description: 'x'.repeat(100000) } } }))).status, 200);
  assert.equal((await fetch(request({ action: 'saveProfile', padding: 'x'.repeat(310000) }))).status, 413);
  assert.equal((await fetch(request({ action: 'apply', tool: 'codex' }))).status, 409); assert.equal(applied, 0);
  commander.sessions.set('s', { id: 's', provider: 'codex', status: 'idle' }); commander.drivers.set('s', {});
  assert.equal((await fetch(request({ action: 'apply', tool: 'codex', confirmNativeWrite: true, revision: 'r', checksums: {} }))).status, 409);
  assert.equal((await fetch(request({ action: 'restore', backupId: 'backup' }))).status, 409);
  commander.drivers.clear(); assert.equal((await fetch(request({ action: 'apply', tool: 'codex', confirmNativeWrite: true, revision: 'r', checksums: {} }))).status, 200); assert.equal(applied, 1);
  for (const dispose of effects.reverse()) await dispose(); assert.equal(stopped, true); assert.equal(commander.toolInstaller, undefined);
});

test('runtime resolves managed executable without importing global tool profile defaults', async () => {
  const commander = new Commander({ providers: { codex: { env: { KEEP: 'yes' } } } });
  commander.toolInstaller = { resolveLaunch: async () => ({ command: '/managed/node', args: ['/managed/codex.js'] }) };
  commander.toolProfiles = { runtime: async () => ({ configured: true, providerId: 'shared', model: 'model', env: { PRIVATE_KEY: 'server-only' } }) };
  const config = await commander.providerConfig('codex');
  assert.equal(config.command, '/managed/node'); assert.deepEqual(config.commandArgs, ['/managed/codex.js']); assert.equal(config.env.KEEP, 'yes'); assert.equal(config.env.PRIVATE_KEY, undefined);
  assert.equal(commander.providers.get('codex').config.command, undefined); assert.equal(commander.providers.get('codex').config.env.PRIVATE_KEY, undefined);
  const acp = await commander.providerConfig('gemini');
  assert.deepEqual(acp.args, ['/managed/codex.js']);
});

test('ACP menu discovery never launches native sessions and uses the applied model', async () => {
  const { discoverModels } = await import('../src/models.mjs');
  for (const tool of ['gemini', 'hermes', 'grok', 'mcode']) {
    assert.deepEqual(await discoverModels(tool, { command: '/not-an-executable' }), []);
    assert.deepEqual(await discoverModels(tool, { command: '/not-an-executable', managedProfile: { model: 'configured-model' } }), [{ id: 'configured-model', name: 'configured-model' }]);
  }
});
