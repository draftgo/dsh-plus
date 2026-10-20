import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Commander } from '../src/runtime.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'commander-store-'));
  const stores = [];
  t.after(async () => {
    await Promise.allSettled(stores.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store() { const store = new Store(directory); stores.push(store); return store; } };
}

async function childStore(t, directory) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    const store = new Store(process.argv[1]);
    process.on('message', async message => {
      if (message !== 'open') return;
      try { await store.open(); process.send({ opened: true }); }
      catch (error) { process.send({ opened: false, message: error.message, code: error.code }); }
    });
    process.send({ ready: true });
  `, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  assert.deepEqual((await once(child, 'message'))[0], { ready: true });
  return { child, exited, async open() { const reply = once(child, 'message'); child.send('open'); return (await reply)[0]; } };
}

test('killed owner restarts from its persisted sessions without manual lock removal', { timeout: 10000 }, async t => {
  const f = await fixture(t), sessions = [{ id: 'kept-session', nativeId: 'native-thread', receipts: { 'input-1': { receipt: { status: 'accepted' } } } }];
  await writeFile(join(f.directory, 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  const owner = await childStore(t, f.directory);
  assert.deepEqual(await owner.open(), { opened: true });
  const oldLock = await readFile(join(f.directory, 'owner.lock'), 'utf8');
  owner.child.kill('SIGKILL'); await owner.exited;
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), oldLock);
  const restarted = f.store();
  assert.deepEqual(await restarted.open(), { version: 1, sessions });
  const newLock = JSON.parse(await readFile(join(f.directory, 'owner.lock'), 'utf8'));
  assert.equal(newLock.pid, process.pid); assert.equal(newLock.host, hostname()); assert.equal(typeof newLock.token, 'string');
  assert.notEqual(JSON.stringify(newLock), oldLock);
});

test('legacy PID and hostname locks are recovered only after their real owner exits', { timeout: 10000 }, async t => {
  const f = await fixture(t), owner = await childStore(t, f.directory);
  const legacy = JSON.stringify({ pid: owner.child.pid, host: hostname() });
  await writeFile(join(f.directory, 'owner.lock'), legacy);
  await assert.rejects(f.store().open(), error => error.code === 'DSH_PLUS_DATA_LOCKED');
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), legacy);
  owner.child.kill('SIGKILL'); await owner.exited;
  assert.deepEqual(await f.store().open(), { version: 1, sessions: [] });
});

test('concurrent processes recovering the same killed owner admit exactly one writer', { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await childStore(t, f.directory);
  assert.equal((await owner.open()).opened, true);
  owner.child.kill('SIGKILL'); await owner.exited;
  const contenders = await Promise.all(Array.from({ length: 5 }, () => childStore(t, f.directory)));
  const results = await Promise.all(contenders.map(contender => contender.open()));
  assert.equal(results.filter(result => result.opened).length, 1, JSON.stringify(results));
  assert.ok(results.filter(result => !result.opened).every(result => result.code === 'DSH_PLUS_DATA_LOCKED'));
  const winner = contenders[results.findIndex(result => result.opened)];
  assert.equal(JSON.parse(await readFile(join(f.directory, 'owner.lock'), 'utf8')).pid, winner.child.pid);
});

test('close releases ownership and repeated close preserves the successor lock', async t => {
  const f = await fixture(t), first = f.store(), next = f.store();
  await first.open(); await first.save([{ id: 'persisted' }]); await first.close();
  assert.deepEqual(await next.open(), { version: 1, sessions: [{ id: 'persisted' }] });
  const record = await readFile(join(f.directory, 'owner.lock'), 'utf8');
  await first.close();
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), record);
  await next.close();
  await assert.rejects(access(join(f.directory, 'owner.lock')), { code: 'ENOENT' });
});

test('close refuses to delete a lock with a different ownership token', async t => {
  const f = await fixture(t), owner = f.store(); await owner.open();
  const successor = JSON.stringify({ pid: process.pid, host: hostname(), token: 'successor' });
  await writeFile(join(f.directory, 'owner.lock'), successor);
  await assert.rejects(owner.close(), error => error.code === 'DSH_PLUS_LOCK_OWNERSHIP_CHANGED');
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), successor);
  await owner.close();
  assert.equal(await readFile(join(f.directory, 'owner.lock'), 'utf8'), successor);
});

test('untrusted locks retain their bytes and do not probe invalid or foreign PIDs', async t => {
  const f = await fixture(t), path = join(f.directory, 'owner.lock');
  const records = [
    '{broken json', 'null', JSON.stringify({ pid: 0, host: hostname() }), JSON.stringify({ pid: -1, host: hostname() }),
    JSON.stringify({ pid: 1.5, host: hostname() }), JSON.stringify({ pid: '12', host: hostname() }),
    JSON.stringify({ pid: 2147483648, host: hostname() }), JSON.stringify({ pid: process.pid }),
    JSON.stringify({ pid: process.pid, host: `${hostname()}-other` }),
  ];
  const probe = t.mock.method(process, 'kill', () => { throw new Error('untrusted PID must not be probed'); });
  for (const record of records) {
    await writeFile(path, record);
    await assert.rejects(f.store().open(), error => ['DSH_PLUS_LOCK_UNREADABLE', 'DSH_PLUS_LOCK_OTHER_HOST'].includes(error.code));
    assert.equal(await readFile(path, 'utf8'), record);
  }
  assert.equal(probe.mock.callCount(), 0);
});

test('permission-denied owner probes preserve the lock instead of taking over', async t => {
  const f = await fixture(t), path = join(f.directory, 'owner.lock');
  const record = JSON.stringify({ pid: process.pid, host: hostname() }); await writeFile(path, record);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
  await assert.rejects(f.store().open(), error => error.code === 'DSH_PLUS_LOCK_PROBE_FAILED' && error.cause.code === 'EPERM');
  assert.equal(await readFile(path, 'utf8'), record);
});

test('corrupt session JSON is retained while failed startup releases its owner lock', async t => {
  const f = await fixture(t), path = join(f.directory, 'sessions.json'), corrupt = '{unfinished';
  await writeFile(path, corrupt);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.store().open(), SyntaxError);
    assert.equal(await readFile(path, 'utf8'), corrupt);
    await assert.rejects(access(join(f.directory, 'owner.lock')), { code: 'ENOENT' });
  }
});

test('runtime hydration failures release ownership without rewriting stored sessions', async t => {
  const f = await fixture(t), path = join(f.directory, 'sessions.json');
  for (const invalid of [{ version: 1, sessions: [null] }, { version: 1, sessions: [{ id: 'broken', status: 'running' }] }, null]) {
    const bytes = JSON.stringify(invalid); await writeFile(path, bytes);
    const runtime = new Commander({ dataDir: f.directory });
    await assert.rejects(runtime.open());
    assert.equal(runtime.sessions.size, 0);
    assert.equal(await readFile(path, 'utf8'), bytes);
    await assert.rejects(access(join(f.directory, 'owner.lock')), { code: 'ENOENT' });
  }
});
