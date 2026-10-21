import { createServer } from 'node:http';
import { randomBytes, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const scrypt = promisify(derive), token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const COOKIE = '__Host-dsh_access', TTL = 12 * 60 * 60 * 1000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const redirectPath = value => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || decoded.startsWith('/__dsh_access') || [...decoded].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 92 || char.charCodeAt(0) === 127)) return '/';
    const url = new URL(value, 'https://redirect.invalid');
    return url.origin === 'https://redirect.invalid' ? url.pathname + url.search + url.hash : '/';
  } catch { return '/'; }
};
const cookie = (value, age = TTL / 1000) => COOKIE + '=' + value + '; Path=/; Max-Age=' + age + '; Secure; HttpOnly; SameSite=Strict';
const body = request => new Promise((resolve, reject) => {
  let size = 0, chunks = [];
  request.on('data', chunk => { size += chunk.length; if (size > 4096) { chunks = []; reject(fail('请求过大', 413)); } else chunks.push(chunk); });
  request.on('end', () => { try { if (size <= 4096) resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(fail('请求格式无效')); } });
  request.on('error', reject);
});

/** Nginx is the only public ingress. Never trust client IP or forwarded origin headers. */
export async function createCloudAccess(directory, { env = process.env, probe = fetch } = {}) {
  const file = join(directory, 'cloud-access.json');
  let state = { enabled: false }, server, origin = '', port = 0, error = '', sessions = new Map(), writes = Promise.resolve();
  let failures = 0, blockedUntil = 0, activeLogins = 0, closed = false, closing, storageError = '';
  let ready = false, checkedAt = 0, readinessError = '', probing;
  const readinessProof = token();
  try {
    state = JSON.parse(await readFile(file, 'utf8')); await chmod(file, 0o600);
    if (!state || typeof state !== 'object' || typeof state.enabled !== 'boolean' || (state.enabled && (!/^[A-Za-z0-9_-]{43}$/.test(state.salt || '') || !/^[a-f0-9]{64}$/.test(state.hash || '')))) throw Error('invalid cloud access file');
  } catch (reason) { if (reason.code !== 'ENOENT') { state = { enabled: true }; storageError = '云端访问配置损坏，鉴权已拒绝访问；请通过本机管理修复配置'; } }
  if (env.DSH_LINK_CLOUD_ORIGIN || env.DSH_LINK_CLOUD_AUTH_PORT) {
    try {
      const url = new URL(env.DSH_LINK_CLOUD_ORIGIN);
      if (url.protocol !== 'https:' || url.origin !== env.DSH_LINK_CLOUD_ORIGIN || url.username || url.password) throw Error();
      if (!/^[0-9]+$/.test(String(env.DSH_LINK_CLOUD_AUTH_PORT)) || Number(env.DSH_LINK_CLOUD_AUTH_PORT) > 65535) throw Error();
      origin = url.origin; port = Number(env.DSH_LINK_CLOUD_AUTH_PORT);
    } catch { error = '需配置精确 HTTPS 源 DSH_LINK_CLOUD_ORIGIN 与独立端口 DSH_LINK_CLOUD_AUTH_PORT'; }
  }
  const checkReady = async (force = false) => {
    if (closed || !server?.listening || storageError) return false;
    if (probing) return probing;
    if (!force && checkedAt && Date.now() - checkedAt < 30_000) return ready;
    probing = (async () => {
      try {
        const target = new URL('/__dsh_access/login', origin);
        const response = await probe(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3000), headers: { accept: 'text/html' } });
        const valid = response.status === 200 && (!response.url || new URL(response.url).origin === origin) && response.headers.get('x-dsh-cloud-ready') === readinessProof;
        await response.body?.cancel();
        if (!valid) throw Error('proxy mismatch');
        if (!closed) { ready = true; readinessError = ''; }
      } catch { if (!closed) { ready = false; readinessError = '云端登录入口暂不可用，请稍后重试'; } }
      checkedAt = Date.now(); return !closed && ready;
    })().finally(() => { probing = undefined; });
    return probing;
  };
  const status = () => {
    if (!closed) void checkReady();
    return { configured: Boolean(!closed && server?.listening), enabled: Boolean(!closed && server?.listening && state.enabled), origin: origin || null, error: storageError || error || null, ready: !closed && ready, readinessError: readinessError || null };
  };
  const persist = async next => {
    if (closed) throw Error('云端鉴权服务已关闭');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + token() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); if (closed) throw Error('云端鉴权服务已关闭'); await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
    state = next; sessions.clear(); failures = 0; blockedUntil = 0;
  };
  const sessionCookie = () => {
    if (closed || storageError || !server?.listening || !state.enabled) throw Error('云端鉴权会话不可用');
    const value = token(), now = Date.now();
    for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
    sessions.set(digest(value), now + TTL); return cookie(value);
  };
  const authorized = request => {
    if (closed || storageError) return false;
    if (!state.enabled) return true;
    const values = String(request.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(COOKIE + '='));
    if (values.length !== 1) return false;
    const value = values[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    const key = digest(value), expiry = sessions.get(key);
    if (!expiry || expiry <= Date.now()) { sessions.delete(key); return false; } return true;
  };
  const manage = input => {
    if (closed) return Promise.reject(Error('云端鉴权服务已关闭'));
    const task = writes.then(async () => {
      if (closed) throw Error('云端鉴权服务已关闭');
      if (storageError) throw Error(storageError);
      if (!server?.listening) throw Error(error || '未配置云端鉴权服务，请先接入全站反向代理');
      if (input.operation === 'disable') await persist({ enabled: false });
      else if (['enable', 'rotate'].includes(input.operation)) {
        if (typeof input.key !== 'string' || input.key.length < 16 || input.key.length > 512 || !input.key.trim()) throw Error('访问密钥需为 16–512 个字符');
        if (input.operation === 'rotate' && !state.enabled) throw Error('请先启用云端访问密钥');
        if (!await checkReady(true)) throw Error('云端登录入口暂不可用，请稍后重试');
        const salt = token(), hash = (await scrypt(input.key, salt, 32)).toString('hex');
        await persist({ enabled: true, salt, hash });
      } else throw Error('不支持的云端访问操作');
      return status();
    }); writes = task.catch(() => {}); return task;
  };
  if (origin && !error) {
    server = createServer(async (request, response) => {
      const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
      const send = (status, value, extra = {}) => { response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', ...extra }); response.end(value === undefined ? undefined : JSON.stringify(value)); };
      try {
        if (closed || storageError) throw fail(storageError || '云端鉴权服务已关闭', 503);
        if (request.headers.host !== new URL(origin).host) throw fail('请求主机无效', 403);
        const url = new URL(request.url, origin);
        if (url.origin !== origin) throw fail('请求主机无效', 403);
        if (url.pathname === '/__dsh_access/check' && request.method === 'GET') { send(authorized(request) ? 204 : 401); return; }
        if (url.pathname === '/__dsh_access/login' && request.method === 'GET') {
          // Nginx appends its raw request URI (no njs needed): keep the entire
          // suffix, including &, existing percent escapes and nested queries.
          const rawNext = url.search.startsWith('?next=/') ? url.search.slice(6) : url.searchParams.get('next');
          const nonce = token(), next = redirectPath(rawNext);
          const html = loginPage(nonce, next);
          response.writeHead(200, { ...headers, 'x-dsh-cloud-ready': readinessProof, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }); response.end(html); return;
        }
        if (url.pathname !== '/__dsh_access/session' || !['POST', 'DELETE'].includes(request.method)) throw fail('未找到', 404);
        if (request.headers.origin !== origin || request.headers['x-dsh-access'] !== '1' || !String(request.headers['content-type'] || '').startsWith('application/json')) throw fail('来源未授权', 403);
        if (request.method === 'DELETE') {
          const value = String(request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
          if (value) sessions.delete(digest(value)); send(200, { ok: true }, { 'set-cookie': cookie('', 0) }); return;
        }
        if (Date.now() < blockedUntil || activeLogins >= 4) { send(429, { error: '尝试过多，请一分钟后重试' }, { 'retry-after': '60' }); return; }
        const input = await body(request);
        if (Date.now() < blockedUntil || activeLogins >= 4) { send(429, { error: '尝试过多，请一分钟后重试' }, { 'retry-after': '60' }); return; }
        if (!state.enabled) { send(200, { next: redirectPath(input.next) }); return; }
        if (typeof input.key !== 'string' || input.key.length < 16 || input.key.length > 512) { failures++; if (failures >= 5) { blockedUntil = Date.now() + 60_000; failures = 0; } throw fail('访问密钥无效', 401); }
        activeLogins++;
        let accepted; const snapshot = state;
        try { const actual = await scrypt(input.key, snapshot.salt, 32); accepted = state === snapshot && timingSafeEqual(actual, Buffer.from(snapshot.hash, 'hex')); } finally { activeLogins--; }
        if (!accepted) { failures++; if (failures >= 5) { blockedUntil = Date.now() + 60_000; failures = 0; } throw fail('访问密钥不正确', 401); }
        failures = 0; send(200, { next: redirectPath(input.next) }, { 'set-cookie': sessionCookie() });
      } catch (reason) { send(reason.status || 500, { error: reason.status ? reason.message : '鉴权服务暂不可用' }); }
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000;
    try {
      await new Promise((resolve, reject) => {
        const failed = reason => { server.removeListener('listening', started); reject(reason); };
        const started = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', started); server.listen(port, '127.0.0.1');
      });
    } catch {
      error = '云端鉴权端口不可用，请检查独立端口配置';
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined;
    }
  }
  return { status, manage, sessionCookie, checkReady, origin, get port() { return server?.address()?.port; }, close() {
    if (closing) return closing;
    closed = true; ready = false; sessions.clear();
    closing = (async () => { if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await writes; await probing; })();
    return closing;
  } };
}

function loginPage(nonce, next) {
  const safeNext = JSON.stringify(next).replace(/</g, String.fromCharCode(92) + 'u003c');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录小角</title><style nonce="' + nonce + '">:root{font:15px system-ui;color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:light-dark(#fffdf8,#171b1d)}main{box-sizing:border-box;width:min(420px,100%);padding:32px}h1{font-size:26px}p{line-height:1.7;color:light-dark(#647074,#a0abab)}label{display:grid;gap:10px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:13px;border:1px solid #8886;border-radius:10px}input{background:transparent}button{margin-top:18px;background:#2c6ee8;color:#fff;border:0;cursor:pointer}#error{color:light-dark(#b34845,#f0928d);min-height:1.5em}</style></head><body><main><h1>登录小角</h1><p>输入此工作区的云端访问密钥。</p><form><label>访问密钥<input type="password" name="key" autocomplete="current-password" minlength="16" maxlength="512" required autofocus></label><button>进入工作区</button><p id="error" role="alert"></p></form></main><script nonce="' + nonce + '">const f=document.querySelector("form"),e=document.querySelector("#error"),b=document.querySelector("button");f.addEventListener("submit",async v=>{v.preventDefault();b.disabled=true;e.textContent="";try{const r=await fetch("/__dsh_access/session",{method:"POST",headers:{"content-type":"application/json","x-dsh-access":"1"},body:JSON.stringify({key:f.elements.key.value,next:' + safeNext + '})});const x=await r.json();f.elements.key.value="";if(!r.ok)throw Error(x.error||"登录失败");const target=new URL(x.next,location.origin);if(!target.hash)target.hash=location.hash;location.replace(target.href)}catch(x){e.textContent=x.message}finally{b.disabled=false}});</script></body></html>';
}
