import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Commander } from '../src/runtime.mjs';
import { CodexProvider } from '../src/providers/codex.mjs';

test('Codex duplex protocol: approvals, multiple turns, steer, interrupt and resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-codex-'));
  const command = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url)); await chmod(command, 0o755);
  const commander = await new Commander({ dataDir: directory, providers: { codex: { command } } }).open();
  t.after(async () => { await commander.close(); await rm(directory, { recursive: true, force: true }); });
  const { id } = await commander.create({ provider: 'codex' });
  const approvalReceived = new Promise(resolve => commander.on('event', event => { if (event.type === 'approval.requested') resolve(event.data); }));
  await commander.submit(id, 'approval');
  const approval = await approvalReceived;
  commander.approve(id, approval.id, { allow: false });
  await commander.wait(id);
  assert.equal(commander.snapshot(id).status, 'idle');
  assert.ok(commander.events(id).events.some(e => e.type === 'text.delta' && e.data.text === 'decline'));
  await commander.submit(id, 'second'); await commander.wait(id);
  await commander.submit(id, 'usage'); await commander.wait(id);
  const usage = commander.events(id).events.filter(event => event.type === 'usage');
  assert.equal(usage.length, 2); assert.deepEqual(usage.map(event => event.data.usage.totalTokens), [110, 220]);
  assert.deepEqual(usage.map(event => event.data.usage.contextTokens), [100, 200]);
  assert.notEqual(usage[0].data.id, usage[1].data.id);
  await commander.submit(id, 'hang'); await commander.steer(id, 'steer'); await commander.interrupt(id); await commander.wait(id);
  await commander.disconnect(id); await commander.connect(id);
  assert.equal(commander.snapshot(id).nativeId, 'thread-fixture');
  assert.equal((await commander.history(id)).thread.id, 'thread-fixture');
  assert.equal((await commander.discover(id)).data.length, 1);
});

test('Codex model changes apply to later turns on the same native thread', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-codex-model-'));
  const command = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url)); await chmod(command, 0o755);
  const commander = await new Commander({ dataDir: directory, providers: { codex: { command } } }).open();
  t.after(async () => { await commander.close(); await rm(directory, { recursive: true, force: true }); });
  const { id } = await commander.create({ provider: 'codex', model: 'model-one' });
  await commander.submit(id, 'first'); await commander.wait(id);
  await commander.drivers.get(id).setModel('model-two');
  await commander.submit(id, 'second'); await commander.wait(id);
  assert.equal(commander.snapshot(id).nativeId, 'thread-fixture');
  assert.deepEqual(commander.events(id).events.filter(event => event.type === 'turn.started').map(event => event.data.model), ['model-one', 'model-two']);
});

test('subscription connections check native account before creating any thread', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-codex-subscription-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url));
  const host = { event() {}, failure() {}, approval: async () => ({ allow: false }) };
  const provider = new CodexProvider({ command, managedProfile: { subscription: true }, env: { COMMANDER_TEST_ACCOUNT_TYPE: 'apiKey' } });
  await assert.rejects(provider.connect({ cwd: directory }, host), /ChatGPT 登录/);
  provider.config.env.COMMANDER_TEST_ACCOUNT_TYPE = 'chatgpt';
  const driver = await provider.connect({ cwd: directory }, host);
  assert.equal(driver.nativeId, 'thread-fixture');
  await driver.close();
});
