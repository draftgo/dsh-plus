import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Commander } from '../src/runtime.mjs';

class ControlledProvider {
  static capabilities = { stream: true, resume: true, approvals: true };
  submitted = [];
  hosts = [];
  async connect(session, host) {
    this.hosts.push(host);
    return {
      nativeId: session.nativeId ?? `native-${session.id}`,
      submit: async text => { this.submitted.push(text); },
      interrupt: async () => { host.event('turn.completed', { status: 'interrupted' }); },
      close: async () => {},
    };
  }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'commander-runtime-'));
  const commander = await new Commander({ dataDir: directory, ...options }).open();
  const provider = new ControlledProvider(); commander.providers.set('test', provider);
  t.after(async () => { await commander.close(); await rm(directory, { recursive: true, force: true }); });
  return { commander, provider, directory };
}

test('reserves the active turn before async persistence; duplicate request IDs never execute twice', async t => {
  const { commander, provider } = await fixture(t);
  const session = await commander.create({ provider: 'test' });
  const first = commander.submit(session.id, 'one', { requestId: 'same' });
  const duplicate = commander.submit(session.id, 'one', { requestId: 'same' });
  await assert.rejects(commander.submit(session.id, 'two'), /running/);
  assert.deepEqual(await first, await duplicate);
  assert.equal(provider.submitted.length, 1);
  await assert.rejects(commander.submit(session.id, 'different', { requestId: 'same' }), /different prompt/);
  provider.hosts[0].event('turn.completed', { status: 'completed' });
  await commander.submit(session.id, 'two');
  assert.deepEqual(provider.submitted, ['one', 'two']);
});

test('human approval is scoped, single use and expires to denial', async t => {
  const { commander, provider } = await fixture(t, { approvalTimeout: 30 });
  const session = await commander.create({ provider: 'test' });
  await commander.submit(session.id, 'run');
  const answer = provider.hosts[0].approval({ kind: 'permission', method: 'bash', details: {} });
  const approval = commander.snapshot(session.id).pendingApprovals[0];
  assert.equal(commander.snapshot(session.id).status, 'waiting');
  assert.throws(() => commander.approve('another-session', approval.id, { allow: true }), /belongs/);
  assert.throws(() => commander.approve(session.id, approval.id, { allow: 'false' }), /boolean/);
  commander.approve(session.id, approval.id, { allow: true });
  assert.deepEqual(await answer, { allow: true });
  assert.throws(() => commander.approve(session.id, approval.id, { allow: true }), /expired/);
  assert.deepEqual(await provider.hosts[0].approval({ kind: 'permission', method: 'edit', details: {} }), { allow: false });
  assert.equal(commander.snapshot(session.id).status, 'running');
});

test('interrupt denies pending permissions, and cancelling a wait does not cancel the native task', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ provider: 'test' });
  await commander.submit(id, 'run');
  const abort = new AbortController();
  const wait = commander.wait(id, { signal: abort.signal });
  abort.abort(new Error('caller left'));
  await assert.rejects(wait, /caller left/);
  assert.equal(commander.snapshot(id).status, 'running');
  const approval = provider.hosts[0].approval({ kind: 'permission', method: 'bash', details: {} });
  await commander.interrupt(id);
  assert.deepEqual(await approval, { allow: false });
  assert.equal(commander.snapshot(id).status, 'idle');
});

test('permissions and questions keep waiting until every pending interaction is resolved', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ provider: 'test' });
  await commander.submit(id, 'run');
  const host = provider.hosts[0];
  const permission = host.approval({ kind: 'permission', method: 'bash', details: {} });
  const question = host.approval({ kind: 'question', method: 'input', details: {} });
  const [first, second] = commander.snapshot(id).pendingApprovals;
  host.event('turn.started');
  assert.equal(commander.snapshot(id).status, 'waiting');
  commander.approve(id, first.id, { allow: true });
  assert.deepEqual(await permission, { allow: true });
  assert.equal(commander.snapshot(id).status, 'waiting');
  assert.equal(commander.snapshot(id).pendingApprovals.length, 1);
  commander.approve(id, second.id, { value: 'answer' });
  assert.deepEqual(await question, { value: 'answer' });
  assert.equal(commander.snapshot(id).status, 'running');
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
});

