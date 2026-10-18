import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const React = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url))('react');
const { createRoot } = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url))('react-dom/client');
const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const compiled = transformSync(readFileSync(new URL('../client/updates.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const initial = () => ({ config: { source: 'mirror', mirrorUrl: 'https://mirror.example/' }, current: { plugin: '0.1.1', app: '0.1.1' }, release: null, phase: 'idle', canInstall: false, canRollback: false, managed: true, restartRequired: false, busy: false });
const update = () => ({ ...initial(), release: { version: '0.1.2', plugin: { version: '0.1.2', compatible: true } }, canInstall: true });

async function mount(respond = () => initial(), props = {}, timers = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://desktop.example/link/' }), previous = new Map(), calls = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const module = { exports: {} }, primitives = {
    Modal: ({ open, children }) => open ? React.createElement('div', { role: 'dialog' }, children) : null,
    Tooltip: ({ children }) => children, LinkIconMedium: () => React.createElement('svg', { 'data-github': true }),
  };
  runInNewContext(compiled, { module, exports: module.exports, document: dom.window.document, location: dom.window.location, URL, AbortController, AbortSignal, setInterval, clearInterval, ...timers,
    fetch: async (url, options) => { const body = JSON.parse(options.body); calls.push(body); assert.equal(String(url), 'https://desktop.example/link/api/commander/updates'); assert.equal(options.credentials, 'same-origin'); const result = await respond(body); return { ok: !result?.httpError, status: result?.httpError || 200, json: async () => result }; },
    require: id => id === 'react' ? React : id.includes('ui-primitives') ? primitives : id.endsWith('.css') ? '' : { UIIcon: () => null },
  });
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = callback => React.act(async () => { callback?.(); await new Promise(resolve => setImmediate(resolve)); });
  const button = label => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  await flush(() => root.render(React.createElement(module.exports.UpdateLauncher, props)));
  return { calls, document: dom.window.document, window: dom.window, flush, button,
    click: label => flush(() => { const node = button(label); assert(node, `Missing button: ${label}`); node.click(); }),
    async dispose() { await flush(() => root.unmount()); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
  };
}

test('host checks once in background, badges the visible launcher and refreshes each opening', async () => {
  const view = await mount(() => update());
  try {
    assert.deepEqual(view.calls.map(call => call.action), ['status', 'check']);
    assert(view.button('更新，有更新'));
    assert.equal(view.document.querySelector('[role="dialog"]'), null);
    await view.click('更新，有更新');
    assert.equal(view.calls.at(-1).action, 'status');
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /当前连接主机 · desktop.example/);
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /更新此主机，手机无需重装/);
    await view.click('关闭更新');
    await view.flush(() => view.document.dispatchEvent(new view.window.Event('commander:updates')));
    assert.equal(view.calls.at(-1).action, 'status');
    assert.equal(view.calls.filter(call => call.action === 'check').length, 1);
  } finally { await view.dispose(); }
});

test('plugin install gives truthful staged restart feedback without claiming automatic restart', async () => {
  let state = update();
  const view = await mount(({ action }) => { if (action === 'install') state = { ...state, phase: 'ready', restartRequired: true }; return state; });
  try {
    await view.click('更新，有更新');
    await view.click('更新插件');
    assert.equal(view.calls.at(-1).action, 'install');
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /重启主机应用后生效/);
    assert.equal(view.button('更新插件'), undefined);
    assert(view.button('更新，待重启'));
  } finally { await view.dispose(); }
});

test('busy host disables installing; incompatible and unmanaged hosts explain required application update', async () => {
  for (const [patch, message] of [[{ busy: true }, /有任务正在运行/], [{ managed: false }, /当前安装方式不支持独立更新/], [{ release: { plugin: { version: '0.1.2', compatible: false, reason: '需要引擎 2.0' } } }, /需要引擎 2.0/]]) {
    const view = await mount(() => ({ ...update(), ...patch }));
    try { await view.click('更新，有更新'); assert(view.button('更新插件').disabled); await view.click('更新插件'); assert(!view.calls.some(call => call.action === 'install')); assert.match(view.document.querySelector('[role="dialog"]').textContent, message); }
    finally { await view.dispose(); }
  }
});

