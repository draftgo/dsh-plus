#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID, X509Certificate, createPrivateKey } from 'node:crypto';
import { access, link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIN_CERTBOT = [5, 4, 0];
const CERT_NAME = 'dsh-link-ip';
const TOOL_DIR = 'dsh-link-ip-certificate';
const TIMER_SERVICE = 'dsh-link-ip-certificate-renew.service';
const TIMER_UNIT = 'dsh-link-ip-certificate-renew.timer';
const RELAY_UNIT = 'dsh-link-relay.service';
const UNIT_MARKER = '# Managed by DSH Link IP certificate tool.';
const TIMER_MANIFEST = '.dsh-link-ip-certificate-renew.json';
const fail = message => { throw new Error(message); };

function options(argv) {
  const [operation, ...rest] = argv;
  if (!['issue', 'renew', 'dry-run', 'status', 'install-timer', 'uninstall-timer'].includes(operation)) fail('用法：ip-certificate.mjs <issue|renew|dry-run|status|install-timer|uninstall-timer> [选项]');
  const allowed = new Set(['--ip', '--email', '--webroot', '--state-dir', '--challenge-port', '--relay-port', '--confirm-public-ip', '--certbot', '--restart-relay-unit']);
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.has(key) || key in values || !value || value.startsWith('--')) fail('证书参数无效：' + key);
    values[key] = value;
  }
  if (operation === 'uninstall-timer') {
    if (Object.keys(values).length) fail('uninstall-timer 不接受参数');
    return { operation, values };
  }
  if (!values['--state-dir']) fail('必须指定 --state-dir');
  if (['status', 'install-timer'].includes(operation) && Object.keys(values).some(key => key !== '--state-dir')) fail(operation + ' 只接受 --state-dir');
  if (!['status', 'install-timer'].includes(operation)) for (const key of ['--ip', '--email', '--webroot', '--challenge-port', '--relay-port', '--confirm-public-ip']) if (!values[key]) fail('必须指定 ' + key);
  if (values['--restart-relay-unit'] && (operation !== 'renew' || values['--restart-relay-unit'] !== RELAY_UNIT)) fail('续期只允许重启本工具管理的 ' + RELAY_UNIT);
  return { operation, values };
}
function portNumber(value) {
  if (!/^\d{1,5}$/.test(value ?? '')) fail('端口必须使用十进制数字');
  return Number(value);
}

