import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deviceName, rememberDeviceName } from '../client/pairing-state.mjs';
import { defaultProjectId, recentSessions } from '../client/mobile-state.mjs';

const require = createRequire(new URL('../../commander/package.json', import.meta.url));
const source = await readFile(new URL('../client/mobile.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const nodes = value => value && typeof value === 'object' ? [value, ...(value.children || []).flatMap(nodes)] : [];
const textOf = value => typeof value === 'object' ? (value?.children || []).map(textOf).join('') : String(value ?? '');
const scanIdentity = (code = 'SCAN.CODE') => ({ url: 'https://desk.example.com', pin: 'test-pin', code });
const uri = value => value?.code ? `dshlink://pair?${new URLSearchParams(value)}` : '';

function fixture({ initial = null, pairError = '', deferPair = false, native = true, hash = '' } = {}) {
  let identity = initial, dirty = false, cursor = 0, tree, status = 'pending', local = 0, pairFailure = pairError, deferred;
  const slots = [], effects = [], calls = [], listeners = new Map(), timers = new Map();
  const emit = () => { for (const fn of listeners.get('link:bootstrap') || []) fn(); };
  const runtime = {
    bootstrap: () => identity, isNative: () => native, contextUri: uri, requestId: () => 'request-id',
    isLocalIdentitySave: () => local > 0 ? (local--, true) : false,
    saveIdentity(value) { identity = value; local++; emit(); },
    clearIdentity() { identity = null; }, scan() {},
    pairingContext(value) {
      if (!value.includes('://')) return { url: 'https://desk.example.com', code: value };
      const parsed = new URL(value);
      return { url: parsed.searchParams.get('url'), pin: parsed.searchParams.get('pin'), code: parsed.searchParams.get('code') };
    },
    async call(action, args) {
      calls.push({ action, args });
      if (action === 'pair') {
        if (deferPair) await new Promise(resolve => { deferred = resolve; });
        if (pairFailure) throw new Error(pairFailure);
        return { requestId: 'pair-request', pollToken: 'private-poll', expiresAt: Date.now() + 60_000 };
      }
      if (action === 'pair/status') return { status, ...(status === 'approved' ? { token: 'approved-token', deviceId: 'device' } : {}) };
      if (action === 'state') return { projects: [], sessions: [], models: [] };
    },
  };
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback(fn, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { fn, deps }; return slots[index].fn; },
    useEffect(fn, deps) { const index = cursor++, old = slots[index]; if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) { slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn(); }); } },
  };
  const window = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    history: { replaceState() {} },
  };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, window, location: { origin: 'https://desk.example.com', hash, pathname: '/link/', search: '' }, navigator: { onLine: true }, document: { getElementById: () => ({}) }, AbortController, URL, URLSearchParams, queueMicrotask, setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), require: id => id === 'react' ? react : id.includes('pairing-state') ? { deviceName, rememberDeviceName } : id.includes('mobile-state') ? { defaultProjectId, recentSessions } : id.includes('app.jsx') ? { Button: 'Button', ErrorText: 'ErrorText', StatusDot: 'StatusDot', useLinkStyle() {} } : {} });
  const render = () => { dirty = false; cursor = 0; tree = module.exports.LinkMobileApp({ runtime }); for (const effect of effects.splice(0)) effect(); return tree; };
  const settle = async () => { for (let i = 0; i < 12; i++) { if (dirty || !tree) render(); await new Promise(resolve => setImmediate(resolve)); } return tree; };
  return { runtime, calls, render, settle, get tree() { return tree; }, get identity() { return identity; }, scan(value = scanIdentity()) { identity = value; emit(); }, status(value) { status = value; }, recover() { pairFailure = ''; }, resolvePair() { deferred?.(); }, async tick() { const ready = [...timers.values()]; timers.clear(); for (const fn of ready) await fn(); return settle(); } };
}

test('device names use five random letters and preserve generated or custom names locally', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } });
  try {
    const generated = deviceName();
    assert.match(generated, /^我的手机-[A-Z]{5}$/);
    rememberDeviceName(generated); assert.equal(deviceName(), generated);
    assert.equal(deviceName('原有手机'), '原有手机');
    rememberDeviceName('  工作手机  '); assert.equal(deviceName(), '工作手机');
    assert.equal(deviceName('a'.repeat(128)).length, 100);
    assert.match(deviceName('', { persist: false }), /^我的手机-[A-Z]{5}$/);
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; }
});

