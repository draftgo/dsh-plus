import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deviceIcon, deviceKind, deviceStatus, jobFinished, sshInput, workbenchUrl } from '../client/device-state.mjs';
import { workbenchNavigationMessage } from '../client/device-navigation.mjs';

const require = createRequire(new URL('../../commander/package.json', import.meta.url));
const source = await readFile(new URL('../client/device-center.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source + '\nexport { AddComputer, AddServer, AddDevice, ManageDevice, RelayWizard };', { loader: 'jsx', format: 'cjs' }).code;
const nodes = value => value && typeof value === 'object' ? [value, ...(value.children || []).flatMap(nodes)] : [];
const textOf = value => typeof value === 'object' ? (value?.children || []).map(textOf).join('') : String(value ?? '');

function fixture(component, props = {}) {
  let cursor = 0, dirty = true, tree, pairStatus = 'pending';
  const slots = [], effects = [], timers = new Map(), calls = [], listeners = new Map();
  const devices = [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'desk', name: '开发电脑', kind: 'computer', status: 'unknown' }, { id: 'server', name: '云端', kind: 'ssh', status: 'offline' }];
  const runtime = { isNative: () => false, bootstrap: () => null, clientName: () => '这台电脑', async call(action, args) {
    calls.push({ action, args });
    if (action === 'list') return { devices, capabilities: { ssh: true, hostAdmin: true } };
    if (action === 'select') { if (args.deviceId === 'server') throw new Error('SSH 隧道未连接'); return { device: devices.find(item => item.id === args.deviceId), url: args.deviceId === 'local' ? null : 'http://127.0.0.1:17771/s/one/' }; }
    if (action === 'pair') return { requestId: 'pair-id' };
    if (action === 'pairStatus') return { status: pairStatus, ...(pairStatus === 'approved' ? { device: devices[1] } : {}) };
    if (action === 'sshProbe') return { fingerprint: 'SHA256:valid' };
    if (action === 'sshConnect') return { jobId: 'job-id' };
    if (action === 'job') return { id: 'job-id', state: 'completed', steps: [{ label: '安装', state: 'completed' }], device: devices[2] };
    if (action === 'reconnect') return { jobId: 'job-id' };
    return {};
  }, ...props.runtime };
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback(fn, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { fn, deps }; return slots[index].fn; },
    useEffect(fn, deps) { const index = cursor++, old = slots[index]; if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) { slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn(); }); } },
  };
  const window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const parent = props.embedded ? { postMessage(data, origin) { this.messages.push({ data, origin }); }, messages: [] } : window;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, URL, URLSearchParams, window, parent, location: { origin: 'http://127.0.0.1:17770', search: props.embedded ? '?parentOrigin=http://127.0.0.1:17770' : '' }, document: { activeElement: null, createElement: () => ({ remove() {} }), head: { append() {} } }, setTimeout(fn) { const id = Math.random(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), require: id => id === 'react' ? react : id.includes('device-navigation') ? { workbenchNavigationMessage } : id.includes('device-state') ? { deviceIcon, deviceKind, deviceStatus, jobFinished, sshInput, workbenchUrl, jobFailed: job => ['failed', 'error'].includes(job?.state) } : id.includes('app.jsx') ? { useLinkStyle() {}, LinkSettings() {} } : {} });
  const frameWindows = new Map();
  const render = () => { dirty = false; cursor = 0; tree = module.exports[component]({ ...props, runtime }); for (const node of nodes(tree)) if (node.type === 'iframe' && node.props.ref) { if (!frameWindows.has(node.props.src)) frameWindows.set(node.props.src, { messages: [], postMessage(data, origin) { this.messages.push({ data, origin }); } }); node.props.ref({ contentWindow: frameWindows.get(node.props.src) }); } for (const effect of effects.splice(0)) effect(); return tree; };
  const settle = async () => { for (let i = 0; i < 10; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } return tree; };
  return { calls, runtime, parent, settle, frameWindows, emit(event) { for (const fn of [...(listeners.get('message') || [])]) fn(event); }, nodes: () => nodes(tree), get tree() { return tree; }, async click(text) { const button = nodes(tree).find(node => typeof node.type === 'function' && textOf(node) === text); assert(button, text); await button.props.onClick(); return settle(); }, async tick() { const ready = [...timers.values()]; timers.clear(); for (const fn of ready) await fn(); return settle(); }, status(value) { pairStatus = value; } };
}

