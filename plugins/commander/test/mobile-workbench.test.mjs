import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { trackFrameResize } from '../client/resize-settling.mjs';

const React = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url))('react');
const { createRoot } = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url))('react-dom/client');
const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const source = readFileSync(new URL('../client/mobile-workbench.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/mobile-workbench.css', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;

test('shared mobile shell uses official navigation, traps drawer focus, restores interaction and keeps typed input', async () => {
  const dom = new JSDOM('<!doctype html><div class="cmd-shell-frame" data-plus-shell data-sidebar-collapsed><div id="drawer"><div class="cmd-shell-sidebar"><button id="first">收起</button><button class="cmd-session">最近对话</button><button id="last" class="cmd-settings">设置</button></div></div><main class="centerCol"><input value="保留的草稿"></main><div data-rightbar-col></div><div data-shell-overlay id="react"></div></div>', { pretendToBeVisual: true });
  const query = new dom.window.EventTarget(); query.matches = true;
  dom.window.matchMedia = () => query;
  Object.defineProperty(dom.window, 'innerHeight', { value: 720, writable: true });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [{}]; };
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const module = { exports: {} };
  // Browser-dispatched touch clicks may checkpoint microtasks between native
  // listeners, before React's delegated listener receives the original target.
  runInNewContext(compiled, { module, exports: module.exports, window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, queueMicrotask: callback => callback(), require: id => id === 'react' ? React : id.endsWith('.css') ? css : id.includes('resize-settling') ? { trackFrameResize: () => () => {} } : { UIIcon: ({ name, selected }) => React.createElement('span', { 'data-icon': name, 'data-selected': selected }) } });
  const frame = dom.window.document.querySelector('.cmd-shell-frame');
  let starts = 0, toggles = 0, opened = 0;
  document.addEventListener('click', event => {
    if (!event.target.closest('.cmd-session')) return;
    assert.equal(frame.hasAttribute('data-sidebar-collapsed'), false, 'the delegated session handler runs before the drawer closes');
    opened++;
  });
  const ctx = { layout: { toggleSidebar: () => { toggles++; frame.toggleAttribute('data-sidebar-collapsed'); } }, uiWorkspace: { startSession: () => { starts++; } } };
  const root = createRoot(dom.window.document.getElementById('react'));
  const flush = fn => React.act(async () => { fn?.(); await new Promise(resolve => setTimeout(resolve, 5)); });
  const click = selector => flush(() => dom.window.document.querySelector(selector).click());
  try {
    await flush(() => root.render(React.createElement(module.exports.MobileWorkbench, { ctx })));
    assert.equal(document.documentElement.style.getPropertyValue('--cmd-mobile-viewport-height'), '720px');
    assert.equal(document.querySelector('.cmd-mobile-toolbar button').getAttribute('aria-expanded'), 'false');
    await click('.cmd-mobile-toolbar button');
    assert.equal(toggles, 1);
    assert.equal(document.querySelector('#drawer').getAttribute('aria-modal'), 'true');
    assert.equal(document.querySelector('main').inert, true);
    assert.equal(document.activeElement.id, 'first');
    document.querySelector('#last').focus();
    await flush(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.id, 'first');
    await flush(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(toggles, 2);
    assert.notEqual(document.querySelector('main').inert, true);
    assert.equal(document.querySelector('#drawer').hasAttribute('role'), false);
    assert.equal(document.activeElement.getAttribute('aria-label'), '打开侧边栏');
    assert.equal(document.querySelector('main input').value, '保留的草稿');
    await click('.cmd-mobile-toolbar button');
    await click('.cmd-session');
    assert.equal(toggles, 4);
    assert.equal(opened, 1);
    await click('.cmd-mobile-toolbar button:last-child');
    assert.equal(starts, 1);
    await click('.cmd-mobile-toolbar button');
    await click('.cmd-settings');
    await flush(() => new Promise(resolve => setTimeout(resolve, 30)));
    assert.equal(toggles, 6);
    assert.notEqual(document.querySelector('main').inert, true);
    await click('.cmd-mobile-toolbar button');
    await click('.cmd-mobile-drawer-mask');
    assert.equal(toggles, 8);
    await flush(() => { window.innerHeight = 420; window.dispatchEvent(new dom.window.Event('resize')); });
    assert.equal(document.documentElement.style.getPropertyValue('--cmd-mobile-viewport-height'), '420px');
    await flush(() => { query.matches = false; query.dispatchEvent(new dom.window.Event('change')); });
    assert.equal(document.querySelector('.cmd-mobile-workbench').hidden, true);
    assert.equal(document.documentElement.style.getPropertyValue('--cmd-mobile-viewport-height'), '');
  } finally {
    await flush(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test('adapter owns reversible CSS/slot only; official settings and editor remain the source of truth', () => {
  const dom = new JSDOM('<!doctype html>'), module = { exports: {} }, cleanups = [], registrations = [];
  runInNewContext(compiled, { module, exports: module.exports, document: dom.window.document, require: id => id === 'react' ? React : id.endsWith('.css') ? css : {} });
  const ctx = { effect: callback => cleanups.push(callback()), slots: { inject: (name, callback) => { assert.equal(name, 'shell.overlay'); callback(); }, register: (options, component) => registrations.push({ options, component }) } };
  module.exports.applyMobileWorkbench(ctx);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.inject().ctx, ctx);
  assert.equal(dom.window.document.querySelectorAll('style[data-commander-mobile-workbench]').length, 1);
  assert.match(css, /grid-column: 2; grid-row: 1/);
  assert.match(css, /\.cmd-shell-sidebar:has\(\.cmd-projects\) \* \{ animation: none !important; transition: none !important; \}/);
  assert.match(css, /\.cmd-shell-frame\[data-plus-resizing\] \* \{ animation: none !important; transition: none !important; \}/);
  assert.match(css, /data-shortcut-modal="settings"/);
  assert.match(css, /contenteditable="true"/);
  assert.doesNotMatch(source, /fetch[(]|localStorage|setInterval/);
  for (const cleanup of cleanups) cleanup();
  assert.equal(dom.window.document.querySelectorAll('style').length, 0);
  dom.window.close();
});

test('mobile header clears safe areas and cancels the desktop corner overhang', () => {
  assert.match(css, /header:has\(\[data-conversation-header-leading\]\)\s*\{[\s\S]*?padding-inline-start: max\(12px, env\(safe-area-inset-left, 0px\)\);[\s\S]*?padding-inline-end: max\(12px, env\(safe-area-inset-right, 0px\)\);/);
  assert.match(css, /\[data-conversation-header-corner\]\s*\{ margin-inline-end: 0; \}/);
});

test('frame resize holds transitions until width settles and cleans up', () => {
  const dom = new JSDOM('<div class="cmd-shell-frame"></div>'), frame = dom.window.document.querySelector('.cmd-shell-frame');
  let width = 900, callback, timer, cancelled = false, disconnected = false;
  frame.getBoundingClientRect = () => ({ width });
  class Observer { constructor(fn) { callback = fn; } observe() {} disconnect() { disconnected = true; } }
  const stop = trackFrameResize(frame, Observer, (fn, delay) => { timer = { fn, delay }; return timer; }, value => { if (timer === value) cancelled = true; });
  width = 700; callback([{ contentRect: { width } }]);
  assert.equal(frame.hasAttribute('data-plus-resizing'), true);
  assert.equal(timer.delay, 260);
  width = 500; callback([{ contentRect: { width } }]);
  assert.equal(cancelled, true);
  timer.fn();
  assert.equal(frame.hasAttribute('data-plus-resizing'), false);
  stop();
  assert.equal(disconnected, true);
  dom.window.close();
});