test('source selection persists on host and rechecks; invalid custom mirrors never reach backend', async () => {
  let state = initial();
  const view = await mount(body => { if (body.action === 'configure') state = { ...state, config: { source: body.source, mirrorUrl: body.mirrorUrl } }; return state; });
  try {
    await view.click('更新');
    const select = view.document.querySelector('select');
    assert.equal(select.value, 'mirror');
    await view.flush(() => { select.value = 'github'; select.dispatchEvent(new view.window.Event('change', { bubbles: true })); });
    assert.equal(view.calls.at(-2).action, 'configure');
    assert.equal(view.calls.at(-2).source, 'github');
    assert.equal(view.calls.at(-1).action, 'check');
    await view.flush(() => { select.value = 'custom'; select.dispatchEvent(new view.window.Event('change', { bubbles: true })); });
    const input = view.document.querySelector('input'), native = Object.getOwnPropertyDescriptor(view.window.HTMLInputElement.prototype, 'value').set;
    await view.flush(() => { native.call(input, 'http://unsafe.example/'); input.dispatchEvent(new view.window.Event('input', { bubbles: true })); });
    const before = view.calls.length;
    await view.flush(() => view.document.querySelector('form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(view.calls.length, before);
    assert.match(view.document.querySelector('[role="alert"]').textContent, /HTTPS/);
    await view.flush(() => { native.call(input, 'https://custom.example/'); input.dispatchEvent(new view.window.Event('input', { bubbles: true })); });
    await view.click('保存');
    assert.equal(view.calls.at(-2).source, 'custom');
    assert.equal(view.calls.at(-2).mirrorUrl, 'https://custom.example/');
  } finally { await view.dispose(); }
});

test('backend errors can retry and application links accept HTTPS only', async () => {
  let failed = true;
  const desktop = { dshDesktop: { updates: { open() {} } } };
  const view = await mount(() => failed ? { httpError: 403, error: '仅主机可执行更新' } : { ...initial(), release: { app: { version: '0.1.2', url: 'https://github.com/example/repo/releases/latest' } } }, {}, desktop);
  try {
    await view.click('更新');
    assert.match(view.document.querySelector('[role="alert"]').textContent, /仅主机可执行更新/);
    await view.flush(() => { failed = false; }); await view.click('重试');
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert.equal(view.document.querySelector('a').href, 'https://github.com/example/repo/releases/latest');
    assert.equal(view.document.querySelector('a').rel, 'noopener noreferrer');
  } finally { await view.dispose(); }
  const unsafe = await mount(() => ({ ...initial(), release: { app: { version: '0.1.2', url: 'javascript:alert(1)' } } }), {}, desktop);
  try { await unsafe.click('更新，有更新'); assert.equal(unsafe.document.querySelector('a'), null); }
  finally { await unsafe.dispose(); }
});

test('only an active operation polls status, then stops when installation is ready', async () => {
  let state = { ...update(), phase: 'downloading' }, tick, cleared = 0;
  const view = await mount(() => state, {}, { setInterval: (callback, delay) => { assert.equal(delay, 2000); tick = callback; return 1; }, clearInterval: () => { cleared++; } });
  try {
    assert.deepEqual(view.calls.map(call => call.action), ['status']);
    assert.equal(typeof tick, 'function');
    state = { ...state, phase: 'ready', restartRequired: true };
    await view.flush(tick);
    assert.deepEqual(view.calls.map(call => call.action), ['status', 'status']);
    assert.equal(cleared, 1);
    assert(view.button('更新，待重启'));
  } finally { await view.dispose(); }
});

test('desktop app update opens the public bridge without a feed entry, prevents reentry and retries errors; mobile shows only its host version', async () => {
  let calls = 0, rejectOpen;
  const blocked = new Promise((_resolve, reject) => { rejectOpen = reject; });
  const updates = { open() { assert.equal(this, updates); calls++; return calls === 1 ? blocked : undefined; } };
  const view = await mount(initial, {}, { dshDesktop: { updates } });
  try {
    await view.click('更新');
    assert(view.button('检查应用更新'));
    await view.click('检查应用更新');
    assert.equal(calls, 1);
    assert(view.button('正在打开…').disabled);
    await view.click('正在打开…');
    assert.equal(calls, 1);
    await view.flush(() => rejectOpen(Error('桌面更新服务不可用')));
    assert.match(view.document.querySelector('[role="alert"]').textContent, /桌面更新服务不可用/);
    await view.click('重试');
    assert.equal(calls, 2);
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert(view.button('检查应用更新'));
  } finally { await view.dispose(); }
  const mobile = await mount(() => ({ ...initial(), release: { app: { version: '0.1.2', url: 'https://github.com/example/repo/releases/latest' } } }));
  try { await mobile.click('更新，有更新'); assert.equal(mobile.button('检查应用更新'), undefined); assert.equal(mobile.document.querySelector('a'), null); assert.match(mobile.document.querySelector('.cmd-update-app-version').textContent, /应用 v0.1.1/); }
  finally { await mobile.dispose(); }
  const older = await mount(() => ({ ...initial(), release: { app: { version: '0.1.0', available: false } } }), {}, { dshDesktop: { updates } });
  try { assert(older.button('更新')); await older.click('更新'); assert.doesNotMatch(older.document.querySelector('.cmd-update-app').textContent, /有新版本/); assert(older.button('检查应用更新')); }
  finally { await older.dispose(); }
});

test('server deployment with an unpublished feed explains deployment ownership without a migration warning or failure alert', async () => {
  let state = { ...initial(), installation: 'server', managed: false, phase: 'unpublished', notice: '更新通道尚未就绪', error: 'HTTP 404' };
  const view = await mount(() => state);
  try {
    await view.click('更新');
    const dialog = view.document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /此主机由服务器部署管理/);
    assert.match(dialog.textContent, /主机更新后，刷新工作台即可使用新版/);
    assert.match(dialog.textContent, /更新通道尚未就绪/);
    assert.doesNotMatch(dialog.textContent, /请先安装新版应用|插件已是最新版本|HTTP 404/);
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert.equal(view.button('重试'), undefined);
    assert.equal(view.button('检查更新').disabled, false);
    state = { ...update(), installation: 'server', managed: false, canInstall: false };
    await view.click('检查更新');
    assert.equal(view.calls.at(-1).action, 'check');
    assert.equal(view.button('更新插件'), undefined);
    assert.equal(view.button('检查更新').disabled, false);
    await view.click('检查更新');
    assert.equal(view.calls.at(-1).action, 'check');
    assert(!view.calls.some(call => call.action === 'install'));
  } finally { await view.dispose(); }
});

test('legacy desktop keeps its migration guidance while a managed server can still install plugin updates', async () => {
  const legacy = await mount(() => ({ ...initial(), installation: 'desktop', managed: false }));
  try { await legacy.click('更新'); assert.match(legacy.document.querySelector('[role="dialog"]').textContent, /请先安装新版应用/); }
  finally { await legacy.dispose(); }
  const managed = await mount(() => ({ ...update(), installation: 'server', managed: true }));
  try { await managed.click('更新，有更新'); assert.equal(managed.button('更新插件').disabled, false); assert.doesNotMatch(managed.document.querySelector('[role="dialog"]').textContent, /此主机由服务器部署管理/); }
  finally { await managed.dispose(); }
});