test('device state remains unknown before probing and SSH credentials are preserved', () => {
  assert.equal(deviceIcon({ kind: 'local' }), 'computer');
  assert.equal(deviceIcon({ kind: 'ssh' }), 'server');
  assert.equal(deviceIcon({ deviceType: 'mobile' }), 'mobile');
  assert.equal(deviceIcon({ name: '我的手机' }), 'devices');
  assert.equal(deviceStatus({ status: 'mystery' }), '未检测'); assert.equal(deviceKind({ kind: 'ssh' }), '服务器');
  const value = sshInput({ host: ' example.com ', username: ' user ', name: ' a ', port: '22', auth: 'password', password: ' actual secret ', source: 'mirror' });
  assert.equal(value.password, ' actual secret '); assert.equal(value.port, 22); assert.equal(value.host, 'example.com');
  assert.throws(() => sshInput({ host: 'x', username: 'u', port: 0 }), /端口/);
  assert.throws(() => workbenchUrl('http://example.com', 'http://localhost'), /地址无效/);
  assert.equal(workbenchUrl('http://127.0.0.1:321/s/id/', 'http://localhost'), 'http://127.0.0.1:321/s/id/');
});

test('pairing waits for approval and opens exactly the approved device', async () => {
  const added = [], view = fixture('AddComputer', { onAdded: value => added.push(value) }); await view.settle();
  view.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: 'dshlink://pair?url=https://desk&code=one' } }); await view.settle();
  await view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(textOf(view.tree).includes('请在目标设备上允许连接')); assert.equal(added.length, 0);
  view.status('approved'); await view.tick();
  assert.equal(added[0].id, 'desk'); assert.equal(view.calls.filter(item => item.action === 'pair').length, 1);
});

test('server authentication starts after fingerprint confirmation', async () => {
  const view = fixture('AddServer', { onAdded() {} }); await view.settle();
  const fields = view.nodes().filter(node => node.type === 'input');
  fields[1].props.onChange({ target: { value: 'server.example.com' } }); fields[3].props.onChange({ target: { value: 'ubuntu' } }); await view.settle();
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(textOf(view.tree).includes('确认服务器身份')); assert.equal(view.calls.some(item => item.action === 'sshConnect'), false);
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert.equal(view.calls.find(item => item.action === 'sshConnect').args.fingerprint, 'SHA256:valid');
  await view.tick(); assert(textOf(view.tree).includes('打开工作台'));
});

test('opening another device leaves the device list immediately', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const view = fixture('DeviceCenter', { runtime: { async call(action, args) {
    if (action === 'list') return { devices: [{ id: 'desk', name: '开发电脑', kind: 'computer', status: 'unknown' }], capabilities: { ssh: true, hostAdmin: true } };
    if (action === 'select') { await pending; return { device: { id: 'desk', kind: 'computer', name: '开发电脑' }, url: 'http://127.0.0.1:17771/s/one/' }; }
    return {};
  } } });
  await view.settle();
  const opening = view.nodes().find(node => node.props.className === 'dc-device-open').props.onClick();
  await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, true);
  release();
  await opening; await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.hidden, false);
});

test('switching preserves existing iframe when another connection fails', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const open = view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑'));
  await open.props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe'); assert.equal(frame.props.src, 'http://127.0.0.1:17771/s/one/');
  const failed = view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('云端'));
  await failed.props.onClick(); await view.settle();
  assert(view.nodes().some(node => node.props.error === 'SSH 隧道未连接')); assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src); assert.equal(view.nodes().find(node => node.type === 'iframe').props.hidden, false);
});

test('mobile centre keeps fallback until valid navigation is ready and retains frame on return', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑')).props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe'), child = view.frameWindows.get(frame.props.src);
  const topbar = () => view.nodes().find(node => node.type === 'header');
  assert.equal(topbar().props.className, 'dc-topbar');
  view.emit({ source: child, origin: 'https://evil.test', data: { type: 'dsh-devices:ready' } }); await view.settle();
  assert.equal(topbar().props.className, 'dc-topbar');
  view.emit({ source: child, origin: 'http://127.0.0.1:17771', data: { type: 'dsh-devices:ready' } }); await view.settle();
  assert.match(topbar().props.className, /integrated/); assert.equal(child.messages.at(-1).data.name, '开发电脑');
  view.emit({ source: child, origin: 'http://127.0.0.1:17771', data: { type: 'dsh-devices:show' } }); await view.settle();
  assert.equal(topbar().props.className, 'dc-topbar');
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, false);
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src);
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑')).props.onClick(); await view.settle();
  view.emit({ source: child, origin: 'http://127.0.0.1:17771', data: { type: 'dsh-devices:unready' } }); await view.settle();
  assert.equal(topbar().props.className, 'dc-topbar');
});

