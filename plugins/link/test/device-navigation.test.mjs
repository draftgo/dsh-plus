import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { connectDeviceNavigation, deviceLauncherMode, workbenchNavigationMessage } from '../client/device-navigation.mjs';
import { readJsonResponse } from '../../commander/client/http-response.mjs';
import { observeHostTheme, readHostTheme } from '../client/device-theme.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const source = await readFile(new URL('../client/device-launcher.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const nodes = value => value && typeof value === 'object' ? [value, ...(value.children || []).flatMap(nodes)] : [];
const textOf = value => typeof value === 'object' ? (value?.children || []).map(textOf).join('') : String(value ?? '');
function eventHost() {
  const listeners = new Map(), sent = [];
  return { sent, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }, emit(type, event) { for (const fn of [...(listeners.get(type) || [])]) fn(event); }, postMessage(data, origin) { sent.push({ data, origin }); } };
}
function fixture(options = {}) {
  let cursor = 0, dirty = true, tree;
  const slots = [], effects = [], requests = [];
  const host = Object.assign(eventHost(), { location: new URL(options.url || 'http://localhost:8000/'), ...options.globals });
  host.parent = host;
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(item => item !== false && item != null) }; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, j) => !Object.is(value, old.deps[j]))) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, globalThis: host, window: host, location: host.location, URL,
    document: { baseURI: host.location.href, body: {} },
    fetch: async (url, input) => { requests.push({ url: String(url), input }); return options.response?.() || Response.json({ url: 'http://127.0.0.1:9000/enter?ticket=one' }); },
    require: id => id === 'react' ? react : id === 'react-dom' ? { createPortal: child => child } : id.includes('device-navigation') ? { connectDeviceNavigation: args => connectDeviceNavigation({ ...args, host }), deviceLauncherMode: () => deviceLauncherMode(host) } : id.includes('device-theme') ? { observeHostTheme: listener => observeHostTheme(listener, host), readHostTheme: () => readHostTheme(host) } : id.includes('http-response') ? { readJsonResponse } : {},
  });
  const render = () => {
    dirty = false; cursor = 0; tree = module.exports.DeviceLauncher({ compact: options.compact });
    for (const node of nodes(tree)) if (node.props.ref && !node.props.ref.current) node.props.ref.current = node.type === 'dialog' ? { open: false, showModal() { this.open = true; }, close() { this.open = false; } } : { contentWindow: eventHost() };
    for (const effect of effects.splice(0)) effect();
  };
  return { host, requests, get tree() { return tree; }, nodes: () => nodes(tree), async settle() { for (let i = 0; i < 8; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

test('owner capabilities distinguish Desktop, local browser, cloud and paired transports', () => {
  assert.equal(deviceLauncherMode({ __DSH_TRANSPORT__: { ownsHost: true } }), 'owner');
  assert.equal(deviceLauncherMode({ location: new URL('http://localhost:8000') }), 'owner');
  assert.equal(deviceLauncherMode({ location: new URL('http://127.0.0.1:8000') }), 'owner');
  assert.equal(deviceLauncherMode({ location: new URL('https://dsh.draftgo.cn') }), 'cloud');
  assert.equal(deviceLauncherMode({ __DSH_TRANSPORT__: {} }), 'remote');
  assert.equal(deviceLauncherMode({ __DSH_LINK_WORKBENCH__: true, __DSH_TRANSPORT__: { ownsHost: true } }), 'remote');
});

test('cloud launcher opens the owner hosted centre and never a browser loopback', async () => {
  const view = fixture({ url: 'https://dsh.draftgo.cn/', response: () => Response.json({ url: 'https://dsh.draftgo.cn/devices/enter?ticket=one' }) }); await view.settle();
  await view.nodes().find(node => node.props['aria-label'] === '设备中心').props.onClick(); await view.settle();
  assert.equal(view.requests.length, 1);
  assert(view.nodes().some(node => node.type === 'iframe' && node.props.src.startsWith('https://dsh.draftgo.cn/devices/')));
  const invalid = fixture({ url: 'https://dsh.draftgo.cn/' }); await invalid.settle();
  await invalid.nodes().find(node => node.props['aria-label'] === '设备中心').props.onClick(); await invalid.settle();
  assert.match(textOf(invalid.tree), /设备中心地址无效/);
});

test('Desktop launcher stays available and HTML 403 preserves status and API path', async () => {
  const view = fixture({ globals: { __DSH_TRANSPORT__: { ownsHost: true } }, response: () => new Response('<html>Forbidden</html>', { status: 403 }) }); await view.settle();
  await view.nodes().find(node => node.props['aria-label'] === '设备中心').props.onClick(); await view.settle();
  assert.match(textOf(view.tree), /HTTP 403 · \/api\/commander-devices/);
  assert.equal(view.requests.length, 1); assert(view.nodes().some(node => node.type === 'button' && textOf(node) === '重试')); view.unmount();
});

test('closing and reopening preserves the centre iframe and avoids a second launch', async () => {
  const view = fixture(); await view.settle();
  const launch = () => view.nodes().find(node => node.props['aria-label'] === '设备中心').props.onClick();
  await launch(); await view.settle(); const frame = view.nodes().find(node => node.type === 'iframe');
  view.nodes().find(node => node.props['aria-label'] === '关闭设备中心').props.onClick(); await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src);
  await launch(); await view.settle(); assert.equal(view.requests.length, 1); view.unmount();
});

test('launcher carries and updates the resolved host appearance for its mounted centre', async () => {
  let sync;
  const root = { style: { colorScheme: 'light' } };
  const view = fixture({ globals: { document: { documentElement: root }, matchMedia: () => ({ matches: true }), MutationObserver: class { constructor(fn) { sync = fn; } observe() {} disconnect() {} } } });
  await view.settle();
  await view.nodes().find(node => node.props['aria-label'] === '设备中心').props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe'), target = frame.props.ref.current.contentWindow;
  assert.equal(new URL(frame.props.src).searchParams.get('theme'), 'light');
  assert.equal(view.nodes().find(node => node.type === 'dialog').props['data-theme'], 'light');
  assert.equal(target.sent.at(-1).data.theme, 'light');
  root.style.colorScheme = 'dark'; sync(); await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'dialog').props['data-theme'], 'dark');
  assert.equal(target.sent.at(-1).data.theme, 'dark');
  const count = target.sent.length;
  view.host.emit('message', { source: {}, origin: new URL(frame.props.src).origin, data: { type: 'dsh-devices:theme-ready' } });
  assert.equal(target.sent.length, count);
  view.host.emit('message', { source: target, origin: new URL(frame.props.src).origin, data: { type: 'dsh-devices:theme-ready' } });
  assert.equal(target.sent.length, count + 1);
  assert.equal(target.sent.at(-1).data.theme, 'dark'); view.unmount();
});

