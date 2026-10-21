import { bootstrap, isNative, nativeDeviceCall, scan, contextUri } from './api.mjs';
import { deviceName } from './pairing-state.mjs';
export const hasDeviceCenter = () => Boolean(globalThis.__DSH_DEVICE_CENTER__ || (isNative() && bootstrap()?.capabilities?.devices));
export const deviceRuntime = {
  bootstrap, isNative, scan, contextUri,
  hostCall(action, input = {}) {
    if (action === 'cloud-access' && globalThis.location?.protocol === 'https:' && globalThis.location.pathname.startsWith('/devices/')) {
      return fetch(new URL('/api/commander-link', location.origin), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }), signal: AbortSignal.timeout(10000) }).then(async response => { const value = await response.json(); if (!response.ok || value.error) throw new Error(value.error || '访问密钥更新失败'); return value; });
    }
    const actions = { relayConfigure: 'hostRelayConfigure', 'cloud-access': 'hostCloudAccess', status: 'hostStatus', configure: 'hostConfigure', pairing: 'hostPairing', confirm: 'hostConfirm', reject: 'hostReject', revoke: 'hostRevoke' };
    if (!actions[action]) return Promise.reject(new Error('当前设备中心不支持此高级设置，请在主机设置中操作'));
    return deviceRuntime.call(actions[action], input);
  },
  clientName: () => isNative() ? deviceName() : '这台电脑',
  async call(action, args = {}) {
    if (isNative()) return nativeDeviceCall(action, args);
    const response = await fetch(new URL('api/devices', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...args, action }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw new Error(result.error || `设备服务返回 HTTP ${response.status}`);
    return result;
  },
};
