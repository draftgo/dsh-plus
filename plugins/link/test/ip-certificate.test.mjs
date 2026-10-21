import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../scripts/ip-certificate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/ip-certificate.mjs');
const require = createRequire(join(root, 'package.json'));
const selfsigned = require('selfsigned');
const signed = selfsigned.generate([{ name: 'commonName', value: '8.8.8.8' }], { keySize: 2048, days: 30, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '8.8.8.8' }] }] });
const fixtureKey = signed.private;
const fixtureCert = signed.cert;
const renewed = selfsigned.generate([{ name: 'commonName', value: 'renewed 8.8.8.8' }], { keySize: 2048, days: 30, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '8.8.8.8' }] }] });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ip-cert-'));
  const stateDir = join(directory, 'state'), webroot = join(directory, 'webroot');
  await mkdir(webroot);
  const argsFile = join(directory, 'certbot-args.json');
  const systemctlLog = join(directory, 'systemctl-args.jsonl');
  const fake = join(directory, 'certbot ; echo injection');
  const systemctl = join(directory, 'systemctl');
const source = `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('certbot ' + (process.env.CERTBOT_TEST_VERSION || '5.4.1') + '\\n'); process.exit(0); }
await writeFile(process.env.CERTBOT_TEST_ARGS, JSON.stringify(args));
if ((process.env.CERTBOT_TEST_FAIL === '1' || process.env.CERTBOT_TEST_INVALID === '1') && args[0] === 'renew') {
  const get = key => args[args.indexOf(key) + 1];
  const live = join(get('--config-dir'), 'live', get('--cert-name'));
  await mkdir(live, { recursive: true });
  await writeFile(join(live, 'fullchain.pem'), process.env.CERTBOT_TEST_INVALID === '1' ? 'invalid certificate' : 'partially-updated invalid lineage');
  if (process.env.CERTBOT_TEST_INVALID === '1') process.exit(0);
  process.stderr.write('simulated renewal failure'); process.exit(1);
}
if (args.includes('--dry-run')) process.exit(0);
const get = key => args[args.indexOf(key) + 1];
const live = join(get('--config-dir'), 'live', get('--cert-name'));
await mkdir(live, { recursive: true });
await writeFile(join(live, 'fullchain.pem'), process.env.CERTBOT_TEST_CERT);
await writeFile(join(live, 'privkey.pem'), process.env.CERTBOT_TEST_KEY);
`;
const systemctlSource = `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--property=LoadState')) process.stdout.write(existsSync(join(process.env.XDG_CONFIG_HOME, 'systemd', 'user', args.at(-1))) ? 'loaded\\n' : 'not-found\\n');
await writeFile(process.env.SYSTEMCTL_TEST_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n', { flag: 'a' });
if (process.env.SYSTEMCTL_TEST_FAIL === '1') process.exit(1);
`;
  await writeFile(fake, source, { mode: 0o700 }); await chmod(fake, 0o700);
  await writeFile(systemctl, systemctlSource, { mode: 0o700 }); await chmod(systemctl, 0o700);
  const env = { ...process.env, CERTBOT_TEST_ARGS: argsFile, CERTBOT_TEST_CERT: fixtureCert, CERTBOT_TEST_KEY: fixtureKey, SYSTEMCTL_TEST_ARGS: systemctlLog, XDG_CONFIG_HOME: join(directory, 'xdg'), PATH: directory + delimiter + (process.env.PATH ?? '') };
  const invoke = (operation, extra = {}, extraEnv = {}) => {
    const options = operation === 'uninstall-timer' ? {}
      : ['status', 'install-timer'].includes(operation) ? { '--state-dir': stateDir, ...extra }
        : { '--state-dir': stateDir, '--certbot': fake, '--ip': '8.8.8.8', '--email': 'admin@example.com', '--webroot': webroot, '--challenge-port': '80', '--relay-port': '24680', '--confirm-public-ip': 'true', ...extra };
    const flags = Object.entries(options).flatMap(([key, value]) => [key, String(value)]);
    return spawnSync(process.execPath, [script, operation, ...flags], { cwd: directory, encoding: 'utf8', env: { ...env, ...extraEnv } });
  };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, stateDir, webroot, argsFile, systemctlLog, unitDir: join(env.XDG_CONFIG_HOME, 'systemd', 'user'), invoke };
}

test('IP and listener configuration accepts public addresses and rejects unsafe ranges and ports', () => {
  const base = { ip: '8.8.8.8', email: 'admin@example.com', webroot: '/tmp/webroot', stateDir: '/tmp/state', challengePort: 80, relayPort: 24680, confirmPublicIp: true };
  assert.equal(validateConfig(base).family, 4);
  assert.equal(validateConfig({ ...base, ip: '2606:4700:4700::1111' }).family, 6);
  for (const ip of ['example.com', '127.0.0.1', '10.0.0.2', '192.0.2.3', '::1', 'fd00::1', '2001:db8::1', '3fff::1']) assert.throws(() => validateConfig({ ...base, ip }));
  assert.throws(() => validateConfig({ ...base, confirmPublicIp: false }), /确认/);
  assert.throws(() => validateConfig({ ...base, challengePort: 8443 }), /80/);
  for (const relayPort of [22, 443, 8080, 19999, 49152, 65535]) assert.throws(() => validateConfig({ ...base, relayPort }));
});

