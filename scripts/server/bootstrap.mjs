/** Run only through a verified SSH channel. Final stdout JSON is a private protocol response. */
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
const source = process.argv[2] ?? 'mirror', operation = process.argv[3] ?? 'connect';
if (!['mirror', 'github'].includes(source) || !['connect', 'update'].includes(operation)) throw new Error('无效的服务器安装参数');
const assets = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(manifest.sha256) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.harnessVersion) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.pluginVersion)) throw new Error('服务器安装清单无效');
const archive = join(assets, 'server-seed.tar.gz');
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== manifest.sha256) throw new Error('服务器插件包校验失败');
const base = join(homedir(), '.local/share/dsh-plus/server');
const stateFile = join(base, 'installation.json'), ownerFile = join(base, 'owner.json');
const registry = source === 'mirror' ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org';
const wait = ms => new Promise(r => setTimeout(r, ms));
const present = async path => { try { await readFile(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', npm_config_registry: registry }, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error((command === 'systemctl' ? '服务器服务操作' : '安装依赖') + '失败（' + code + '）')));
  });
}
async function atomic(path, value) { const tmp = path + '.' + randomUUID() + '.tmp'; await writeFile(tmp, value, { mode: 0o600 }); await rename(tmp, path); }
async function freePort() { const server = createServer(); await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); }); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
await mkdir(base, { recursive: true, mode: 0o700 });
let installed; try { installed = JSON.parse(await readFile(stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const lock = join(base, 'install.lock');
try { await mkdir(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Error('已有服务器安装正在进行，请稍后重试'); throw e; }
try {
  if (!installed || operation === 'update') {
    if (installed && installed.harnessVersion !== manifest.harnessVersion) throw new Error('此包需要升级服务器引擎，请由维护者处理，现有数据已保留');
    const runtime = join(base, 'runtimes', manifest.harnessVersion);
    if (!(await present(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')))) {
      process.stderr.write('安装固定版本 Harness…\n');
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      await atomic(join(runtime, 'package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': manifest.harnessVersion } }));
      await run('npm', ['install', '--prefix', runtime, '--omit=dev', '--no-audit', '--no-fund', '--registry', registry]);
    }
    const incoming = join(base, '.seed-' + randomUUID()); await mkdir(incoming, { mode: 0o700 });
    try {
      await run('tar', ['-xzf', archive, '-C', incoming, '--no-same-owner', '--no-same-permissions']);
      const helper = await import(pathToFileURL(join(incoming, 'node_modules/dsh-plus/shared/plugin-install.mjs')).href);
      const profile = join(base, 'home/profiles/web');
      if (!(await present(join(profile, 'package.json')))) {
        const boot = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
        boot.initProfile(profile, boot.PROFILE_TEMPLATES.web.bundles);
      }
      const release = await helper.prepareRelease({ directory: incoming, root: join(profile, '.dsh-plus/releases'), version: manifest.pluginVersion, runtime });
      const webPort = installed?.webPort ?? await freePort(), port = installed?.port ?? await freePort();
      const dataDir = installed?.dataDir ?? join(base, 'data');
      if (!installed) await atomic(join(profile, 'cordis.patch.yml'), ['- id: commander', '  config:', '    dataDir: ' + JSON.stringify(dataDir), '    link:', '      directory: ' + JSON.stringify(join(dataDir, 'link')), '- id: session-telemetry-otel', '  disabled: true', ''].join('\n'));
      if (installed) {
        const active = await authorize(installed, false);
        const state = await linkJson(installed, '/link/api/rpc', { action: 'state' }, active.token);
        await ownerAdmin(installed, { action: 'revoke', id: active.deviceId });
        if (state.sessions?.some(session => session.running)) throw new Error('服务器有任务运行中，请结束后再升级');
      }
      await helper.activateRelease({ profile, release, enabled: true, appVersion: null });
      installed = { schemaVersion: 1, harnessVersion: manifest.harnessVersion, pluginVersion: manifest.pluginVersion, runtime, profile, dataDir, webPort, port };
      await atomic(stateFile, JSON.stringify(installed));
      const launcher = '(' + launchServer.toString() + ')(' + [process.execPath, runtime, ownerFile, base, webPort].map(value => JSON.stringify(value)).join(',') + ');';
      await atomic(join(base, 'start.mjs'), launcher);
      const units = join(homedir(), '.config/systemd/user'); await mkdir(units, { recursive: true, mode: 0o700 });
      const quote = value => JSON.stringify(String(value)).replaceAll('%', '%%');
      const unit = ['[Unit]', 'Description=DSH-Plus server', 'After=network-online.target', '', '[Service]', 'Type=simple', 'UMask=0077', 'WorkingDirectory=' + quote(base), 'ExecStart=' + quote(process.execPath) + ' ' + quote(join(base, 'start.mjs')), 'Environment=' + quote('PATH=' + process.env.PATH), 'Restart=on-failure', 'RestartSec=3', '', '[Install]', 'WantedBy=default.target', ''].join('\n');
      await atomic(join(units, 'dsh-plus.service'), unit);
      await run('systemctl', ['--user', 'daemon-reload']); await run('systemctl', ['--user', 'enable', 'dsh-plus.service']);
      await rm(ownerFile, { force: true }); await run('systemctl', ['--user', 'restart', 'dsh-plus.service']);
    } finally { await rm(incoming, { recursive: true, force: true }); }
  } else { process.stderr.write('复用已安装的 DSH-Plus…\n'); await run('systemctl', ['--user', 'start', 'dsh-plus.service']); }
  if (operation === 'update') {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { const status = await ownerAdmin(installed, { action: 'status' }); if (status.enabled && status.port === installed.port && status.host === '127.0.0.1') { ready = true; break; } } catch {} await wait(500); }
    if (!ready) throw new Error('服务器升级后未正常就绪，请查看服务日志');
  }
  const result = operation === 'update' ? { port: installed.port, pin: createHash('sha256').update(new X509Certificate(JSON.parse(await readFile(join(installed.dataDir, 'link/tls.json'), 'utf8')).cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64') } : await authorize(installed, true);
  const linger = await run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value']).catch(() => 'unknown');
  process.stdout.write(JSON.stringify({ ...result, version: installed.pluginVersion, persistent: linger.trim() === 'yes', ...(linger.trim() !== 'yes' ? { warning: '系统尚未启用用户常驻服务，退出所有 SSH 会话后服务可能停止；维护者可执行 loginctl enable-linger 用户名' } : {}) }) + '\n');
} finally { await rm(lock, { recursive: true, force: true }); }
async function ownerAdmin(state, input) {
  const owner = JSON.parse(await readFile(ownerFile, 'utf8')); const url = new URL(owner.url);
  if (url.hostname !== '127.0.0.1' || Number(url.port) !== state.webPort) throw new Error('服务器启动授权地址无效');
  const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); if (!cookie) throw new Error('服务器尚未准备好');
  const response = await fetch(url.origin + '/api/commander-link', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: url.origin }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '服务器初始化失败'); return value;
}
async function linkJson(state, path, value, token) {
  const identity = JSON.parse(await readFile(join(state.dataDir, 'link/tls.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const request = httpsRequest('https://127.0.0.1:' + state.port + path, { method: 'POST', ca: identity.cert, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, timeout: 10000 }, response => {
      let data = ''; response.on('data', chunk => { data += chunk; }); response.on('end', () => { try { const result = JSON.parse(data); response.statusCode < 400 ? resolve(result) : reject(new Error(result.error ?? '服务器授权失败')); } catch (error) { reject(error); } });
    }); request.on('error', reject); request.on('timeout', () => request.destroy(new Error('服务器授权超时'))); request.end(JSON.stringify(value));
  });
}
async function authorize(state, retry) {
  let failure;
  for (let i = 0; i < (retry ? 100 : 1); i++) {
    try {
      let status = await ownerAdmin(state, { action: 'status' });
      if (!status.enabled) status = await ownerAdmin(state, { action: 'configure', enabled: true, host: '127.0.0.1', port: state.port, publicUrl: '' });
      if (status.host !== '127.0.0.1' || status.port !== state.port) throw new Error('服务器 Link 监听配置已改变，请由维护者检查');
      const pair = await ownerAdmin(state, { action: 'pairing', mode: 'lan' });
      const pending = await linkJson(state, '/link/api/pair', { code: pair.code, name: 'SSH 设备-' + randomUUID().slice(0, 5) });
      await ownerAdmin(state, { action: 'confirm', id: pending.requestId });
      const approved = await linkJson(state, '/link/api/pair/status', pending);
      const tls = JSON.parse(await readFile(join(state.dataDir, 'link/tls.json'), 'utf8'));
      const pin = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
      return { port: state.port, pin, token: approved.token, deviceId: approved.deviceId };
    } catch (error) { failure = error; if (retry) await wait(500); }
  }
  throw new Error('服务器启动或授权失败：' + (failure?.message ?? '未知错误'));
}

function launchServer(node, runtime, ownerFile, base, webPort) {
  Promise.all([import('node:child_process'), import('node:fs'), import('node:path')]).then(([{ spawn }, { writeFileSync, renameSync }, { join }]) => {
    const child = spawn(node, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--host', '127.0.0.1', '--port', String(webPort), '--no-open'], { env: { ...process.env, DSH_HOME: join(base, 'home'), DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    function log(data) {
      pending = (pending + data.toString()).slice(-65536);
      const match = pending.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
      if (match) { writeFileSync(ownerFile + '.tmp', JSON.stringify({ url: match[1] }), { mode: 0o600 }); renameSync(ownerFile + '.tmp', ownerFile); }
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) process.stdout.write(line.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]') + '\n');
    }
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.on('error', () => process.exit(1)); child.on('exit', code => process.exit(code ?? 1));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  }).catch(() => process.exit(1));
}
