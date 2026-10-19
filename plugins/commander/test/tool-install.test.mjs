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
    if (args.includes('install') || args[0] === 'tool') {
      const prefix = args[0] === 'tool' ? opts.env.UV_TOOL_BIN_DIR.replace(/.bin$/, '') : args[args.indexOf('--prefix') + 1];
      const tool = TOOL_CATALOG.find(tool => args.includes(tool.packageName + '@latest') || args.includes(tool.source));
      const file = manager.managedExecutable(tool.id); await mkdir(join(prefix, 'bin'), { recursive: true }); await writeFile(file, 'fixture'); await chmod(file, 0o755);
      opts.onOutput?.('install token=secret-value\n'); return { stdout: 'ok' };
    }
    return { stdout: 'tool 1.2.3' };
  };
  const runtime = { supported: () => true, resolveNode: async () => process.execPath, ensure: async () => ({ command: join(bin, 'npm'), args: [], binDir: bin }) };
  manager = new ToolInstaller({ root: join(dir, 'tools'), env: { PATH: bin, API_KEY: 'secret-value' }, executor, runtime, ...options });
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
test('managed npm install validates its binary, preserves system preference and uninstalls only prefix', async t => {
  const { manager, calls, dir } = await fixture(t);
  const system = await manager.resolveExecutable('codex'); assert.match(system, /bin.codex$/);
  const config = join(dir, 'user-config.json'); await writeFile(config, '{"keep":true}');
  const job = manager.install('codex'); assert.equal(job.status, 'queued'); assert.throws(() => manager.install('codex'), /进行中/);
  assert.equal((await done(manager, job.id)).status, 'succeeded');
  assert.equal(await manager.resolveExecutable('codex'), system);
  assert.ok(calls[0].args.includes('@openai/codex@latest')); assert.ok(calls[0].args.includes('--engine-strict'));
  const installed = (await manager.list()).find(x => x.id === 'codex');
  assert.equal(installed.source, 'external'); assert.equal(installed.systemExecutable, system);
  assert.equal(installed.managedExecutable, manager.managedExecutable('codex')); assert.equal(installed.managedInstalled, true);
  assert.equal(installed.managedVersion, 'tool 1.2.3'); assert.equal(installed.canInstall, false); assert.equal(installed.canUpdate, true); assert.equal(installed.canReinstall, true);
  assert.equal(calls[1].command, manager.managedExecutable('codex'));
  assert.equal((await done(manager, manager.uninstall('codex').id)).status, 'succeeded');
  assert.equal(await readFile(config, 'utf8'), '{"keep":true}'); assert.match(await manager.resolveExecutable('codex'), /bin.codex$/);
  assert.equal((await done(manager, manager.uninstall('codex').id)).status, 'failed');
});
test('running tools refuse destructive lifecycle actions and unsupported platforms are explicit', async t => {
  const { manager, calls } = await fixture(t, { isRunning: id => id === 'codex' });
  assert.equal((await done(manager, manager.install('codex').id)).status, 'failed'); assert.equal(calls.length, 0);
  assert.equal((await done(manager, manager.updateTool('codex').id)).status, 'failed');
  assert.equal((await done(manager, manager.reinstall('codex').id)).status, 'failed');
  assert.equal((await done(manager, manager.uninstall('codex').id)).status, 'failed'); assert.equal(calls.length, 0);
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
  assert.equal((await done(manager, manager.updateTool('hermes').id)).status, 'succeeded'); assert.ok(calls[2].args.includes('--upgrade'));
});
test('existing unowned installation prefix is never overwritten and secrets are not inherited', async t => {
  const { manager, calls } = await fixture(t); await mkdir(manager.prefix('pi'), { recursive: true });
  await writeFile(join(manager.prefix('pi'), 'keep'), 'original');
  assert.match((await done(manager, manager.install('pi').id)).error, /拒绝覆盖/);
  assert.equal(await readFile(join(manager.prefix('pi'), 'keep'), 'utf8'), 'original');
  await done(manager, manager.install('codex').id); assert.equal(calls[0].env.API_KEY, undefined);
});
test('update and reinstall target only managed copies while preserving system tools and accounts', async t => {
  const { manager, calls, dir, bin } = await fixture(t);
  const accountHome = join(dir, 'account'); await mkdir(accountHome); const account = join(accountHome, 'auth.json'); await writeFile(account, '{"account":"keep"}');
  Object.assign(manager.env, { HOME: accountHome, USERPROFILE: accountHome, CODEX_HOME: accountHome, CLAUDE_CONFIG_DIR: accountHome });
  assert.equal((await done(manager, manager.updateTool('codex').id)).status, 'failed');
  assert.equal((await done(manager, manager.reinstall('codex').id)).status, 'failed'); assert.equal(calls.length, 0);
  assert.equal((await done(manager, manager.install('codex').id)).status, 'succeeded');
  assert.equal((await done(manager, manager.install('codex').id)).status, 'failed');
  const stale = join(manager.prefix('codex'), 'old-artifact'); await writeFile(stale, 'old');
  assert.equal((await done(manager, manager.updateTool('codex').id)).status, 'succeeded'); assert.equal(await readFile(stale, 'utf8'), 'old');
  assert.equal((await done(manager, manager.reinstall('codex').id)).status, 'succeeded'); await assert.rejects(readFile(stale), { code: 'ENOENT' });
  for (const call of calls) { assert.equal(call.env.HOME, join(manager.prefix('codex'), '.install-home')); assert.equal(call.env.CODEX_HOME, undefined); assert.equal(call.env.CLAUDE_CONFIG_DIR, undefined); }
  assert.equal(await readFile(account, 'utf8'), '{"account":"keep"}'); assert.equal(await readFile(join(bin, 'codex'), 'utf8'), 'fixture');
  assert.equal((await done(manager, manager.uninstall('codex').id)).status, 'succeeded');
  assert.equal(await readFile(account, 'utf8'), '{"account":"keep"}'); assert.equal(await manager.resolveExecutable('codex'), join(bin, 'codex'));
});
test('managed PATH entries stay managed and unowned binaries are never launched', async t => {
  const { manager, bin } = await fixture(t);
  await done(manager, manager.install('pi').id); manager.env.PATH = join(manager.prefix('pi'), 'bin') + ':' + bin;
  const row = (await manager.list()).find(item => item.id === 'pi'); assert.equal(row.source, 'managed'); assert.equal(row.systemExecutable, null); assert.equal(row.executable, manager.managedExecutable('pi'));
  await mkdir(join(manager.prefix('claude'), 'bin'), { recursive: true }); await writeFile(manager.managedExecutable('claude'), 'fixture'); await chmod(manager.managedExecutable('claude'), 0o755);
  assert.equal(await manager.resolveExecutable('claude'), null);
});
test('Windows system npm launch resolves beside the system shim even when a managed copy exists', async t => {
  const { manager, bin } = await fixture(t); manager.platform = 'win32';
  const pkg = join(bin, 'node_modules', '@openai', 'codex'); await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'cli.js' } })); await writeFile(join(pkg, 'cli.js'), 'fixture'); await writeFile(join(bin, 'codex.cmd'), 'fixture');
  const managedPkg = join(manager.prefix('codex'), 'node_modules', '@openai', 'codex'); await mkdir(managedPkg, { recursive: true });
  await writeFile(join(managedPkg, 'package.json'), JSON.stringify({ bin: { codex: 'other.js' } })); await writeFile(join(managedPkg, 'other.js'), 'fixture'); await writeFile(manager.managedExecutable('codex'), 'fixture');
  await writeFile(join(manager.prefix('codex'), 'dsh-install.json'), JSON.stringify({ owner: 'dsh-plus', toolId: 'codex' }));
  assert.deepEqual(await manager.resolveLaunch('codex'), { command: process.execPath, args: [join(pkg, 'cli.js')] });
  assert.deepEqual(await manager.resolveLaunch('codex', { managed: true }), { command: process.execPath, args: [join(managedPkg, 'other.js')], env: manager.runtimeEnvironment(process.execPath, manager.env) });
});
test('cancelled executions keep the tool locked until the subprocess exits', async t => {
  let release, started; const entered = new Promise(resolve => { started = resolve; });
  const { manager } = await fixture(t, { executor: async () => { started(); await new Promise(resolve => { release = resolve; }); return { stdout: 'ok' }; } });
  const job = manager.install('pi'); await entered; manager.cancel(job.id);
  const row = (await manager.list()).find(item => item.id === 'pi'); assert.equal(row.job.status, 'cancelled'); assert.equal(row.canInstall, false); assert.equal(row.canUninstall, false); assert.equal(row.canReinstall, false);
  await assert.rejects(manager.resolveLaunch('pi'), /等待任务结束/);
  assert.throws(() => manager.reinstall('pi'), /进行中/); release(); await Promise.all([...manager.tasks]);
  assert.equal((await manager.list()).find(item => item.id === 'pi').canUninstall, true);
});
test('Windows managed npm launcher resolves JavaScript entry without a shell', async t => {
  const { manager } = await fixture(t); manager.platform = 'win32';
  const packageDir = join(manager.prefix('pi'), 'node_modules', '@earendil-works', 'pi-coding-agent');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ bin: { pi: 'cli.js' } })); await writeFile(join(packageDir, 'cli.js'), 'fixture');
  await writeFile(manager.managedExecutable('pi'), 'fixture');
  await writeFile(join(manager.prefix('pi'), 'dsh-install.json'), JSON.stringify({ owner: 'dsh-plus', toolId: 'pi' }));
  assert.deepEqual(await manager.resolveLaunch('pi'), { command: process.execPath, args: [join(packageDir, 'cli.js')], env: manager.runtimeEnvironment(process.execPath, manager.env) });
});
test('executor invokes argv without a shell and kills cancelled subprocess', async () => {
  const result = await executeToolCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '; echo unsafe']); assert.equal(result.stdout, '; echo unsafe');
  const controller = new AbortController(); const pending = executeToolCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /cancelled/);
});


