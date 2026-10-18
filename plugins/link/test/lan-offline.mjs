// Opt-in Linux integration: two isolated network namespaces, no default route,
// DNS or Internet. Run: node plugins/link/test/lan-offline.mjs (CAP_NET_ADMIN).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { connectionAddresses, listen } from '../src/transport/server.mjs';

const file = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--isolated') {
  const result = spawnSync('unshare', ['--net', process.execPath, file, '--isolated'], { stdio: 'inherit', timeout: 30_000 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const ip = (...args) => {
  const result = spawnSync('ip', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `ip ${args.join(' ')} failed`);
  return result.stdout;
};
const directory = await mkdtemp(join(tmpdir(), 'link-offline-lan-'));
const clientCode = String.raw`
  const {execFileSync} = require('node:child_process');
  const {request} = require('node:https');
  const {createHash} = require('node:crypto');
  execFileSync('ip', ['link','set','lo','up']);
  process.stdout.write('ready\n');
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const input = JSON.parse(line);
      if (input.configure) {
        execFileSync('ip',['addr','add','192.168.82.2/24','dev','link-phone']);
        execFileSync('ip',['link','set','link-phone','up']);
        process.stdout.write(JSON.stringify({id:input.id, route:execFileSync('ip',['route','show','default'],{encoding:'utf8'})})+'\n');
        continue;
      }
      const req = request(input.url + input.path, {
        method:'POST',ca:input.ca,agent:false,timeout:3000,
        headers:{'content-type':'application/json',...(input.token?{authorization:'Bearer '+input.token}:{})},
        checkServerIdentity(hostname,cert) {
          const pin=createHash('sha256').update(cert.pubkey).digest('base64');
          if(pin!==input.pin)return Error('SPKI mismatch');
        }
      }, res => {let bytes='';res.on('data',chunk=>bytes+=chunk);res.on('end',()=>process.stdout.write(JSON.stringify({id:input.id,status:res.statusCode,body:JSON.parse(bytes)})+'\n'));});
      req.on('timeout',()=>req.destroy(Error('timeout')));
      req.on('error',error=>process.stdout.write(JSON.stringify({id:input.id,error:error.message})+'\n'));
      req.end(JSON.stringify(input.body||{}));
    }
  });
`;
let server, client;
try {
  ip('link', 'set', 'lo', 'up');
  assert.equal(ip('route', 'show', 'default'), '');
  client = spawn('unshare', ['--net', process.execPath, '-e', clientCode], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, output = '', errors = '';
  const pending = new Map();
  client.stderr.on('data', chunk => { errors += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`Phone namespace startup timed out: ${errors}`)), 5000);
    client.once('exit', code => { clearTimeout(timeout); reject(Error(`Phone namespace exited ${code}: ${errors}`)); });
    client.stdout.on('data', chunk => {
      output += chunk;
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (line === 'ready') { clearTimeout(timeout); resolve(); continue; }
        const value = JSON.parse(line), request = pending.get(value.id);
        if (request) { clearTimeout(request.timer); pending.delete(value.id); request.resolve(value); }
      }
    });
  });
  await ready;
  ip('link', 'add', 'link-host', 'type', 'veth', 'peer', 'name', 'link-phone');
  ip('link', 'set', 'link-phone', 'netns', String(client.pid));
  ip('addr', 'add', '192.168.82.1/24', 'dev', 'link-host');
  ip('link', 'set', 'link-host', 'up');
  const request = input => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Phone request timed out')); }, 5000);
    pending.set(id, { resolve, timer }); client.stdin.write(JSON.stringify({ ...input, id }) + '\n');
  });
  assert.equal((await request({ configure: true })).route, '');
  assert.deepEqual(connectionAddresses('0.0.0.0'), ['192.168.82.1']);
  const identity = await loadIdentity(directory), store = await openStore(directory);
  server = await listen({ identity, config: { host: '0.0.0.0', port: 0, publicUrl: '' }, webRoot: new URL('../dist/web/', import.meta.url), store, dispatch: async input => ({ action: input.action, offline: true }), onError: error => { throw error; } });
  const remote = (path, body, token, pin = identity.pin) => request({ url: `https://192.168.82.1:${server.port}`, path: '/link/api/' + path, body, token, pin, ca: identity.cert });
  const code = store.begin();
  assert.match((await remote('pair', {}, undefined, 'wrong-pin')).error, /SPKI mismatch/);
  const pair = await remote('pair', { code: code.code, name: 'Offline LAN phone' });
  assert.equal(pair.status, 200);
  assert.equal((await remote('pair/status', pair.body)).body.status, 'pending');
  await store.decide(pair.body.requestId, true);
  const approved = (await remote('pair/status', pair.body)).body;
  assert.equal(approved.status, 'approved');
  assert.deepEqual((await remote('rpc', { action: 'state' }, approved.token)).body, { action: 'state', offline: true });
  await store.revoke(approved.deviceId);
  assert.equal((await remote('rpc', { action: 'state' }, approved.token)).status, 401);
  await store.flush();
  console.log('Offline LAN passed: 192.168.82.2 → 192.168.82.1; no default routes; TLS/SPKI mismatch rejection, pair, desktop approval, authenticated RPC and revoke.');
} finally {
  await server?.close();
  if (client && client.exitCode === null) { client.kill('SIGTERM'); await new Promise(resolve => client.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true });
}
