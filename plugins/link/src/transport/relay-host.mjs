import { request } from 'node:https';
import { WebSocket } from 'ws';
import { remoteAgent } from '../devices/remote.mjs';
import { RELAY_CONTROL_PATH as CONTROL, RELAY_DATA_PATH as DATA, RELAY_CHUNK_BYTES as CHUNK, RELAY_VOICE_PATH as VOICE, relayPathAllowed } from './relay-protocol.mjs';

const MAX_BUFFERED = 256 * 1024;
const fail = message => Object.assign(new Error(message), { status: 502 });
const send = async (ws, value, options = {}) => {
  while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > MAX_BUFFERED) await new Promise(resolve => setTimeout(resolve, 5));
  if (ws.readyState !== WebSocket.OPEN) throw fail('中继数据通道已关闭');
  await new Promise((resolve, reject) => ws.send(value, options, error => error ? reject(error) : resolve()));
};
const targetOrigin = target => new URL(target.url).origin;
function validate(options) {
  const { relayUrl, token, target } = options;
  let relay, local;
  try { relay = new URL(relayUrl); local = new URL(target?.url); } catch { throw new Error('中继或 Link 主机地址无效'); }
  if (relay.protocol !== 'https:' || relay.origin !== relayUrl || relay.username || relay.password || relay.pathname !== '/' || relay.search || relay.hash) throw new Error('中继地址必须是独立 HTTPS origin');
  if (local.protocol !== 'https:' || local.origin !== target.url || local.username || local.password || local.pathname !== '/' || local.search || local.hash || !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) throw new Error('Link 上游必须是固定 HTTPS loopback 地址');
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) throw new Error('中继主机密钥至少需要 32 个字符');
  if (typeof target.pin !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(target.pin) || Buffer.from(target.pin, 'base64').length !== 32) throw new Error('Link 主机 SPKI 指纹无效');
  if (options.relayCa !== undefined && typeof options.relayCa !== 'string' && !Buffer.isBuffer(options.relayCa)) throw new Error('中继 CA 证书无效');
  return { relay: relay.origin, target: { url: local.origin, pin: target.pin } };
}
function headersFor(input, target) {
  const headers = {};
  for (const name of ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since', 'cookie']) {
    if (typeof input.headers?.[name] === 'string') headers[name] = input.headers[name];
  }
  if (['/link/api/rpc', '/link/api/workbench'].includes(input.path.split('?')[0]) && typeof input.headers?.authorization === 'string') headers.authorization = input.headers.authorization;
  headers.host = new URL(target.url).host;
  headers.origin = targetOrigin(target);
  return headers;
}