test('missing npm stays installable and prepares runtime automatically before mirrored install', async t => {
  const { manager, calls } = await fixture(t);
  let prepared; manager.env.PATH = '';
  manager.runtime = { supported: () => true, resolveNode: async () => process.execPath, ensure: async options => {
    prepared = options; options.onMessage('正在下载 Node.js');
    return { command: process.execPath, args: ['/private/npm-cli.js'], binDir: '/private' };
  } };
  assert.equal((await manager.list()).find(item => item.id === 'codex').canInstall, true);
  const messages = []; manager.on('job', job => messages.push(job.message));
  const job = await done(manager, manager.install('codex').id);
  assert.equal(job.status, 'succeeded'); assert.equal(job.source, 'mirror');
  assert.equal(prepared.source, 'mirror'); assert.equal(prepared.env.API_KEY, undefined);
  assert.notEqual(prepared.env.HOME, manager.env.HOME);
  const install = calls.find(call => call.args.includes('install'));
  assert.equal(install.command, process.execPath); assert.equal(install.args[0], '/private/npm-cli.js');
  assert.equal(install.args[install.args.indexOf('--registry') + 1], 'https://registry.npmmirror.com');
  assert.equal(install.env.npm_config_registry, 'https://registry.npmmirror.com');
  assert.ok(messages.some(message => message.includes('下载 Node.js')));
  assert.ok(messages.some(message => message.includes('验证 Codex')));
});