function ipv4Number(ip) { return ip.split('.').reduce((value, item) => (value << 8n) | BigInt(item), 0n); }
function inCidr(value, base, bits, width) { return (value >> BigInt(width - bits)) === (base >> BigInt(width - bits)); }
function ipv6Number(ip) {
  let value = ip.toLowerCase();
  if (value.includes('.')) {
    const index = value.lastIndexOf(':');
    const v4 = value.slice(index + 1);
    if (isIP(v4) !== 4) return null;
    const n = ipv4Number(v4);
    value = value.slice(0, index) + ':' + ((n >> 16n).toString(16)) + ':' + (n & 0xffffn).toString(16);
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  if (halves.length > 2) return null;
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((number, group) => (number << 16n) | BigInt('0x' + group), 0n);
}

export function validateConfig(input) {
  const ip = input.ip;
  const family = typeof ip === 'string' ? isIP(ip) : 0;
  if (!family) fail('必须填写有效的 IP 地址，不能填写域名');
  if (input.confirmPublicIp !== true) fail('请确认该 IP 是此服务器实际使用的公网 IP');
  if (family === 4) {
    const value = ipv4Number(ip);
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
      ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    if (blocked.some(([base, bits]) => inCidr(value, ipv4Number(base), bits, 32))) fail('该 IPv4 地址不是可签发证书的公网单播地址');
  } else {
    const value = ipv6Number(ip);
    if (value === null || (value >> 125n) !== 1n || inCidr(value, ipv6Number('2001::'), 23, 128) || inCidr(value, ipv6Number('2001:db8::'), 32, 128) || inCidr(value, ipv6Number('2001:20::'), 28, 128) || inCidr(value, ipv6Number('3fff::'), 20, 128)) fail('该 IPv6 地址不是可签发证书的公网单播地址');
  }
  if (!/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(input.email ?? '')) fail('请输入有效的联系邮箱');
  if (input.challengePort !== 80) fail('Let’s Encrypt HTTP-01 固定使用公网 80 端口；请让现有反向代理将挑战目录映射到 webroot');
  if (!Number.isInteger(input.relayPort) || input.relayPort < 20000 || input.relayPort > 49151 || [22, 80, 443, 8080, 8443].includes(input.relayPort)) fail('中继业务端口须为 20000–49151 的专用高位端口');
  if (typeof input.webroot !== 'string' || !input.webroot || !input.stateDir) fail('必须指定已存在的 webroot 和状态目录');
  if (input.certbot !== undefined && (typeof input.certbot !== 'string' || !input.certbot || input.certbot.includes('\0'))) fail('Certbot 路径无效');
  return { ip, family, email: input.email, challengePort: 80, relayPort: input.relayPort, webroot: resolve(input.webroot), stateDir: resolve(input.stateDir), certbot: input.certbot ?? 'certbot' };
}

async function existingDirectory(path, label, writable = false) {
  const resolved = await realpath(path).catch(() => fail(label + ' 必须是已存在的目录'));
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) fail(label + ' 必须是目录');
  await access(resolved, writable ? 2 : 4).catch(() => fail(label + (writable ? ' 不可写' : ' 不可读')));
  return resolved;
}
async function stateDirectory(path, { create = false } = {}) {
  const requested = resolve(path);
  if (create) await mkdir(requested, { recursive: true, mode: 0o700 });
  const resolved = await realpath(requested).catch(error => error.code === 'ENOENT' && !create ? null : fail('状态目录必须是可访问的目录'));
  if (!resolved) return null;
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) fail('状态目录必须是目录');
  await access(resolved, create ? 2 : 4).catch(() => fail(create ? '状态目录不可写' : '状态目录不可读'));
  return resolved;
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function systemdArg(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) fail('systemd 参数不能包含换行或空字符');
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$').replace(/%/g, '%%') + '"';
}
function unitDirectory() {
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), '.config');
  return join(configHome, 'systemd', 'user');
}
function timerContents(config, stateDir) {
  const script = fileURLToPath(import.meta.url);
  const args = [
    process.execPath, script, 'renew', '--state-dir', stateDir, '--ip', config.ip, '--email', config.email,
    '--webroot', config.webroot, '--challenge-port', '80', '--relay-port', String(config.relayPort),
    '--confirm-public-ip', 'true', '--certbot', config.certbot ?? 'certbot', '--restart-relay-unit', RELAY_UNIT,
  ];
  const service = [
    UNIT_MARKER, '[Unit]', 'Description=Renew the DSH Link IP certificate', 'After=network-online.target', '',
    '[Service]', 'Type=oneshot', 'UMask=0077', 'TimeoutStartSec=25min', 'ExecStart=' + args.map(systemdArg).join(' '), '',
  ].join('\n');
  const timer = [
    UNIT_MARKER, '[Unit]', 'Description=Daily renewal of the DSH Link IP certificate', '',
    '[Timer]', 'OnCalendar=daily', 'RandomizedDelaySec=1h', 'Persistent=true', 'Unit=' + TIMER_SERVICE, '',
    '[Install]', 'WantedBy=timers.target', '',
  ].join('\n');
  return { [TIMER_SERVICE]: service, [TIMER_UNIT]: timer };
}

async function ownedFile(path, expectedHash, label) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail(label + ' 不是本工具拥有的普通文件');
  const contents = await readFile(path, 'utf8');
  if (!contents.startsWith(UNIT_MARKER) || digest(contents) !== expectedHash) fail(label + ' 已被修改，拒绝覆盖或删除');
  return contents;
}

