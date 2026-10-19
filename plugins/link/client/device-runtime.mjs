import { bootstrap, isNative, nativeDeviceCall, scan, contextUri } from './api.mjs';
import { deviceName } from './pairing-state.mjs';
export const hasDeviceCenter = () => Boolean(globalThis.__DSH_DEVICE_CENTER__ || (isNative() && bootstrap()?.capabilities?.devices));
export const deviceRuntime = {
  bootstrap, isNative, scan, contextUri,
  clientName: () => isNative() ? deviceName() : '这台电脑',
  async call(action, args = {}) {
    if (isNative()) return nativeDeviceCall(action, args);
    const response = await fetch(new URL('api/devices', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...args, action }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw new Error(result.error || `设备服务返回 HTTP ${response.status}`);
    return result;
  },
};
