import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHarnessCommands } from '../src/harness-commands.mjs';

test('native command discovery and execution use official command results and stable request identity', async () => {
  let definition, executed;
  const native = { id: 'native', ownerSessionId: 'harness', provider: 'codex', model: 'model', status: 'idle', cursor: 4 };
  const commander = { list: () => [native], commands: async () => [{ name: 'compact', description: 'Compact context' }], snapshot: () => native,
    command: async (id, input) => { executed = { id, ...input }; return { turnId: 'turn' }; }, wait: async () => ({ status: 'idle' }),
    events: () => ({ events: [{ type: 'turn.completed', turnId: 'turn', data: { result: 'Done' } }] }) };
  const ctx = { effect: fn => fn(), commands: { register: d => { definition = d; return () => {}; } }, logger: { warn() {} } };
  mountHarnessCommands(ctx, commander);
  const invocation = { agent: { session: { id: 'harness' }, options: { provider: 'commander-codex', model: 'model' } }, signal: new AbortController().signal, commandId: 'command-1', rawInput: '' };
  ctx.get = () => ({ stateOf: () => ({ pending: { provider: 'commander-codex', model: 'model' }, lastUsed: null }) });
  assert.match((await definition.handler({ ...invocation, agent: { ...invocation.agent, options: { provider: 'deepseek' } } })).text, /compact/);
  delete ctx.get;
  assert.equal(definition.name, 'native');
  assert.match((await definition.handler(invocation)).text, /compact/);
  assert.deepEqual(await definition.handler({ ...invocation, rawInput: 'compact preserve decisions' }), { kind: 'success', text: 'Done' });
  assert.deepEqual(executed, { id: 'native', name: 'compact', arguments: 'preserve decisions', requestId: 'harness-command:command-1' });
  assert.equal((await definition.handler({ ...invocation, agent: { ...invocation.agent, options: { provider: 'deepseek' } } })).kind, 'error');
});