async function readTimerManifest(directory) {
  const path = join(directory, TIMER_MANIFEST);
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('续期 timer 归属清单权限或文件类型无效');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.tool !== 'dsh-link-ip-certificate' || !manifest.units || typeof manifest.units[TIMER_SERVICE] !== 'string' || typeof manifest.units[TIMER_UNIT] !== 'string') fail('续期 timer 归属清单无效');
  if (![manifest.units[TIMER_SERVICE], manifest.units[TIMER_UNIT]].every(value => /^[a-f0-9]{64}$/.test(value))) fail('续期 timer 归属清单哈希无效');
  return manifest;
}

async function createOwnedFile(path, contents) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  try { await link(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

async function systemd(args) { return command('systemctl', ['--user', ...args], { timeout: 30000, label: 'systemctl' }); }
async function requireRelayUnit() {
  const { stdout } = await systemd(['show', '--property=LoadState', '--value', RELAY_UNIT]);
  if (stdout.trim() !== 'loaded') fail('当前用户的 systemd 尚未加载 ' + RELAY_UNIT + '，请先配置并启动中继服务');
}

async function installTimer(config, stateDir) {
  await requireRelayUnit();
  const directory = unitDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const contents = timerContents(config, stateDir), hashes = Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, digest(value)]));
  const manifestPath = join(directory, TIMER_MANIFEST), manifest = await readTimerManifest(directory);
  if (manifest) {
    if (manifest.units[TIMER_SERVICE] !== hashes[TIMER_SERVICE] || manifest.units[TIMER_UNIT] !== hashes[TIMER_UNIT]) fail('续期 timer 已安装但配置不同，请先卸载再安装');
    for (const name of [TIMER_SERVICE, TIMER_UNIT]) {
      const current = await ownedFile(join(directory, name), manifest.units[name], name);
      if (!current) await createOwnedFile(join(directory, name), contents[name]);
    }
  } else {
    for (const name of [TIMER_SERVICE, TIMER_UNIT]) {
      try { await lstat(join(directory, name)); fail(name + ' 已存在且不属于本工具，拒绝覆盖'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let serviceCreated = false, timerCreated = false;
    try {
      await createOwnedFile(join(directory, TIMER_SERVICE), contents[TIMER_SERVICE]); serviceCreated = true;
      await createOwnedFile(join(directory, TIMER_UNIT), contents[TIMER_UNIT]); timerCreated = true;
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, tool: 'dsh-link-ip-certificate', units: hashes }) + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (timerCreated) await rm(join(directory, TIMER_UNIT), { force: true });
      if (serviceCreated) await rm(join(directory, TIMER_SERVICE), { force: true });
      throw error;
    }
  }
  await systemd(['daemon-reload']);
  await systemd(['enable', '--now', TIMER_UNIT]);
}

async function uninstallTimer() {
  const directory = unitDirectory(), manifest = await readTimerManifest(directory);
  if (!manifest) {
    for (const name of [TIMER_SERVICE, TIMER_UNIT]) {
      try { await lstat(join(directory, name)); fail(name + ' 存在但没有本工具归属清单，拒绝删除'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return false;
  }
  for (const name of [TIMER_SERVICE, TIMER_UNIT]) await ownedFile(join(directory, name), manifest.units[name], name);
  await systemd(['disable', '--now', TIMER_UNIT]);
  for (const name of [TIMER_SERVICE, TIMER_UNIT]) await rm(join(directory, name), { force: true });
  await rm(join(directory, TIMER_MANIFEST));
  await systemd(['daemon-reload']);
  return true;
}

async function markRelayReloadPending(root) {
  const path = join(root, 'relay-reload-pending');
  try { await writeFile(path, 'pending\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('中继 reload 标记文件权限或类型无效');
  }
}

async function reloadRelayIfPending(root) {
  const path = join(root, 'relay-reload-pending');
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('中继 reload 标记文件权限或类型无效');
  await systemd(['try-restart', RELAY_UNIT]);
  await rm(path);
  return true;
}

function command(binary, args, { timeout = 20 * 60 * 1000, env = process.env, label = 'Certbot' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(value); };
    const append = (current, data) => (current + data.toString()).slice(-16000);
    child.stdout.on('data', data => { stdout = append(stdout, data); });
    child.stderr.on('data', data => { stderr = append(stderr, data); });
    child.once('error', error => finish(new Error(error.code === 'ENOENT' ? (label === 'Certbot' ? '未找到 Certbot，请先手动安装 Certbot 5.4 或更高版本' : '未找到 ' + label) : label + ' 无法启动：' + error.message)));
    child.once('close', code => code === 0 ? finish(null, { stdout, stderr }) : finish(new Error(label + ' 执行失败（' + code + '）：' + (stderr.trim() || stdout.trim()).slice(-1200))));
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error(label + ' 操作超时')); }, timeout); timer.unref?.();
  });
}