test('completion and provider failure clear pending interaction without restoring running status', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ provider: 'test' });
  const host = provider.hosts[0];
  for (const status of ['completed', 'failed']) {
    await commander.submit(id, 'run');
    const answer = host.approval({ kind: 'question', method: 'input', details: {} });
    host.event('turn.completed', { status });
    assert.deepEqual(await answer, { allow: false });
    assert.equal(commander.snapshot(id).status, status === 'completed' ? 'idle' : 'failed');
    assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
  }
  await commander.connect(id);
  await commander.submit(id, 'run again');
  const current = provider.hosts.at(-1);
  const answer = current.approval({ kind: 'permission', method: 'bash', details: {} });
  current.failure(new Error('stream lost'));
  assert.deepEqual(await answer, { allow: false });
  assert.equal(commander.snapshot(id).status, 'failed');
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
});

test('failed native submission clears interactions opened before acknowledgement', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ provider: 'test' });
  let answer;
  commander.drivers.get(id).submit = async () => {
    answer = provider.hosts[0].approval({ kind: 'question', method: 'input', details: {} });
    throw new Error('native acknowledgement lost');
  };
  await assert.rejects(commander.submit(id, 'run'), /native acknowledgement lost/);
  assert.deepEqual(await answer, { allow: false });
  assert.equal(commander.snapshot(id).status, 'failed');
  assert.equal(commander.snapshot(id).pendingApprovals.length, 0);
});

test('restarts retain native identity and input receipts without replaying work', async t => {
  const { commander, provider, directory } = await fixture(t);
  const { id, nativeId } = await commander.create({ provider: 'test' });
  await commander.submit(id, 'persisted', { requestId: 'durable' });
  await commander.close();
  const restored = await new Commander({ dataDir: directory }).open();
  restored.providers.set('test', provider);
  try {
    assert.equal(restored.snapshot(id).status, 'disconnected');
    assert.equal(restored.snapshot(id).nativeId, nativeId);
    await restored.connect(id);
    await restored.submit(id, 'persisted', { requestId: 'durable' });
    assert.equal(provider.submitted.length, 1);
    assert.equal(restored.snapshot(id).nativeId, nativeId);
    assert.ok(restored.events(id).events.some(e => e.type === 'input.accepted'));
  } finally { await restored.close(); }
});

test('old driver callbacks cannot finish or mutate a newly connected generation', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ provider: 'test' });
  const old = provider.hosts[0];
  await commander.disconnect(id); await commander.connect(id); await commander.submit(id, 'new');
  old.event('turn.completed', { status: 'completed' }); old.nativeId('wrong'); old.failure(new Error('old stream'));
  assert.equal(commander.snapshot(id).status, 'running');
  assert.notEqual(commander.snapshot(id).nativeId, 'wrong');
  assert.deepEqual(await old.approval({ kind: 'permission' }), { allow: false });
});

test('bounded replay signals a missing baseline instead of silently hiding a gap', async t => {
  const { commander, provider } = await fixture(t, { eventLimit: 3 });
  const { id } = await commander.create({ provider: 'test' });
  for (let n = 0; n < 10; n++) provider.hosts[0].event('text.delta', { text: `${n}` });
  const replay = commander.events(id, 0);
  assert.equal(replay.events.length, 3); assert.equal(replay.truncated, true);
  assert.equal(replay.cursor, replay.latest);
  await commander.persist();
  const data = JSON.parse(await readFile(join(commander.store.directory, 'sessions.json'), 'utf8'));
  assert.equal(data.sessions[0].events.length, 3);
});

test('owner lock prevents two runtimes writing the same state', async t => {
  const { directory } = await fixture(t);
  await assert.rejects(new Commander({ dataDir: directory }).open(), /already in use/);
});

test('duplicate callers both fail if the input cannot be durably accepted; native engine is not invoked', async t => {
  const { commander, provider } = await fixture(t);
  const { id } = await commander.create({ provider: 'test' });
  const original = commander.store.save.bind(commander.store);
  commander.store.save = () => Promise.reject(new Error('disk full'));
  const first = commander.submit(id, 'one', { requestId: 'same' });
  const retry = commander.submit(id, 'one', { requestId: 'same' });
  await assert.rejects(first, /disk full/);
  await assert.rejects(retry, /disk full/);
  assert.equal(provider.submitted.length, 0);
  commander.store.save = original;
});

