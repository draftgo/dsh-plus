import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolInstaller, redactToolOutput, executeToolCommand } from '../src/tool-install.mjs';
import { TOOL_CATALOG, normalizeToolId } from '../src/tool-catalog.mjs';
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-installer-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); await mkdir(bin);
  for (const name of ['npm', 'uv', 'codex']) { const path = join(bin, name); await writeFile(path, 'fixture'); await chmod(path, 0o755); }
  const calls = []; let manager;
  const executor = async (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    if (args[0] === 'install' || args[0] === 'tool') {
      const prefix = args[0] === 'tool' ? opts.env.UV_TOOL_BIN_DIR.replace(/.bin$/, '') : args[args.indexOf('--prefix') + 1];
      const tool = TOOL_CATALOG.find(tool => args.includes(tool.packageName + '@latest') || args.includes(tool.source));
      const file = manager.managedExecutable(tool.id); await mkdir(join(prefix, 'bin'), { recursive: true }); await writeFile(file, 'fixture'); await chmod(file, 0o755);
      opts.onOutput?.('install token=secret-value\n'); return { stdout: 'ok' };
    }
    return { stdout: 'tool 1.2.3' };
  };
  manager = new ToolInstaller({ root: join(dir, 'tools'), env: { PATH: bin, API_KEY: 'secret-value' }, executor, ...options });
  t.after(() => manager.close()); return { dir, bin, calls, manager };
}
async function done(manager, id) {
  for (let i = 0; i < 100; i++) { const job = manager.job(id); if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job; await delay(5); }
  assert.fail('job did not finish');
}
test('catalog is fixed and aliases cannot become commands or paths', () => {
  assert.equal(TOOL_CATALOG.length, 10); assert.equal(normalizeToolId('grokbuild'), 'grok'); assert.equal(normalizeToolId('minimax'), 'mcode');
  for (const id of ['../codex', 'codex;curl evil', '__proto__', null]) assert.throws(() => normalizeToolId(id));
});
test('managed npm install validates binary, resolves before PATH and uninstalls only prefix', async t => {
  const { manager, calls, dir } = await fixture(t);
  assert.match(await manager.resolveExecutable('codex'), /bin.codex$/);
  const config = join(dir, 'user-config.json'); await writeFile(config, '{"keep":true}');
  const job = manager.install('codex'); assert.equal(job.status, 'queued'); assert.throws(() => manager.install('codex'), /进行中/);
  assert.equal((await done(manager, job.id)).status, 'succeeded');
  assert.equal(await manager.resolveExecutable('codex'), manager.managedExecutable('codex'));
  assert.ok(calls[0].args.includes('@openai/codex@latest')); assert.ok(calls[0].args.includes('--engine-strict'));
  assert.equal((await manager.list()).find(x => x.id === 'codex').source, 'managed');
  assert.equal((await done(manager, manager.uninstall('codex').id)).status, 'succeeded');
  assert.equal(await readFile(config, 'utf8'), '{"keep":true}'); assert.match(await manager.resolveExecutable('codex'), /bin.codex$/);
  assert.equal((await done(manager, manager.uninstall('codex').id)).status, 'failed');
});
test('running tools refuse destructive lifecycle actions and unsupported platforms are explicit', async t => {
  const { manager, calls } = await fixture(t, { isRunning: id => id === 'codex' });
  assert.equal((await done(manager, manager.install('codex').id)).status, 'failed'); assert.equal(calls.length, 0);
  assert.equal((await manager.list()).find(x => x.id === 'codex').canInstall, false);
  assert.equal((await done(manager, manager.install('claude-desktop').id)).status, 'failed');
  const other = new ToolInstaller({ root: manager.root, platform: 'freebsd' }); t.after(() => other.close());
  assert.match((await other.list()).find(x => x.id === 'codex').installReason, /freebsd/);
});
test('no binary after successful command is a real failure and failed prefix remains removable', async t => {
  const { manager } = await fixture(t, { executor: async () => ({ stdout: 'success' }) });
  const job = await done(manager, manager.install('pi').id); assert.equal(job.status, 'failed'); assert.match(job.error, /入口不可用/);
  assert.equal((await manager.list()).find(x => x.id === 'pi').canUninstall, true);
  assert.equal((await done(manager, manager.uninstall('pi').id)).status, 'succeeded');
});
test('cancel queued tasks without execution; running tasks abort and timeout is bounded', async t => {
  const calls = [];
  const { manager } = await fixture(t, { maxConcurrent: 1, timeoutMs: 30, executor: (command, args, { signal }) => { calls.push(args); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  const first = manager.install('codex'), second = manager.install('pi'); manager.cancel(second.id);
  assert.equal((await done(manager, first.id)).status, 'failed'); assert.match(manager.job(first.id).error, /超时/); assert.equal(manager.job(second.id).status, 'cancelled'); assert.equal(calls.length, 1);
});
test('logs redact secrets, URLs and split chunks before publication', async t => {
  const { manager } = await fixture(t, { executor: async (_, args, { onOutput }) => { onOutput('API_KEY=secret-'); onOutput('value\n'); throw new Error('https://user:pass@host/path dg_123456789012345678'); } });
  const job = await done(manager, manager.install('pi').id); assert.ok(!JSON.stringify(job).includes('secret-value')); assert.ok(!job.error.includes('user:pass'));
  assert.match(redactToolOutput('password=abc123'), /REDACTED/);
});
test('symbolic link prefixes cannot be adopted or deleted', async t => {
  const { manager, dir } = await fixture(t); await mkdir(manager.root); await symlink(dir, manager.prefix('codex'));
  const job = await done(manager, manager.install('codex').id); assert.equal(job.status, 'failed'); assert.match(job.error, /符号链接/);
});
test('Hermes uses official Git source and isolated uv runtime directories', async t => {
  const { manager, calls } = await fixture(t); const job = await done(manager, manager.install('hermes').id);
  assert.equal(job.status, 'succeeded'); assert.ok(calls[0].args.includes('git+https://github.com/NousResearch/hermes-agent.git'));
  assert.equal(calls[0].env.UV_TOOL_DIR, join(manager.prefix('hermes'), 'tools')); assert.equal(calls[0].env.UV_PYTHON_INSTALL_DIR, join(manager.prefix('hermes'), 'python'));
});
test('existing unowned installation prefix is never overwritten and secrets are not inherited', async t => {
  const { manager, calls } = await fixture(t); await mkdir(manager.prefix('pi'), { recursive: true });
  await writeFile(join(manager.prefix('pi'), 'keep'), 'original');
  assert.match((await done(manager, manager.install('pi').id)).error, /拒绝覆盖/);
  assert.equal(await readFile(join(manager.prefix('pi'), 'keep'), 'utf8'), 'original');
  await done(manager, manager.install('codex').id); assert.equal(calls[0].env.API_KEY, undefined);
});
test('Windows managed npm launcher resolves JavaScript entry without a shell', async t => {
  const { manager } = await fixture(t); manager.platform = 'win32';
  const packageDir = join(manager.prefix('pi'), 'node_modules', '@earendil-works', 'pi-coding-agent');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ bin: { pi: 'cli.js' } })); await writeFile(join(packageDir, 'cli.js'), 'fixture');
  await writeFile(manager.managedExecutable('pi'), 'fixture');
  assert.deepEqual(await manager.resolveLaunch('pi'), { command: process.execPath, args: [join(packageDir, 'cli.js')] });
});
test('executor invokes argv without a shell and kills cancelled subprocess', async () => {
  const result = await executeToolCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '; echo unsafe']); assert.equal(result.stdout, '; echo unsafe');
  const controller = new AbortController(); const pending = executeToolCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /cancelled/);
});
