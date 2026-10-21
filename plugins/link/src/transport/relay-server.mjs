import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSecureServer } from 'node:http2';
import { WebSocketServer } from 'ws';
import { RELAY_CHUNK_BYTES as CHUNK, RELAY_CONTROL_PATH as CONTROL, RELAY_DATA_PATH as DATA, RELAY_VOICE_PATH as VOICE, RELAY_WORKBENCH_PATH as WORKBENCH, relayPathAllowed } from './relay-protocol.mjs';

const MAX_BUFFERED = 256 * 1024;
const MAX_STREAM_BYTES = 512 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => {
  const left = Buffer.from(digest(a)); const right = Buffer.from(digest(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (ws, value) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(value));
const workbenchCookie = value => typeof value === 'string'
  ? value.split(';').map(item => item.trim()).filter(item => item.startsWith('dsh_link_workbench=')).join('; ')
  : '';
const send = async (ws, data, options) => {
  while (ws.readyState === ws.OPEN && ws.bufferedAmount > MAX_BUFFERED) await new Promise(resolve => setTimeout(resolve, 5));
  if (ws.readyState !== ws.OPEN) throw new Error('中继通道已关闭');
  await new Promise((resolve, reject) => ws.send(data, options ?? {}, error => error ? reject(error) : resolve()));
};
const requestHeaders = (headers, path) => {
  const result = {};
  for (const key of ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since', 'cookie']) {
    if (typeof headers[key] === 'string') result[key] = key === 'cookie' ? workbenchCookie(headers[key]) : headers[key];
  }
  if (['/link/api/rpc', '/link/api/workbench'].includes(path) && typeof headers.authorization === 'string') result.authorization = headers.authorization;
  return result;
};
const responseHeaders = headers => {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(key)) result[key] = value;
  }
  return result;
};

