import { join } from 'node:path';
import { hostname } from 'node:os';
import { openStore, text } from './pairing/store.mjs';
import { loadIdentity } from './transport/tls.mjs';
import { listen, localAddresses, authority, validateConfig } from './transport/server.mjs';
import { createSessionAdapter } from './session/adapter.mjs';
import { createNativeAdapter } from './session/native.mjs';

/** Owner admin uses Harness Connection; remote devices get a distinct TLS carrier. */
export async function mountLink(ctx, config = {}) {
  const directory = config.directory ?? join(ctx.get('commander').store.directory, 'link');
  const store = await openStore(directory);
  validateConfig({}, store.state);
  const sessions = createSessionAdapter(ctx);
  const native = createNativeAdapter(ctx);
  const dispatch = async (input, device) => {
    if (input?.id?.startsWith('native:')) return native.dispatch(input);
    const result = await sessions.dispatch(input, device);
    if (input.action === 'state') result.sessions.push(...native.list());
    return result;
  };
  let listener, identity, error = '', closed = false, changes = Promise.resolve();
  const webRoot = config.webRoot ?? new URL('../dist/web/', import.meta.url);
  const start = async () => {
    identity ??= await loadIdentity(directory);
    listener = await listen({ identity, config: { ...store.state }, webRoot, store, dispatch, onError: e => { error = e.message; } });
    error = '';
  };
  const status = () => ({
    enabled: Boolean(listener), host: store.state.host, port: listener?.port ?? store.state.port, publicUrl: store.state.publicUrl,
    hostName: hostname(), error: error || null,
    addresses: (store.state.host === '0.0.0.0' || store.state.host === '::' ? localAddresses() : [store.state.host]).map(a => `https://${authority(a, listener?.port ?? store.state.port)}`),
    devices: store.state.devices.map(({ tokenHash, ...device }) => device), pending: store.pending(),
  });
  const admin = async input => {
    if (closed) throw new Error('Link 已关闭');
    const action = text(input?.action, '操作');
    if (action === 'status') return status();
    if (action === 'configure') {
      const task = changes.then(async () => {
        const value = validateConfig(input, store.state);
        store.clearPairings(); await listener?.close(); listener = undefined; await sessions.close();
        Object.assign(store.state, value);
        try { if (value.enabled) await start(); }
        catch (e) { error = e.message; store.state.enabled = false; await store.persist(); throw e; }
        await store.persist(); return status();
      });
      changes = task.catch(() => {}); return task;
    }
    if (action === 'pairing') {
      if (!listener) throw new Error('请先启用 Link');
      const mode = input.mode ?? 'lan';
      if (!['lan', 'public'].includes(mode)) throw new Error('连接模式无效');
      let url = mode === 'public' ? store.state.publicUrl : status().addresses.find(a => !a.includes('[')) ?? status().addresses[0];
      url ||= `https://127.0.0.1:${listener.port}`;
      if (mode === 'public' && !store.state.publicUrl) throw new Error('请先保存可达的公网 HTTPS 地址');
      if (input.address !== undefined) {
        if (mode !== 'lan' || !status().addresses.includes(input.address)) throw new Error('局域网地址无效');
        url = input.address;
      }
      const pair = store.begin();
      const query = new URLSearchParams({ url, pin: mode === 'lan' ? identity.pin : '', code: pair.code });
      return { ...pair, mode, uri: `dshlink://pair?${query}`, ...(mode === 'public' ? { webUrl: `${url}/link/#code=${encodeURIComponent(pair.code)}` } : {}), url };
    }
    if (action === 'confirm' || action === 'reject') { await store.decide(text(input.id, '设备 ID'), action === 'confirm'); return status(); }
    if (action === 'revoke') { const id = text(input.id, '设备 ID'); await store.revoke(id); await sessions.revoke(id); return status(); }
    throw new Error('不支持的管理操作');
  };
  const close = async () => {
    closed = true; await changes; await listener?.close(); listener = undefined; await sessions.close(); store.clearPairings(); await store.flush();
  };
  try { if (store.state.enabled) await start(); } catch (e) { error = e.message; }
  ctx.effect(() => () => close());
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander-link', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try { return Response.json(await admin(await request.json()), { headers: { 'cache-control': 'no-store' } }); }
      catch (e) { return Response.json({ error: e.message }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  return { admin, status, close };
}