test('explicit source survives update/reinstall; npm settings cannot override selection or write user configuration', async t => {
  const { manager, calls } = await fixture(t);
  Object.assign(manager.env, { NPM_CONFIG_REGISTRY: 'https://wrong.test', npm_config_prefix: '/outside', NODE_OPTIONS: '--require /outside/inject.js', ELECTRON_RUN_AS_NODE: '1' });
  const home = manager.env.HOME;
  assert.throws(() => manager.install('pi', { source: 'unknown' }), /下载源/);
  assert.equal((await done(manager, manager.install('pi', { source: 'official' }).id)).status, 'succeeded');
  assert.equal((await done(manager, manager.updateTool('pi', { source: 'official' }).id)).status, 'succeeded');
  assert.equal((await done(manager, manager.reinstall('pi').id)).status, 'succeeded');
  const installs = calls.filter(call => call.args.includes('install'));
  assert.deepEqual(installs.map(call => call.env.npm_config_registry), ['https://registry.npmjs.org', 'https://registry.npmjs.org', 'https://registry.npmmirror.com']);
  for (const call of installs) {
    assert.equal(call.env.NPM_CONFIG_REGISTRY, undefined); assert.equal(call.env.npm_config_prefix, undefined);
    assert.equal(call.env.NODE_OPTIONS, undefined); assert.equal(call.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.ok(call.env.npm_config_userconfig.startsWith(manager.prefix('pi')));
  }
  assert.equal(manager.env.HOME, home); assert.equal(manager.env.NPM_CONFIG_REGISTRY, 'https://wrong.test');
});

test('failed runtime preparation is surfaced without starting npm and remains removable', async t => {
  const { manager, calls } = await fixture(t);
  manager.runtime.ensure = async () => { throw new Error('Node.js 下载校验失败'); };
  const job = await done(manager, manager.install('codex').id);
  assert.equal(job.status, 'failed'); assert.match(job.error, /校验失败/); assert.equal(calls.length, 0);
  assert.equal((await done(manager, manager.uninstall('codex').id)).status, 'succeeded');
});

test('version receipt excludes CLI warnings before the actual version', async t => {
  const { manager } = await fixture(t);
  const execute = manager.executor;
  manager.executor = async (command, args, options) => args.includes('--version')
    ? { stdout: 'WARNING: temporary HOME has limited helpers\ncodex-cli 0.163.0\n' }
    : execute(command, args, options);
  assert.equal((await done(manager, manager.install('codex').id)).status, 'succeeded');
  assert.equal((await manager.receipt('codex')).version, 'codex-cli 0.163.0');
});
