import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { smokePreparedRuntime } from '../../deepseek-harness/apps/desktop/scripts/smoke-prepared-runtime.ts';
import { DesktopHostProcess } from '../../deepseek-harness/apps/desktop/src/host-process.ts';
import { getInstallState } from '../../plugins/commander/shared/plugin-install.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const app = join(root, 'artifacts/windows/win-unpacked');
const resources = join(app, 'resources');
const executable = join(app, 'DSH-Plus.exe');
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
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: commander\n  config:\n    dataDir: ${JSON.stringify(join(temporary, 'commander'))}\n`);
  host = new DesktopHostProcess(executable, join(resources, 'app.asar', 'dsh'), profile, undefined, environment, undefined, join(resources, 'runtime/primary-runtime'), { pnpm: join(resources, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), nodeBin: join(resources, 'runtime/bin') });
  let deadline;
  let ready;
  try { ready = await Promise.race([host.start(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Packaged Plus Host startup exceeded 120 seconds')), 120_000); })]); }
  finally { clearTimeout(deadline); }
  const login = await fetch(ready.url, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const response = await fetch(new URL('/api/commander-link', ready.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }) });
  const status = await response.json();
  if (!response.ok || status.enabled !== false) throw new Error(`Packaged Plus management route failed: ${JSON.stringify(status)}`);
  console.log('Packaged DSH runtime, offline Plus enrollment and authenticated Link management passed.');
} finally { try { await host?.stop(); } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } }
