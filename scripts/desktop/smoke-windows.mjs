import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { smokePreparedRuntime } from '../../deepseek-harness/apps/desktop/scripts/smoke-prepared-runtime.ts';
import { DesktopHostProcess } from '../../deepseek-harness/apps/desktop/src/host-process.ts';
import { getInstallState } from '../../plugins/commander/shared/plugin-install.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const app = join(root, 'artifacts/windows/win-unpacked');
const resources = join(app, 'resources');
const executable = join(app, '小角.exe');
const descriptor = JSON.parse(await readFile(join(root, 'deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/dsh/desktop-runtime.json')));
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor);
const temporary = await mkdtemp(join(tmpdir(), 'dsh-plus-installed-'));
const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: temporary, HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary, DSH_TELEMETRY_DISABLED: '1' };
let host;
try {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--expose-internals', join(resources, 'dsh-plus/plugin-bundle.mjs'), 'init-profile', '--resources', resources, '--runtime', join(resources, 'app.asar.unpacked/dsh')], { env: environment, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Packaged Plus enrollment failed: ${code}`)));
  });
  const manifest = JSON.parse(await readFile(join(temporary, 'profiles/desktop/package.json')));
  const profile = join(temporary, 'profiles/desktop');
  const state = await getInstallState(profile);
  if (!state.managed || !state.enabled || !manifest.dependencies?.[state.bundleName]?.startsWith('link:')) throw new Error('Installed profile did not activate managed Plus');
  await readFile(join(profile, 'node_modules', state.bundleName, 'package.json'));
  const inventory = JSON.parse(await readFile(join(resources, 'app.asar.unpacked/dsh/desktop-runtime.json')));
  if (inventory.sharedPackages.some(item => item.name === 'dsh-plus' || item.name === '@dowork/dsh-plus-desktop')) throw new Error('Plugin is still locked inside the sealed engine');
  // Use the shipped default dataDir under the isolated user's home, as real installs do.
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n`);
  const makeHost = () => new DesktopHostProcess(executable, join(resources, 'app.asar', 'dsh'), profile, undefined, environment, undefined, join(resources, 'runtime/primary-runtime'), { pnpm: join(resources, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), nodeBin: join(resources, 'runtime/bin') });
  host = makeHost();
  let deadline;
  let ready;
  try { ready = await Promise.race([host.start(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Packaged Plus Host startup exceeded 120 seconds')), 120_000); })]); }
  finally { clearTimeout(deadline); }
  const login = await fetch(ready.url, { redirect: 'manual' });
  let cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const response = await fetch(new URL('/api/commander-link', ready.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }) });
  const status = await response.json();
  if (!response.ok || status.enabled !== false) throw new Error(`Packaged Plus management route failed: ${JSON.stringify(status)}`);
  const sidebarCall = async input => {
    const result = await fetch(new URL('/api/commander', ready.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const body = await result.text();
    if (!result.ok || !result.headers.get('content-type')?.includes('application/json')) throw new Error(`Packaged sidebar ${input.action} returned ${result.status}: ${body.slice(0, 500)}`);
    return JSON.parse(body);
  };
  const sidebar = await sidebarCall({ action: 'state' });
  if (!Array.isArray(sidebar.projects) || !Array.isArray(sidebar.sessions)) throw new Error('Packaged sidebar state is incomplete');
  const recent = await sidebarCall({ action: 'ensureRecent' });
  if (!recent.workspaceId || !recent.path || !(await sidebarCall({ action: 'state' })).projects.some(project => project.id === recent.workspaceId)) throw new Error('Packaged sidebar could not recover its recent workspace');
  const fontManifest = JSON.parse(await readFile(join(state.directory, 'node_modules/dsh-plus/assets/fonts/manifest.json')));
  const font = await fetch(new URL('/api/commander-fonts/' + fontManifest[0].file, ready.url), { headers: { cookie } });
  if (!font.ok || Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString() !== 'wOF2') throw new Error('Packaged sidebar font could not be loaded');
  console.log('Packaged authenticated sidebar state, recent workspace recovery and font asset passed.');
  const dataDir = join(temporary, '.dowork', 'commander');
  const lockPath = join(dataDir, 'owner.lock');
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid === process.pid) throw new Error('Unexpected packaged Host owner record');
  process.kill(owner.pid, 'SIGKILL');
  const exitedBy = Date.now() + 15_000;
  for (;;) {
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') break; throw error; }
    if (Date.now() > exitedBy) throw new Error('Killed packaged Host did not exit');
    await delay(50);
  }
  // The old Host is dead; keep the legacy lock format to exercise existing installations.
  host = undefined;
  await writeFile(lockPath, JSON.stringify({ pid: owner.pid, host: owner.host }));
  const fixture = { version: 1, sessions: [{ id: 'crash-recovery-check', provider: 'codex', cwd: temporary, status: 'disconnected', archived: false, cursor: 0, events: [], receipts: {}, pendingApprovals: [], nativeId: 'preserved-native-handle' }] };
  const saved = JSON.stringify(fixture);
  await writeFile(join(dataDir, 'sessions.json'), saved);
  host = makeHost();
  try { ready = await Promise.race([host.start(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Packaged Host crash recovery exceeded 120 seconds')), 120_000); })]); }
  finally { clearTimeout(deadline); }
  const recoveredLogin = await fetch(ready.url, { redirect: 'manual' });
  cookie = recoveredLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const recovered = await sidebarCall({ action: 'state' });
  if (!recovered.sessions.some(session => session.id === 'crash-recovery-check' && session.nativeId === 'preserved-native-handle')) throw new Error('Packaged Host lost sessions after crash recovery');
  if (await readFile(join(dataDir, 'sessions.json'), 'utf8') !== saved) throw new Error('Crash recovery rewrote saved sessions');
  if (!(await sidebarCall({ action: 'ensureRecent' })).workspaceId) throw new Error('Packaged sidebar recent workspace failed after crash recovery');
  console.log('Packaged Host forced-exit recovery with legacy owner.lock, default user dataDir and preserved sessions passed.');
  console.log('Packaged DSH runtime, offline Plus enrollment and authenticated Link management passed.');
} finally { try { await host?.stop(); } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } }
