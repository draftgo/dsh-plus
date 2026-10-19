import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

export const WORKBENCH_PATH = '/link/workbench/';
const COOKIE = 'dsh_link_workbench';
const MAX_BODY = 300 * 1024 * 1024;
const SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/** Resolve the installed web app's frontend through its own composition. */
function frontendRoot(ctx, configured) {
  if (configured) return configured instanceof URL ? fileURLToPath(configured) : resolve(configured);
  const bases = [ctx.baseUrl, ...Array.from(ctx.loader?.entries?.() ?? [], entry => entry.parent?.tree?.ctx?.baseUrl)].filter(Boolean);
  for (const base of bases) {
    try {
      const direct = createRequire(base);
      try { return join(dirname(direct.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist'); } catch {}
      const internal = ctx.loader?.internal;
      const name = '@deepseek-ai/dsh-web-app';
      const module = internal?.resolveSync ? (internal.version === 'v2' ? internal.resolveSync(base, { specifier: name, attributes: {} }) : internal.resolveSync(name, base, {})).url : createRequire(base).resolve(name);
      const require = createRequire(module);
      return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist');
    } catch { /* A loader can contain several independent compositions. */ }
  }
  throw fail('网页工作台资源尚未就绪，请先构建官方网页前端', 503);
}
async function readBody(req, limit = 256 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw fail('请求过大', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function json(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('需要 application/json', 415);
  const value = JSON.parse((await readBody(req)).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('请求必须是对象');
  return value;
}
async function writeChunk(res, chunk, signal) {
  if (signal.aborted || res.destroyed) return;
  if (!res.write(chunk)) await new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done); res.once('close', done);
  });
}

/** Same installed UI and Gateway, admitted exclusively by a paired device. */
export function createWorkbench(ctx, store, { webRoot, workbenchRoot } = {}) {
  const cookies = new Map(), peers = new Map();
  let closed = false;
  const authenticate = req => {
    const cookie = req.headers.cookie?.split(';').map(row => row.trim()).find(row => row.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!cookie || cookie.length > 128) return;
    const session = cookies.get(digest(cookie));
    if (!session) return;
    const device = store.state.devices.find(device => device.id === session.id && device.tokenHash === session.tokenHash);
    if (!device || session.expires <= Date.now()) { cookies.delete(digest(cookie)); return; }
    device.lastSeenAt = Date.now();
    return device;
  };
  const peerFor = device => {
    let record = peers.get(device.id);
    if (!record) {
      if (peers.size >= 32) throw fail('连接设备过多', 429);
      record = { peer: ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' }), abort: new AbortController(), streams: new Map() };
      peers.set(device.id, record);
    }
    return record;
  };
  const revoke = async id => {
    for (const [key, session] of cookies) if (session.id === id) cookies.delete(key);
    const record = peers.get(id);
    if (!record) return;
    peers.delete(id); record.abort.abort();
    for (const stream of record.streams.values()) { stream.abort.abort(); stream.wake?.(); }
    await record.peer.dispose();
  };
  const begin = (device, res) => {
    if (closed) throw fail('Link 已关闭', 503);
    for (const [key, session] of cookies) if (session.expires <= Date.now() || !store.state.devices.some(device => device.id === session.id)) cookies.delete(key);
    const sessions = [...cookies].filter(([, session]) => session.id === device.id);
    while (sessions.length >= 8) cookies.delete(sessions.shift()[0]);
    const token = randomBytes(32).toString('base64url');
    cookies.set(digest(token), { id: device.id, tokenHash: device.tokenHash, expires: Date.now() + SESSION_AGE });
    res.setHeader('set-cookie', COOKIE + '=' + token + '; Path=' + WORKBENCH_PATH + '; HttpOnly; Secure; SameSite=Strict; Max-Age=' + SESSION_AGE / 1000);
    return { url: WORKBENCH_PATH };
  };
  const handle = async (req, res, url, headers) => {
    if (closed) throw fail('Link 已关闭', 503);
    const device = authenticate(req);
    if (!device) {
      if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === WORKBENCH_PATH || url.pathname === WORKBENCH_PATH + 'index.html')) {
        res.writeHead(303, { ...headers, location: '/link/' }); res.end(); return;
      }
      throw fail('设备授权已失效，请重新配对', 401);
    }
    const path = url.pathname.slice(WORKBENCH_PATH.length);
    const record = peerFor(device);
    const abort = new AbortController();
    const signal = AbortSignal.any([record.abort.signal, abort.signal]);
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', onClose);
    const onAbort = () => { if (!res.writableEnded) res.destroy(); };
    record.abort.signal.addEventListener('abort', onAbort, { once: true });
    const sendResponse = async response => {
      res.writeHead(response.status, { ...headers, ...Object.fromEntries(response.headers), 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      if (req.method !== 'HEAD' && response.body) for await (const chunk of response.body) await writeChunk(res, chunk, signal);
      res.end();
    };
    try {
      if (path === 'remote/open' && req.method === 'POST') {
        const input = await json(req);
        if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) || typeof input.endpoint !== 'string' || !/^[a-zA-Z0-9_$.-]+(?:\/[a-zA-Z0-9_$.-]+)*$/.test(input.endpoint)) throw fail('流请求无效');
        if (record.streams.has(input.id) || record.streams.size >= 64) throw fail('活跃流过多或重复', 429);
        const stream = { abort: new AbortController(), items: [], bytes: 0, ended: false, wake: undefined };
        const streamSignal = AbortSignal.any([signal, stream.abort.signal]);
        record.streams.set(input.id, stream);
        const uplink = { async *[Symbol.asyncIterator]() {
          while (!streamSignal.aborted) {
            if (stream.items.length) { const next = stream.items.shift(); stream.bytes -= next.bytes; yield next.value; }
            else if (stream.ended) break;
            else await new Promise(resolve => {
              const done = () => { streamSignal.removeEventListener('abort', done); stream.wake = undefined; resolve(); };
              stream.wake = done; streamSignal.addEventListener('abort', done, { once: true });
              if (streamSignal.aborted) done();
            });
          }
        } };
        res.writeHead(200, { ...headers, 'content-type': 'application/x-ndjson', 'x-accel-buffering': 'no' });
        res.flushHeaders?.();
        await writeChunk(res, '{"type":"ready"}\n', streamSignal);
        const heartbeat = setInterval(() => { if (!streamSignal.aborted && !res.destroyed && res.writableLength < 65536) res.write('{"type":"heartbeat"}\n'); }, 15000);
        heartbeat.unref?.();
        try {
          const source = await ctx.typertGateway.wireStream.open(input.endpoint, input.payload, uplink, record.peer, streamSignal);
          for await (const value of source) await writeChunk(res, JSON.stringify({ type: 'item', value }) + '\n', streamSignal);
          await writeChunk(res, '{"type":"end"}\n', streamSignal);
        } catch (error) {
          if (!streamSignal.aborted) await writeChunk(res, JSON.stringify({ type: 'error', error: ctx.typertGateway.wireStream.failure(error) }) + '\n', streamSignal);
        } finally { clearInterval(heartbeat); stream.abort.abort(); stream.wake?.(); if (record.streams.get(input.id) === stream) record.streams.delete(input.id); res.end(); }
        return;
      }
      if (path === 'remote/uplink' && req.method === 'POST') {
        const input = await json(req), stream = record.streams.get(input.id);
        if (!stream) throw fail('流已结束', 410);
        if (input.type === 'cancel') stream.abort.abort();
        else if (input.type === 'end') stream.ended = true;
        else if (input.type === 'item' && !stream.ended) {
          const bytes = Buffer.byteLength(JSON.stringify(input.value) ?? 'null');
          if (stream.items.length >= 64 || stream.bytes + bytes > 1024 * 1024) { stream.abort.abort(); throw fail('流缓冲区已满', 429); }
          stream.items.push({ value: input.value, bytes }); stream.bytes += bytes;
        } else throw fail('流帧无效');
        stream.wake?.(); res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      if (path === 'disconnect' && req.method === 'POST') {
        const cookie = req.headers.cookie?.split(';').map(row => row.trim()).find(row => row.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
        if (cookie) cookies.delete(digest(cookie));
        res.setHeader('set-cookie', COOKIE + '=; Path=' + WORKBENCH_PATH + '; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
        res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      if (path === 'open-in-app/apps' && req.method === 'GET') {
        // The mobile carrier has no desktop app launcher; keep the shared shell's optional discovery UI honest.
        res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end('{"apps":[]}'); return;
      }
      if (path.startsWith('api/')) {
        if (['api/commander-link', 'api/commander-devices'].some(route => path === route || path.startsWith(route + '/'))) throw fail('请在电脑上管理配对设备', 403);
        if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw fail('不支持的方法', 405);
        const target = new URL('/' + path + url.search, url.origin);
        const api = ctx.connection.createSharedFetchHandler('/api');
        const mode = api.requestBodyMode?.({ method: req.method, url: target }) ?? 'buffered';
        const incomingHeaders = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && !key.startsWith(':') && !['authorization', 'cookie'].includes(key)) incomingHeaders.set(key, value);
        const options = { method: req.method, headers: incomingHeaders, signal };
        if (!['GET', 'HEAD'].includes(req.method)) {
          if (mode === 'streaming') { options.body = Readable.toWeb(req); options.duplex = 'half'; }
          else options.body = await readBody(req, MAX_BODY);
        }
        if (!store.state.devices.some(row => row.id === device.id && row.tokenHash === device.tokenHash)) throw fail('设备授权已失效', 401);
        await sendResponse(await api.fetch(new Request(target, options), record.peer)); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fail('不支持的方法', 405);
      if (path.startsWith('plugins/')) {
        if (!ctx.clientModules?.fetchBundle) throw fail('网页模块尚未就绪', 503);
        await sendResponse(await ctx.clientModules.fetchBundle(new Request(new URL('/' + path + url.search, url.origin), { method: req.method, signal }))); return;
      }
      if (path === 'workbench.js') {
        const bytes = await readFile(new URL('workbench.js', webRoot));
        res.writeHead(200, { ...headers, 'content-type': mime['.js'] }); res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      const root = await realpath(frontendRoot(ctx, workbenchRoot));
      let asset;
      try { asset = await realpath(join(root, decodeURIComponent(path || 'index.html'))); } catch (error) { if (error.code === 'ENOENT') throw fail('未找到', 404); throw error; }
      const child = relative(root, asset);
      if (child === '..' || child.startsWith('..' + sep) || resolve(root, child) !== asset || !(await stat(asset)).isFile()) throw fail('未找到', 404);
      let data = await readFile(asset);
      let policy = headers['content-security-policy'];
      if (path === '' || path === 'index.html') {
        const html = ctx.webServer.renderIndex(data.toString()).replace(/<base\b[^>]*>/gi, '').replace(/(["'])\/(plugins|api)\//g, (_, quote, route) => quote + WORKBENCH_PATH + route + '/').replace(/<head(?:\s[^>]*)?>/i, open => open + '<base href="' + WORKBENCH_PATH + '"><script src="' + WORKBENCH_PATH + 'workbench.js"></script>').replace('width=device-width, initial-scale=1', 'width=device-width, initial-scale=1, viewport-fit=cover');
        const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
        policy = "default-src 'self'; script-src 'self' 'unsafe-eval' " + hashes.join(' ') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
        data = Buffer.from(html);
      }
      res.writeHead(200, { ...headers, 'content-security-policy': policy, 'permissions-policy': 'microphone=(self), camera=(self)', 'content-type': mime[extname(asset)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } finally { record.abort.signal.removeEventListener('abort', onAbort); res.off('close', onClose); }
  };
  return { begin, handle, revoke, close: async () => { closed = true; await Promise.all([...peers.keys()].map(revoke)); cookies.clear(); } };
}
