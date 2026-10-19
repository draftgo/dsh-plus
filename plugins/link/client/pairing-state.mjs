const DEVICE_NAME_KEY = 'dsh.link.device-name';

/** A readable device label, never an authentication secret. */
export function deviceName(preferred = '', { persist = true } = {}) {
  let saved = '';
  if (persist) try { saved = globalThis.localStorage?.getItem(DEVICE_NAME_KEY) || ''; } catch {}
  const existing = String(preferred || saved).trim();
  if (existing) return existing.slice(0, 100);
  const bytes = new Uint8Array(5);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  return '我的手机-' + Array.from(bytes, value => String.fromCharCode(65 + value % 26)).join('');
}

export function rememberDeviceName(name) {
  const value = String(name || '').trim().slice(0, 100);
  if (value) try { globalThis.localStorage?.setItem(DEVICE_NAME_KEY, value); } catch {}
}