test('embedded navigation requires parent source and fixes its trusted origin', () => {
  const host = eventHost(), parent = eventHost(), values = []; host.parent = parent;
  const nav = connectDeviceNavigation({ host, onChange: value => values.push(value), ready: true });
  assert.equal(parent.sent[0].data.type, 'dsh-devices:ready');
  host.emit('message', { source: {}, origin: 'https://parent.test', data: { type: 'dsh-devices:init', name: '伪造' } });
  host.emit('message', { source: parent, origin: 'null', data: { type: 'dsh-devices:init', name: '伪造' } }); assert.equal(values.length, 0);
  host.emit('message', { source: parent, origin: 'https://parent.test', data: { type: 'dsh-devices:init', name: '设备一' } });
  host.emit('message', { source: parent, origin: 'https://other.test', data: { type: 'dsh-devices:init', name: '伪造' } });
  assert.equal(values.length, 1); assert.equal(values[0].name, '设备一');
  assert.equal(nav.showDevices(), true); assert.equal(parent.sent.at(-1).origin, 'https://parent.test'); assert.equal(parent.sent.at(-1).data.type, 'dsh-devices:show');
  nav.dispose(); assert.equal(parent.sent.at(-1).data.type, 'dsh-devices:unready');
});

test('native compact navigation reannounces ready on cached-page reactivation', () => {
  const host = eventHost(), messages = []; host.parent = host;
  host.XiaojiaoDevices = { postMessage: value => messages.push(JSON.parse(value)) }; host.__DSH_DEVICE_NAVIGATION__ = { name: '手机连接' };
  const sidebar = connectDeviceNavigation({ host }); assert.equal(messages.length, 0);
  const nav = connectDeviceNavigation({ host, ready: true }); assert.equal(messages.at(-1).type, 'dsh-devices:ready');
  assert.equal(nav.showDevices(), true); assert.equal(messages.at(-1).type, 'dsh-devices:show');
  host.emit('dsh-devices:navigation'); assert.equal(messages.at(-1).type, 'dsh-devices:ready');
  sidebar.dispose(); assert.equal(messages.at(-1).type, 'dsh-devices:ready'); nav.dispose(); assert.equal(messages.at(-1).type, 'dsh-devices:unready');
});

test('native navigation waits for a late device name before hiding its fallback', () => {
  const host = eventHost(), messages = [], changes = []; host.parent = host;
  host.XiaojiaoDevices = { postMessage: value => messages.push(JSON.parse(value)) };
  const nav = connectDeviceNavigation({ host, ready: true, onChange: value => changes.push(value) });
  assert.equal(messages.length, 0); assert.equal(nav.showDevices(), false);
  host.__DSH_DEVICE_NAVIGATION__ = { name: '稍后注入设备' }; host.emit('dsh-devices:navigation');
  assert.equal(changes.at(-1).name, '稍后注入设备'); assert.equal(messages.at(-1).type, 'dsh-devices:ready');
  assert.equal(nav.showDevices(), true); assert.equal(messages.at(-1).type, 'dsh-devices:show'); nav.dispose();
});

test('parent accepts only messages from its mounted frame and exact origin', () => {
  const child = {}, frames = [{ id: 'one', url: 'http://127.0.0.1:9001/s/work/', window: child }];
  assert.equal(workbenchNavigationMessage({ source: {}, origin: 'http://127.0.0.1:9001', data: { type: 'dsh-devices:ready' } }, frames), null);
  assert.equal(workbenchNavigationMessage({ source: child, origin: 'http://127.0.0.1:9002', data: { type: 'dsh-devices:ready' } }, frames), null);
  assert.equal(workbenchNavigationMessage({ source: child, origin: 'http://127.0.0.1:9001', data: { type: 'dsh-devices:ready' } }, frames).id, 'one');
});
