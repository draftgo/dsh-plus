import test from 'node:test';
import assert from 'node:assert/strict';
import { createPickerCatalog, encodeRouteModelId, decodeRouteModelId } from '../src/picker-catalog.mjs';
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function catalogFixture(overrides = {}) {
  const calls = { installations: 0, profiles: 0, providers: 0, models: 0, resolve: 0 };
  const state = { bindings: { shared: ['codex', 'claude'] } };
  const rows = [{ id: 'model-a', name: 'Model A' }];
  const service = createPickerCatalog({
    installer: { list: async () => { calls.installations++; return ['codex', 'claude'].map(id => ({ id, installed: true, chatSupported: true })); } },
    profiles: { list: async () => { calls.profiles++; return structuredClone(state); } },
    providers: { list: async () => { calls.providers++; return [{ id: 'shared', name: 'Shared' }]; } },
    routeService: { supports: () => true },
    llm: {
      listModels: async () => { calls.models++; return structuredClone(rows); },
      resolveModelInfo: async () => { calls.resolve++; return { context: { contextWindow: 128000 }, reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }; },
    },
    ...overrides,
  });
  return { service, calls, state, rows };
}
test('opaque routes preserve provider/model separators without collisions', () => {
  const one = encodeRouteModelId('vendor/a', 'b/c');
  assert.notEqual(one, encodeRouteModelId('vendor', 'a/b/c'));
  assert.deepEqual(decodeRouteModelId(one), { providerId: 'vendor/a', model: 'b/c' });
  assert.equal(decodeRouteModelId('vendor/model'), null);
  assert.throws(() => decodeRouteModelId(one + '='), /Invalid/);
  assert.throws(() => decodeRouteModelId('dsh-route-v1:invalid'), /Invalid/);
});
test('catalog gates installed tools by explicit binding and safe route support without exposing credentials', async () => {
  let probes = 0, resolutions = 0;
  const service = createPickerCatalog({
    installer: { list: async () => { probes++; return [{ id: 'codex', name: 'Codex', installed: true, chatSupported: true }, { id: 'pi', installed: false, chatSupported: true }, { id: 'hermes', installed: true, chatSupported: true }]; } },
    profiles: { list: async () => ({ bindings: { 'router/go': ['harness', 'codex', 'pi', 'hermes'] } }) },
    routeService: { supports: tool => ({ supported: ['codex', 'pi'].includes(tool), reason: 'Unsupported safely' }) },
    providers: { list: async () => [{ id: 'router/go', name: 'RouterGo', apiKey: 'do-not-expose' }], resolve() { resolutions++; throw Error('must not resolve'); } },
    llm: { listModels: async () => [{ id: 'vendor/model', name: 'Model' }], resolveModelInfo: async () => ({ context: { contextWindow: 128000 }, reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }) },
  });
  const result = await service.list(), models = await service.models('codex');
  assert.deepEqual(result.providers[0].tools, ['deepseek', 'codex']);
  assert.equal(result.tools.find(tool => tool.id === 'hermes').routeSupported, false);
  assert.equal(models.length, 1); assert.equal(models[0].name, 'Model');
  assert.deepEqual(decodeRouteModelId(models[0].id), { providerId: 'router/go', model: 'vendor/model' });
  assert.equal(models[0].reasoning.defaultEffort, 'high');
  assert.equal(models[0].context.contextWindow, 128000);
  assert.equal(probes, 1); assert.equal(resolutions, 0);
  assert.doesNotMatch(JSON.stringify([result, models]), /apiKey|do-not-expose/);
});
test('supplier model failures never introduce a native-default fallback', async () => {
  const service = createPickerCatalog({ installer: { list: async () => [{ id: 'codex', installed: true, chatSupported: true }] }, routeService: { supports: () => true }, profiles: { list: async () => ({ bindings: { shared: ['codex'] } }) }, providers: { list: async () => [{ id: 'shared' }], models: async () => { throw Error('offline'); } } });
  assert.deepEqual(await service.models('codex'), []);
});
test('legacy implicit eligibility matches editor defaults while explicit empty bindings opt out', async () => {
  const state = { bindings: { disabled: [] } };
  const service = createPickerCatalog({ installer: { list: async () => [{ id: 'codex', installed: true, chatSupported: true }, { id: 'pi', installed: false, chatSupported: true }, { id: 'hermes', installed: true, chatSupported: true }] }, routeService: { supports: tool => ({ supported: tool === 'codex' }) }, profiles: { list: async () => state }, providers: { list: async () => [{ id: 'legacy' }, { id: 'disabled' }], models: async () => [{ id: 'model' }] } });
  const result = await service.list();
  assert.deepEqual(result.providers.find(row => row.id === 'legacy').tools, ['deepseek', 'codex']);
  assert.deepEqual(result.providers.find(row => row.id === 'disabled').tools, []);
  assert.equal(result.routes.filter(row => row.tool === 'codex').length, 1);
  assert.equal(result.routes.some(row => row.providerId === 'disabled' || row.tool === 'hermes' || row.tool === 'pi'), false);
  assert.deepEqual(state, { bindings: { disabled: [] } });
});
test('concurrent tool directories share one complete catalog build', async () => {
  const { service, calls } = catalogFixture();
  const [codex, claude, absent, catalog] = await Promise.all([
    service.models('codex'), service.models('claude'), service.models('pi'), service.list(),
  ]);
  assert.equal(codex.length, 1);
  assert.equal(claude.length, 1);
  assert.equal(codex[0].provider, 'commander-codex');
  assert.equal(claude[0].provider, 'commander-claude');
  assert.deepEqual(absent, []);
  assert.equal(catalog.routes.length, 2);
  assert.deepEqual(calls, { installations: 1, profiles: 1, providers: 1, models: 1, resolve: 1 });
});
test('shared catalog callers receive isolated nested result objects', async () => {
  const { service } = catalogFixture();
  const [first, second, models, otherModels] = await Promise.all([
    service.list(), service.list(), service.models('codex'), service.models('codex'),
  ]);
  first.tools[0].name = 'Changed';
  first.providers[0].tools.length = 0;
  first.routes[0].context.contextWindow = 1;
  first.routes[0].reasoning.efforts[0].name = 'Changed';
  models[0].context.contextWindow = 2;
  models[0].reasoning.efforts[0].name = 'Changed';
  assert.equal(second.tools[0].name, 'DeepSeek');
  assert.deepEqual(second.providers[0].tools, ['codex', 'claude']);
  assert.equal(second.routes[0].context.contextWindow, 128000);
  assert.equal(second.routes[0].reasoning.efforts[0].name, 'High');
  assert.equal(otherModels[0].context.contextWindow, 128000);
  assert.equal(otherModels[0].reasoning.efforts[0].name, 'High');
});
test('completed reads do not cache stale bindings or model directories', async () => {
  const { service, calls, state, rows } = catalogFixture();
  const first = await service.list();
  state.bindings.shared = ['claude'];
  rows.splice(0, 1, { id: 'model-b', name: 'Model B' });
  const [codex, claude] = await Promise.all([service.models('codex'), service.models('claude')]);
  assert.deepEqual(codex, []);
  assert.deepEqual(claude.map(row => row.nativeModelId), ['model-b']);
  assert.equal(first.routes.some(row => row.tool === 'codex' && row.nativeModelId === 'model-a'), true);
  assert.deepEqual(calls, { installations: 1, profiles: 2, providers: 2, models: 2, resolve: 2 });
});
test('a failed shared catalog build is released so the next request can recover', async () => {
  let reads = 0;
  const { service } = catalogFixture({
    profiles: { list: async () => { if (++reads === 1) throw Error('profile temporarily unavailable'); return { bindings: { shared: ['codex'] } }; } },
  });
  const failed = await Promise.allSettled([service.list(), service.models('codex')]);
  assert.equal(reads, 1);
  for (const result of failed) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /profile temporarily unavailable/);
  }
  assert.equal((await service.models('codex')).length, 1);
  assert.equal(reads, 2);
});
test('invalidating an in-flight build prevents its completion from clearing the replacement', async () => {
  const oldGate = deferred(), newGate = deferred();
  let reads = 0;
  const { service } = catalogFixture({ providers: { list: () => (++reads === 1 ? oldGate.promise : newGate.promise) } });
  const oldRead = service.list();
  service.invalidate();
  const replacement = service.list();
  assert.equal(reads, 2);
  oldGate.resolve([{ id: 'old', name: 'Old' }]);
  assert.equal((await oldRead).providers[0].id, 'old');
  const joined = service.list();
  assert.equal(reads, 2);
  newGate.resolve([{ id: 'new', name: 'New' }]);
  const [current, concurrent] = await Promise.all([replacement, joined]);
  assert.equal(current.providers[0].id, 'new');
  assert.deepEqual(current, concurrent);
  assert.notEqual(current, concurrent);
});
test('model metadata resolves concurrently without changing model associations', async () => {
  const gates = new Map([['first', deferred()], ['second', deferred()]]), started = deferred();
  const requested = [];
  const { service } = catalogFixture({ llm: {
    listModels: async () => [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }],
    resolveModelInfo: (_provider, id) => { requested.push(id); if (requested.length === 2) started.resolve(); return gates.get(id).promise; },
  } });
  const result = service.models('codex');
  await started.promise;
  assert.deepEqual(requested, ['first', 'second']);
  gates.get('second').resolve({ context: { contextWindow: 200 } });
  gates.get('first').resolve({ context: { contextWindow: 100 } });
  assert.deepEqual((await result).map(row => [row.nativeModelId, row.context.contextWindow]), [['first', 100], ['second', 200]]);
});