test('issue uses Certbot argv, publishes a matching cert atomically, and never prints the private key', async t => {
  const f = await fixture(t), suspiciousWebroot = join(f.directory, 'webroot; touch shell-pwn');
  await mkdir(suspiciousWebroot);
  const result = f.invoke('issue', { '--webroot': suspiciousWebroot });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.state, 'ready'); assert.equal(value.changed, true); assert.equal(value.challengePort, 80); assert.equal(value.relayPort, 24680);
  assert(!result.stdout.includes(fixtureKey)); assert(!result.stderr.includes(fixtureKey));
  const args = JSON.parse(await readFile(f.argsFile, 'utf8'));
  assert.equal(args[0], 'certonly'); assert(args.includes('--ip-address')); assert(args.includes('8.8.8.8'));
  assert.equal(args[args.indexOf('--preferred-profile') + 1], 'shortlived');
  assert.equal(args[args.indexOf('--webroot-path') + 1], suspiciousWebroot);
  assert(!args.includes('--standalone')); assert(!args.includes('--nginx'));
  await assert.rejects(readFile(join(f.directory, 'shell-pwn')), { code: 'ENOENT' });
  const stateRoot = join(f.stateDir, 'dsh-link-ip-certificate');
  const first = await readlink(join(stateRoot, 'active'));
  const savedKey = await readFile(join(stateRoot, first, 'privkey.pem'), 'utf8'); assert.equal(savedKey, fixtureKey);
  const status = f.invoke('status'); assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, 'ready'); assert(!status.stdout.includes(fixtureKey));
});

test('first dry-run uses certonly and does not publish a certificate', async t => {
  const f = await fixture(t);
  const result = f.invoke('dry-run'); assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(await readFile(f.argsFile, 'utf8'));
  assert.equal(args[0], 'certonly'); assert(args.includes('--dry-run')); assert.equal(args[args.indexOf('--preferred-profile') + 1], 'shortlived');
  const status = f.invoke('status'); assert.equal(JSON.parse(status.stdout).state, 'certificate-missing');
});

test('status on an absent explicit state directory is read-only', async t => {
  const f = await fixture(t);
  const result = f.invoke('status'); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { state: 'not-configured' });
  await assert.rejects(readFile(join(f.stateDir, 'dsh-link-ip-certificate', 'managed.json')), { code: 'ENOENT' });
});

test('failed renewal leaves the active certificate version and bytes untouched', async t => {
  const f = await fixture(t);
  const issued = f.invoke('issue'); assert.equal(issued.status, 0, issued.stderr);
  const active = join(f.stateDir, 'dsh-link-ip-certificate', 'active');
  const beforeLink = await readlink(active), beforeKey = await readFile(join(active, 'privkey.pem'), 'utf8');
  const failed = f.invoke('renew', { '--restart-relay-unit': 'dsh-link-relay.service' }, { CERTBOT_TEST_FAIL: '1' });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /Certbot 执行失败/);
  assert.equal(await readlink(active), beforeLink); assert.equal(await readFile(join(active, 'privkey.pem'), 'utf8'), beforeKey);
  await assert.rejects(readFile(f.systemctlLog, 'utf8'), { code: 'ENOENT' });
  const status = f.invoke('status'); assert.equal(JSON.parse(status.stdout).state, 'ready');
});

test('successful Certbot exit with mismatched output also leaves the active certificate untouched', async t => {
  const f = await fixture(t);
  const issued = f.invoke('issue'); assert.equal(issued.status, 0, issued.stderr);
  const active = join(f.stateDir, 'dsh-link-ip-certificate', 'active');
  const beforeLink = await readlink(active), beforeKey = await readFile(join(active, 'privkey.pem'), 'utf8');
  const failed = f.invoke('renew', {}, { CERTBOT_TEST_INVALID: '1' });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /证书或私钥无效/);
  assert.equal(await readlink(active), beforeLink); assert.equal(await readFile(join(active, 'privkey.pem'), 'utf8'), beforeKey);
});

