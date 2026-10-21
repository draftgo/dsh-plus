import { join } from 'node:path';
import { hostname } from 'node:os';
import { openStore, text } from './pairing/store.mjs';
import { loadIdentity } from './transport/tls.mjs';
import { listen, connectionAddresses, authority, validateConfig } from './transport/server.mjs';
import { createSessionAdapter } from './session/adapter.mjs';
import { createNativeAdapter } from './session/native.mjs';
import { createDeviceCenter } from './devices/center.mjs';
import { createWorkbench } from './transport/workbench.mjs';
import { createCloudAccess } from './cloud-access.mjs';
import { createCloudDeviceGateway } from './devices/cloud-gateway.mjs';

/** Owner admin uses Harness Connection; remote devices get a distinct TLS carrier. */
export async function mountLink(ctx, config = {}) {
  const directory = config.directory ?? join(ctx.get('commander').store.directory, 'link');
  const store = await openStore(directory);
  validateConfig({}, store.state);
  const sessions = createSessionAdapter(ctx);
  const native = createNativeAdapter(ctx);
  const cloudAccess = await createCloudAccess(directory, { env: config.env ?? process.env, probe: config.cloudProbe });
  const dispatch = async (input, device) => {
    if (input?.id?.startsWith('native:')) return native.dispatch(input);
    const result = await sessions.dispatch(input, device);
    if (input.action === 'state') result.sessions.push(...native.list());
    return result;
  };
  let listener, identity, workbench, error = '', closed = false, closing, changes = Promise.resolve();
  const webRoot = config.webRoot ?? new URL('../dist/web/', import.meta.url);
  const start = async () => {
    identity ??= await loadIdentity(directory);
    workbench = createWorkbench(ctx, store, { webRoot, workbenchRoot: config.workbenchRoot });
    listener = await listen({ identity, config: { ...store.state }, webRoot, store, dispatch, workbench, onError: e => { error = e.message; } });
    error = '';
  };
  const status = () => ({
    enabled: Boolean(listener), host: store.state.host, port: listener?.port ?? store.state.port, publicUrl: store.state.publicUrl,
    hostName: hostname(), error: error || null,
    addresses: connectionAddresses(store.state.host).map(a => `https://${authority(a, listener?.port ?? store.state.port)}`),
    devices: store.state.devices.map(({ tokenHash, ...device }) => device), pending: store.pending(),
    cloudAccess: cloudAccess.status(),
  });
  const admin = async input => {
    if (closed) throw new Error('Link 已关闭');
    const action = text(input?.action, '操作');
    if (action === 'status') return status();
    if (action === 'cloud-access') { await cloudAccess.manage(input); return status(); }
    if (action === 'configure') {
      const task = changes.then(async () => {
        if (closed) throw new Error('Link 已关闭');
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
      const addresses = status().addresses;
      let url = mode === 'public' ? store.state.publicUrl : addresses[0];
      if (mode === 'public' && !store.state.publicUrl) throw new Error('请先保存可达的公网 HTTPS 地址');
      if (input.address !== undefined) {
        if (mode !== 'lan' || !addresses.includes(input.address)) throw new Error('局域网地址无效');
        url = input.address;
      }
      if (!url) throw new Error('未找到可用的连接地址，请检查网络或在高级设置中指定监听地址');
      const pair = store.begin();
      const query = new URLSearchParams({ url, pin: mode === 'lan' ? identity.pin : '', code: pair.code });
      return { ...pair, mode, uri: `dshlink://pair?${query}`, ...(mode === 'public' ? { webUrl: `${url}/link/#code=${encodeURIComponent(pair.code)}` } : {}), url };
    }
    if (action === 'confirm' || action === 'reject') { await store.decide(text(input.id, '设备 ID'), action === 'confirm'); return status(); }
    if (action === 'revoke') { const id = text(input.id, '设备 ID'); await store.revoke(id); await Promise.all([sessions.revoke(id), workbench?.revoke(id)]); return status(); }
    throw new Error('不支持的管理操作');
  };
  let deviceCenter, cloudCenter, cloudGateway;
  const env = config.env ?? process.env;
  const getCloudCenter = () => cloudCenter ??= createDeviceCenter({ directory: join(directory, 'cloud-outgoing'), webRoot, hostAdmin: admin, publicOrigin: cloudAccess.origin, workbenchOrigin: env.DSH_LINK_WORKBENCH_ORIGIN, registerProxy: () => cloudGateway.registerProxy() }).catch(error => { cloudCenter = undefined; throw error; });
  if (env.DSH_LINK_DEVICE_GATEWAY_PORT) cloudGateway = await createCloudDeviceGateway({ ownerOrigin: cloudAccess.origin, workbenchOrigin: env.DSH_LINK_WORKBENCH_ORIGIN, port: Number(env.DSH_LINK_DEVICE_GATEWAY_PORT), getCenter: getCloudCenter });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander-devices', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (closed) throw new Error('Link 已关闭');
        const input = await request.json();
        if (input.action !== 'launch') throw new Error('不支持的设备操作');
        const requestedParent = input.parentOrigin;
        // The official HTTP bridge uses dsh.internal in request.url; browser
        // Origin and the carrier Host retain the actual admitted page address.
        const origin = request.headers.get('origin');
        const host = request.headers.get('host');
        const carrier = host ? new URL('http://' + host) : new URL(request.url);
        const local = value => ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname);
        const native = !origin && local(carrier) && ['dsh-app://app', 'dsh-app://localhost'].includes(requestedParent);
        const page = origin ? new URL(origin) : carrier;
        const parent = native ? requestedParent : page.origin;
        if (!native && (!['http:', 'https:'].includes(page.protocol) || !local(page))) {
          if (!cloudGateway || page.origin !== cloudAccess.origin) return Response.json({ error: '请配置云端设备网关后重试；本机小角可继续管理设备。', code: 'CLOUD_DEVICE_GATEWAY_REQUIRED' }, { status: 409, headers: { 'cache-control': 'no-store' } });
          const center = await getCloudCenter();
          return Response.json(center.launch(page.origin), { headers: { 'cache-control': 'no-store' } });
        }
        deviceCenter ??= createDeviceCenter({ directory: join(directory, 'outgoing'), webRoot, hostAdmin: admin }).catch(error => { deviceCenter = undefined; throw error; });
        const center = await deviceCenter;
        if (closed) throw new Error('Link 已关闭');
        return Response.json(center.launch(parent), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  const close = () => {
    if (closing) return closing;
    closed = true;
    const cloudClosing = cloudAccess.close();
    closing = (async () => {
      await (await deviceCenter?.catch(() => undefined))?.close();
      await cloudGateway?.close();
      await (await cloudCenter?.catch(() => undefined))?.close();
      await cloudClosing;
      await changes; await listener?.close(); listener = undefined; await sessions.close(); store.clearPairings(); await store.flush();
    })();
    return closing;
  };
  try { if (store.state.enabled) await start(); } catch (e) { error = e.message; }
  ctx.effect(() => () => close());
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander-link', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json(), value = await admin(input);
        const headers = { 'cache-control': 'no-store' };
        // The browser keeps its owner session when a key is enabled or rotated.
        // A local/Desktop administrator logs into the cloud domain separately.
        if (input.action === 'cloud-access' && ['enable', 'rotate'].includes(input.operation) && request.headers.get('origin') === cloudAccess.origin) headers['set-cookie'] = cloudAccess.sessionCookie();
        return Response.json(value, { headers });
      }
      catch (e) { return Response.json({ error: e.message }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  return { admin, status, close };
}
