import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deviceSwitchItems, deviceSwitchState } from '../client/device-switch.mjs';
import { readJsonResponse } from '../../commander/client/http-response.mjs';
import { deviceIcon, deviceKind, deviceStatus, workbenchUrl } from '../client/device-state.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const source = await readFile(new URL('../client/device-switch.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const nodes = value => value && typeof value === 'object' ? [value, ...(value.children || []).flatMap(nodes)] : [];
const textOf = value => typeof value === 'object' ? (value?.children || []).map(textOf).join('') : String(value ?? '');

test('caption switch stays hidden for one device and labels the real active workbench', () => {
  assert.equal(deviceSwitchState({ devices: [] }).multiple, false);
  assert.equal(deviceSwitchItems([{ id: 'local', name: '  本机  ', kind: 'local' }, { id: '', name: '空' }, { kind: 'computer', name: '缺编号' }]).length, 1);
  const several = deviceSwitchState({ devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }], activeId: null, open: true });
  assert.equal(several.multiple, true);
  assert.equal(several.active.name, '本机');
  assert.equal(several.open, true);
  assert.equal(deviceSwitchState({ devices: several.items, activeId: 'cloud', busy: 'cloud', open: true }).open, false);
});

function fixture(responses) {
  let cursor = 0, dirty = true, tree;
  const slots = [], effects = [], requests = [];
  const listeners = new Map();
  const document = {
    documentElement: { attributes: new Set(['data-windows-titlebar']), hasAttribute(name) { return this.attributes.has(name); }, toggleAttribute(name, force) { force ? this.attributes.add(name) : this.attributes.delete(name); }, removeAttribute(name) { this.attributes.delete(name); } },
    body: {}, baseURI: 'http://127.0.0.1:8000/',
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
  };
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(item => item !== false && item != null) }; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, j) => !Object.is(value, old.deps[j]))) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const host = { document, location: new URL(document.baseURI), innerWidth: 1280, addEventListener() {}, removeEventListener() {} };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, globalThis: host, window: host, location: host.location, URL, document,
    fetch: async (url, input) => { requests.push({ url: String(url), body: input.body }); const next = responses.shift(); if (next instanceof Response) return next; return Response.json(next); },
    require: id => id === 'react' ? react : id === 'react-dom' ? { createPortal: child => child } : id.includes('http-response') ? { readJsonResponse } : id.includes('device-switch.mjs') ? { deviceSwitchState } : { deviceIcon, deviceKind, deviceStatus, workbenchUrl },
  });
  const render = () => { dirty = false; cursor = 0; tree = module.exports.DeviceSwitch(); for (const effect of effects.splice(0)) effect(); };
  return { host, requests, document, listeners, get tree() { return tree; }, nodes: () => nodes(tree), async settle() { for (let i = 0; i < 8; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

test('Windows caption lists saved devices and keeps the local page while opening one remote workbench', async () => {
  const view = fixture([
    { devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }] },
    { devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }] },
    { url: 'http://127.0.0.1:9100/enter?ticket=once' },
    new Response(null, { status: 303, headers: { location: '/s/' + 'a'.repeat(43) + '/' } }),
    { device: { id: 'cloud', kind: 'computer' }, url: 'http://127.0.0.1:9101/s/work/' },
    { devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }] },
  ]);
  await view.settle();
  const trigger = view.nodes().find(node => node.props.className === 'dsh-device-switch-trigger');
  assert.equal(trigger.props['aria-label'], '当前工作台：本机');
  trigger.props.onClick(); await view.settle();
  const cloud = view.nodes().find(node => node.props.role === 'menuitemradio' && textOf(node).includes('dsh.draftgo.cn'));
  await cloud.props.onClick(); await view.settle();
  assert.equal(view.requests[2].url, 'http://127.0.0.1:8000/api/commander-devices');
  assert.equal(JSON.parse(view.requests.find(item => item.body?.includes('"select"')).body).deviceId, 'cloud');
  const frame = view.nodes().find(node => node.type === 'iframe');
  assert.equal(frame.props.src, 'http://127.0.0.1:9101/s/work/');
  assert.equal(frame.props.hidden, false);
  assert.equal(view.document.documentElement.hasAttribute('data-dsh-remote-workbench'), true);
  view.nodes().find(node => node.props['aria-label'] === '当前工作台：dsh.draftgo.cn').props.onClick(); await view.settle();
  await view.nodes().find(node => node.props.role === 'menuitemradio' && textOf(node).includes('本机')).props.onClick(); await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.hidden, true);
  assert.equal(view.document.documentElement.hasAttribute('data-dsh-remote-workbench'), false);
  assert.equal(view.requests.filter(item => item.body?.includes('"select"')).length, 1);
  view.unmount();
  assert.equal(view.document.documentElement.hasAttribute('data-dsh-remote-workbench'), false);
});

test('caption stays absent outside Windows and when no other device is saved', async () => {
  const absent = fixture([]); absent.document.documentElement.removeAttribute('data-windows-titlebar'); await absent.settle();
  assert.equal(absent.tree, null); assert.equal(absent.requests.length, 0);
  const single = fixture([{ devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }] }]); await single.settle();
  assert.equal(single.tree, null);
});