async function certbotVersion(binary) {
  const { stdout, stderr } = await command(binary, ['--version'], { timeout: 15000 });
  const match = (stdout + stderr).match(/certbot\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match || compareVersion(match.slice(1).map(Number), MIN_CERTBOT) < 0) fail('IP webroot 证书需要 Certbot 5.4.0 或更高版本');
  return match.slice(1).join('.');
}
function compareVersion(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

const owned = dir => join(dir, TOOL_DIR);
const markerPath = dir => join(owned(dir), 'managed.json');
async function readMarker(dir) {
  try {
    const path = markerPath(dir), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('证书状态归属标记权限无效');
    const marker = JSON.parse(await readFile(path, 'utf8'));
    if (marker.schemaVersion !== 1 || marker.tool !== 'dsh-link-ip-certificate') fail('证书状态目录归属标记无效');
    return marker;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function ensureOwnedDir(dir) {
  const path = owned(dir);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('证书状态目录必须是仅当前用户可访问的真实目录');
  let marker = await readMarker(dir);
  if (!marker) {
    if ((await readdir(path)).length) fail('证书状态目录已有非本工具数据，拒绝接管');
    marker = { schemaVersion: 1, tool: 'dsh-link-ip-certificate' };
    await writeFile(markerPath(dir), JSON.stringify(marker) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return path;
}

async function saveMarker(stateDir, value) {
  const path = markerPath(stateDir), temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
}

function certbotArgs(operation, config, root, hasLineage = false) {
  const common = ['--non-interactive', '--agree-tos', '--no-eff-email', '--email', config.email, '--config-dir', join(root, 'certbot'), '--work-dir', join(root, 'work'), '--logs-dir', join(root, 'logs')];
  if (operation === 'issue') return ['certonly', '--authenticator', 'webroot', '--webroot-path', config.webroot, '--preferred-challenges', 'http', '--ip-address', config.ip, '--preferred-profile', 'shortlived', '--cert-name', CERT_NAME, ...common];
  if (operation === 'dry-run') return hasLineage
    ? ['renew', '--cert-name', CERT_NAME, '--webroot-path', config.webroot, '--preferred-profile', 'shortlived', '--dry-run', ...common]
    : ['certonly', '--authenticator', 'webroot', '--webroot-path', config.webroot, '--preferred-challenges', 'http', '--ip-address', config.ip, '--preferred-profile', 'shortlived', '--cert-name', CERT_NAME, '--dry-run', ...common];
  return ['renew', '--cert-name', CERT_NAME, '--webroot-path', config.webroot, '--preferred-profile', 'shortlived', ...common];
}

async function readCertificate(certPath, keyPath, ip, { allowExpired = false } = {}) {
  const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
  let certificate;
  try { certificate = new X509Certificate(cert); if (!certificate.checkPrivateKey(createPrivateKey(key))) fail('证书与私钥不匹配'); }
  catch (error) { if (/证书与私钥/.test(error.message)) throw error; fail('Certbot 返回的证书或私钥无效'); }
  if (!certificate.checkIP(ip)) fail('签发证书的 IP 与配置不匹配');
  const notBefore = Date.parse(certificate.validFrom), notAfter = Date.parse(certificate.validTo), now = Date.now();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore > now + 5 * 60_000 || (!allowExpired && notAfter <= now)) fail('证书尚未生效或已经过期');
  return { cert, key, notBefore: new Date(notBefore).toISOString(), notAfter: new Date(notAfter).toISOString(), daysRemaining: Math.floor((notAfter - now) / 86400000), expired: notAfter <= now };
}

async function activePaths(root) {
  const active = join(root, 'active');
  let target;
  try { target = await readlink(active); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('活动证书路径不是本工具创建的链接'); }
  if (!/^releases\/[A-Za-z0-9-]+$/.test(target)) fail('活动证书链接指向状态目录之外');
  const release = join(root, target);
  const actual = await realpath(release).catch(() => fail('活动证书版本目录缺失'));
  if (!actual.startsWith(join(root, 'releases') + '/')) fail('活动证书版本目录越界');
  return { cert: join(actual, 'fullchain.pem'), key: join(actual, 'privkey.pem'), link: target };
}

async function publish(root, data, ip) {
  const releases = join(root, 'releases'); await mkdir(releases, { recursive: true, mode: 0o700 });
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const release = join(releases, id); await mkdir(release, { mode: 0o700 });
  try {
    await writeFile(join(release, 'fullchain.pem'), data.cert, { mode: 0o644, flag: 'wx' });
    await writeFile(join(release, 'privkey.pem'), data.key, { mode: 0o600, flag: 'wx' });
    await writeFile(join(release, 'metadata.json'), JSON.stringify({ ip, notBefore: data.notBefore, notAfter: data.notAfter }) + '\n', { mode: 0o600, flag: 'wx' });
    const active = join(root, 'active'), current = await activePaths(root), temp = join(root, '.active-' + process.pid + '-' + Date.now());
    await symlink('releases/' + id, temp);
    try { await rename(temp, active); } catch (error) { await rm(temp, { force: true }); throw error; }
    return { cert: join(active, 'fullchain.pem'), key: join(active, 'privkey.pem'), release: 'releases/' + id, previous: current?.link };
  } catch (error) { await rm(release, { recursive: true, force: true }); throw error; }
}

function output(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
async function main() {
  const parsed = options(process.argv.slice(2));
  const { operation, values } = parsed;
  if (operation === 'uninstall-timer') {
    output({ state: await uninstallTimer() ? 'timer-removed' : 'timer-not-installed' });
    return;
  }
  const stateDir = await stateDirectory(values['--state-dir'], { create: !['status', 'install-timer'].includes(operation) });
  if (!stateDir) {
    if (operation === 'install-timer') fail('请先成功签发证书，再安装自动续期');
    output({ state: 'not-configured' }); return;
  }
  const root = owned(stateDir), marker = await readMarker(stateDir);
  if (operation === 'install-timer') {
    if (!marker?.config) fail('请先成功签发证书，再安装自动续期');
    const saved = marker.config;
    const config = validateConfig({ ip: saved.ip, email: saved.email, webroot: saved.webroot, stateDir, challengePort: 80, relayPort: saved.relayPort, confirmPublicIp: true, certbot: saved.certbot });
    config.webroot = await existingDirectory(config.webroot, 'webroot', true);
    const paths = await activePaths(root);
    if (!paths) fail('尚无本工具管理的有效证书，请先运行 issue');
    await readCertificate(paths.cert, paths.key, config.ip, { allowExpired: true });
    await installTimer(config, stateDir);
    output({ state: 'timer-installed', timer: TIMER_UNIT, relayUnit: RELAY_UNIT });
    return;
  }
  if (operation === 'status') {
    if (!marker) { output({ state: 'not-configured' }); return; }
    const config = marker.config;
    if (!config) { output({ state: 'not-configured' }); return; }
    const paths = await activePaths(root);
    if (!paths) { output({ state: 'certificate-missing', config }); return; }
    const data = await readCertificate(paths.cert, paths.key, config.ip, { allowExpired: true });
    output({ state: data.expired ? 'expired' : 'ready', ...config, notBefore: data.notBefore, notAfter: data.notAfter, daysRemaining: data.daysRemaining, cert: paths.cert, key: paths.key, renewalRecommended: data.daysRemaining <= 2 });
    return;
  }
  const config = validateConfig({ ip: values['--ip'], email: values['--email'], webroot: values['--webroot'], stateDir, challengePort: portNumber(values['--challenge-port']), relayPort: portNumber(values['--relay-port']), confirmPublicIp: values['--confirm-public-ip'] === 'true', certbot: values['--certbot'] });
  config.webroot = await existingDirectory(config.webroot, 'webroot', true);
  if (operation === 'renew' && (!marker?.config || !(await activePaths(root)))) fail('尚无本工具管理的有效证书，请先运行 issue');
  if (marker?.config && marker.config.ip !== config.ip) fail('同一证书状态目录不能更换 IP，请为新 IP 使用独立状态目录');
  if (marker?.config && operation !== 'issue' && (marker.config.webroot !== config.webroot || marker.config.relayPort !== config.relayPort)) fail('续期配置必须与当前证书的 webroot 和中继端口一致');
  const version = await certbotVersion(config.certbot);
  const managed = await ensureOwnedDir(stateDir);
  if (operation === 'dry-run') {
    let hasLineage = false;
    try { await access(join(managed, 'certbot/live', CERT_NAME, 'fullchain.pem')); hasLineage = true; } catch {}
    await command(config.certbot, certbotArgs('dry-run', config, managed, hasLineage));
    await saveMarker(stateDir, { schemaVersion: 1, tool: 'dsh-link-ip-certificate', certbot: version, config: { ip: config.ip, email: config.email, webroot: config.webroot, challengePort: 80, relayPort: config.relayPort, certbot: config.certbot } });
    output({ state: 'dry-run-passed', certbot: version, challenge: 'http-01', challengePort: 80, relayPort: config.relayPort });
    return;
  }
  const previousPaths = operation === 'renew' ? await activePaths(root) : null;
  const previous = previousPaths ? await readCertificate(previousPaths.cert, previousPaths.key, config.ip, { allowExpired: true }) : null;
  await mkdir(join(managed, 'certbot'), { recursive: true, mode: 0o700 });
  await mkdir(join(managed, 'work'), { recursive: true, mode: 0o700 });
  await mkdir(join(managed, 'logs'), { recursive: true, mode: 0o700 });
  await command(config.certbot, certbotArgs(operation, config, managed));
  const raw = await readCertificate(join(managed, 'certbot/live', CERT_NAME, 'fullchain.pem'), join(managed, 'certbot/live', CERT_NAME, 'privkey.pem'), config.ip);
  const changed = operation === 'issue' || !previous || previous.cert !== raw.cert || previous.key !== raw.key;
  if (!changed) {
    if (values['--restart-relay-unit']) await reloadRelayIfPending(root);
    output({ state: 'ready', changed: false, certbot: version, challenge: 'http-01', challengePort: 80, relayPort: config.relayPort, ip: config.ip, notBefore: raw.notBefore, notAfter: raw.notAfter, daysRemaining: raw.daysRemaining, cert: previousPaths.cert, key: previousPaths.key });
    return;
  }
  const nextMarker = { schemaVersion: 1, tool: 'dsh-link-ip-certificate', certbot: version, config: { ip: config.ip, email: config.email, webroot: config.webroot, challengePort: 80, relayPort: config.relayPort, certbot: config.certbot } };
  await saveMarker(stateDir, nextMarker);
  const published = await publish(managed, raw, config.ip);
  if (values['--restart-relay-unit']) {
    await markRelayReloadPending(root);
    await reloadRelayIfPending(root);
  }
  output({ state: 'ready', changed: true, certbot: version, challenge: 'http-01', challengePort: 80, relayPort: config.relayPort, ip: config.ip, notBefore: raw.notBefore, notAfter: raw.notAfter, daysRemaining: raw.daysRemaining, cert: published.cert, key: published.key });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write((error?.message ?? '证书操作失败') + '\n'); process.exitCode = 1; });
}
