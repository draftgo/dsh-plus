import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';

/** Loopback-only Nginx upstream. Routes only explicitly registered centres/proxies. */
export async function createCloudDeviceGateway({ ownerOrigin, workbenchOrigin, port, getCenter }) {
  const owner = new URL(ownerOrigin);
  const workspace = workbenchOrigin ? new URL(workbenchOrigin) : null;
  if (owner.protocol !== 'https:' || owner.origin !== ownerOrigin || owner.username || owner.password || workspace && (workspace.protocol !== 'https:' || workspace.origin !== workbenchOrigin || workspace.origin === owner.origin || workspace.username || workspace.password)) throw Error('设备中心需精确 HTTPS owner 与独立工作台源');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('设备网关端口无效');
  const targets = new Map(), sockets = new Set();
  let closed = false;
  const resolve = async req => {
    if (closed) throw Error('设备网关已关闭');
    const path = new URL(req.url, ownerOrigin);
    if (req.headers.host === owner.host && path.pathname.startsWith('/devices/')) {
      return { target: (await getCenter()).origin, path: path.pathname.slice('/devices'.length) + path.search };
    }
    const match = path.pathname.match(/^\/p\/([A-Za-z0-9_-]{32})(\/.*)$/);
    const proxy = match && targets.get(match[1]);
    if (!workspace || req.headers.host !== workspace.host || !proxy) throw Error('设备工作台地址未授权');
    if (req.headers.origin && req.headers.origin !== workspace.origin) throw Error('来源未授权');
    return { target: proxy.origin, path: match[2] + path.search };
  };
  const headers = (req, target) => {
    const value = { ...req.headers, host: new URL(target).host };
    // Never pass owner cookies, bearer headers or forwarded identity downstream.
    for (const key of ['cookie', 'authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']) delete value[key];
    if (req.headers.origin) value.origin = new URL(target).origin;
    return value;
  };
  const server = createServer(async (req, res) => {
    try {
      const route = await resolve(req);
      if (req.headers.origin && req.headers.host === owner.host && req.headers.origin !== owner.origin) throw Error('来源未授权');
      const upstream = request(new URL(route.path, route.target), { method: req.method, headers: headers(req, route.target) }, response => {
        const outgoing = { ...response.headers }; delete outgoing['set-cookie'];
        res.writeHead(response.statusCode, outgoing); response.pipe(res);
        response.on('error', error => res.destroy(error));
      });
      upstream.on('error', () => { if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); } });
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); }); req.pipe(upstream);
    } catch { res.writeHead(403, { 'cache-control': 'no-store' }); res.end('设备地址未授权'); }
  });
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    try {
      if (!workspace || req.headers.host !== workspace.host || req.headers.origin !== workspace.origin) throw Error();
      const route = await resolve(req);
      const upstream = request(new URL(route.path, route.target), { headers: headers(req, route.target) });
      upstream.on('upgrade', (response, remote, upstreamHead) => {
        sockets.add(remote); remote.once('close', () => sockets.delete(remote)); remote.on('error', () => socket.destroy());
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
        if (upstreamHead.length) socket.write(upstreamHead); if (head.length) remote.write(head); socket.pipe(remote); remote.pipe(socket);
        socket.once('close', () => remote.destroy());
      });
      upstream.on('response', () => socket.destroy()); upstream.on('error', () => socket.destroy()); upstream.end();
    } catch { socket.destroy(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    registerProxy() {
      const id = randomBytes(24).toString('base64url');
      return { prefix: '/p/' + id, attach(proxy) { targets.set(id, proxy); const close = proxy.close.bind(proxy); proxy.close = async () => { targets.delete(id); await close(); }; }, remove() { targets.delete(id); } };
    },
    async close() { closed = true; targets.clear(); const done = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await done; },
  };
}
