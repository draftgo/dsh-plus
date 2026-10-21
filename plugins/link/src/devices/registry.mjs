import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
const label = value => { if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('设备名称应为 1–100 个字符'); return value.trim(); };
export function normalizeTarget(value) {
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('设备地址必须是 HTTPS 主机地址');
  const pin = String(value.pin || '').replace(/^sha256\//, '');
  if (pin && (!/^[A-Za-z0-9+/]{43}=$/.test(pin) || Buffer.from(pin, 'base64').length !== 32)) throw new Error('主机公钥指纹无效');
  return { url: url.origin, pin };
}
export function normalizeRoutes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new Error('设备连接路线无效');
  return value.map(route => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('设备连接路线无效');
    const allowed = route.kind === 'direct' ? ['kind', 'url', 'pin'] : route.kind === 'relay' ? ['kind', 'url'] : [];
    if (!allowed.length || Object.keys(route).some(key => !allowed.includes(key))) throw new Error('设备连接路线无效');
    const target = normalizeTarget({ url: route.url, pin: route.pin });
    if (route.kind === 'direct' && !target.pin) throw new Error('直连路线必须固定主机指纹');
    if (route.kind === 'relay' && route.pin) throw new Error('中继路线必须使用系统 CA 验证');
    return route.kind === 'direct' ? { kind: 'direct', ...target } : { kind: 'relay', url: target.url };
  });
}
export async function openDeviceRegistry(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'connections.json');
  let state = { version: 1, activeId: 'local', devices: [] };
  try { state = JSON.parse(await readFile(file, 'utf8')); await chmod(file, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.version !== 1 || !Array.isArray(state.devices)) throw new Error('设备配置格式不受支持');
  // Runtime liveness must be checked again after restarting the local carrier.
  state.devices.forEach(value => { value.status = 'unknown'; value.lastError = null; value.currentPath = null; });
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify({ ...state, devices: state.devices.map(({ currentPath, ...device }) => device) }, null, 2), temporary = file + '.' + randomUUID() + '.tmp';
    const task = writes.then(async () => { try { await writeFile(temporary, snapshot, { mode: 0o600 }); await rename(temporary, file); } finally { await rm(temporary, { force: true }); } });
    writes = task.catch(() => {}); return task;
  };
  const get = id => { const result = state.devices.find(value => value.id === id); if (!result) throw new Error('设备不存在'); return result; };
  const publicDevice = value => ({ id: value.id, name: value.name, kind: value.kind, url: value.kind === 'ssh' ? value.ssh?.host : value.url, status: value.status || 'unknown', lastError: value.lastError || null, currentPath: value.currentPath ?? null, ...(value.warning ? { warning: value.warning } : {}) });
  return {
    get, publicDevice,
    list() { return { activeId: state.activeId, devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, ...state.devices.map(publicDevice)] }; },
    async upsert(input) {
      const target = normalizeTarget(input), routes = normalizeRoutes(input.routes), existing = input.id ? state.devices.find(value => value.id === input.id) : state.devices.find(value => value.kind !== 'ssh' && value.url === target.url && value.pin === target.pin);
      if (state.devices.length >= 32 && !existing) throw new Error('最多保存 32 台设备');
      if (typeof input.token !== 'string' || !input.token || input.token.length > 4096) throw new Error('设备授权无效');
      const value = { ...existing, ...input, ...target, ...(routes === undefined ? {} : { routes }), id: existing?.id || input.id || randomUUID(), name: label(input.name || existing?.name || new URL(target.url).hostname), kind: input.kind === 'ssh' ? 'ssh' : 'computer', status: 'online', lastError: null, currentPath: existing?.currentPath ?? null };
      state.devices = [...state.devices.filter(row => row.id !== value.id), value];
      await persist(); return publicDevice(value);
    },
    async select(id) { if (id !== 'local') get(id); state.activeId = id; await persist(); return id === 'local' ? { id, name: '本机', kind: 'local', status: 'online' } : publicDevice(get(id)); },
    async rename(id, name) { const value = get(id); value.name = label(name); await persist(); return publicDevice(value); },
    async remove(id) { get(id); state.devices = state.devices.filter(row => row.id !== id); if (state.activeId === id) state.activeId = 'local'; await persist(); },
    mark(id, status, lastError = null) { const value = get(id); value.status = status; value.lastError = lastError; },
    markRoute(id, kind) { if (kind !== 'direct' && kind !== 'relay') throw new Error('设备连接路线无效'); get(id).currentPath = kind; },
    flush: () => writes,
  };
}
