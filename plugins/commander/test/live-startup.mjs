// Opt-in real Harness smoke. Isolated user home; no GUI or model requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const node = resolve(process.env.COMMANDER_TEST_NODE || join(root, 'node_modules/.toolchain/node_modules/node/bin/node'));
const dependencies = resolve(process.env.COMMANDER_HARNESS_NODE_MODULES || join(root, '.local/web/home/profiles/web/node_modules'));
const tsx = join(root, 'deepseek-harness/node_modules/tsx/dist/esm/index.mjs');
for (const path of [node, tsx, join(dependencies, 'dsh-plus/package.json')]) await access(path);
const directory = await mkdtemp(join(tmpdir(), 'dsh-plus-startup-'));
const home = join(directory, 'user');
const dshHome = join(home, '.dsh');
const profile = join(dshHome, 'profiles/web');
const workspace = join(directory, 'workspace');
const data = join(home, '.dowork/commander');
const sessionsPath = join(data, 'sessions.json');
const lockPath = join(data, 'owner.lock');
const dismissedPath = join(data, 'dismissed-harness.json');
let instance;
const safe = value => String(value).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]');

async function boot() {
  let output = '';
  const child = spawn(node, ['--import', tsx, join(root, 'deepseek-harness/apps/cli/src/bin.ts'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: workspace,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DSH_HOME: dshHome, DSH_AGENTS_HOME: join(home, 'agents'), TSX_TSCONFIG_PATH: join(root, 'deepseek-harness/tsconfig.json'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ended = new Promise(resolve => { child.once('exit', resolve); child.once('error', error => { output += error.message; resolve(); }); });
  instance = { child, ended };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  const deadline = Date.now() + 90_000;
  let login;
  while (Date.now() < deadline) {
    const match = output.match(/dsh web: (http:[/][/]127\.0\.0\.1:\d+[/][?]token=[^\s]+)/);
    if (match) { login = new URL(match[1]); break; }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Harness exited: ${safe(output).slice(-4000)}`);
    await delay(100);
  }
  assert.ok(login, `Harness ready deadline: ${safe(output).slice(-4000)}`);
  const signed = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const cookie = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'real owner authentication cookie');
  return async action => {
    const response = await fetch(new URL('/api/commander', login), {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(10_000),
    });
    assert.match(response.headers.get('content-type') || '', /application[/]json/);
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
}

async function stop(signal = 'SIGTERM') {
  if (!instance) return;
  const { child, ended } = instance;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    await Promise.race([ended, delay(10_000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
  }
  instance = undefined;
}

try {
  for (const path of [profile, workspace, data]) await mkdir(path, { recursive: true });
  await symlink(dependencies, join(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-plus-startup-smoke', private: true, dependencies: { 'dsh-plus': `link:${root}plugins/commander` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plus'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: session-log-deepseek\n  config:\n    enabled: false\n- id: session-telemetry-otel\n  disabled: true\n');
  const fixture = JSON.stringify({ version: 1, sessions: [{ id: 'preserved-session', provider: 'codex', cwd: workspace, status: 'disconnected', archived: false, cursor: 0, events: [], receipts: {}, pendingApprovals: [], nativeId: 'preserved-native-id' }] });
  await writeFile(sessionsPath, fixture);
  let call = await boot();
  const initial = await call('state');
  assert.equal(initial.status, 200);
  assert.ok(initial.body.sessions.some(session => session.nativeId === 'preserved-native-id'));
  assert.equal((await call('ensureRecent')).status, 200);
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(owner.host, hostname());
  assert.equal(owner.pid, instance.child.pid);
  await stop('SIGKILL');
  assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, owner.pid);
  await writeFile(lockPath, JSON.stringify({ pid: owner.pid, host: owner.host }));
  call = await boot();
  const recovered = await call('state');
  assert.equal(recovered.status, 200);
  assert.ok(recovered.body.sessions.some(session => session.id === 'preserved-session' && session.nativeId === 'preserved-native-id'));
  assert.equal(await readFile(sessionsPath, 'utf8'), fixture);
  assert.ok((await call('ensureRecent')).body.workspaceId);
  console.log('PASS: real authenticated Harness state and recent workspace after SIGKILL, legacy lock recovery, unchanged saved sessions.');
  await stop();
  const corrupt = '{unfinished';
  await writeFile(dismissedPath, corrupt);
  call = await boot();
  const sidebarFailure = await call('state');
  assert.equal(sidebarFailure.status, 503);
  assert.equal(sidebarFailure.body.code, 'COMMANDER_UNAVAILABLE');
  assert.match(sidebarFailure.body.error, /DSH-Plus 启动失败/);
  assert.equal(sidebarFailure.cache, 'no-store');
  assert.equal(await readFile(dismissedPath, 'utf8'), corrupt);
  await stop();
  await rm(dismissedPath);
  await writeFile(sessionsPath, corrupt);
  call = await boot();
  const storeFailure = await call('state');
  assert.equal(storeFailure.status, 503);
  assert.equal(storeFailure.body.code, 'COMMANDER_UNAVAILABLE');
  assert.equal(await readFile(sessionsPath, 'utf8'), corrupt);
  await assert.rejects(access(lockPath), { code: 'ENOENT' });
  console.log('PASS: corrupt sidebar and session files produce authenticated JSON 503, preserve original data, and release failed startup ownership.');
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
