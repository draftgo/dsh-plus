import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { mountHarnessAdapter } from '../src/harness-adapter.mjs';
import { encodeRouteModelId } from '../src/picker-catalog.mjs';

class Native extends EventEmitter {
  providers = new Map([['codex', { config: {} }]]);
  records = [];
  sent = [];
  interrupted = 0;
  list() { return this.records; }
  snapshot(id) { return this.get(id); }
  get(id) { return this.records.find(record => record.id === id); }
  async create(options) {
    const record = { ...options, id: `native-${this.records.length}`, status: 'idle', cursor: 0, events: [], receipts: {} };
    this.records.push(record); return record;
  }
  async connect(id) { this.get(id).status = 'idle'; }
  event(id, type, data, turnId) {
    const record = this.get(id);
    const event = { sessionId: id, type, data, turnId, seq: ++record.cursor };
    record.events.push(event);
    if (type === 'turn.completed') record.status = data.status === 'completed' ? 'idle' : 'failed';
    this.emit('event', event);
  }
  async submit(id, text, { requestId }) {
    const record = this.get(id);
    this.sent.push(text); record.status = 'running';
    const receipt = { requestId, turnId: `turn-${this.sent.length}`, status: 'accepted' };
    record.receipts[requestId] = { text, receipt };
    if (this.respond !== false) {
      this.event(id, 'text.delta', { text: 'native reply' }, receipt.turnId);
      this.event(id, 'turn.completed', { status: this.fail ? 'failed' : 'completed', error: this.fail ? 'broken' : undefined }, receipt.turnId);
    }
    return receipt;
  }
  async interrupt(id) { this.interrupted++; this.get(id).status = 'idle'; }
  events(id, after, limit) {
    const record = this.get(id), events = record.events.filter(event => event.seq > after).slice(0, limit);
    return { events, cursor: events.at(-1)?.seq ?? after, latest: record.cursor, truncated: false };
  }
}
function setup() {
  const native = new Native(), effects = [], owners = [];
  const ctx = {
    agents: { requireInitiator: () => ({ session: { id: 'harness', header: { cwd: '/project' } } }) },
    llm: { registerAdapter(routes, adapter) { ctx.routes = routes; ctx.adapter = adapter; return () => { ctx.removed = true; }; } },
    get: () => ({ list: () => [{ path: '/project' }] }),
    effect(fn) { effects.push(fn()); }, on() {}, logger: { warn() {} },
  };
  const adapter = mountHarnessAdapter(ctx, native, { bindOwner: (...args) => owners.push(args), discover: async () => [{ id: 'real-model', name: 'Real model', contextWindow: 131072 }] });
  return { ctx, native, adapter, owners, dispose: async () => { for (const effect of effects.reverse()) await effect?.(); } };
}
test('provider route identity reaches native create and existing conversations cannot silently switch', async () => {
  const s = setup(), model = encodeRouteModelId('router/a', 'vendor/model');
  s.native.pickerCatalog = { models: async () => [{ provider: 'commander-codex', id: model, name: 'Actual model', inputModalities: ['text'] }] };
  assert.deepEqual((await s.adapter.listModels('commander-codex')).map(row => row.id), [model]);
  await collect(s.adapter.stream({ ...request([human('one', 'hello')]), model }));
  assert.equal(s.native.records[0].model, 'vendor/model');
  assert.deepEqual(s.native.records[0].route, { providerId: 'router/a', model: 'vendor/model' });
  await collect(s.adapter.stream({ ...request([human('one', 'hello'), human('two', 'continue')]), model }));
  assert.equal(s.native.records.length, 1);
  await assert.rejects(collect(s.adapter.stream({ ...request([human('three', 'switch')]), model: encodeRouteModelId('router/b', 'vendor/model') })), /新建聊天/);
  assert.equal(s.native.records.length, 1);
  await s.dispose();
});
test('managed picker refuses unsafe new defaults while preserving legacy native sessions', async () => {
  const s = setup(); s.native.pickerCatalog = { models: async () => [] };
  await assert.rejects(collect(s.adapter.stream(request([human('one', 'hello')]))), /本机默认配置/);
  await assert.rejects(collect(s.adapter.stream({ ...request([human('one', 'hello')]), model: encodeRouteModelId('removed', 'model') })), /重新选择/);
  assert.equal(s.native.records.length, 0);
  await s.native.create({ provider: 'codex', cwd: '/project', ownerSessionId: 'harness' });
  await collect(s.adapter.stream(request([human('one', 'hello')])));
  assert.equal(s.native.records.length, 1); assert.equal(s.native.records[0].route, undefined);
  await s.dispose();
});
const human = (id, text) => ({ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text }] });
const request = messages => ({ provider: 'commander-codex', model: 'native-default', sessionId: 'harness', messages });
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }

test('native providers and discovered models enter the official catalog without creating sessions', async () => {
  const s = setup();
  assert.deepEqual(s.ctx.routes, ['commander-codex', 'commander-claude', 'commander-pi', 'commander-opencode', 'commander-gemini', 'commander-hermes', 'commander-grok', 'commander-mcode']);
  assert.deepEqual((await s.adapter.listModels('commander-codex')).map(model => model.id), ['native-default', 'real-model']);
  assert.deepEqual((await s.adapter.resolveModel('commander-codex', 'real-model')).context, { contextWindow: 131072 });
  assert.equal((await s.adapter.resolveModel('commander-codex', 'native-default')).context, undefined);
  assert.equal((await s.adapter.resolveModel('commander-codex', 'unknown-model')).context, undefined);
  assert.equal(s.native.records.length, 0);
  assert.equal(s.adapter.providerRetryPolicy().maxRetries, 0);
  await s.dispose(); assert.equal(s.ctx.removed, true);
});

test('official text stream forwards only durable human inputs and preserves native identity on follow-up and replay', async () => {
  const s = setup();
  const context = { role: 'user', id: 'ctx', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Do not forward' }] };
  const one = request([{ role: 'system', content: [{ type: 'text', text: 'Harness tool definitions' }] }, context, human('one', 'hello')]);
  const chunks = await collect(s.adapter.stream(one));
  assert.deepEqual(s.native.sent, ['hello']);
  assert.equal(chunks[0].type, 'block-start');
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(chunks.some(chunk => chunk.type === 'usage' || chunk.type === 'tool-call-delta'), false);
  await collect(s.adapter.stream(request([human('one', 'hello'), human('two', 'continue')])));
  assert.deepEqual(s.native.sent, ['hello', 'continue']);
  assert.equal(s.native.records.length, 1);
  await collect(s.adapter.stream(request([human('one', 'hello'), human('two', 'continue')])));
  assert.equal(s.native.sent.length, 2);
  assert.equal(s.native.listenerCount('event'), 0);
  await s.dispose();
});

test('auxiliary requests, wrong identities and attachments fail before native side effects', async () => {
  const s = setup();
  await assert.rejects(collect(s.adapter.stream({ ...request([human('one', 'hello')]), purpose: 'session-title' })), /auxiliary/);
  await assert.rejects(collect(s.adapter.stream({ ...request([human('one', 'hello')]), sessionId: 'other' })), /identity/);
  const attachment = human('one', 'hello'); attachment.content.push({ type: 'image', attachment: {} });
  await assert.rejects(collect(s.adapter.stream(request([attachment]))), /attachments/);
  assert.equal(s.native.records.length, 0); await s.dispose();
});

test('a single native request feeds official usage while replay and multi-request turns do not', async () => {
  const s = setup();
  const submit = s.native.submit.bind(s.native);
  s.native.respond = false;
  s.native.submit = async (...args) => {
    const receipt = await submit(...args), id = args[0];
    s.native.event(id, 'text.delta', { text: 'native reply' }, receipt.turnId);
    const sample = { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, totalTokens: 120 };
    s.native.event(id, 'usage', { id: 'request-one', convention: 'inclusive', usage: sample }, receipt.turnId);
    if (s.native.multiple) s.native.event(id, 'usage', { id: 'request-two', convention: 'inclusive', usage: sample }, receipt.turnId);
    s.native.event(id, 'turn.completed', { status: 'completed' }, receipt.turnId);
    return receipt;
  };
  const first = await collect(s.adapter.stream(request([human('one', 'hello')])));
  assert.deepEqual(first.find(chunk => chunk.type === 'usage'), { type: 'usage', usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, totalTokens: 120 } });
  const replay = await collect(s.adapter.stream(request([human('one', 'hello')])));
  assert.equal(replay.some(chunk => chunk.type === 'usage'), false);
  s.native.multiple = true;
  const multiple = await collect(s.adapter.stream(request([human('one', 'hello'), human('two', 'continue')])));
  assert.equal(multiple.some(chunk => chunk.type === 'usage'), false);
  await s.dispose();
});

test('native turn failures reject and release stream listeners', async () => {
  const s = setup(); s.native.fail = true;
  await assert.rejects(collect(s.adapter.stream(request([human('one', 'hello')]))), /failed.*broken/);
  assert.equal(s.native.listenerCount('event'), 0); await s.dispose();
});

test('a delegated child with the same owner and model cannot become the main conversation', async () => {
  const s = setup();
  const child = await s.native.create({ provider: 'codex', cwd: '/project', ownerSessionId: 'harness', parentId: 'another-native-parent' });
  await collect(s.adapter.stream(request([human('one', 'hello')])));
  assert.equal(s.native.records.length, 2);
  assert.notEqual(s.owners.at(-1)[0], child.id);
  assert.equal(child.cursor, 0);
  await s.dispose();
});

test('aborting an official stream interrupts the native turn and removes listeners', async () => {
  const s = setup(); s.native.respond = false;
  const controller = new AbortController();
  const pending = collect(s.adapter.stream({ ...request([human('one', 'hello')]), signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(s.native.interrupted, 1); assert.equal(s.native.listenerCount('event'), 0); await s.dispose();
});

test('plugin disposal cancels active streams before unregistering', async () => {
  const s = setup(); s.native.respond = false;
  const pending = collect(s.adapter.stream(request([human('one', 'hello')])));
  const rejected = assert.rejects(pending, /disposed/);
  await new Promise(resolve => setImmediate(resolve)); await s.dispose(); await rejected;
  assert.equal(s.native.listenerCount('event'), 0); assert.equal(s.native.interrupted, 1);
});

test('actual Harness LlmRuntime routes native text and rejects attachments before modality projection', async () => {
  const ctx = new Context(), native = new Native();
  ctx.provide('agents', { requireInitiator: () => ({ session: { id: 'harness', header: { cwd: '/project' } } }) });
  try {
    await ctx.plugin(LlmRuntime);
    const fiber = ctx.plugin({ name: 'adapter-test', inject: ['llm', 'agents'], apply(scope) { mountHarnessAdapter(scope, native, { discover: async () => [] }); } });
    await fiber;
    assert.equal(ctx.llm.listProviders().length, 8);
    const chunks = await collect(ctx.llm.stream(request([human('one', 'hello')])));
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
    const attachment = human('two', 'look'); attachment.content.push({ type: 'image', attachment: {} });
    const unsupported = await collect(ctx.llm.stream(request([attachment])));
    assert.equal(unsupported.at(-1).reason.failure.code, 'UNSUPPORTED_ATTACHMENT');
    assert.deepEqual(native.sent, ['hello']);
    await fiber.dispose(); assert.equal(ctx.llm.listProviders().length, 0);
  } finally { await ctx.fiber.dispose(); }
});

test('a child explicitly adopted into its own Harness conversation reuses its native context', async () => {
  const s = setup();
  const child = await s.native.create({ provider: 'codex', cwd: '/project', ownerSessionId: 'harness', parentId: 'parent', harnessAdopted: true });
  await collect(s.adapter.stream(request([human('one', 'continue child')])));
  assert.equal(s.native.records.length, 1);
  assert.equal(s.owners.at(-1)[0], child.id);
  await s.dispose();
});