test('initial scan automatically requests approval once and displays recognized pairing code', async () => {
  const view = fixture({ initial: scanIdentity(), deferPair: true });
  view.render();
  assert.equal(view.calls.filter(call => call.action === 'pair').length, 1);
  view.render(); view.scan(); view.render();
  assert.equal(view.calls.filter(call => call.action === 'pair').length, 1);
  view.resolvePair(); await view.settle();
  assert.match(view.calls[0].args.name, /^我的手机-[A-Z]{5}$/);
  assert(textOf(view.tree).includes('请在电脑上允许连接'));
  assert.equal(nodes(view.tree).find(node => node.props.id === 'pair-code').props.value, 'SCAN.CODE');
  assert.equal(nodes(view.tree).find(node => node.props.id === 'pair-name').props.disabled, true);
  view.scan(); await view.settle();
  assert.equal(view.calls.filter(call => call.action === 'pair').length, 1);
  view.status('approved'); await view.tick();
  assert.equal(view.identity.token, 'approved-token');
  assert.equal(view.identity.code, 'SCAN.CODE');
  assert.equal(nodes(view.tree).some(node => node.props.id === 'pair-code'), false);
});

test('scan events connect using the chosen name; a new scan ignores stale pending responses', async () => {
  const view = fixture(); await view.settle();
  nodes(view.tree).find(node => node.props.id === 'pair-name').props.onChange({ target: { value: '工作手机' } });
  await view.settle(); view.scan(scanIdentity('FIRST')); await view.settle();
  assert.equal(view.calls.find(call => call.action === 'pair').args.name, '工作手机');
  view.scan(scanIdentity('SECOND')); await view.settle();
  assert.deepEqual(view.calls.filter(call => call.action === 'pair').map(call => call.args.code), ['FIRST', 'SECOND']);
  view.status('approved'); await view.tick();
  assert.equal(view.identity.code, 'SECOND');
  assert.equal(view.identity.name, '工作手机');
});

test('network failure shows a manual retry and never starts an automatic retry loop', async () => {
  const view = fixture({ initial: scanIdentity(), pairError: '网络连接失败' }); await view.settle();
  assert.equal(view.calls.filter(call => call.action === 'pair').length, 1);
  assert(textOf(view.tree).includes('网络连接失败'));
  const retry = nodes(view.tree).find(node => node.type === 'Button' && textOf(node) === '重试连接');
  assert.equal(retry.props.disabled, false); view.recover(); await retry.props.onClick(); await view.settle();
  assert.equal(view.calls.filter(call => call.action === 'pair').length, 2);
  assert(textOf(view.tree).includes('请在电脑上允许连接'));
});

test('browser QR link auto connects; manually pasted pairing codes still require submission', async () => {
  const scanned = fixture({ native: false, hash: '#code=BROWSER.CODE' }); await scanned.settle();
  assert.equal(scanned.calls.find(call => call.action === 'pair').args.code, 'BROWSER.CODE');
  const pasted = fixture({ native: false }); await pasted.settle();
  nodes(pasted.tree).find(node => node.props.id === 'pair-uri').props.onChange({ target: { value: 'PASTED.CODE' } }); await pasted.settle();
  assert.equal(pasted.calls.length, 0);
  await nodes(pasted.tree).find(node => node.type === 'form').props.onSubmit(); await pasted.settle();
  assert.equal(pasted.calls.find(call => call.action === 'pair').args.code, 'PASTED.CODE');
});

test('rejected requests cannot reuse single-use codes and a new scan recovers', async () => {
  const view = fixture({ initial: scanIdentity() }); await view.settle();
  view.status('rejected'); await view.tick();
  assert(textOf(view.tree).includes('电脑未允许这次连接'));
  assert.equal(nodes(view.tree).some(node => node.type === 'Button' && textOf(node) === '连接工作台'), false);
  assert.equal(nodes(view.tree).find(node => node.type === 'Button' && textOf(node) === '使用地址连接').props.disabled, true);
  view.scan(scanIdentity('NEW.CODE')); view.status('pending'); await view.settle();
  assert.equal(view.calls.filter(call => call.action === 'pair').length, 2);
});