test('remove releases an idle driver and persists record deletion while retaining native history, project files and children', async t => {
  const { commander, provider, directory } = await fixture(t);
  const nativeHistory = join(directory, 'native-history.jsonl');
  await writeFile(nativeHistory, 'native history remains');
  const parent = await commander.create({ provider: 'test', cwd: directory });
  const child = await commander.create({ provider: 'test', cwd: directory, parentId: parent.id });
  let closed = false;
  commander.drivers.get(parent.id).close = async () => { closed = true; };
  assert.deepEqual(await commander.remove(parent.id), { id: parent.id, removed: true });
  assert.equal(closed, true);
  assert.equal(commander.drivers.has(parent.id), false);
  assert.throws(() => commander.snapshot(parent.id), /Unknown Commander session/);
  assert.equal(commander.snapshot(child.id).parentId, undefined);
  assert.equal(await readFile(nativeHistory, 'utf8'), 'native history remains');
  await access(directory);
  const data = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
  assert.deepEqual(data.sessions.map(s => s.id), [child.id]);
  provider.hosts[0].event('text.delta', { text: 'stale event' });
  assert.equal(commander.list().length, 1);
});

test('archive and remove refuse active turns and remove excludes reconnect during resource cleanup', async t => {
  const { commander } = await fixture(t);
  const { id } = await commander.create({ provider: 'test' });
  await commander.submit(id, 'active');
  await assert.rejects(commander.remove(id), /interrupt.*before deleting/);
  await assert.rejects(commander.archive(id), /interrupt.*before archiving/);
  await commander.interrupt(id);
  let release;
  commander.drivers.get(id).close = () => new Promise(resolve => { release = resolve; });
  const removal = commander.remove(id);
  await assert.rejects(commander.connect(id), /being deleted/);
  await assert.rejects(commander.submit(id, 'race'), /being deleted/);
  release();
  await removal;
});

test('archive prevents reconnect and deletion until driver cleanup finishes', async t => {
  const { commander } = await fixture(t);
  const { id } = await commander.create({ provider: 'test' });
  let release;
  commander.drivers.get(id).close = () => new Promise(resolve => { release = resolve; });
  const pending = commander.archive(id);
  await assert.rejects(commander.connect(id), /being archived/);
  await assert.rejects(commander.remove(id), /being archived/);
  release();
  assert.equal((await pending).archived, true);
  assert.equal(commander.drivers.has(id), false);
});

test('removing a parent detaches shared-owner children without changing independently adopted children', async t => {
  const { commander, directory } = await fixture(t);
  const parent = await commander.create({ provider: 'test', cwd: directory, ownerSessionId: 'original-harness' });
  const child = await commander.create({ provider: 'test', cwd: directory, parentId: parent.id, ownerSessionId: 'original-harness' });
  const adopted = await commander.create({ provider: 'test', cwd: directory, parentId: parent.id, ownerSessionId: 'independent-harness' });
  commander.get(adopted.id).harnessAdopted = true;
  const adoptedSameOwner = await commander.create({ provider: 'test', cwd: directory, parentId: parent.id, ownerSessionId: 'original-harness' });
  commander.get(adoptedSameOwner.id).harnessAdopted = true;
  await commander.remove(parent.id);
  assert.equal(commander.snapshot(child.id).ownerSessionId, `commander-web:detached:${child.id}`);
  assert.equal(commander.snapshot(child.id).parentId, undefined);
  assert.equal(commander.snapshot(adopted.id).ownerSessionId, 'independent-harness');
  assert.equal(commander.snapshot(adoptedSameOwner.id).ownerSessionId, 'original-harness');
  const primary = commander.list().find(s => !s.parentId && !s.harnessAdopted && s.ownerSessionId === 'original-harness');
  assert.equal(primary, undefined);
  const saved = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
  assert.equal(saved.sessions.find(s => s.id === child.id).ownerSessionId, `commander-web:detached:${child.id}`);
});

test('failed removal persistence restores child parent and ownership fields', async t => {
  const { commander, directory } = await fixture(t);
  const parent = await commander.create({ provider: 'test', cwd: directory, ownerSessionId: 'original-harness' });
  const child = await commander.create({ provider: 'test', cwd: directory, parentId: parent.id, ownerSessionId: 'original-harness' });
  const unowned = await commander.create({ provider: 'test', cwd: directory, parentId: parent.id });
  const persist = commander.persist.bind(commander);
  commander.persist = async () => {
    if (!commander.sessions.has(parent.id)) throw new Error('deletion write failed');
    return persist();
  };
  await assert.rejects(commander.remove(parent.id), /deletion write failed/);
  assert.equal(commander.snapshot(parent.id).ownerSessionId, 'original-harness');
  assert.equal(commander.snapshot(child.id).parentId, parent.id);
  assert.equal(commander.snapshot(child.id).ownerSessionId, 'original-harness');
  assert.equal(commander.snapshot(unowned.id).parentId, parent.id);
  assert.equal(Object.hasOwn(commander.get(unowned.id), 'ownerSessionId'), false);
  commander.persist = persist;
});
