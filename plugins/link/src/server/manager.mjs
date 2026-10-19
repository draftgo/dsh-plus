import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
const { Client } = ssh2;
export const fingerprintOf = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function validateSshInput(input, { credentials = false } = {}) {
  const host = typeof input?.host === 'string' ? input.host.trim().replace(/^\[|\]$/g, '') : '';
  const username = typeof input?.username === 'string' ? input.username.trim() : '';
  const port = input?.port === undefined || input.port === '' ? 22 : Number(input.port);
  if (!host || host.length > 253 || !(isIP(host) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) throw new Error('请输入有效的服务器 IP 或域名');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须为 1–65535');
  if (!username || username.length > 64 || /[\x00-\x20\x7f]/.test(username)) throw new Error('请输入有效的 SSH 用户名');
  if (credentials && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.fingerprint ?? '')) throw new Error('请先确认服务器 SSH 指纹');
  if (credentials && !input.password && !input.privateKey) throw new Error('请输入 SSH 密码或私钥');
  for (const field of ['password', 'privateKey', 'passphrase']) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > (field === 'privateKey' ? 65536 : 4096))) throw new Error('SSH 认证信息无效');
  const source = input.source ?? 'mirror'; if (!['mirror', 'github'].includes(source)) throw new Error('不支持的下载源');
  return { host, port, username, source };
}
const privateRecord = device => ({ id: device.id, name: device.name, kind: 'ssh', url: device.url, pin: device.pin, token: device.token, status: device.status, ssh: device.ssh, ...(device.warning ? { warning: device.warning } : {}), ...(device.lastError ? { lastError: device.lastError } : {}) });
const publicRecord = device => ({ id: device.id, name: device.name, kind: 'ssh', url: device.url, status: device.status, ...(device.warning ? { warning: device.warning } : {}), ...(device.lastError ? { lastError: device.lastError } : {}) });
export function redactServerLog(text, secrets = []) {
  let result = String(text).replace(/([?&](?:token|code)=)[^\s&]+/gi, '$1[redacted]').replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]').replace(/("(?:password|passphrase|privateKey|token)"\s*:\s*")[^"]*/gi, '$1[redacted]');
  for (const value of secrets.filter(Boolean)) result = result.split(value).join('[redacted]');
  return result.slice(-12000);
}
const friendlyError = error => /host denied|hostkey|fingerprint/i.test(error?.message ?? '') ? 'SSH 主机指纹不匹配，已阻止认证' : /authentication|auth|password/i.test(error?.message ?? '') ? 'SSH 认证失败，请检查用户名、密码或私钥' : /timed out|timeout/i.test(error?.message ?? '') ? 'SSH 连接超时，请检查地址和网络' : error?.message ?? '服务器连接失败';
function sshConnect(input, factory, probe = false) {
  return new Promise((resolve, reject) => {
    const client = factory(); let settled = false, mismatch = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { client.destroy(); finish(new Error('SSH 连接超时')); }, 25000); timer.unref?.();
    client.on('error', error => finish(new Error(mismatch ? 'SSH 主机指纹不匹配，已阻止认证' : friendlyError(error))));
    client.on('close', () => { if (!settled) finish(new Error('SSH 连接已关闭')); });
    client.on('ready', () => finish(null, client));
    const base = validateSshInput(input, { credentials: !probe });
    try {
      client.connect({ ...base, readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        ...(probe ? { authHandler: () => false } : { password: input.password, privateKey: input.privateKey, passphrase: input.passphrase, authHandler: input.privateKey ? ['publickey'] : ['password', 'keyboard-interactive'], tryKeyboard: Boolean(input.password) }),
        hostVerifier(key) {
          const fingerprint = fingerprintOf(key);
          if (probe) { finish(null, { fingerprint }); queueMicrotask(() => client.destroy()); return false; }
          mismatch = fingerprint !== input.fingerprint; return !mismatch;
        },
      });
      if (!probe && input.password) client.on('keyboard-interactive', (_name, _instructions, _language, prompts, done) => done(prompts.map(() => input.password)));
    } catch (error) { client.destroy(); finish(error); }
  });
}
export async function execute(client, command, { timeout = 60000, stdin, maximum = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return; }
      let output = '', stderr = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { stream.close(); finish(new Error('服务器操作超时')); }, timeout); timer.unref?.();
      const append = (text, data) => { const value = text + data; if (Buffer.byteLength(value) > maximum) { stream.close(); finish(new Error('服务器返回内容过大')); } return value; };
      stream.on('data', data => { output = append(output, data); }); stream.stderr.on('data', data => { stderr = append(stderr, data); });
      stream.once('error', error => finish(error)); stream.once('close', code => finish(null, { code, stdout: output, stderr }));
      stream.end(stdin);
    });
  });
}
async function upload(client, local, remote) {
  const sftp = await new Promise((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)));
  try { await new Promise((resolve, reject) => sftp.fastPut(local, remote, { mode: 0o600 }, error => error ? reject(error) : resolve())); }
  finally { sftp.end(); }
}
export async function openSshTunnel(client, remotePort) {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('服务器端口无效');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    client.forwardOut('127.0.0.1', socket.localPort || 0, '127.0.0.1', remotePort, (error, stream) => {
      if (error || socket.destroyed) { stream?.destroy(); socket.destroy(); return; }
      stream.on('error', () => socket.destroy()); socket.on('close', () => stream.destroy()); stream.on('close', () => socket.destroy()); socket.pipe(stream).pipe(socket);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: 'https://127.0.0.1:' + server.address().port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
export function createServerManager({ directory, onDevice = async () => {}, runtimeRoot, assetsRoot, clientFactory = () => new Client() } = {}) {
  if (!directory) throw new Error('服务器管理目录未配置');
  const clients = new Set();
  const file = join(directory, 'servers.json'), records = new Map(), sessions = new Map(), jobs = new Map(), connecting = new Set();
  let writes = Promise.resolve(), closed = false;
  const assets = assetsRoot ?? (runtimeRoot ? (runtimeRoot instanceof URL ? fileURLToPath(runtimeRoot) : runtimeRoot) : fileURLToPath(new URL('../../../dist/server/', import.meta.url)));
  const ready = mkdir(directory, { recursive: true, mode: 0o700 }).then(async () => { try { for (const device of JSON.parse(await readFile(file, 'utf8'))) if (device.kind === 'ssh' && device.ssh?.host && device.id) records.set(device.id, { ...device, status: 'offline' }); } catch (e) { if (e.code !== 'ENOENT') throw e; } });
  function persist() { const data = JSON.stringify([...records.values()].map(device => ({ ...privateRecord(device), url: '', status: 'offline' }))); const task = writes.then(async () => { const tmp = file + '.' + randomUUID() + '.tmp'; try { await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, file); } finally { await rm(tmp, { force: true }); } }); writes = task.catch(() => {}); return task; }
  const ensure = () => { if (closed) throw new Error('服务器管理已关闭'); };
  const open = async (input, probe = false) => { const client = await sshConnect(input, () => { const value = clientFactory(); clients.add(value); value.once('close', () => clients.delete(value)); return value; }, probe); ensure(); return client; };
  async function install(client, input, operation) {
    const nonce = randomBytes(16).toString('hex');
    const command = 'umask 077; directory="$HOME/.cache/dsh-plus-bootstrap-' + nonce + '"; mkdir -p -- "$directory"; printf "%s\n" "$directory"';
    const created = await execute(client, command); const path = created.stdout.trim();
    if (created.code !== 0 || !path.startsWith('/') || /[\r\n\0]/.test(path) || !path.endsWith('dsh-plus-bootstrap-' + nonce)) throw new Error('无法创建服务器安装目录');
    try {
      for (const name of ['bootstrap.sh', 'bootstrap.mjs', 'manifest.json', 'server-seed.tar.gz']) await upload(client, join(assets, name), path + '/' + name);
      const result = await execute(client, 'bash ' + shellQuote(path + '/bootstrap.sh') + ' ' + shellQuote(input.source ?? 'mirror') + ' ' + shellQuote(operation), { timeout: 20 * 60 * 1000 });
      if (result.code !== 0) throw new Error(redactServerLog(result.stderr || '服务器安装失败', [input.password, input.privateKey, input.passphrase]));
      let value; try { value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch { throw new Error('服务器安装器未返回有效结果'); }
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[A-Za-z0-9+/]{43}=$/.test(value.pin ?? '') || (operation !== 'update' && !/^[A-Za-z0-9_-]{20,256}$/.test(value.token ?? ''))) throw new Error('服务器授权结果无效');
      return value;
    } finally { await execute(client, 'rm -rf -- ' + shellQuote(path), { timeout: 10000 }).catch(() => {}); }
  }
  function startJob(work) {
    ensure(); if (jobs.size >= 64) for (const [id, job] of jobs) { if (job.state !== 'running') jobs.delete(id); if (jobs.size < 32) break; }
    const job = { id: randomUUID(), state: 'running', steps: [{ name: '连接 SSH', state: 'running' }] }; jobs.set(job.id, job);
    const step = name => { for (const old of job.steps) if (old.state === 'running') old.state = 'done'; job.steps.push({ name, state: 'running' }); };
    Promise.resolve().then(() => work(job, step)).then(device => { job.state = 'done'; for (const step of job.steps) if (step.state === 'running') step.state = 'done'; job.device = publicRecord(device); }).catch(error => { job.state = 'error'; job.error = friendlyError(error); for (const step of job.steps) if (step.state === 'running') step.state = 'error'; });
    return { jobId: job.id };
  }
  async function attach(client, device) {
    const tunnel = await openSshTunnel(client, device.ssh.remotePort); const previous = sessions.get(device.id);
    const session = { client, tunnel }; sessions.set(device.id, session); device.url = tunnel.url; device.status = 'online'; delete device.lastError;
    const disconnect = () => { if (sessions.get(device.id) !== session) return; sessions.delete(device.id); tunnel.close().catch(() => {}); device.status = 'offline'; device.lastError = 'SSH 连接已断开，请重新连接'; Promise.resolve(onDevice(privateRecord(device))).catch(() => {}); };
    client.on('error', disconnect); client.on('close', disconnect);
    try { await onDevice(privateRecord(device)); records.set(device.id, device); await persist(); }
    catch (error) { sessions.delete(device.id); await tunnel.close(); client.end(); throw error; }
    if (previous) { await previous.tunnel.close(); if (previous.client !== client) previous.client.end(); }
    return device;
  }
  return {
    async probe(input) { ensure(); validateSshInput(input); return open(input, true); },
    async connect(input) {
      ensure(); await ready; const target = validateSshInput(input, { credentials: true });
      const name = String(input.name || target.host).trim(); if (!name || name.length > 100) throw new Error('设备名称须为 1–100 个字符');
      const key = [target.host, target.port, target.username].join('|');
      const known = [...records.values()].find(device => [device.ssh.host, device.ssh.port, device.ssh.username].join('|') === key);
      if (known) { if (known.ssh.fingerprint !== input.fingerprint) throw new Error('SSH 主机指纹已改变，已保留原连接'); return this.reconnect({ ...input, id: known.id, device: { name } }); }
      if (connecting.has(key)) throw new Error('此服务器正在连接'); connecting.add(key);
      return startJob(async (_job, step) => { let client; try { client = await open(input); ensure(); step('检查与安装'); const result = await install(client, input, 'connect'); ensure(); step('建立安全隧道'); const previous = [...records.values()].find(device => [device.ssh.host, device.ssh.port, device.ssh.username].join('|') === key); return await attach(client, { id: previous?.id ?? randomUUID(), name, kind: 'ssh', pin: result.pin, token: result.token, ssh: { ...target, fingerprint: input.fingerprint, remotePort: result.port }, ...(result.warning ? { warning: result.warning } : {}) }); } catch (error) { client?.end(); throw error; } finally { connecting.delete(key); } });
    },
    async reconnect(input) {
      ensure(); await ready; const device = records.get(input.id); if (device && input.device?.name) device.name = input.device.name; if (!device) throw new Error('未找到此服务器');
      const value = { ...device.ssh, password: input.password, privateKey: input.privateKey, passphrase: input.passphrase }; validateSshInput(value, { credentials: true });
      return startJob(async (_job, step) => { const client = await open(value); try { ensure(); step('恢复安全隧道'); const channel = await new Promise((resolve, reject) => client.forwardOut('127.0.0.1', 0, '127.0.0.1', device.ssh.remotePort, (error, stream) => error ? reject(error) : resolve(stream))); channel.destroy(); return await attach(client, { ...device }); } catch (error) { client.end(); throw error; } });
    },
    async job(id) { ensure(); const job = jobs.get(typeof id === 'string' ? id : id?.id); if (!job) throw new Error('任务已过期'); return structuredClone(job); },
    async manage(input) {
      ensure(); await ready; const device = records.get(input.id), session = sessions.get(input.id); if (device && input.device?.name) device.name = input.device.name; if (!device || !session) throw new Error('请先重新连接服务器');
      const operation = input.operation;
      if (operation === 'update') return startJob(async (_job, step) => { step('升级 DSH-Plus'); const result = await install(session.client, { source: device.ssh.source }, 'update'); return attach(session.client, { ...device, pin: result.pin, token: result.token ?? device.token, ssh: { ...device.ssh, remotePort: result.port } }); });
      const prefix = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"; export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; ';
      const commands = { status: 'systemctl --user is-active dsh-plus.service', start: 'systemctl --user start dsh-plus.service', stop: 'systemctl --user stop dsh-plus.service', restart: 'systemctl --user restart dsh-plus.service', logs: 'journalctl --user -u dsh-plus.service --no-pager -n 80 -o cat' };
      if (!Object.hasOwn(commands, operation)) throw new Error('不支持的服务器操作');
      const result = await execute(session.client, prefix + commands[operation]); if (result.code !== 0 && operation !== 'status') throw new Error('服务器服务操作失败');
      return { operation, status: operation === 'status' ? result.stdout.trim() : operation === 'stop' ? 'stopped' : undefined, ...(operation === 'logs' ? { logs: redactServerLog(result.stdout) } : {}) };
    },
    async disconnect(id) { await ready; const session = sessions.get(id); sessions.delete(id); if (session) { await session.tunnel.close(); session.client.end(); } records.delete(id); await persist(); },
    async close() { if (closed) return; closed = true; for (const client of clients) client.destroy(); await ready; for (const session of sessions.values()) { await session.tunnel.close(); session.client.end(); } sessions.clear(); await writes; },
  };
}
