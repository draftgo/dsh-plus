import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { connectionDefaults } from '../client/connection-mode.mjs';

const require = createRequire(new URL('../../commander/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const source = await readFile(new URL('../client/app.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../client/style.css', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const catalog = JSON.parse(await readFile(new URL('../../commander/client/assets/iconsax/catalog.json', import.meta.url), 'utf8'));
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : [];
const textOf = node => (node?.children || []).map(value => typeof value === 'object' ? textOf(value) : String(value)).join('');
function fixture({ origin = 'https://dsh.draftgo.cn', clipboard = async () => {}, respond } = {}) {
  const location = new URL(origin), slots = [], effects = [], calls = [], timers = new Map();
  let cursor = 0, effectCursor = 0;
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) });
  const react = { createElement, useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; }, useRef(initial) { const id = cursor++; return slots[id] ??= { current: initial }; }, useEffect(fn) { if (!effects[effectCursor]) effects[effectCursor] = fn; effectCursor++; }, useId: () => 'pair-title' + cursor++ };
  const status = { enabled: true, publicUrl: '', host: '0.0.0.0', port: 48721, addresses: ['https://192.168.1.4:48721'], devices: [], pending: [] };
  const module = { exports: {} }, portalTarget = {};
  const listeners = new Map();
  const document = { body: portalTarget, getElementById: () => ({}), activeElement: null, addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } };
  runInNewContext(code, { module, exports: module.exports, location, document, navigator: { clipboard: { writeText: clipboard } }, AbortController, setTimeout: (callback, delay) => { const id = timers.size + 1; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id), require: id => id.includes('device-state') ? { deviceIcon: () => 'devices' } : id === 'react' ? react : id === 'react-dom' ? { createPortal: (node, target) => { assert.equal(target, portalTarget); return node; } } : id.includes('connection-mode') ? { connectionDefaults } : id.includes('api.mjs') ? { managementCall: async (action, input) => { calls.push({ action, input }); if (respond) return respond(action, input, status); if (action === 'configure') Object.assign(status, input); return action === 'pairing' ? { mode: input.mode, code: 'FULL.CODE', uri: 'dshlink://pair?code=FULL.CODE' } : { ...status }; } } : id.includes('iconsax') ? { UIIcon: 'Icon' } : id.includes('shared/client/select') ? { Select: 'Select' } : id.includes('qr.jsx') ? { PairQr: 'QR' } : { default: '' } });
  const render = (component = module.exports.LinkSettings, props = { ctx: {} }) => { cursor = 0; effectCursor = 0; return component(props); };
  const find = (tree, label) => nodes(tree).find(node => textOf(node) === label && (node.type === 'button' || typeof node.type === 'function'));
  return { exports: module.exports, render, find, slots, effects, calls, status, document, listeners, timers };
}

test('HTTPS cloud hosts default to browser pairing; private LAN hosts need no public URL', () => {
  assert.deepEqual(connectionDefaults(new URL('https://dsh.draftgo.cn')), { mode: 'public', publicUrl: 'https://dsh.draftgo.cn' });
  assert.equal(connectionDefaults(new URL('https://111.170.18.12:48721')).mode, 'public');
  for (const host of ['localhost', 'work.localhost', 'work.local', '127.0.0.1', '10.1.2.3', '172.19.0.1', '192.168.8.8', '169.254.1.1', '[::1]', '[fd00::1]', '[fe80::1]']) assert.deepEqual(connectionDefaults(new URL('https://' + host)), { mode: 'lan', publicUrl: '' }, host);
  assert.equal(connectionDefaults(new URL('http://dsh.draftgo.cn')).mode, 'lan');
});