test('server reconnect remains an explicit job until completion', async () => {
  const view = fixture('ManageDevice', { device: { id: 'server', name: '云端', kind: 'ssh' }, onChanged() {}, onRemoved() {} }); await view.settle();
  await view.click('重新连接隧道');
  const forms = view.nodes().filter(node => node.type === 'form'); await forms[1].props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(view.nodes().some(node => node.props.job?.id === 'job-id'));
  await view.tick(); assert(view.nodes().some(node => node.props.job?.state === 'completed'));
});


test('device center exposes one add flow and owner pairing through existing settings', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /添加电脑|添加服务器|连接手机|App 地址/);
  await view.click('添加设备');
  assert(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'AddDevice'));
  const add = fixture('AddDevice', { onAdded() {}, sshAvailable: true }); await add.settle();
  assert.match(textOf(add.tree), /连接已有设备/); assert.match(textOf(add.tree), /安装到服务器/);
  await add.click('安装到服务器');
  assert(add.nodes().some(node => typeof node.type === 'function' && node.type.name === 'AddServer'));
});

test('connection management and saved devices occupy separate segment panels', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const panel = id => view.nodes().find(node => node.props.id === 'dc-panel-' + id);
  const tab = id => view.nodes().find(node => node.props.id === 'dc-tab-' + id);
  const current = view.nodes().find(node => node.props.className === 'dc-current-device');
  const remote = view.nodes().find(node => node.props.className === 'dc-other-devices');
  assert.match(textOf(current), /本机/);
  assert.doesNotMatch(textOf(remote), /本机/);
  assert.match(textOf(remote), /开发电脑/);
  assert.equal(panel('devices').props.hidden, false);
  assert.equal(panel('connections').props.hidden, true);
  assert.equal(tab('devices').props['aria-selected'], true);
  assert.equal(view.nodes().some(node => node.props.className === 'dc-brand'), false);
  const hostSettings = nodes(panel('connections')).find(node => typeof node.type === 'function' && node.type.name === 'LinkSettings');
  assert(hostSettings); assert.equal(hostSettings.props.embedded, true);
  assert.equal(nodes(panel('devices')).some(node => typeof node.type === 'function' && node.type.name === 'LinkSettings'), false);
  await tab('connections').props.onClick(); await view.settle();
  assert.equal(panel('connections').props.hidden, false);
  assert.equal(panel('devices').props.hidden, true);
  assert.equal(tab('connections').props.tabIndex, 0);
  assert.equal(tab('devices').props.tabIndex, -1);
});

test('segment keyboard navigation focuses the destination and keeps workbench frames', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑')).props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe');
  const deviceTab = view.nodes().find(node => node.props.id === 'dc-tab-devices');
  let focused = '', prevented = false;
  deviceTab.props.onKeyDown({ key: 'Home', preventDefault() { prevented = true; }, currentTarget: { parentElement: { querySelector(selector) { focused = selector; return { focus() {} }; } } } });
  await view.settle();
  assert.equal(prevented, true); assert.equal(focused, '#dc-tab-connections');
  assert.equal(view.nodes().find(node => node.props.id === 'dc-panel-connections').props.hidden, false);
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, false);
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src);
  await view.nodes().find(node => typeof node.type === 'function' && node.props['aria-label'] === '返回开发电脑工作台').props.onClick(); await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, true);
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src);
});

