import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { remoteAgent, remoteJson } from './remote.mjs';
const secret = () => randomBytes(32).toString('base64url');
/** Each host has its own origin. Remote scripts cannot read the device centre. */
export async function createDeviceProxy(target, { parentOrigin, onFailure, webRoot } = {}) {
  const agent = remoteAgent(target), tickets = new Map(), sessions = new Set(), sockets = new Set();
  let origin, remoteCookie, closed = false;
  const upstream = async () => {
    const { headers } = await remoteJson(target, '/link/api/workbench', {}, { agent });
    const cookie = headers['set-cookie']?.find(value => value.startsWith('dsh_link_workbench='))?.split(';')[0];
    if (!cookie) throw new Error('主机未签发工作台授权');
    remoteCookie = cookie;
  };
  await upstream();
  const server = createServer(async (req, res) => {
    try {
      if (closed || req.headers.host !== new URL(origin).host) throw Object.assign(new Error('设备连接地址无效'), { status: 403 });
      const url = new URL(req.url, origin);
      if (url.pathname === '/enter' && req.method === 'GET') {
        const ticket = url.searchParams.get('ticket'), expires = tickets.get(ticket);
        tickets.delete(ticket);
        if (!expires || expires < Date.now()) throw Object.assign(new Error('工作台入口已过期，请重新选择设备'), { status: 401 });
        const token = sessions.values().next().value || secret(); sessions.add(token);
        if (sessions.size > 16) sessions.delete(sessions.values().next().value);
        res.writeHead(303, { location: '/s/' + token + '/link/workbench/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return;
      }
      const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{43})(\/.*)$/);
      if (!match || !sessions.has(match[1]) || req.headers.origin && req.headers.origin !== origin) throw Object.assign(new Error('设备工作台未授权'), { status: 403 });
      const prefix = '/s/' + match[1]; url.pathname = match[2];
      if (url.pathname === '/local-proxy.js' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end('globalThis.__DSH_LINK_LOCAL_PROXY__=true;'); return; }
      if (webRoot && url.pathname === '/link/workbench/workbench.js' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(await readFile(new URL('workbench.js', webRoot))); return; }
      if (!url.pathname.startsWith('/link/workbench/') || !['GET', 'HEAD', 'POST'].includes(req.method)) throw Object.assign(new Error('路径未授权'), { status: 403 });
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !['cookie','authorization','host','origin','referer','connection','upgrade','sec-websocket-key','sec-websocket-version'].includes(key)) headers[key] = value;
      headers['accept-encoding'] = 'identity'; headers.cookie = remoteCookie; headers.origin = new URL(target.url).origin;
      const remote = request(new URL(url.pathname + url.search, target.url), { agent, method: req.method, headers }, response => {
        const outgoing = { ...response.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
        delete outgoing['set-cookie']; delete outgoing['x-frame-options']; delete outgoing['strict-transport-security'];
        if (outgoing['content-security-policy']) outgoing['content-security-policy'] = outgoing['content-security-policy'].replace(/frame-ancestors[^;]*/g, 'frame-ancestors ' + parentOrigin + ' dsh-app:');
        if (response.statusCode >= 300 && response.statusCode < 400) {
          const location = new URL(response.headers.location || '/', target.url);
          if (location.origin !== new URL(target.url).origin || !location.pathname.startsWith('/link/workbench/')) {
            response.resume(); res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('设备授权已失效，请返回设备列表重新连接'); return;
          }
          outgoing.location = prefix + location.pathname + location.search;
        }
        if (String(outgoing['content-type']).startsWith('text/html')) {
          const chunks = []; let bytes = 0;
          response.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) response.destroy(new Error('工作台页面过大')); else chunks.push(chunk); });
          response.on('end', () => { if (res.destroyed) return; const html = Buffer.concat(chunks).toString().replaceAll('/link/workbench/', prefix + '/link/workbench/').replace('<head>', '<head><script src="' + prefix + '/local-proxy.js"></script>'); const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'"); if (outgoing['content-security-policy']) { outgoing['content-security-policy'] = outgoing['content-security-policy'].replace(/'sha256-[^']+'/g, '').replace(/script-src([^;]*)/, (_, rules) => 'script-src' + rules + ' ' + hashes.join(' ')).replace(/connect-src([^;]*)/, (_, rules) => 'connect-src' + rules + ' ' + origin.replace('http:', 'ws:')); } delete outgoing['content-length']; res.writeHead(response.statusCode, outgoing); res.end(html); });
        } else { res.writeHead(response.statusCode, outgoing); response.pipe(res); }
        response.on('error', error => res.destroy(error));
      });
      remote.on('error', error => { onFailure?.(error); if (res.headersSent) res.destroy(); else { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('主机暂时不可达，请返回设备列表重试'); } });
      remote.setTimeout(90000, () => remote.destroy(new Error('工作台响应超时')));
      res.on('close', () => { if (!res.writableEnded) remote.destroy(); });
      req.pipe(remote);
    } catch (error) { if (!res.headersSent) res.writeHead(error.status || 502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(error.message); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const activeSockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    const match = req.url?.match(/^\/s\/([A-Za-z0-9_-]{43})\/socket$/);
    if (closed || req.headers.host !== new URL(origin).host || req.headers.origin !== origin || !match || !sessions.has(match[1])) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      activeSockets.add(ws); const requests = new Map();
      const send = data => { if (ws.readyState === 1) { if (ws.bufferedAmount > 8 * 1024 * 1024) ws.terminate(); else ws.send(JSON.stringify(data)); } };
      ws.on('message', raw => {
        let input;
        try {
          input = JSON.parse(raw.toString());
          if (input.type === 'cancel') { requests.get(input.id)?.destroy(); requests.delete(input.id); return; }
          if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id) || requests.has(input.id) || requests.size >= 64) throw new Error('流请求无效');
          const body = JSON.stringify(input.body);
          if (input.type !== 'open' || typeof input.body !== 'object' || body.length > 1024 * 1024) throw new Error('流请求无效');
          const remote = request(new URL('/link/workbench/remote/open', target.url), { agent, method: 'POST', headers: { cookie: remoteCookie, origin: new URL(target.url).origin, 'content-type': 'application/json' } }, response => {
            send({ id: input.id, type: 'headers', status: response.statusCode });
            let buffer = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { buffer += chunk; if (buffer.length > 4 * 1024 * 1024) { remote.destroy(new Error('流响应过大')); return; } let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) { try { send({ id: input.id, type: 'data', value: JSON.parse(line) }); } catch { remote.destroy(new Error('流响应格式错误')); } } } });
            response.on('end', () => { requests.delete(input.id); send({ id: input.id, type: 'end' }); });
            response.on('error', error => remote.destroy(error));
          });
          requests.set(input.id, remote);
          remote.setTimeout(90000, () => remote.destroy(new Error('流连接超时')));
          remote.on('error', error => { requests.delete(input.id); send({ id: input.id, type: 'error', error: error.message }); });
          remote.end(body);
        } catch (error) { send({ id: input?.id, type: 'error', error: error.message }); }
      });
      ws.on('error', () => {});
      ws.on('close', () => { activeSockets.delete(ws); for (const remote of requests.values()) remote.destroy(); requests.clear(); });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin,
    async enter() { await upstream(); for (const [ticket, expires] of tickets) if (expires < Date.now()) tickets.delete(ticket); const ticket = secret(); tickets.set(ticket, Date.now() + 60000); return origin + '/enter?ticket=' + ticket; },
    async close() { closed = true; for (const ws of activeSockets) ws.terminate(); wss.close(); tickets.clear(); sessions.clear(); agent.destroy(); const done = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await done; },
  };
}
