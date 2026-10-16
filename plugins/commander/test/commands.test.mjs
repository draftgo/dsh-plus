import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Commander } from '../src/runtime.mjs';

async function fixture(t, provider, model) {
  const directory = await mkdtemp(join(tmpdir(), 'commander-commands-'));
  const command = fileURLToPath(new URL('./commands-fixture.mjs', import.meta.url));
  await chmod(command, 0o755);
  const runtime = await new Commander({ dataDir: directory, providers: { [provider]: { command } } }).open();
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const session = await runtime.create({ provider, model });
  return { runtime, id: session.id, directory };
}

test('Codex commands discover native skills and use skill and compact protocol routes', async t => {
  const { runtime, id } = await fixture(t, 'codex');
  assert.deepEqual((await runtime.commands(id)).map(c => c.name), ['compact', 'review']);
  await assert.rejects(runtime.command(id, { name: 'compact', arguments: 'unsupported', requestId: 'invalid' }), /does not accept arguments/);
  assert.equal(runtime.snapshot(id).status, 'idle');
  assert.equal(runtime.get(id).receipts.invalid, undefined);
  await runtime.command(id, { name: '/review', arguments: 'changed files', requestId: 'skill' });
  await runtime.wait(id);
  await runtime.command(id, { name: 'compact', requestId: 'compact' });
  await runtime.wait(id);
  assert.equal(runtime.snapshot(id).status, 'idle');
  const before = runtime.get(id).cursor;
  await assert.rejects(runtime.command(id, { name: 'unknown' }), /Unsupported native command/);
  assert.equal(runtime.get(id).cursor, before);
});

test('Pi compact uses native RPC and extension commands without model turns finish cleanly', async t => {
  const { runtime, id } = await fixture(t, 'pi');
  assert.deepEqual((await runtime.commands(id)).map(c => c.name), ['compact', 'review']);
  await runtime.command(id, { name: 'compact', arguments: 'keep decisions' });
  assert.equal(runtime.snapshot(id).status, 'idle');
  await runtime.command(id, { name: 'review' });
  assert.equal(runtime.snapshot(id).status, 'idle');
  await runtime.submit(id, '/review');
  assert.equal(runtime.snapshot(id).status, 'idle');
  assert.ok(runtime.events(id).events.some(e => e.type === 'turn.completed' && e.data.agentInvoked === false));
  await runtime.command(id, { name: 'review', arguments: 'legacy' });
  assert.equal(runtime.snapshot(id).status, 'idle');
  assert.ok(runtime.events(id).events.some(e => e.type === 'text.delta' && e.data.text === 'native-command-output'));
  await runtime.command(id, { name: 'review', arguments: 'contradiction' });
  assert.equal(runtime.snapshot(id).status, 'running');
  await runtime.wait(id);
});

test('OpenCode compact validates required model before allocating a command receipt', async t => {
  const { runtime, id } = await fixture(t, 'opencode');
  await assert.rejects(runtime.command(id, { name: 'compact', requestId: 'no-model' }), /explicit provider\/model/);
  assert.equal(runtime.snapshot(id).status, 'idle');
  assert.equal(runtime.get(id).receipts['no-model'], undefined);
});

test('OpenCode native commands and summarize use authenticated HTTP and complete through SSE', async t => {
  const { runtime, id } = await fixture(t, 'opencode', 'test/model');
  assert.deepEqual((await runtime.commands(id)).map(c => c.name), ['compact', 'review', 'summarize']);
  await runtime.command(id, { name: 'review', arguments: 'changed files' });
  await runtime.wait(id);
  await runtime.command(id, { name: 'compact' });
  await runtime.wait(id);
  await runtime.command(id, { name: 'summarize' });
  await runtime.wait(id);
  assert.deepEqual(runtime.events(id).events.filter(e => e.type === 'text.delta').map(e => e.data.text), ['reviewed', 'compacted', 'compacted']);
});

test('native commands preserve active-turn exclusion, idempotency, receipt kind and uncertain retries', async t => {
  const { runtime, id, directory } = await fixture(t, 'pi');
  const driver = runtime.drivers.get(id);
  let executions = 0;
  let release;
  driver.command = async () => { executions++; await new Promise(resolve => { release = resolve; }); throw new Error('ack lost'); };
  const first = runtime.command(id, { name: 'review', requestId: 'once' });
  // Catalog discovery is asynchronous; wait until the provider has the command.
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const duplicate = runtime.command(id, { name: 'review', requestId: 'once' });
  await assert.rejects(runtime.submit(id, 'another turn'), /running/);
  await assert.rejects(runtime.command(id, { name: 'compact', requestId: 'different' }), /running/);
  release();
  await assert.rejects(first, /ack lost/);
  await assert.rejects(duplicate, /ack lost/);
  assert.equal(executions, 1);
  assert.equal((await runtime.command(id, { name: 'review', requestId: 'once' })).status, 'uncertain');
  await assert.rejects(runtime.submit(id, '/review', { requestId: 'once' }), /different prompt or command/);
  await runtime.close();
  const restored = await new Commander({ dataDir: directory }).open();
  try {
    assert.equal((await restored.command(id, { name: 'review', requestId: 'once' })).status, 'uncertain');
    assert.equal(restored.drivers.size, 0);
  } finally { await restored.close(); }
});