test('Certbot older than 5.4 is rejected before certificate state is created', async t => {
  const f = await fixture(t);
  const result = f.invoke('dry-run', {}, { CERTBOT_TEST_VERSION: '5.3.0' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /5\.4\.0 或更高/);
  await assert.rejects(readFile(join(f.stateDir, 'dsh-link-ip-certificate', 'managed.json')), { code: 'ENOENT' });
});

test('unchanged renewal does not publish a release or restart the relay', async t => {
  const f = await fixture(t), issued = f.invoke('issue'); assert.equal(issued.status, 0, issued.stderr);
  const active = join(f.stateDir, 'dsh-link-ip-certificate', 'active'), before = await readlink(active);
  const result = f.invoke('renew', { '--restart-relay-unit': 'dsh-link-relay.service' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).changed, false);
  assert.equal(await readlink(active), before);
  await assert.rejects(readFile(f.systemctlLog, 'utf8'), { code: 'ENOENT' });
});

test('changed renewal restarts only the fixed relay service and retries a failed restart', async t => {
  const f = await fixture(t), issued = f.invoke('issue'); assert.equal(issued.status, 0, issued.stderr);
  const active = join(f.stateDir, 'dsh-link-ip-certificate', 'active'), old = await readlink(active);
  const failedRestart = f.invoke('renew', { '--restart-relay-unit': 'dsh-link-relay.service' }, { CERTBOT_TEST_CERT: renewed.cert, CERTBOT_TEST_KEY: renewed.private, SYSTEMCTL_TEST_FAIL: '1' });
  assert.notEqual(failedRestart.status, 0); assert.notEqual(await readlink(active), old);
  assert.equal(await readFile(join(f.stateDir, 'dsh-link-ip-certificate', 'relay-reload-pending'), 'utf8'), 'pending\n');
  const retry = f.invoke('renew', { '--restart-relay-unit': 'dsh-link-relay.service' }, { CERTBOT_TEST_CERT: renewed.cert, CERTBOT_TEST_KEY: renewed.private });
  assert.equal(retry.status, 0, retry.stderr); assert.equal(JSON.parse(retry.stdout).changed, false);
  await assert.rejects(readFile(join(f.stateDir, 'dsh-link-ip-certificate', 'relay-reload-pending'), 'utf8'), { code: 'ENOENT' });
  const calls = (await readFile(f.systemctlLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [['--user', 'try-restart', 'dsh-link-relay.service'], ['--user', 'try-restart', 'dsh-link-relay.service']]);
});

test('timer installation and removal manage only owned units and never remove the relay service', async t => {
  const f = await fixture(t), issued = f.invoke('issue'); assert.equal(issued.status, 0, issued.stderr);
  await mkdir(f.unitDir, { recursive: true });
  const relayUnit = join(f.unitDir, 'dsh-link-relay.service'), relayContents = '[Service]\nExecStart=/usr/bin/node relay.js\n';
  await writeFile(relayUnit, relayContents);
  const installed = f.invoke('install-timer'); assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).state, 'timer-installed');
  const service = await readFile(join(f.unitDir, 'dsh-link-ip-certificate-renew.service'), 'utf8');
  const timer = await readFile(join(f.unitDir, 'dsh-link-ip-certificate-renew.timer'), 'utf8');
  assert.match(service, /--restart-relay-unit.*dsh-link-relay\.service/);
  assert.match(service, /--state-dir/); assert.match(timer, /OnCalendar=daily/); assert.match(timer, /Persistent=true/);
  const installedCalls = (await readFile(f.systemctlLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(installedCalls, [['--user', 'show', '--property=LoadState', '--value', 'dsh-link-relay.service'], ['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'dsh-link-ip-certificate-renew.timer']]);
  const removed = f.invoke('uninstall-timer'); assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).state, 'timer-removed');
  await assert.rejects(readFile(join(f.unitDir, 'dsh-link-ip-certificate-renew.service'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(relayUnit, 'utf8'), relayContents);
  const allCalls = (await readFile(f.systemctlLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(allCalls.slice(-2), [['--user', 'disable', '--now', 'dsh-link-ip-certificate-renew.timer'], ['--user', 'daemon-reload']]);
  assert(!allCalls.some(args => ['enable', 'disable', 'try-restart', 'stop', 'restart'].includes(args[1]) && args.includes('dsh-link-relay.service')));
});

test('timer installation refuses to overwrite an unrelated same-name unit', async t => {
  const f = await fixture(t), issued = f.invoke('issue'); assert.equal(issued.status, 0, issued.stderr);
  await mkdir(f.unitDir, { recursive: true });
  await writeFile(join(f.unitDir, 'dsh-link-relay.service'), '[Service]\nExecStart=/usr/bin/node relay.js\n');
  const path = join(f.unitDir, 'dsh-link-ip-certificate-renew.service'), contents = '[Service]\nExecStart=/bin/true\n';
  await writeFile(path, contents);
  const result = f.invoke('install-timer');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /拒绝覆盖/);
  assert.equal(await readFile(path, 'utf8'), contents);
  await assert.rejects(readFile(join(f.unitDir, 'dsh-link-ip-certificate-renew.timer'), 'utf8'), { code: 'ENOENT' });
});
