import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { openDeviceRegistry, normalizeTarget } from './registry.mjs';
import { remoteJson } from './remote.mjs';
import { createDeviceProxy } from './proxy.mjs';
import { createServerManager } from '../server/manager.mjs';
const secret = () => randomBytes(32).toString('base64url');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('需要 application/json', 415);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) throw fail('请求过大', 413); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('请求必须是对象'); return input;
}
export async function createDeviceCenter({ directory, webRoot, managerFactory = createServerManager }) {
  const registry = await openDeviceRegistry(directory), pending = new Map(), proxies = new Map(), tickets = new Map(), sessions = new Map(), parents = new Set(), sockets = new Set();
  let origin, closed = false;
  const manager = await managerFactory({ directory, runtimeRoot: new URL('../server/', webRoot), onDevice: async device => {
    if (device.status === 'offline') { try { registry.mark(device.id, 'offline', device.lastError); } catch {} return; }
    const proxy = proxies.get(device.id); if (proxy) { proxies.delete(device.id); await proxy.close(); }
    return registry.upsert(device);
  } });
  const idOf = input => input.deviceId || input.targetId || input.id;
  const api = async input => {
    const id = idOf(input);
    if (input.action === 'list') return { ...registry.list(), capabilities: { ssh: Boolean(manager) } };
    if (input.action === 'pair') {
      for (const [key, item] of pending) if (item.expiresAt < Date.now()) pending.delete(key);
      if (pending.size >= 16) throw fail('配对请求过多');
      const uri = new URL(input.uri);
      if (uri.protocol !== 'dshlink:' || uri.hostname !== 'pair') throw fail('请粘贴完整 Link 配对地址');
      const target = normalizeTarget({ url: uri.searchParams.get('url'), pin: uri.searchParams.get('pin') });
      const code = uri.searchParams.get('code'); if (!code || code.length > 256) throw fail('配对码无效');
      const { value } = await remoteJson(target, '/link/api/pair', { code, name: input.name || hostname().slice(0, 100) });
      const requestId = randomUUID();
      pending.set(requestId, { ...target, remote: value, expiresAt: Math.min(value.expiresAt || Date.now() + 300000, Date.now() + 300000) });
      return { requestId, expiresAt: value.expiresAt };
    }
    if (input.action === 'pairStatus') {
      const pair = pending.get(input.requestId); if (!pair || pair.expiresAt < Date.now()) { pending.delete(input.requestId); throw fail('配对已过期，请重新扫码'); }
      if (pair.device) return { status: 'approved', device: pair.device };
      const { value } = await remoteJson(pair, '/link/api/pair/status', { requestId: pair.remote.requestId, pollToken: pair.remote.pollToken });
      if (value.status !== 'approved') return { status: value.status };
      pair.device = await registry.upsert({ ...pair, remote: undefined, token: value.token, kind: 'computer', name: new URL(pair.url).hostname });
      return { status: 'approved', device: pair.device };
    }
    if (input.action === 'select') {
      if (id === 'local') return { device: await registry.select(id), url: null };
      const target = registry.get(id);
      let proxy = proxies.get(id);
      try {
        if (!proxy) { proxy = await createDeviceProxy(target, { webRoot, parentOrigin: [origin, ...parents].join(' '), onFailure: error => registry.mark(id, 'offline', error.message) }); proxies.set(id, proxy); }
        const url = await proxy.enter(); registry.mark(id, 'online'); return { device: await registry.select(id), url };
      } catch (error) { registry.mark(id, 'offline', error.message); throw error; }
    }
    if (input.action === 'rename') return { device: await registry.rename(id, input.name) };
    if (input.action === 'remove') { await registry.remove(id); const proxy = proxies.get(id); proxies.delete(id); await proxy?.close(); await manager?.disconnect?.(id); return { ok: true }; }
    if (!manager) throw fail('此客户端不支持 SSH，请更新应用');
    if (input.action === 'sshProbe') return manager.probe(input);
    if (input.action === 'sshConnect') return manager.connect(input);
    if (input.action === 'job') return manager.job(input.jobId || input.id);
    if (input.action === 'reconnect') return manager.reconnect({ ...input, id, device: registry.get(id) });
    if (input.action === 'serverAction') return manager.manage({ ...input, id, device: registry.get(id) });
    throw fail('不支持的操作');
  };
  const server = createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    try {
      if (closed || req.headers.host !== new URL(origin).host) throw fail('本机设备地址无效', 403);
      const url = new URL(req.url, origin);
      if (url.pathname === '/enter' && req.method === 'GET') {
        const ticket = url.searchParams.get('ticket'), value = tickets.get(ticket); tickets.delete(ticket);
        if (!value || value.expires < Date.now()) throw fail('设备入口已过期，请从侧栏重新打开', 401);
        const token = secret(); sessions.set(token, value.parentOrigin); if (sessions.size > 16) sessions.delete(sessions.keys().next().value);
        if (value.parentOrigin) parents.add(value.parentOrigin);
        res.writeHead(303, { ...headers, location: '/s/' + token + '/' }); res.end(); return;
      }
      const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{43})(\/.*)$/);
      if (!match || !sessions.has(match[1])) throw fail('设备中心未授权', 401);
      url.pathname = match[2];
      if (url.pathname === '/device-config.js' && req.method === 'GET') {
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }); res.end('globalThis.__DSH_DEVICE_CENTER__=true;globalThis.__DSH_DEVICE_PARENT_ORIGIN__=' + JSON.stringify(sessions.get(match[1])) + ';'); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/devices') {
        if (req.headers.origin !== origin) throw fail('来源未授权', 403);
        const value = await api(await body(req)); res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return;
      }
      if (req.method !== 'GET') throw fail('不支持的方法', 405);
      const file = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' }[url.pathname];
      if (!file) throw fail('未找到', 404);
      let data = await readFile(new URL(file, webRoot));
      if (file === 'index.html') data = Buffer.from(data.toString().replace('<head>', '<head><script src="./device-config.js"></script>'));
      const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src http://127.0.0.1:*; connect-src 'self'; frame-ancestors " + ([...parents, 'dsh-app:'].join(' ')) + "; base-uri 'none'; form-action 'self'";
      res.writeHead(200, { ...headers, 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', 'content-security-policy': policy }); res.end(data);
    } catch (error) { if (!res.headersSent) res.writeHead(error.status || 400, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin, api,
    launch(parentOrigin) { for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key); const ticket = secret(); tickets.set(ticket, { expires: Date.now() + 60000, parentOrigin }); return { url: origin + '/enter?ticket=' + ticket }; },
    async close() { closed = true; tickets.clear(); sessions.clear(); await Promise.all([...proxies.values()].map(proxy => proxy.close())); await manager?.close(); await registry.flush(); const done = new Promise(resolve => server.close(resolve)); sockets.forEach(socket => socket.destroy()); await done; },
  };
}