/** Outbound-only Link host tunnel. The upstream is always its pinned loopback Link listener. */
export function createRelayHost(options) {
  const { relay, target } = validate(options);
  const agent = remoteAgent(target), sockets = new Set(), work = new Set();
  let closed = false, connected = false, lastError = null, control, retryTimer, retryResolve, heartbeat;
  const failRequest = (ws, error) => {
    if (ws.readyState === WebSocket.OPEN) void send(ws, JSON.stringify({ type: 'error', error: '目标 Link 请求失败' })).catch(() => {});
    ws.close(1011, 'upstream failed'); lastError = error?.message || '目标 Link 请求失败'; options.onError?.(new Error(lastError));
  };
  const httpTransaction = (ws, input) => {
    if (!relayPathAllowed(input.method, input.path)) { ws.close(1008); return; }
    const endpoint = new URL(input.path, target.url);
    if (endpoint.origin !== target.url || !['GET', 'HEAD', 'POST'].includes(input.method)) { ws.close(1008); return; }
    let ended = false;
    const upstream = request(endpoint, { agent, method: input.method, headers: headersFor(input, target), timeout: 120_000 }, response => {
      void send(ws, JSON.stringify({ type: 'response', status: response.statusCode, headers: response.headers })).catch(error => upstream.destroy(error));
      response.on('data', chunk => {
        response.pause();
        (async () => {
          for (let offset = 0; offset < chunk.length; offset += CHUNK) await send(ws, chunk.subarray(offset, offset + CHUNK), { binary: true });
          response.resume();
        })().catch(error => response.destroy(error));
      });
      response.once('end', () => { ended = true; void send(ws, JSON.stringify({ type: 'end' })).catch(() => {}); });
      response.once('error', error => failRequest(ws, error));
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', error => { if (!ended) failRequest(ws, error); });
    ws.on('message', (raw, binary) => {
      if (binary) {
        if (!upstream.write(raw)) { ws.pause(); upstream.once('drain', () => ws.resume()); }
        return;
      }
      let frame; try { frame = JSON.parse(raw.toString()); } catch { upstream.destroy(new Error('invalid relay frame')); return; }
      if (frame.type === 'request-end') upstream.end(); else upstream.destroy(new Error('unexpected relay frame'));
    });
    ws.once('close', () => upstream.destroy()); ws.once('error', () => upstream.destroy());
  };
  const voiceTransaction = (ws, input) => {
    if (input.path !== VOICE || typeof input.cookie !== 'string' || input.cookie.length > 4096) { ws.close(1008); return; }
    const endpoint = new URL(input.path, target.url); endpoint.protocol = 'wss:';
    const upstream = new WebSocket(endpoint, { agent, origin: targetOrigin(target), headers: { ...(input.cookie ? { cookie: input.cookie } : {}) }, handshakeTimeout: 10_000, maxPayload: 64 * 1024, perMessageDeflate: false });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    let ended = false;
    const finish = error => {
      if (ended) return; ended = true;
      if (error) lastError = error.message;
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
    };
    upstream.once('open', () => { void send(ws, JSON.stringify({ type: 'voice-ready' })).catch(finish); });
    upstream.on('message', (data, binary) => {
      const prefix = Buffer.from([binary ? 1 : 0]);
      void send(ws, Buffer.concat([prefix, Buffer.from(data)]), { binary: true }).catch(finish);
    });
    ws.on('message', (data, binary) => {
      if (binary) {
        const frame = Buffer.from(data);
        if (frame.length < 1 || frame[0] > 1 || upstream.readyState !== WebSocket.OPEN) return finish(new Error('voice frame invalid'));
        if (upstream.bufferedAmount + frame.length - 1 > 256 * 1024) return finish(new Error('voice buffer full'));
        upstream.send(frame.subarray(1), { binary: frame[0] === 1 }, error => { if (error) finish(error); });
      } else if (!binary) finish(new Error('unexpected voice relay frame'));
    });
    ws.once('close', () => finish()); upstream.once('close', () => finish()); ws.on('error', finish); upstream.on('error', finish);
  };
  const onControlMessage = raw => {
    if (raw.length > 16 * 1024) return control?.close(1009, 'control frame too large');
    let input; try { input = JSON.parse(raw.toString()); } catch { return control?.close(1008, 'invalid control frame'); }
    if (!['http', 'voice'].includes(input.type) || typeof input.ticket !== 'string' || input.ticket.length > 128) return control?.close(1008, 'invalid control frame');
    const url = new URL(DATA, relay); url.protocol = 'wss:';
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer ' + input.ticket }, ...(options.relayCa ? { ca: options.relayCa } : {}), handshakeTimeout: 10_000, maxPayload: 128 * 1024, perMessageDeflate: false });
    sockets.add(ws); ws.once('close', () => sockets.delete(ws));
    ws.once('open', () => input.type === 'http' ? httpTransaction(ws, input) : voiceTransaction(ws, input));
    ws.once('error', error => { lastError = error.message; });
  };
  const run = async () => {
    let delay = 1000;
    while (!closed) {
      try {
        const controlUrl = new URL(CONTROL, relay); controlUrl.protocol = 'wss:';
        control = new WebSocket(controlUrl, { headers: { authorization: 'Bearer ' + options.token }, ...(options.relayCa ? { ca: options.relayCa } : {}), handshakeTimeout: 10_000, maxPayload: 16 * 1024, perMessageDeflate: false });
        const currentControl = control;
        sockets.add(currentControl); currentControl.once('close', () => sockets.delete(currentControl));
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = error => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            currentControl.off('open', onOpen); currentControl.off('error', onError); currentControl.off('close', onClose);
            if (error) reject(error); else resolve();
          };
          const onOpen = () => { connected = true; lastError = null; delay = 1000; finish(); };
          const onError = error => finish(error);
          const onClose = () => finish(new Error('中继在握手完成前关闭'));
          const timer = setTimeout(() => { currentControl.terminate(); finish(new Error('中继连接超时')); }, 10_000); timer.unref?.();
          currentControl.once('open', onOpen); currentControl.once('error', onError); currentControl.once('close', onClose);
        });
        let lastPong = Date.now();
        currentControl.on('error', error => { if (!closed) { lastError = error.message; options.onError?.(error); } });
        control.on('pong', () => { lastPong = Date.now(); });
        heartbeat = setInterval(() => {
          if (currentControl.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastPong > 45_000) { currentControl.terminate(); return; }
          currentControl.ping();
        }, 15_000);
        heartbeat.unref?.();
        currentControl.on('message', onControlMessage);
        await new Promise(resolve => currentControl.once('close', resolve));
      } catch (error) { if (!closed) { lastError = error.message; options.onError?.(error); } }
      clearInterval(heartbeat);
      connected = false;
      if (!closed) await new Promise(resolve => { retryResolve = resolve; retryTimer = setTimeout(() => { retryResolve = undefined; resolve(); }, delay); retryTimer.unref?.(); });
      delay = Math.min(delay * 2, 30_000);
    }
  };
  const running = run(); work.add(running);
  return {
    status: () => ({ connected, lastError }),
    async close() {
      if (closed) return;
      closed = true; clearTimeout(retryTimer); retryResolve?.(); retryResolve = undefined; connected = false;
      clearInterval(heartbeat);
      control?.close(1001, 'host stopped');
      for (const socket of sockets) socket.terminate();
      agent.destroy(); await Promise.allSettled([...work]); work.clear();
    },
  };
}
