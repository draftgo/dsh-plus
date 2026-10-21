/** Device management belongs to a local owner, never to a paired transport. */
export function deviceLauncherMode(scope = globalThis) {
  if (scope.__DSH_LINK_WORKBENCH__ || (scope.__DSH_TRANSPORT__ && scope.__DSH_TRANSPORT__.ownsHost !== true)) return 'remote';
  if (scope.__DSH_TRANSPORT__?.ownsHost === true) return 'owner';
  const page = scope.location;
  return page?.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname) ? 'owner' : 'cloud';
}

const validOrigin = origin => {
  try { const url = new URL(origin); return ['http:', 'https:', 'dsh-app:'].includes(url.protocol) && (url.origin === origin || (url.protocol === 'dsh-app:' && 'dsh-app://' + url.host === origin)); } catch { return false; }
};
const deviceName = value => typeof value === 'string' ? value.trim().slice(0, 100) : '';

/** Only the embedding parent initializes navigation; lock its first origin. */
export function connectDeviceNavigation({ host = globalThis, onChange = () => {}, ready = false } = {}) {
  let parentOrigin = '', disposed = false, current = null;
  const native = host.XiaojiaoDevices && typeof host.XiaojiaoDevices.postMessage === 'function';
  const embedded = host.parent && host.parent !== host;
  const publish = name => { current = name ? { name } : null; onChange(current); };
  const send = type => {
    if (native) host.XiaojiaoDevices.postMessage(JSON.stringify({ type }));
    else if (embedded) host.parent.postMessage({ type }, parentOrigin || '*');
  };
  const receive = event => {
    if (native || !embedded || event.source !== host.parent || !validOrigin(event.origin) || (parentOrigin && event.origin !== parentOrigin)) return;
    if (event.data?.type === 'dsh-devices:probe') { if (ready) host.parent.postMessage({ type: 'dsh-devices:ready' }, event.origin); return; }
    if (event.data?.type !== 'dsh-devices:init') return;
    const name = deviceName(event.data.name); if (!name) return;
    parentOrigin = event.origin; publish(name);
  };
  const syncNative = () => {
    if (!native) return;
    publish(deviceName(host.__DSH_DEVICE_NAVIGATION__?.name));
    if (ready && current) send('dsh-devices:ready');
  };
  host.addEventListener('message', receive);
  host.addEventListener('dsh-devices:navigation', syncNative);
  syncNative();
  if (ready && !native && embedded) send('dsh-devices:ready');
  return {
    showDevices() { if (!current || disposed) return false; send('dsh-devices:show'); return true; },
    dispose() {
      if (disposed) return; disposed = true;
      host.removeEventListener('message', receive); host.removeEventListener('dsh-devices:navigation', syncNative);
      if (ready && (native || embedded)) send('dsh-devices:unready');
    },
  };
}

/** Match mounted frame plus exact origin without cross-origin DOM access. */
export function workbenchNavigationMessage(event, frames) {
  if (!['dsh-devices:ready', 'dsh-devices:show', 'dsh-devices:unready'].includes(event.data?.type)) return null;
  const frame = frames.find(item => item.window === event.source && new URL(item.url).origin === event.origin);
  return frame ? { id: frame.id, type: event.data.type } : null;
}
