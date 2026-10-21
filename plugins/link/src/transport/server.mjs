import { createSecureServer } from 'node:http2';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

export const localAddresses = () => [...new Set(Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(x => !x.internal && !x.address.includes('%')).map(x => x.address)))];

// Discovery is deliberately narrower than the HTTP Host allowlist: container
// networks and IPv6 link-local addresses are not useful phone pairing targets.
const virtualInterface = /^(?:docker\d+|br-[0-9a-f]+|veth.*|virbr\d+(?:-nic)?|vboxnet\d+|vmnet\d+|cni\d+|flannel.*|podman\d+)$|^vEthernet \((?:Default Switch|WSL.*|Docker.*)\)$/i;
export function connectionAddresses(host = '::', interfaces = networkInterfaces()) {
  if (host !== '0.0.0.0' && host !== '::') return [host];
  const ipv4 = new Set(), ipv6 = new Set();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (virtualInterface.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || entry.address.includes('%')) continue;
      const family = isIP(entry.address);
      if (family === 4) {
        const [a, b] = entry.address.split('.').map(Number);
        if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) continue;
        ipv4.add(entry.address);
      } else if (family === 6 && host === '::') {
        const address = new URL(`https://[${entry.address}]`).hostname.slice(1, -1);
        if (address === '::' || address === '::1' || /^fe[89ab][0-9a-f]:|^ff/i.test(address)) continue;
        ipv6.add(address);
      }
    }
  }
  const privateIpv4 = address => {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  };
  return [...[...ipv4].filter(privateIpv4), ...[...ipv4].filter(address => !privateIpv4(address)), ...ipv6];
}
export const authority = (address, port) => `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;

export function validateConfig(input, prior) {
  const value = { ...prior };
  for (const key of ['enabled', 'host', 'port', 'publicUrl']) if (input[key] !== undefined) value[key] = input[key];
  if (typeof value.enabled !== 'boolean') throw new Error('启用状态必须是布尔值');
  if (!isIP(value.host) && value.host !== 'localhost') throw new Error('监听地址必须是 IP 或 localhost');
  if (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535) throw new Error('端口必须在 0 至 65535 之间');
  if (typeof value.publicUrl !== 'string') throw new Error('公网地址无效');
  value.publicUrl = value.publicUrl.trim().replace(/\/$/, '');
  if (value.publicUrl) {
    const url = new URL(value.publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请输入 HTTPS 公网地址，例如 https://desk.example.com，不包含子路径');
    value.publicUrl = url.origin;
  }
  return value;
}

const headers = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw fail('需要 application/json', 415);
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw fail('请求过大', 413);
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('请求必须是对象');
  return input;
}

/** Separate encrypted carrier: it exposes only Link's allowlist, never the Host admin API. */
export async function listen({ identity, config, webRoot, store, dispatch, workbench, onError }) {
  const rates = new Map();
  const sockets = new Set(), sessions = new Set();
  let active = true;
  const send = (response, status, value, type = 'application/json; charset=utf-8') => {
    if (response.destroyed) return;
    response.writeHead(status, { ...headers, 'content-type': type });
    response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
  };
  const authorize = (req, requireOrigin = false) => {
    if (!active) throw fail('Link 已关闭', 503);
    const publicHost = config.publicUrl ? new URL(config.publicUrl).host : undefined;
    const allowed = new Set(['localhost', '127.0.0.1', '::1', ...localAddresses(), config.host].map(a => authority(a, server.address().port)));
    if (publicHost) allowed.add(publicHost);
    const host = req.headers[':authority'] || req.headers.host;
    if (req.headers.host && req.headers[':authority'] && req.headers.host !== req.headers[':authority']) throw fail('主机地址不一致', 403);
    if (!host || !allowed.has(host)) throw fail('主机地址未授权', 403);
    if ((requireOrigin || req.headers.origin) && req.headers.origin !== `https://${host}`) throw fail('来源未授权', 403);
    const url = new URL(req.url, `https://${host}`);
    const ip = req.socket.remoteAddress ?? 'unknown';
    const tick = Math.floor(Date.now() / 60_000);
    if (rates.size > 1024) for (const [key, entry] of rates) if (entry.tick !== tick) rates.delete(key);
    if (rates.size > 1024 && !rates.has(ip)) throw fail('请求过多', 429);
    const rate = rates.get(ip)?.tick === tick ? rates.get(ip) : { tick, count: 0, pairs: 0 };
    rates.set(ip, rate);
    if (++rate.count > 600) throw fail('请求过多，请稍后重试', 429);
    return { url, rate };
  };
  // Harness opens several persistent subscriptions. Multiplex them over HTTP/2
  // so session navigation and uplink calls cannot exhaust a browser's H1 pool.
  // Keep HTTP/1.1 for existing native clients and reverse proxies.
  const server = createSecureServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2', allowHTTP1: true }, async (req, res) => {
    try {
      const { url, rate } = authorize(req);
      if (url.pathname.startsWith('/link/workbench/')) {
        if (!workbench) throw fail('网页工作台尚未就绪', 503);
        return await workbench.handle(req, res, url, headers);
      }
      if (req.method === 'GET') {
        if (url.pathname === '/link/api/info') return send(res, 200, { name: 'DSH Link', version: '0.1.0' });
        const file = { '/link': 'index.html', '/link/': 'index.html', '/link/index.html': 'index.html', '/link/app.js': 'app.js', '/link/app.css': 'app.css' }[url.pathname];
        if (!file) throw fail('未找到', 404);
        if (url.pathname === '/link') { res.writeHead(308, { location: '/link/', ...headers }); return res.end(); }
        let data;
        try { data = await readFile(new URL(file, webRoot)); } catch (e) { if (e.code === 'ENOENT') throw fail('请先构建 Link 网页资源', 503); throw e; }
        return send(res, 200, data, file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
      }
      if (req.method !== 'POST') throw fail('不支持的方法', 405);
      if (url.pathname === '/link/api/pair') {
        if (++rate.pairs > 12) throw fail('配对请求过多', 429);
        const input = await body(req);
        const agent = req.headers['user-agent'] || '';
        const deviceType = /iPad|Tablet/i.test(agent) ? 'tablet' : /Android|iPhone|Mobile/i.test(agent) ? 'mobile' : /Windows|Macintosh|X11/i.test(agent) ? 'computer' : 'unknown';
        return send(res, 200, store.request(input.code, input.name, deviceType));
      }
      if (url.pathname === '/link/api/pair/status') {
        const input = await body(req);
        return send(res, 200, store.poll(input.requestId, input.pollToken));
      }
      if (!['/link/api/rpc', '/link/api/workbench'].includes(url.pathname)) throw fail('未找到', 404);
      const device = store.authenticate(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
      if (!device) throw fail('设备授权已失效，请重新配对', 401);
      if (url.pathname === '/link/api/workbench') {
        if (!workbench) throw fail('网页工作台尚未就绪', 503);
        await body(req);
        return send(res, 200, workbench.begin(device, res));
      }
      const input = await body(req);
      if (!active || !store.state.devices.some(d => d.id === device.id)) throw fail('设备授权已失效', 401);
      return send(res, 200, await dispatch(input, device));
    } catch (e) { if (res.headersSent) res.destroy(); else send(res, e.status ?? 400, { error: e.message }); }
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try {
      const { url } = authorize(req, true);
      if (url.pathname !== '/link/workbench/api/voice/realtime') throw fail('未找到', 404);
      if (!workbench?.upgrade) throw fail('实时语音尚未就绪', 503);
      workbench.upgrade(req, socket, head);
    } catch (error) {
      const status = error.status ?? 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('session', session => { sessions.add(session); session.once('close', () => sessions.delete(session)); });
  // Mobile links can pause while a request body crosses a high-latency network;
  // keep this below the reverse proxy's 120s upstream limits while allowing
  // normal workbench API and uplink requests to finish without premature 408s.
  server.requestTimeout = 60_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  server.on('error', onError);
  return {
    port: server.address().port,
    timeouts: { request: server.requestTimeout, headers: server.headersTimeout, keepAlive: server.keepAliveTimeout },
    close: async () => { active = false; await workbench?.close(); const ended = new Promise(resolve => server.close(resolve)); for (const session of sessions) session.destroy(); for (const socket of sockets) socket.destroy(); await ended; rates.clear(); },
  };
}
