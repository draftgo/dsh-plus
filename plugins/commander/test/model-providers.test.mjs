import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelProviders } from '../src/model-providers.mjs';
function fixture() {
  const refs = new Map([['ROUTER_KEY', 'fixture-secret-value'], ['NATIVE_KEY', 'native-fixture-secret']]);
  const doc = { ns: 'llm-pi-ai', revision: 1, value: { providers: { routergo: { displayName: 'RouterGo', baseURL: 'https://gateway.example/v1', apiKeyEnv: 'ROUTER_KEY', api: 'openai-completions', models: [] } } } };
  const special = { ns: 'llm-special', revision: 2, value: { baseURL: 'https://special.example/v1', apiKeyEnv: 'NATIVE_KEY' } };
  const base = [{ provider: 'native', displayName: 'Native', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'native'], defaultBaseURL: 'https://native.example/v1', nativeAuth: { env: ['NATIVE_KEY'] } }, { provider: 'special', displayName: 'Special', settingsNs: 'llm-special', settingsPath: [] }];
  const ctx = { llm: { listConfigurableProviders: () => [...base, ...Object.keys(doc.value.providers).map(provider => ({ provider, settingsNs: doc.ns, settingsPath: ['providers', provider] }))] }, settings: { describe: () => [doc, special], mutate: async (ns, operations, revision) => { assert.equal(ns, doc.ns); assert.equal(revision, doc.revision); for (const op of operations) { let node = doc.value; for (const part of op.path.slice(0, -1)) node = node[part] ||= {}; node[op.path.at(-1)] = structuredClone(op.value); } doc.revision++; } }, credentials: { resolve: async ref => refs.has(ref) ? { value: refs.get(ref) } : undefined, set: async (ref, value) => refs.set(ref, value) }, effect: callback => callback(), connection: { fetch: { register: entry => { ctx.route = entry; return () => {}; } } } };
  return { ctx, doc, refs, service: createModelProviders(ctx) };
}
test('provider directory resolves official profile/native credentials and orders RouterGo first without secrets', async () => {
  const { service } = fixture(); const list = await service.list(); assert.equal(list[0].id, 'routergo'); assert.equal(list.length, 3); assert.ok(!JSON.stringify(list).includes('fixture-secret')); assert.deepEqual(await service.resolve('routergo'), { baseURL: 'https://gateway.example/v1', apiKey: 'fixture-secret-value' });
});
test('provider directory projects settings once for all providers and observes the next read', async () => {
  const { ctx, doc, refs, service } = fixture();
  let descriptions = 0;
  const describe = ctx.settings.describe;
  ctx.settings.describe = () => { descriptions++; return describe(); };
  const first = await service.list();
  assert.equal(first.length, 3);
  assert.equal(descriptions, 1);
  doc.value.providers.routergo.displayName = 'Updated RouterGo';
  refs.delete('NATIVE_KEY');
  const second = await service.list();
  assert.equal(descriptions, 2);
  assert.deepEqual(second.map(row => row.id), ['routergo']);
  assert.equal(second[0].name, 'Updated RouterGo');
  assert.equal(first[0].name, 'RouterGo');
});
test('model metadata outranks names and audio models never enter the official chat list', async t => {
  const { service, doc } = fixture(); const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => { assert.equal(url, 'https://gateway.example/v1/models'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, 'Bearer fixture-secret-value'); return Response.json({ data: [{ id: 'chat-good', capabilities: { text: true } }, { id: 'speech-one', task: 'text-to-speech' }, { id: 'listen-one', task: 'automatic-speech-recognition' }, { id: 'whisper-1' }, { id: 'tts-1' }, { id: 'tts-named-chat', task: 'text-generation' }, { id: 'embed', type: 'embedding' }, { id: 'image', type: 'image-generation' }, { id: 'fixture-secret-value' }] }); };
  const models = await service.models('routergo'); assert.deepEqual(models.find(row => row.id === 'speech-one').kinds, ['tts']); assert.equal(models.find(row => row.id === 'speech-one').inferred, false); assert.equal(models.find(row => row.id === 'whisper-1').inferred, true); assert.ok(!models.some(row => row.id === 'fixture-secret-value')); assert.deepEqual(doc.value.providers.routergo.models, []);
});
test('catalog failures do not expose service payloads or credential-bearing errors', async t => {
  const { service } = fixture(), original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('fixture-secret-value', { status: 401 }); await assert.rejects(service.models('routergo'), error => /401/.test(error.message) && !error.message.includes('secret'));
  globalThis.fetch = async () => { throw Error('request fixture-secret-value redirect'); }; await assert.rejects(service.models('routergo'), /Unable to reach/);
  globalThis.fetch = async () => new Response('x', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }); await assert.rejects(service.models('routergo'), /4 MiB/);
  globalThis.fetch = async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)); await assert.rejects(service.models('routergo'), /4 MiB/);
  globalThis.fetch = async () => new Response('fixture-secret-value'); await assert.rejects(service.models('routergo'), /invalid JSON/);
});
test('voice discovery preserves custom chat model parameters and infers audio when metadata is only context limits', async t => {
  const { service, doc } = fixture(), original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  doc.value.providers.routergo.models = [{ id: 'chat-custom', contextWindow: 12000, maxTokens: 2000, reasoningEfforts: false, input: ['text', 'image'] }];
  globalThis.fetch = async () => Response.json({ data: [{ id: 'chat-custom', name: 'Updated' }, { id: 'whisper-special', metadata: { context_window: 16000 } }, { id: 'tts-one', type: 'model', metadata: { max_tokens: 2048 } }] });
  const rows = await service.models('routergo'); assert.equal(rows.find(row => row.id === 'whisper-special').inferred, true); assert.deepEqual(rows.find(row => row.id === 'tts-one').kinds, ['tts']); assert.deepEqual(doc.value.providers.routergo.models, [{ id: 'chat-custom', contextWindow: 12000, maxTokens: 2000, reasoningEfforts: false, input: ['text', 'image'] }]);
});
test('catalog request cannot commit after credential value or reference changes', async t => {
  const { service, refs, doc } = fixture(), original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { refs.set('ROUTER_KEY', 'rotated-fixture-key'); return Response.json({ data: [{ id: 'new-chat' }] }); };
  await assert.rejects(service.models('routergo'), /Provider changed/); assert.deepEqual(doc.value.providers.routergo.models, []);
  globalThis.fetch = async () => { doc.value.providers.routergo.apiKeyEnv = 'OTHER_KEY'; refs.set('OTHER_KEY', 'rotated-fixture-key'); return Response.json({ data: [{ id: 'new-chat' }] }); };
  await assert.rejects(service.models('routergo'), /Provider changed/); assert.deepEqual(doc.value.providers.routergo.models, []);
});

test('managed route descriptor reuses official protocol and credential reference only on the server',async()=>{
 const {service}=fixture(); const descriptor=await service.describeRoute('routergo');
 assert.equal(descriptor.protocol,'openai-completions');assert.equal(descriptor.credentialRef,'ROUTER_KEY');
 assert.equal(descriptor.baseURL,'https://gateway.example/v1');
 assert.doesNotMatch(JSON.stringify(await service.list()),/fixture-secret|apiKey|credentialRef/);
});
