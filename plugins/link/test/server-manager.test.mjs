import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ssh2 from 'ssh2';
import { createServerManager, fingerprintOf, validateSshInput, shellQuote, redactServerLog, openSshTunnel, execute } from '../src/server/manager.mjs';
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-server-manager-'));
  const clients = new Set(); let authentications = 0;
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => { authentications++; context.method === 'password' && context.password === 'secret' ? context.accept() : context.reject(); });
    client.on('ready', () => {
      client.on('session', accept => { const session = accept(); session.on('exec', (accept, _reject, info) => { const stream = accept(); if (info.command === 'test echo') { stream.write('stdout'); stream.stderr.write('stderr'); stream.exit(0); stream.end(); } else { stream.stderr.write('expected-install-failure'); stream.exit(1); stream.end(); } }); });
      client.on('tcpip', (accept, _reject, info) => { const stream = accept(); const socket = tcpConnect(info.destPort, info.destIP); socket.on('error', () => stream.destroy()); stream.on('error', () => socket.destroy()); stream.on('close', () => socket.destroy()); socket.pipe(stream).pipe(socket); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = createServerManager({ directory, ...options });
  t.after(async () => { await manager.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, manager, input: { host: '127.0.0.1', port: server.address().port, username: 'tester' }, authentications: () => authentications };
}
async function completed(manager, id) { for (let i = 0; i < 100; i++) { const value = await manager.job(id); if (value.state !== 'running') return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('job did not settle'); }
test('input validation preserves host values and rejects shell and malformed addresses', () => {
  for (const host of ['127.0.0.1', '::1', 'node.example.com']) assert.equal(validateSshInput({ host, username: 'user' }).host, host);
  for (const host of ['a; touch /tmp/pwn', '-oProxyCommand=x', 'https://host', 'a\nlocalhost']) assert.throws(() => validateSshInput({ host, username: 'user' }));
  assert.throws(() => validateSshInput({ host: 'host', username: 'user', port: 65536 }));
  assert.throws(() => validateSshInput({ host: 'host', username: 'user' }, { credentials: true }), /指纹/);
  const input = "a'b $(touch /tmp/not-run)";
  assert.equal(spawnSync('sh', ['-c', 'printf %s ' + shellQuote(input)], { encoding: 'utf8' }).stdout, input);
});
test('probe returns SSH SHA256 fingerprint before attempting any authentication', async t => {
  const f = await fixture(t); const result = await f.manager.probe(f.input);
  assert.match(result.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.authentications(), 0);
});
test('host fingerprint mismatch blocks password authentication and returns a failed job', async t => {
  const f = await fixture(t);
  const { jobId } = await f.manager.connect({ ...f.input, fingerprint: 'SHA256:' + 'A'.repeat(43), password: 'secret' });
  const job = await completed(f.manager, jobId); assert.equal(job.state, 'error'); assert.match(job.error, /指纹/); assert.equal(f.authentications(), 0); assert(!JSON.stringify(job).includes('secret'));
});
test('valid fingerprint authenticates but failed install neither persists nor returns a token', async t => {
  const f = await fixture(t); const { fingerprint } = await f.manager.probe(f.input);
  const { jobId } = await f.manager.connect({ ...f.input, fingerprint, password: 'secret' });
  const job = await completed(f.manager, jobId); assert.equal(job.state, 'error'); assert.equal(f.authentications(), 1); assert(!job.device); assert(!JSON.stringify(job).includes('secret'));
  await assert.rejects(readFile(join(f.directory, 'servers.json')), { code: 'ENOENT' });
});
test('real SSH execution and local-only tunnel carry independent streams', async t => {
  const f = await fixture(t); const { fingerprint } = await f.manager.probe(f.input);
  const client = new ssh2.Client(); client.on('error', () => {});
  await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ ...f.input, password: 'secret', hostVerifier: key => fingerprintOf(key) === fingerprint }); });
  const echo = createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); }); await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const tunnel = await openSshTunnel(client, echo.address().port);
  t.after(async () => { await tunnel.close(); client.end(); await new Promise(resolve => echo.close(resolve)); });
  assert.equal(new URL(tunnel.url).hostname, '127.0.0.1');
  const result = await execute(client, 'test echo'); assert.deepEqual(result, { code: 0, stdout: 'stdout', stderr: 'stderr' });
  const socket = tcpConnect(Number(new URL(tunnel.url).port), '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.once('connect', resolve); });
  const value = randomUUID(); const received = new Promise(resolve => socket.once('data', data => resolve(data.toString()))); socket.write(value); assert.equal(await received, value); socket.destroy();
});
test('saved servers reopen offline; disconnect removes private record without deleting host data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-server-saved-'));
  await writeFile(join(directory, 'servers.json'), JSON.stringify([{ id: 'device', kind: 'ssh', name: 'old', token: 'device-token', url: 'https://127.0.0.1:1234', ssh: { host: '127.0.0.1', username: 'user', port: 22, fingerprint: 'SHA256:' + 'A'.repeat(43) } }]), { mode: 0o600 });
  const manager = createServerManager({ directory });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(manager.manage({ id: 'device', operation: 'stop' }), /重新连接/);
  await manager.disconnect('device'); assert.deepEqual(JSON.parse(await readFile(join(directory, 'servers.json'))), []); assert.equal((await stat(join(directory, 'servers.json'))).mode & 0o777, 0o600);
});
test('server logs redact credentials, bearer, URL and private JSON fields', () => {
  const text = redactServerLog('Bearer abc-123 https://host/?token=hidden&code=paired {"token":"json-secret","password":"pass"} private-key-value', ['private-key-value']);
  for (const value of ['abc-123', 'hidden', 'paired', 'json-secret', 'pass"', 'private-key-value']) assert(!text.includes(value), value);
});
