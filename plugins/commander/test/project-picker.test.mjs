import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const React = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url))('react');
const { createRoot } = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url))('react-dom/client');
const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const compiled = transformSync(readFileSync(new URL('../client/project-picker.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const listing = (path, entries = []) => ({ path, parent: '/', home: '/home', entries });

async function mount({ api, desktop, onSelected = () => {}, onClose = () => {} }) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>'), previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const module = { exports: {} };
  const primitives = {
    Modal: ({ children }) => React.createElement('div', { role: 'dialog' }, children),
    Tooltip: ({ children }) => children,
    LinkIconMedium: () => null,
  };
  runInNewContext(compiled, { module, exports: module.exports, document: dom.window.document, __DSH_DIRECTORY_PICKER__: desktop, require: id => id === 'react' ? React : id.includes('ui-primitives') ? primitives : { UIIcon: () => null } });
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = callback => React.act(async () => { callback?.(); await new Promise(resolve => setImmediate(resolve)); });
  const button = label => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  await flush(() => root.render(React.createElement(module.exports.ProjectPicker, { api, onSelected, onClose })));
  return {
    document: dom.window.document, window: dom.window, button, flush,
    click: label => flush(() => { const node = button(label); assert(node, `Missing button: ${label}`); node.click(); }),
    async dispose() {
      await flush(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    },
  };
}

test('failed folder navigation disables adding the old directory and retries the failed target', async () => {
  const calls = [], pending = deferred(); let attempts = 0;
  const view = await mount({ api: async (action, args) => {
    calls.push({ action, path: args?.path });
    if (args?.path === '/home/repo' && ++attempts === 1) return pending.promise;
    return listing(args?.path ?? '/home', [{ name: 'repo', path: '/home/repo' }]);
  } });
  try {
    await view.click('repo');
    assert.equal(view.button('添加项目').disabled, true);
    await view.click('添加项目');
    await view.flush(() => pending.reject(Error('Access denied')));
    assert.match(view.document.querySelector('[role="alert"]').textContent, /Access denied/);
    assert.equal(view.button('添加项目').disabled, true);
    await view.click('添加项目');
    assert.equal(calls.some(call => call.action === 'project'), false);
    await view.click('重试');
    assert.equal(calls.at(-1).path, '/home/repo');
    assert.equal(view.button('添加项目').disabled, false);
    await view.click('添加项目');
    assert.equal(calls.at(-1).action, 'project');
    assert.equal(calls.at(-1).path, '/home/repo');
  } finally { await view.dispose(); }
});

test('folder and GitHub tabs support arrow, Home and End keys and move focus with selection', async () => {
  const view = await mount({ api: async () => listing('/home') });
  try {
    view.button('文件夹').focus();
    for (const [key, expected] of [['ArrowRight', 'GitHub'], ['ArrowRight', '文件夹'], ['End', 'GitHub'], ['Home', '文件夹'], ['ArrowLeft', 'GitHub']]) {
      const event = new view.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      await view.flush(() => view.document.activeElement.dispatchEvent(event));
      const selected = view.document.querySelector('[role="tab"][aria-selected="true"]');
      assert.equal(selected.textContent, expected);
      assert.equal(view.document.activeElement, selected);
      assert.equal(event.defaultPrevented, true);
      assert.equal(view.document.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), selected.id);
      assert.equal(view.document.querySelector('[role="tab"][aria-selected="false"]').tabIndex, -1);
    }
  } finally { await view.dispose(); }
});

test('desktop cancellation and picker failures release busy state and allow a subsequent selection', async () => {
  const first = deferred(), calls = [], selected = []; let attempt = 0, closed = 0;
  const view = await mount({
    desktop: { pick: async () => { if (++attempt === 1) return first.promise; if (attempt === 2) throw Error('Picker unavailable'); return 'C:\\repo'; } },
    api: async (action, args) => { calls.push(action); return action === 'project' ? { project: { id: args.path } } : listing('C:\\'); },
    onSelected: project => selected.push(project.id), onClose: () => { closed++; },
  });
  try {
    await view.click('系统选择文件夹');
    assert.equal(view.button('系统选择文件夹').disabled, true);
    assert.equal(view.button('关闭').disabled, true);
    await view.click('关闭');
    assert.equal(closed, 0);
    await view.flush(() => first.resolve(null));
    assert.equal(view.button('系统选择文件夹').disabled, false);
    assert.equal(calls.includes('project'), false);
    await view.click('系统选择文件夹');
    assert.match(view.document.querySelector('[role="alert"]').textContent, /Picker unavailable/);
    assert.equal(view.button('关闭').disabled, false);
    await view.click('系统选择文件夹');
    assert.deepEqual(selected, ['C:\\repo']);
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert.equal(view.button('关闭').disabled, false);
  } finally { await view.dispose(); }
});
