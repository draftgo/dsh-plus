import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Commander } from '../src/runtime.mjs';

test('OpenCode v1: authenticated loopback server, SSE ready before prompt, approval reply and resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-opencode-'));
  const command = fileURLToPath(new URL('./opencode-fixture.mjs', import.meta.url)); await chmod(command, 0o755);
  const runtime = await new Commander({ dataDir: directory, providers: { opencode: { command } } }).open();
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const { id } = await runtime.create({ provider: 'opencode' });
  await runtime.submit(id, 'hello'); await runtime.wait(id);
  assert.ok(runtime.events(id).events.some(e => e.type === 'text.delta' && e.data.text === 'fixture-opencode'));
  const pending = new Promise(resolve => runtime.on('event', event => { if (event.type === 'approval.requested') resolve(event.data); }));
  await runtime.submit(id, 'approval'); const approval = await pending;
  runtime.approve(id, approval.id, { allow: true }); await runtime.wait(id);
  assert.ok(runtime.events(id).events.some(e => e.type === 'text.delta' && e.data.text === 'once'));
  await runtime.disconnect(id); await runtime.connect(id);
  assert.equal(runtime.snapshot(id).nativeId, 'native-opencode');
  assert.equal((await runtime.history(id)).length, 1);
});

test('OpenCode v2 cannot be mistaken for a compatible v1 server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-opencode-v2-'));
  const command = fileURLToPath(new URL('./opencode-fixture.mjs', import.meta.url)); await chmod(command, 0o755);
  const runtime = await new Commander({ dataDir: directory, providers: { opencode: { command, env: { FIXTURE_VERSION: '2.0.0' } } } }).open();
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(runtime.create({ provider: 'opencode' }), /Unsupported OpenCode/);
});