/** One TLS origin and one registered Link host. TLS ends here; HTTP content is visible to this relay. */
export async function createRelayServer({ host = '0.0.0.0', port, identity, publicUrl, token, onError = () => {} }) {
  if (!identity?.key || !identity?.cert) throw new Error('中继 TLS 证书无效');
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) throw new Error('中继主机密钥至少需要 32 个字符');
  const publicOrigin = new URL(publicUrl);
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== publicUrl || publicOrigin.username || publicOrigin.password) throw new Error('中继公网地址必须是独立 HTTPS origin');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('中继监听端口无效');
  let closed = false, activeHost;
  const tickets = new Map(), transactions = new Set(), sockets = new Set();
  const controls = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const data = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const voice = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const securityHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  const ticket = () => {
    const value = randomBytes(32).toString('base64url');
    tickets.set(digest(value), { value, expires: Date.now() + 15_000 });
    return value;
  };
  const openTicket = value => {
    if (typeof value !== 'string' || value.length > 128) return;
    const key = digest(value), entry = tickets.get(key);
    tickets.delete(key);
    if (!entry || entry.expires < Date.now() || !same(value, entry.value)) return;
    return entry;
  };
  const remove = transaction => { clearTimeout(transaction.attachTimer); clearTimeout(transaction.voiceTimer); tickets.delete(digest(transaction.ticket)); transactions.delete(transaction); };
  const makeTransaction = (req, res, method, path, headers, kind = 'http') => {
    if (!activeHost || activeHost.readyState !== activeHost.OPEN) throw fail('目标设备离线', 503);
    if (transactions.size >= 64) throw fail('中继连接数已满', 429);
    const value = ticket();
    let resolveData, rejectData;
    const dataReady = new Promise((resolve, reject) => { resolveData = resolve; rejectData = reject; });
    dataReady.catch(() => {});
    const transaction = { ticket: value, req, res, method, path, headers, kind, socket: undefined, dataReady, resolveData, rejectData, host: activeHost };
    transactions.add(transaction);
    req.once('close', () => { if (!req.complete) transaction.socket?.close(1001, 'request closed'); });
    res?.once('close', () => { if (!res.writableEnded) transaction.socket?.close(1001, 'client closed'); });
    const attachTimer = setTimeout(() => {
      remove(transaction); rejectData(new Error('主机接入超时'));
      if (transaction.rawSocket && !transaction.rawSocket.destroyed) transaction.rawSocket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }, 15_000);
    attachTimer.unref?.(); transaction.attachTimer = attachTimer;
    return transaction;
  };
  const relayHttp = async (req, res, path) => {
    const query = new URL(req.url, publicOrigin).search;
    if (!relayPathAllowed(req.method, path + query)) throw fail('Link 路径未授权', 404);
    if (req.headers.origin && req.headers.origin !== publicOrigin.origin) throw fail('来源未授权', 403);
    const transaction = makeTransaction(req, res, req.method, path + query, requestHeaders(req.headers, path));
    json(activeHost, { type: 'http', ticket: transaction.ticket, method: transaction.method, path: transaction.path, headers: transaction.headers });
    let timer = setTimeout(() => transaction.socket?.close(1011, 'relay timeout'), 120_000); timer.unref?.();
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => transaction.socket?.close(1011, 'relay timeout'), 120_000); timer.unref?.(); };
    let requestBytes = 0, responseBytes = 0;
    try {
      transaction.socket = await transaction.dataReady;
      if (transaction.socket.readyState !== transaction.socket.OPEN) throw new Error('中继数据通道已关闭');
      transaction.socket.on('message', (raw, binary) => {
        if (binary) {
          if (!res.headersSent) { transaction.socket.close(1002, 'response headers missing'); return; }
          responseBytes += raw.length;
          if (responseBytes > MAX_STREAM_BYTES) { transaction.socket.close(1009, 'response too large'); return; }
          touch();
          if (!res.write(raw)) { transaction.socket.pause(); res.once('drain', () => transaction.socket?.resume()); }
          return;
        }
        let frame; try { frame = JSON.parse(raw.toString()); } catch { transaction.socket.close(1002, 'invalid frame'); return; }
        if (frame.type === 'response' && !res.headersSent && Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599 && frame.headers && typeof frame.headers === 'object') res.writeHead(frame.status, { ...responseHeaders(frame.headers), ...securityHeaders });
        else if (frame.type === 'end') { clearTimeout(timer); if (!res.headersSent) res.writeHead(502, securityHeaders); res.end(); remove(transaction); transaction.socket.close(1000); }
        else if (frame.type === 'error') { clearTimeout(timer); if (!res.headersSent) { res.writeHead(502, securityHeaders); res.end('目标设备请求失败'); } else res.destroy(); remove(transaction); transaction.socket.close(); }
        else { transaction.socket.close(1002, 'unexpected frame'); }
      });
      transaction.socket.once('close', () => {
        clearTimeout(timer);
        if (transactions.has(transaction)) { if (!res.headersSent) { res.writeHead(502, securityHeaders); res.end('目标设备连接中断'); } else if (!res.writableEnded) res.destroy(); remove(transaction); }
      });
      for await (const chunk of req) {
        requestBytes += chunk.length;
        if (requestBytes > MAX_STREAM_BYTES) throw fail('请求过大', 413);
        touch();
        for (let offset = 0; offset < chunk.length; offset += CHUNK) await send(transaction.socket, chunk.subarray(offset, offset + CHUNK), { binary: true });
      }
      json(transaction.socket, { type: 'request-end' });
    } catch (error) {
      clearTimeout(timer); remove(transaction); transaction.socket?.close(1009, 'request aborted');
      if (!res.headersSent && !res.destroyed) { res.writeHead(error.status ?? 502, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }); res.end(error.status ? error.message : '目标设备连接中断'); }
    }
  };
  const server = createSecureServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2', allowHTTP1: true }, (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    try {
      const authority = req.headers[':authority'] || req.headers.host;
      if (closed || authority !== publicOrigin.host) throw fail('中继地址未授权', 403);
      const raw = req.url || '/';
      if (!relayPathAllowed(req.method, raw)) throw fail('Link 路径未授权', 404);
      const url = new URL(raw, publicOrigin);
      if (url.origin !== publicOrigin.origin || !(url.pathname === '/link' || url.pathname.startsWith('/link/'))) throw fail('Link 路径未授权', 404);
      void relayHttp(req, res, url.pathname).catch(error => { if (!res.headersSent) { res.writeHead(error.status ?? 502, { ...securityHeaders, ...headers }); res.end(error.status ? error.message : '目标设备连接失败'); } else res.destroy(); });
    } catch (error) { res.writeHead(error.status ?? 400, headers); res.end(error.message); }
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const reject = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.url === CONTROL) {
      const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!supplied || !same(supplied, token)) { socket.destroy(); return; }
      if (closed || req.headers.host !== publicOrigin.host || req.headers.origin && req.headers.origin !== publicOrigin.origin) return reject(403);
      controls.handleUpgrade(req, socket, head, ws => {
        const previous = activeHost;
        activeHost = ws; previous?.close(1012, 'host replaced');
        ws.on('message', () => ws.close(1008, 'control messages are server initiated'));
        ws.on('error', () => {});
        ws.once('close', () => {
          if (activeHost === ws) activeHost = undefined;
          for (const entry of transactions) if (entry.host === ws) { entry.data?.close(1011, 'host disconnected'); entry.browser?.close(1011, 'host disconnected'); entry.rejectData?.(new Error('主机已断开')); entry.res?.destroy(); entry.rawSocket?.destroy(); remove(entry); }
        });
      }); return;
    }
    if (req.url !== DATA) {
      if (req.url !== VOICE || req.headers.host !== publicOrigin.host || req.headers.origin !== publicOrigin.origin || closed || !activeHost || activeHost.readyState !== activeHost.OPEN) return reject(403);
      let transaction;
      try { transaction = makeTransaction(req, undefined, 'GET', VOICE, {}, 'voice'); }
      catch (error) { return reject(error.status ?? 502); }
      transaction.rawSocket = socket;
      json(activeHost, { type: 'voice', ticket: transaction.ticket, path: VOICE, cookie: workbenchCookie(req.headers.cookie).slice(0, 4096) });
      transaction.attachVoice = dataSocket => {
        clearTimeout(transaction.attachTimer);
        transaction.data = dataSocket;
        const timeout = transaction.voiceTimer = setTimeout(() => { if (!transaction.browser) { reject(504); remove(transaction); dataSocket.terminate(); } }, 12_000); timeout.unref?.();
        dataSocket.on('message', (raw, binary) => {
          if (!transaction.browser) {
            if (binary) { dataSocket.close(1002, 'unexpected voice data'); return; }
            let frame; try { frame = JSON.parse(raw.toString()); } catch { dataSocket.close(1002, 'invalid voice handshake'); return; }
            if (frame.type !== 'voice-ready') { dataSocket.close(1002, 'invalid voice handshake'); return; }
            clearTimeout(timeout);
            voice.handleUpgrade(req, socket, head, browser => {
              transaction.browser = browser;
              browser.on('message', (value, isBinary) => {
                const payload = Buffer.from(value), framed = Buffer.allocUnsafe(payload.length + 1);
                framed[0] = isBinary ? 1 : 0; payload.copy(framed, 1);
                if (dataSocket.readyState !== dataSocket.OPEN || dataSocket.bufferedAmount + framed.length > MAX_BUFFERED * 4) { browser.close(1009, 'voice buffer full'); return; }
                dataSocket.send(framed, { binary: true });
              });
              dataSocket.on('message', (value, isBinary) => {
                if (!isBinary) { dataSocket.close(1002, 'invalid voice payload'); return; }
                const payload = Buffer.from(value);
                if (payload.length < 1 || payload[0] > 1 || browser.readyState !== browser.OPEN || browser.bufferedAmount + payload.length > MAX_BUFFERED * 4) { browser.close(1009, 'voice frame invalid'); return; }
                browser.send(payload.subarray(1), { binary: payload[0] === 1 });
              });
              const close = () => { browser.terminate(); dataSocket.terminate(); remove(transaction); };
              browser.once('close', close); dataSocket.once('close', close);
              browser.on('error', close); dataSocket.on('error', close);
            });
          }
        });
        dataSocket.once('close', () => { clearTimeout(timeout); if (!transaction.browser) reject(502); remove(transaction); socket.destroy(); });
      };
      return;
    }
    if (closed || req.headers.host !== publicOrigin.host || req.headers.origin && req.headers.origin !== publicOrigin.origin) return reject(403);
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const entry = openTicket(supplied);
    if (!entry) { socket.destroy(); return; }
    data.handleUpgrade(req, socket, head, ws => {
      const transaction = [...transactions].find(value => value.ticket === entry.value);
      if (!transaction) { ws.close(1008); return; }
      clearTimeout(transaction.attachTimer);
      transaction.data = ws; transaction.socket = ws;
      transaction.resolveData(ws);
      if (transaction.kind === 'voice') transaction.attachVoice(ws);
      ws.on('error', () => { transaction.res?.destroy(); transaction.rawSocket?.destroy(); remove(transaction); });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.requestTimeout = 0; server.headersTimeout = 15_000; server.keepAliveTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  server.on('error', onError);
  return {
    port: server.address().port,
    origin: publicOrigin.origin,
    async close() {
      closed = true; activeHost?.close(1001, 'relay closed');
      for (const transaction of transactions) { transaction.data?.close(1001, 'relay closed'); transaction.browser?.close(1001, 'relay closed'); transaction.res?.destroy(); transaction.rawSocket?.destroy(); transaction.rejectData?.(new Error('relay closed')); remove(transaction); }
      tickets.clear();
      const done = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      controls.close(); data.close(); voice.close(); await done;
    },
  };
}

export const relayRoutes = Object.freeze({ control: CONTROL, data: DATA, workbench: WORKBENCH, voice: VOICE });