test('cloud connect reuses the HTTPS origin without overwriting advanced drafts or manual mode', async () => {
  const view = fixture();
  view.render(); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  let tree = view.render();
  const hostInput = nodes(tree).find(node => node.type === 'input' && node.props.placeholder === '0.0.0.0');
  hostInput.props.onChange({ target: { value: '127.0.0.9' } });
  await view.find(tree, '生成连接信息').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(view.calls.filter(call => call.action !== 'status'))), [{ action: 'configure', input: { enabled: true, publicUrl: 'https://dsh.draftgo.cn' } }, { action: 'pairing', input: { mode: 'public' } }]);
  tree = view.render();
  assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.placeholder === '0.0.0.0').props.value, '127.0.0.9');
  nodes(tree).find(node => node.type === 'Select' && node.props['aria-label'] === '连接方式').props.onChange({ target: { value: 'lan' } });
  view.effects[1](); await new Promise(resolve => setImmediate(resolve)); tree = view.render();
  assert.equal(nodes(tree).find(node => node.type === 'Select' && node.props['aria-label'] === '连接方式').props.value, 'lan');
});

test('local connect pairs using LAN without configuring a public endpoint', async () => {
  const view = fixture({ origin: 'http://localhost:3000' });
  view.render(); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  await view.find(view.render(), '生成连接信息').props.onClick();
  assert.equal(view.calls.some(call => call.action === 'configure'), false);
  assert.equal(view.calls.at(-1).action, 'pairing');
  assert.equal(view.calls.at(-1).input.mode, 'lan');
});

test('pairing portal copies the full code and URI, reports clipboard failure', async () => {
  const copied = [], pairing = { mode: 'lan', code: 'VERY.LONG.FULL.CODE', uri: 'dshlink://pair?code=VERY.LONG.FULL.CODE' };
  const view = fixture({ clipboard: async value => copied.push(value) });
  const props = { pairing, pending: [], onClose() {}, onConfirm() {}, busy: '' };
  const tree = view.render(view.exports.PairingDialog, props);
  assert(nodes(tree).some(node => node.props.role === 'dialog' && node.props['aria-modal'] === 'true'));
  await view.find(tree, '复制完整配对码').props.onClick(); await view.find(tree, '复制连接信息').props.onClick();
  assert.deepEqual(copied, [pairing.code, pairing.uri]);
  assert(nodes(view.render(view.exports.PairingDialog, props)).some(node => node.props.role === 'status' && textOf(node) === '连接信息已复制'));
  const failed = fixture({ clipboard: async () => { throw Error('denied'); } });
  await failed.find(failed.render(failed.exports.PairingDialog, props), '复制完整配对码').props.onClick();
  assert(nodes(failed.render(failed.exports.PairingDialog, props)).some(node => node.props.role === 'status' && textOf(node).includes('复制失败')));
});

test('Link controls use real Iconsax assets and one bounded linear icon layer', () => {
  for (const match of source.matchAll(/(?:icon|name)="([A-Za-z]+)"/g)) assert(catalog[match[1]], 'missing Iconsax key: ' + match[1]);
  assert.match(css, /\.link-dialog-backdrop\) \.cmd-ui-bold\s*\{\s*display: none !important/);
  assert.match(css, /\.link-pair-code \{[^}]*max-width: 100%[^}]*overflow: hidden[^}]*text-overflow: ellipsis/s);
  assert.match(css, /body\[data-ds-dark-theme\] :is\(\.link-settings, \.link-dialog-backdrop\)/);
  for (const key of ['scan', 'refresh', 'copy', 'close']) for (const variant of ['linear', 'bold']) {
    assert(catalog[key][variant].includes('viewBox="0 0 24 24"'));
    assert(catalog[key][variant].includes('currentColor'));
  }
});

test('pairing modal owns Escape and Tab focus, restoring its invoking control', () => {
  const view = fixture(); let closed = 0, focused = '';
  view.document.activeElement = { isConnected: true, focus() { focused = 'previous'; } };
  const tree = view.render(view.exports.PairingDialog, { pairing: { mode: 'lan', code: 'CODE', uri: 'dshlink://pair' }, pending: [], onClose() { closed++; }, busy: '' });
  const first = { focus() { focused = 'first'; }, closest() { return null; } }, last = { focus() { focused = 'last'; }, closest() { return null; } };
  const dialog = { querySelector() { return first; }, querySelectorAll() { return [first, last]; }, contains(element) { return element === first || element === last; } };
  nodes(tree).find(node => node.props.role === 'dialog').props.ref.current = dialog;
  const cleanup = view.effects[0](); assert.equal(focused, 'first');
  const event = key => ({ key, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } });
  view.document.activeElement = last; const tab = event('Tab'); view.listeners.get('keydown')(tab);
  assert.equal(focused, 'first'); assert.equal(tab.defaultPrevented, true); assert.equal(tab.stopped, true);
  view.document.activeElement = first; const back = { ...event('Tab'), shiftKey: true }; view.listeners.get('keydown')(back); assert.equal(focused, 'last');
  const escape = event('Escape'); view.listeners.get('keydown')(escape); assert.equal(closed, 1); assert.equal(escape.stopped, true);
  cleanup(); assert.equal(focused, 'previous'); assert.equal(view.listeners.size, 0);
});

