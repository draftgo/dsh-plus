import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acpProviderClasses, ACP_TOOL_DEFAULTS } from '../src/providers/acp.mjs';
const fixture = fileURLToPath(new URL('./acp-fixture.mjs', import.meta.url));
async function connect(t, { id = 'gemini', env = {}, session = {}, approval, delegation, config = {} } = {}) {
  const events = [], errors = [], approvals = []; let nativeId;
  const provider = new acpProviderClasses[id]({ command: process.execPath, args: [fixture], env, timeout: 500, commandsTimeout: 10, ...config });
  const driver = await provider.connect({ cwd: process.cwd(), ...session }, { delegation, event: (type, data) => events.push({ type, data }), nativeId: id => { nativeId = id; }, failure: error => errors.push(error), approval: async (...args) => { approvals.push(args); return approval ? approval(...args) : { allow: false }; } });
  t.after(() => driver.close()); return { provider, driver, events, errors, approvals, get nativeId() { return nativeId; } };
}
async function completed(state, count = 1) { for (let i = 0; i < 100; i++) { if (state.events.filter(event => event.type === 'turn.completed').length >= count) return; await delay(5); } assert.fail('ACP turn never finished'); }
test('ACP defaults use confirmed Paseo launch commands', () => {
  assert.deepEqual(Object.keys(acpProviderClasses), ['gemini', 'hermes', 'grok', 'mcode']);
  assert.deepEqual(ACP_TOOL_DEFAULTS.grok.args, ['agent', 'stdio']); assert.deepEqual(ACP_TOOL_DEFAULTS.gemini.args, ['--acp']);
});
test('all ACP tools initialize, select model, stream messages/tools and discover commands', async t => {
  for (const id of Object.keys(acpProviderClasses)) {
    const state = await connect(t, { id, session: { model: 'model-b' } }); assert.equal(state.nativeId, 'acp-native-fixture');
    assert.equal((await state.driver.models())[1].id, 'model-b'); assert.equal((await state.driver.commands())[0].name, 'compact');
    await state.driver.submit('hello'); await completed(state);
    assert.ok(state.events.some(event => event.type === 'text.delta' && event.data.text === 'hello:model-b'));
    assert.ok(state.events.some(event => event.type === 'item' && event.data.type === 'reasoning'));
    assert.ok(state.events.some(event => event.type === 'item' && event.data.sessionUpdate === 'tool_call_update'));
    await state.driver.command({ name: 'compact', arguments: '' }); await completed(state, 2);
    await assert.rejects(state.driver.command({ name: 'arbitrary', arguments: '' }), /Unsupported/);
    assert.equal((await state.driver.discover()).sessions[0].sessionId, state.nativeId); assert.deepEqual(state.errors, []); await state.driver.close();
  }
});
test('resume preserves native id, rejects unsupported resume or missing native history', async t => {
  const state = await connect(t, { session: { nativeId: 'acp-native-fixture' } }); assert.equal(state.driver.nativeId, 'acp-native-fixture');
  await assert.rejects(connect(t, { env: { ACP_NO_RESUME: '1' }, session: { nativeId: 'old' } }), /does not support session resume/);
  await assert.rejects(connect(t, { session: { nativeId: 'missing' } }), /Session not found/);
  await assert.rejects(connect(t, { env: { ACP_MISMATCH: '1' }, session: { nativeId: 'old' } }), /different session id/);
});
test('permission decisions only select allow_once; defaults deny, never allow_always', async t => {
  for (const allow of [true, false]) {
    const state = await connect(t, { approval: async () => ({ allow }) });
    await state.driver.submit('permission'); await completed(state);
    const output = state.events.find(event => event.type === 'text.delta').data.text; assert.match(output, allow ? /once/ : /cancelled/); assert.ok(!output.includes('always'));
    assert.equal(state.approvals.length, 1); await state.driver.close();
  }
  const state = await connect(t); await state.driver.submit('always'); await completed(state); assert.equal(state.approvals.length, 0);
});
test('client filesystem requests are explicitly rejected without host permissions', async t => {
  const state = await connect(t); await state.driver.submit('fs'); await completed(state);
  assert.match(state.events.find(event => event.type === 'text.delta').data.text, /unsupported/); assert.equal(state.approvals.length, 0);
});
test('cancel ends busy turn and permits follow up; model config options supported', async t => {
  const state = await connect(t, { env: { ACP_CONFIG_MODELS: '1' }, session: { model: 'model-b' } });
  await state.driver.submit('hang'); await assert.rejects(state.driver.submit('other'), /already running/); await state.driver.interrupt(); await completed(state);
  assert.equal(state.events.at(-1).data.status, 'cancelled');
  await state.driver.submit('next'); await completed(state, 2); assert.match(state.events.find(event => event.type === 'text.delta').data.text, /model-b/);
});
test('startup and prompt timeouts clean up transport without unresolved execution', async t => {
  await assert.rejects(connect(t, { env: { ACP_NO_INITIALIZE: '1' }, config: { timeout: 40 } }), /timed out/);
  const state = await connect(t, { config: { promptTimeout: 40 } }); await state.driver.submit('hang'); await completed(state);
  assert.equal(state.events.at(-1).data.status, 'failed'); assert.match(state.errors[0].message, /timed out/);
});
test('unadvertised model fails before a prompt and approval timeout defaults to deny', async t => {
  await assert.rejects(connect(t, { session: { model: 'invented-model' } }), /not advertised/);
  const state = await connect(t, { approval: () => new Promise(() => {}), config: { approvalTimeout: 20 } });
  await state.driver.submit('permission'); await completed(state); assert.match(state.events.find(event => event.type === 'text.delta').data.text, /cancelled/);
});
test('ignored cancellation closes agent and reports uncertain execution rather than hanging', async t => {
  const state = await connect(t, { env: { ACP_IGNORE_CANCEL: '1' }, config: { cancelTimeout: 20 } });
  await state.driver.submit('hang'); await state.driver.interrupt(); await completed(state);
  assert.equal(state.events.at(-1).data.status, 'failed'); assert.match(state.errors[0].message, /not acknowledged/);
  await assert.rejects(state.driver.submit('new'), /disconnected/);
});
const delegation = { command: process.execPath, script: '/fixture/commander-mcp.mjs', url: 'http://127.0.0.1:9000/delegate', token: 'fixture-token-only' };
const delegationMcp = [{ name: 'commander', command: delegation.command, args: [delegation.script], env: [{ name: 'COMMANDER_DELEGATE_URL', value: delegation.url }, { name: 'COMMANDER_DELEGATE_TOKEN', value: delegation.token }] }];
test('all ACP tools receive Commander stdio MCP on both new and resumed sessions', async t => {
  for (const id of Object.keys(acpProviderClasses)) {
    for (const session of [{}, { nativeId: 'acp-native-fixture' }]) {
      const state = await connect(t, { id, delegation, session, env: { ACP_EXPECT_DELEGATION: JSON.stringify(delegationMcp) } });
      assert.equal(state.nativeId, 'acp-native-fixture');
      await state.driver.submit('delegation'); await completed(state); assert.deepEqual(state.errors, []); await state.driver.close();
    }
  }
});
test('rejected MCP fails explicitly without silently retrying without delegation', async t => {
  for (const session of [{}, { nativeId: 'acp-native-fixture' }]) {
    await assert.rejects(connect(t, { delegation, session, env: { ACP_REJECT_MCP: '1' } }), /DSH-Plus delegation MCP failed: This agent does not support MCP servers/);
  }
  await assert.rejects(connect(t, { delegation: { ...delegation, token: '' } }), /delegation requires/);
});
test('native id is persisted before invalid models or model switch failures', async () => {
  for (const env of [{}, { ACP_MODEL_FAILURE: '1' }, { ACP_MODEL_FAILURE: '1', ACP_CONFIG_MODELS: '1' }]) {
    let nativeId, persisted = false;
    const provider = new acpProviderClasses.gemini({ command: process.execPath, args: [fixture], env, timeout: 500 });
    await assert.rejects(provider.connect({ cwd: process.cwd(), model: env.ACP_MODEL_FAILURE ? 'model-b' : 'invalid-model' }, {
      event() {}, failure() {}, async nativeId(value) { await delay(10); nativeId = value; persisted = true; },
    }), /not advertised|Model (config )?switch failed/);
    assert.equal(nativeId, 'acp-native-fixture'); assert.equal(persisted, true);
  }
});
