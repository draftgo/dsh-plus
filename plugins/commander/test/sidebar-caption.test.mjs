import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { shellUi } from '../scripts/shell-ui.mjs';

const sidebarPath = fileURLToPath(new URL('../../../deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx', import.meta.url));
const sidebarRequire = createRequire(sidebarPath);
const rendererRequire = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url));
const upstreamRequire = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url));
const React = sidebarRequire('react');
const { createRoot } = rendererRequire('react-dom/client');
const { JSDOM } = upstreamRequire('jsdom');
const handlers = [];
shellUi().setup({ onLoad: (meta, callback) => handlers.push({ ...meta, callback }) });
const { contents } = await handlers.find(handler => handler.filter.test(sidebarPath)).callback({ path: sidebarPath });
const { code } = await transform(contents, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
const pluginCss = await readFile(new URL('../client/style.css', import.meta.url), 'utf8');

function mountSidebar({ windows, collapsed = false }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  if (windows) dom.window.document.documentElement.setAttribute('data-windows-titlebar', '');
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, document: dom.window.document, window: dom.window, process, require(id) {
    if (id === './SidebarRoot.module.css') return { __esModule: true, default: new Proxy({}, { get: (_, name) => 'SidebarRoot_' + String(name) }) };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
      Tooltip: ({ children }) => children,
      isDarwinDesktop: () => false,
      FishLogo: () => null,
      IconPanelLeftOutlineRegular: () => null,
      IconNewChatOutlineMedium: () => null,
      IconNewChatOutlineRegular: () => null,
      ShortcutKeys: () => null,
    };
    return sidebarRequire(id);
  } });
  const style = dom.window.document.createElement('style');
  style.textContent = pluginCss;
  dom.window.document.head.append(style);
  const root = createRoot(dom.window.document.getElementById('root'));
  let toggleCount = 0;
  function render() {
    React.act(() => root.render(React.createElement(module.exports.SidebarRoot, {
      collapsed, width: collapsed ? (windows ? 0 : 56) : 300,
      usePanels: selector => selector([]),
      useShortcuts: selector => selector([]),
      usePanelInfo: selector => selector({ activePanelId: null }),
      startSession() {}, selectPanel() {},
      toggleSidebar() { collapsed = !collapsed; toggleCount++; render(); },
      t: key => key,
      renderSlot: (name, { wide } = {}) => name === 'sidebar.workspaces'
        ? React.createElement('div', { className: 'cmd-projects' + (wide ? '' : ' cmd-narrow') })
        : null,
    })) );
  }
  render();
  return {
    document: dom.window.document,
    get collapsed() { return collapsed; },
    get toggleCount() { return toggleCount; },
    row: () => dom.window.document.querySelector('.SidebarRoot_logoRow'),
    toggle: () => dom.window.document.querySelector('button[aria-label="' + (collapsed ? 'toggle.open' : 'toggle.collapse') + '"]'),
    click() { React.act(() => this.toggle().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); },
    transform() { return dom.window.getComputedStyle(this.row()).transform; },
    close() {
      React.act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

for (const initiallyCollapsed of [false, true]) test('Windows caption toggle survives repeated collapse and expand, initial collapsed=' + initiallyCollapsed, () => {
  const view = mountSidebar({ windows: true, collapsed: initiallyCollapsed });
  try {
    for (let count = 0; count < 6; count++) {
      assert(view.toggle(), 'the current open/collapse action stays mounted');
      assert.equal(view.row().style.transform, 'none');
      assert.equal(view.transform(), 'none', 'the web rail must not contain the fixed caption control');
      const wasCollapsed = view.collapsed;
      view.click();
      assert.equal(view.collapsed, !wasCollapsed);
      assert.equal(view.toggleCount, count + 1);
    }
  } finally { view.close(); }
});

test('web collapse retains the centered narrow rail and clickable reopen control', () => {
  const view = mountSidebar({ windows: false, collapsed: true });
  try {
    assert.equal(view.row().style.transform, '');
    assert.equal(view.transform(), 'translateX(-50%)');
    view.click();
    assert.equal(view.collapsed, false);
    view.click();
    assert.equal(view.collapsed, true);
    assert.equal(view.transform(), 'translateX(-50%)');
    assert(view.toggle());
  } finally { view.close(); }
});

test('Windows application menu keeps the same compact gap in both sidebar states', () => {
  const view = mountSidebar({ windows: true });
  try {
    const selector = 'html[data-windows-titlebar]:has(.cmd-shell-sidebar .cmd-projects)';
    for (let step = 0; step < 4; step++) {
      assert.equal(view.document.documentElement.matches(selector), true);
      assert.equal(view.document.defaultView.getComputedStyle(view.document.documentElement).getPropertyValue('--dsh-windows-menu-start').trim(), '48px');
      view.click();
    }
  } finally { view.close(); }
});

test('official Windows zero-width geometry and fixed caption positioning remain intact', async () => {
  const frame = await readFile(new URL('../../../deepseek-harness/packages/client/ui-layout/src/client/AppFrame.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../../deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.module.css', import.meta.url), 'utf8');
  assert.match(frame, /hasAttribute\('data-windows-titlebar'\) \? 0 : SIDEBAR_COLLAPSED/);
  assert.match(css, /:global\(\[data-windows-titlebar\]\) \.toggle\s*\{\s*position: fixed;/);
});