test('host failure ends loading, disables dependent actions, stops polling and recovers on retry', async () => {
  let fail = true;
  const view = fixture({ respond: async (_action, _input, status) => { if (fail) throw Object.assign(Error('服务待就绪，请稍后重试'), { detail: 'HTTP 404 · /api/commander-link' }); return { ...status, cloudAccess: { configured: true, ready: true, enabled: false } }; } });
  let tree = view.render();
  assert(nodes(tree).some(node => node.props.label === '正在读取连接状态…'));
  assert.equal(nodes(tree).some(node => textOf(node) === '生成连接信息'), false);
  const stop = view.effects[1](); await new Promise(resolve => setImmediate(resolve)); tree = view.render();
  assert.doesNotMatch(textOf(tree), /正在连接|读取中|三步|CONNECT YOUR|LINK HOST/);
  assert.match(textOf(tree), /dsh\.draftgo\.cn/);
  assert.equal(view.find(tree, '生成连接信息').props.disabled, true);
  assert.equal(nodes(tree).find(node => node.props.value === undefined && node.props.id === 'link-enabled').props.disabled, true);
  assert.equal(view.timers.size, 0);
  assert(nodes(tree).some(node => node.type === 'details' && node.props.className === 'link-error-detail'));
  const cloud = nodes(tree).find(node => node.props.onRetry && 'failed' in node.props);
  assert.equal(cloud.props.loading, false); assert.equal(cloud.props.failed, true); assert.equal(cloud.props.disabled, true);
  fail = false; await view.find(tree, '重试').props.onClick(); tree = view.render();
  assert.equal(view.find(tree, '生成连接信息').props.disabled, false);
  assert.equal(view.timers.size, 1);
  assert.equal([...view.timers.values()][0].delay, 10_000);
  stop(); assert.equal(view.timers.size, 0);
});


test('embedded settings use owner device transport and keep advanced options collapsed', async () => {
  const view = fixture(); const calls = [];
  const props = { embedded: true, management: async (action, input) => { calls.push({ action, input }); return { enabled: true, devices: [], pending: [] }; } };
  view.render(view.exports.LinkSettings, props); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  const tree = view.render(view.exports.LinkSettings, props);
  await view.find(tree, '生成连接信息').props.onClick();
  assert.equal(calls.at(-1).action, 'pairing');
  const advanced = nodes(tree).find(node => node.type === 'details' && node.props.className === 'link-advanced');
  assert(advanced); assert.equal(advanced.props.open, undefined); assert(nodes(advanced).some(node => node.props.management === props.management));
  assert.doesNotMatch(textOf(tree), /连接手机|App 地址/);
});


test('relay pairing uses its own mode without overwriting public URL and blocks offline pairing', async () => {
  const view = fixture({ origin: 'http://localhost:3000' });
  view.status.relay = { configured: true, connected: true };
  view.render(); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  let tree = view.render();
  const select = nodes(tree).find(node => node.type === 'Select' && node.props['aria-label'] === '连接方式');
  assert(nodes(select).some(node => node.type === 'option' && node.props.value === 'relay' && !node.props.disabled));
  select.props.onChange({ target: { value: 'relay' } });
  await view.find(view.render(), '生成连接信息').props.onClick();
  assert.equal(view.calls.at(-1).input.mode, 'relay');
  assert.equal(view.calls.some(call => call.action === 'configure'), false);
  view.status.relay.connected = false;
  await view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.find(view.render(), '生成连接信息').props.disabled, true);
});
