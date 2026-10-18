import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('CLI help presents the dsh-plus command without changing the underlying entry point', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--help']);
  assert.match(stdout, /^dsh-plus \[--data-dir PATH\]/);
  assert.doesNotMatch(stdout, /Commander/);
  assert.equal(stderr, '');
});

test('local JSONL control can answer approvals while a wait request is pending', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-cli-'));
  const command = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url)); await chmod(command, 0o755);
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ dataDir: join(directory, 'state'), providers: { codex: { command } } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--stdio', '--config', config], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); const events = []; let seq = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.event) events.push(message.event);
    else { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); }
  });
  const request = (method, params = {}) => new Promise(resolve => {
    const id = ++seq; pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    const created = await request('create', { provider: 'codex', cwd: directory });
    assert.ok(created.result.id); const id = created.result.id;
    await request('send', { id, text: 'approval', requestId: 'one' });
    const waiting = request('wait', { id, timeout: 5000 });
    const snapshot = (await request('list')).result.find(s => s.id === id);
    assert.equal(snapshot.status, 'waiting');
    await request('approve', { id, approvalId: snapshot.pendingApprovals[0].id, answer: { allow: false } });
    assert.equal((await waiting).result.status, 'idle');
    assert.ok(events.some(e => e.type === 'text.delta' && e.data.text === 'decline'));
  } finally {
    const exited = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
