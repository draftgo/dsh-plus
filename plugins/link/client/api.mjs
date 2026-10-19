const native = () => typeof window !== 'undefined' && window.LinkNative;
let sequence = 0;
const pending = new Map();
let browserIdentity;
const localSaves = new Map();
const identityKey = value => JSON.stringify([
  String(value?.url || '').trim().replace(/\/+$/, ''), String(value?.pin || '').trim().replace(/^sha256\//, ''),
  String(value?.code || '').trim(), String(value?.name || '').slice(0, 128), String(value?.token || '').trim(),
]);
if (typeof window !== 'undefined') window.__linkNativeResult = (id, value) => {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id); clearTimeout(request.timer);
  try {
    let result = typeof value === 'string' ? JSON.parse(value) : value;
    if (result && 'ok' in result && result.ok === false) throw new Error(result.error || '设备操作失败');
    if (result && 'body' in result) {
      const envelope = result;
      result = typeof envelope.body === 'string' ? JSON.parse(envelope.body) : envelope.body;
      if (!envelope.ok || envelope.status >= 400) throw new Error(result?.error || `连接服务返回 HTTP ${envelope.status}`);
    }
    if (result?.error) request.reject(new Error(result.error)); else request.resolve(result);
  } catch (error) { request.reject(error); }
};
export const isNative = () => Boolean(native());
export function bootstrap() {
  try {
    const value = native()?.bootstrap?.();
    if (value) return typeof value === 'string' ? JSON.parse(value) : value;
    return browserIdentity || JSON.parse(sessionStorage.getItem('dsh.link.identity') || 'null');
  } catch { return browserIdentity || null; }
}
export function saveIdentity(identity) {
  if (isNative()) {
    const raw = native().saveIdentity(JSON.stringify(identity));
    const result = typeof raw === 'string' && raw ? JSON.parse(raw) : raw;
    if (result?.error) throw new Error(result.error);
    const key = identityKey(identity);
    localSaves.set(key, { count: (localSaves.get(key)?.count || 0) + 1, expiresAt: Date.now() + 15_000 });
  }
  else { browserIdentity = identity; try { sessionStorage.setItem('dsh.link.identity', JSON.stringify(identity)); } catch {} }
  window.dispatchEvent(new Event('link:identity-updated'));
}
/** The Android bridge emits bootstrap after both scanning and JS identity saves. */
export function isLocalIdentitySave(identity) {
  for (const [key, value] of localSaves) if (value.expiresAt <= Date.now()) localSaves.delete(key);
  const key = identityKey(identity), value = localSaves.get(key);
  if (!value) return false;
  if (value.count === 1) localSaves.delete(key); else value.count--;
  return true;
}
export function clearIdentity() {
  localSaves.clear();
  if (isNative()) native().clearIdentity();
  else { browserIdentity = null; try { sessionStorage.removeItem('dsh.link.identity'); } catch {} }
}
export function scan() { native()?.scan?.(); }
export async function openWorkbench() {
  if (isNative()) {
    if (!native().openWorkbench) throw new Error('请更新 Android 客户端以打开完整工作台');
    const raw = native().openWorkbench();
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (result?.error) throw new Error(result.error);
    return;
  }
  const result = await jsonPost(new URL('/link/api/workbench', location.origin), {}, undefined, bootstrap()?.token);
  if (result.url !== '/link/workbench/') throw new Error('工作台地址无效，请重新连接');
  location.assign(result.url);
}
export function nativeCall(method, path, body) {
  const bridge = native();
  if (!bridge?.request) return Promise.reject(new Error('当前客户端不支持原生连接'));
  const id = `link-${Date.now()}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('连接超时，请检查网络后重试')); }, 25000);
    pending.set(id, { resolve, reject, timer });
    try { bridge.request(JSON.stringify({ id, method, path, body })); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}
/** Device management stays on the trusted local carrier, never a remote page. */
export function nativeDeviceCall(action, args = {}) {
  const bridge = native();
  if (!bridge?.deviceCall) return Promise.reject(new Error('请更新客户端以管理多台设备'));
  const id = `device-${Date.now()}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('设备操作超时，请重试')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    try { bridge.deviceCall(JSON.stringify({ ...args, action, id })); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}
async function jsonPost(url, body, signal, token) {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.error) throw new Error(value.error || `连接服务返回 HTTP ${response.status}`);
  return value;
}
export function managementCall(action, args = {}, signal) {
  return jsonPost(new URL('api/commander-link', document.baseURI), { action, ...args }, signal);
}
export function call(action, args = {}, signal) {
  const path = action === 'pair' ? '/link/api/pair' : action === 'pair/status' ? '/link/api/pair/status' : '/link/api/rpc';
  const body = path.endsWith('/rpc') ? { action, ...args } : args;
  if (isNative()) return nativeCall('POST', path, body);
  return jsonPost(new URL(path, location.origin), body, signal, bootstrap()?.token);
}
export function pairingContext(input) {
  const value = input.trim();
  if (!value) throw new Error('请先扫描或粘贴配对地址');
  if (!value.includes('://')) {
    if (isNative()) throw new Error('请扫描二维码或粘贴包含主机地址的完整配对链接');
    return { url: location.origin, code: value };
  }
  const uri = new URL(value);
  if (uri.protocol === 'dshlink:') {
    const url = uri.searchParams.get('url');
    if (!url || new URL(url).protocol !== 'https:') throw new Error('配对主机必须使用 HTTPS');
    return { url, code: uri.searchParams.get('code') || '', pin: uri.searchParams.get('pin') || '' };
  }
  if (uri.protocol !== 'https:' || (!isNative() && uri.origin !== location.origin)) throw new Error('请在主机提供的 HTTPS 页面中配对');
  return { url: uri.origin, code: new URLSearchParams(uri.hash.slice(1)).get('code') || uri.searchParams.get('code') || '' };
}
export function contextUri(value) {
  if (!value?.url || !value?.code) return '';
  return `dshlink://pair?${new URLSearchParams({ url: value.url, pin: value.pin || '', code: value.code })}`;
}
export function requestId() { return globalThis.crypto?.randomUUID?.() || `link-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
