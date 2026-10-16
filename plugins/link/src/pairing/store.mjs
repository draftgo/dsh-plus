import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function sameSecret(value, digest) {
  if (typeof value !== 'string' || typeof digest !== 'string') return false;
  const a = Buffer.from(hash(value)), b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const text = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效的 ${name}`);
  return value.trim();
};

/** Device credentials are persisted as hashes. Pairing secrets exist for five minutes only. */
export async function openStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'devices.json');
  let saved = {};
  try { saved = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const state = { enabled: false, host: '0.0.0.0', port: 48721, publicUrl: '', ...saved };
  state.devices ??= [];
  const pairings = new Map(), pending = new Map();
  let writes = Promise.resolve();
  function persist() {
    const data = JSON.stringify(state, null, 2);
    const task = writes.then(async () => {
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, file); }
      finally { await rm(tmp, { force: true }); }
    });
    writes = task.catch(() => {});
    return task;
  }
  function prune() {
    for (const [key, value] of pairings) if (value.expiresAt <= Date.now()) pairings.delete(key);
    for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
  }
  return {
    state, persist, flush: () => writes,
    pending() { prune(); return [...pending.values()].filter(p => p.status === 'pending').map(({ id, name, createdAt, expiresAt }) => ({ id, name, createdAt, expiresAt })); },
    begin() {
      prune(); if (pairings.size + pending.size >= 32) throw new Error('配对请求过多，请稍后重试');
      const code = secret(), expiresAt = Date.now() + 300_000;
      pairings.set(hash(code), { expiresAt }); return { code, expiresAt };
    },
    request(code, name) {
      prune(); const key = hash(text(code, '配对码', 128)); const value = pairings.get(key);
      if (!value) throw new Error('配对码已使用或过期');
      pairings.delete(key);
      const pollToken = secret(), id = randomUUID();
      pending.set(id, { id, name: text(name, '设备名称', 100), createdAt: Date.now(), expiresAt: value.expiresAt, pollHash: hash(pollToken), status: 'pending' });
      return { requestId: id, pollToken, expiresAt: value.expiresAt };
    },
    poll(id, pollToken) {
      prune(); const p = pending.get(id);
      if (!p || !sameSecret(pollToken, p.pollHash)) throw new Error('配对请求已过期或验证失败');
      return { status: p.status, ...(p.status === 'approved' ? { token: p.token, deviceId: p.deviceId } : {}) };
    },
    async decide(id, allow) {
      prune(); const p = pending.get(id);
      if (!p || p.status !== 'pending') throw new Error('配对请求已失效');
      if (!allow) { p.status = 'rejected'; return; }
      if (state.devices.length >= 32) throw new Error('最多配对 32 台设备，请先撤销不用的设备');
      p.status = 'approving';
      const token = secret(), device = { id: randomUUID(), name: p.name, tokenHash: hash(token), pairedAt: Date.now(), lastSeenAt: Date.now() };
      state.devices.push(device);
      try { await persist(); } catch (e) { state.devices = state.devices.filter(d => d !== device); p.status = 'pending'; throw e; }
      p.token = token; p.deviceId = device.id; p.status = 'approved';
    },
    authenticate(token) {
      if (typeof token !== 'string' || token.length > 256) return;
      const d = state.devices.find(d => sameSecret(token, d.tokenHash));
      if (d) d.lastSeenAt = Date.now(); return d;
    },
    async revoke(id) {
      state.devices = state.devices.filter(d => d.id !== id);
      for (const [key, value] of pending) if (value.deviceId === id) pending.delete(key);
      await persist();
    },
    clearPairings() { pairings.clear(); pending.clear(); },
  };
}
