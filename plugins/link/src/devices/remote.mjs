import { Agent, request } from 'node:https';
import { connect } from 'node:tls';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
function verifyPinnedPeer(socket, pin) {
  const cert = socket.getPeerCertificate(true), expected = Buffer.from(pin, 'base64');
  if (!cert.pubkey || !Number.isFinite(Date.parse(cert.valid_to)) || !Number.isFinite(Date.parse(cert.valid_from)) || Date.parse(cert.valid_to) <= Date.now() || Date.parse(cert.valid_from) > Date.now()) throw Object.assign(new Error('主机证书无效或已过期'), { code: 'ERR_LINK_CERTIFICATE' });
  const actual = createHash('sha256').update(cert.pubkey).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Object.assign(new Error('主机公钥与保存的指纹不一致'), { code: 'ERR_LINK_CERTIFICATE' });
}
/** TLS-only reachability check: no HTTP bytes, bearer tokens or cookies leave the client. */
export function probeRemote(target, { timeout = 2500, signal } = {}) {
  const url = new URL(target.url), host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host, rejectUnauthorized: !target.pin, signal });
    let finished = false;
    const finish = error => { if (finished) return; finished = true; socket.destroy(); error ? reject(error) : resolve(); };
    socket.once('error', finish);
    socket.setTimeout(timeout, () => finish(Object.assign(new Error('连接超时，请检查主机是否在线'), { code: 'ETIMEDOUT' })));
    socket.once('secureConnect', () => {
      try { if (target.pin) verifyPinnedPeer(socket, target.pin); finish(); } catch (error) { finish(error); }
    });
  });
}
/** Verify pinned self-signed peers before sending HTTP bytes or credentials. */
export function remoteAgent(target) {
  const agent = new Agent({ keepAlive: true, maxSockets: 64 });
  if (target.pin) agent.createConnection = (options, callback) => {
    const socket = connect({ ...options, rejectUnauthorized: false, servername: undefined });
    const error = value => { socket.destroy(); callback(value); };
    socket.once('error', error);
    socket.once('secureConnect', () => {
      try {
        verifyPinnedPeer(socket, target.pin);
        socket.removeListener('error', error); callback(null, socket);
      } catch (reason) { error(reason); }
    });
    return undefined;
  };
  return agent;
}
export function remoteJson(target, path, input, { agent, token = target.token, signal } = {}) {
  const own = !agent; agent ??= remoteAgent(target);
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, target.url), { method: 'POST', agent, signal, timeout: 20000, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res => {
      let body = '', bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(new Error('主机响应过大')); else body += chunk; });
      res.on('error', reject);
      res.on('end', () => { try { const value = JSON.parse(body); if (res.statusCode >= 400) throw Object.assign(new Error(value.error || '主机返回 HTTP ' + res.statusCode), { statusCode: res.statusCode }); resolve({ value, headers: res.headers }); } catch (reason) { reject(reason); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('连接超时，请检查主机是否在线')));
    req.end(JSON.stringify(input));
  }).finally(() => { if (own) agent.destroy(); });
}