test('embedded device list can return without using the window close control', async () => {
  const view = fixture('DeviceCenter', { embedded: true }); await view.settle();
  const back = view.nodes().find(node => node.props.className?.includes('dc-back'));
  assert.equal(back.props['aria-label'], '返回工作台');
  assert.equal(textOf(back), '');
  const main = view.nodes().find(node => node.props.className === 'dc-topbar-main');
  assert.equal(main.children[0], back);
  assert.equal(main.children[1].props.className, 'dc-segment');
  await back.props.onClick(); await view.settle();
  assert.equal(view.parent.messages.at(-1).data.type, 'dsh-devices:return-local');
  assert.equal(view.parent.messages.at(-1).origin, 'http://127.0.0.1:17770');
  const standalone = fixture('DeviceCenter'); await standalone.settle();
  assert.equal(standalone.nodes().some(node => node.props.className?.includes('dc-back')), false);
});

test('clients without hosting retain their remote device list', async () => {
  const view = fixture('DeviceCenter', { runtime: { async call() { return { devices: [{ id: 'desk', name: '开发电脑', kind: 'computer', status: 'unknown' }], capabilities: { hostAdmin: false, ssh: false } }; } } });
  await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dc-current-device').props.hidden, true);
  assert.match(textOf(view.nodes().find(node => node.props.className === 'dc-other-devices')), /开发电脑/);
  assert.equal(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'LinkSettings'), false);
});


test('relay wizard requires SSH fingerprint before deployment and gates pairing on host connectivity', async () => {
  const calls = [];
  let connected = false;
  const view = fixture('RelayWizard', { onChanged() {}, runtime: { async call(action, args) {
    calls.push({ action, args });
    if (action === 'relayProbe') return { fingerprint: 'SHA256:relay' };
    if (action === 'relayDeploy') return { jobId: 'relay-job' };
    if (action === 'job') return { id: 'relay-job', state: 'completed', steps: [], relay: { url: 'https://8.8.8.8:24680' } };
    if (action === 'hostStatus') return { relay: { connected } };
    if (action === 'hostPairing') return { uri: 'dshlink://pair?code=once' };
    return {};
  } } });
  await view.settle();
  const input = placeholder => view.nodes().find(node => node.type === 'input' && node.props.placeholder === placeholder);
  input('IP 或域名').props.onChange({ target: { value: '8.8.8.8' } });
  input('需具备部署权限').props.onChange({ target: { value: 'root' } });
  input('例如：203.0.113.10').props.onChange({ target: { value: '8.8.8.8' } });
  await view.settle();
  const submit = async () => { view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle(); };
  await submit(); assert.equal(calls[0].action, 'relayProbe'); assert(!calls.some(item => item.action === 'relayDeploy'));
  await submit();
  const deployment = calls.find(item => item.action === 'relayDeploy');
  assert.equal(deployment.args.fingerprint, 'SHA256:relay'); assert.equal(deployment.args.relayPort, 24680); assert.equal(deployment.args.challengeMode, 'standalone');
  await view.tick();
  const pairButton = () => view.nodes().find(node => typeof node.type === 'function' && textOf(node) === '生成中继连接信息');
  assert.equal(pairButton().props.disabled, true);
  connected = true; await view.tick();
  assert.equal(pairButton().props.disabled, false);
  await view.click('生成中继连接信息');
  assert.equal(calls.find(item => item.action === 'hostPairing').args.mode, 'relay');
  assert(view.nodes().some(node => node.type === 'textarea' && node.props.readOnly && node.props.value.includes('code=once')));
});

test('relay deployment exposes explicit challenge webroot and invalidates changed server trust', async () => {
  const view = fixture('RelayWizard', { onChanged() {}, runtime: { async call(action) { if (action === 'relayProbe') return { fingerprint: 'SHA256:relay' }; return {}; } } });
  await view.settle();
  const inputs = view.nodes().filter(node => node.type === 'input');
  inputs[0].props.onChange({ target: { value: 'relay.example.com' } }); inputs[2].props.onChange({ target: { value: 'root' } }); await view.settle();
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert.match(textOf(view.tree), /确认服务器身份/);
  view.nodes().find(node => node.type === 'input' && node.props.placeholder === 'IP 或域名').props.onChange({ target: { value: 'other.example.com' } }); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /确认服务器身份/);
  view.nodes().find(node => node.props.value === 'standalone').props.onChange({ target: { value: 'webroot' } }); await view.settle();
  assert(view.nodes().some(node => node.type === 'input' && node.props.placeholder === '/var/www/acme' && node.props.required));
});

test('relay deployment entry is unavailable when client capability is absent', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const button = view.nodes().find(node => typeof node.type === 'function' && textOf(node) === '配置自有中继');
  assert.equal(button.props.disabled, true);
});
