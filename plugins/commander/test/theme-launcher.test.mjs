import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const require = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url));
const React = require('react');
const { createRoot } = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url))('react-dom/client');
const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const code = transformSync(readFileSync(new URL('../client/theme-launcher.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const module = { exports: {} };
runInNewContext(code, { module, exports: module.exports, require: id => id === 'react' ? React : {
  Tooltip: ({ children, label }) => React.createElement('span', { title: label }, children),
  IconLightOutlineMedium: () => React.createElement('svg', { 'data-icon': 'light' }),
  IconDarkOutlineMedium: () => React.createElement('svg', { 'data-icon': 'dark' }),
} });
const { ThemeLauncher, createThemeSource } = module.exports;

for (const [preference, scheme] of [['light', 'light'], ['dark', 'dark'], ['system', 'light'], ['system', 'dark']]) {
  test(`theme shortcut toggles resolved ${scheme} from ${preference} and follows external changes`, () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const previous = new Map();
    for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    let snapshot = { preference, active: { colorScheme: scheme } };
    const listeners = new Set(), writes = [];
    const publish = (preference, colorScheme) => { snapshot = { preference, active: { colorScheme } }; for (const listener of listeners) listener(); };
    const ctx = {
      theme: { getTheme: () => snapshot, setTheme: value => { writes.push(value); publish(value, value); } },
      on: (event, listener) => { assert.equal(event, 'theme/change'); listeners.add(listener); return () => listeners.delete(listener); },
    };
    const source = createThemeSource(ctx);
    const root = createRoot(dom.window.document.getElementById('root'));
    const button = () => dom.window.document.querySelector('button');
    const click = () => React.act(() => button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    try {
      React.act(() => root.render(React.createElement(ThemeLauncher, { theme: source })));
      assert.equal(button().getAttribute('aria-label'), scheme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
      assert.equal(listeners.size, 1);
      click();
      const target = scheme === 'dark' ? 'light' : 'dark';
      assert.deepEqual(writes, [target]);
      assert.equal(button().querySelector('svg').getAttribute('data-icon'), scheme);
      click();
      assert.deepEqual(writes, [target, scheme]);
      React.act(() => publish('system', target));
      assert.equal(button().getAttribute('aria-label'), target === 'dark' ? '切换到浅色模式' : '切换到深色模式');
      click();
      assert.equal(writes.at(-1), scheme);
    } finally {
      React.act(() => root.unmount());
      assert.equal(listeners.size, 0);
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}

test('wide and rail footer keep theme, update and usage shortcuts in order', () => {
  const source = readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8');
  const code = transformSync(source + '\nexport { SettingsLauncher };', { loader: 'jsx', format: 'cjs' }).code;
  const UsageLauncher = () => null;
  const UpdateLauncher = () => null;
  const Stub = () => null;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: id => {
    if (id === 'react') return { ...React, useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() };
    if (id === './theme-launcher.jsx') return { ThemeLauncher };
    if (id === './usage.jsx') return { UsageLauncher, UsageDialog: Stub };
    if (id === './updates.jsx') return { UpdateLauncher };
    if (id === './iconsax.jsx') return { UIIcon: Stub };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: Stub };
    return {};
  } });
  for (const wide of [true, false]) {
    const theme = {};
    const tree = module.exports.SettingsLauncher({ wide, theme, openSettings() {} });
    const children = React.Children.toArray(tree.props.children);
    const position = children.findIndex(child => child.type === ThemeLauncher);
    assert(position >= 0);
    assert.equal(children[position + 1].type, UpdateLauncher);
    assert.equal(children[position + 2].type, UsageLauncher);
    assert.equal(children[position].props.theme, theme);
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-theme'));
});
