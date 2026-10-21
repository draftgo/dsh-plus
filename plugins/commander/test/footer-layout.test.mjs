import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build, transformSync } from 'esbuild';

const require = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url));
const React = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url))('react');
const { renderToStaticMarkup } = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url))('react-dom/server');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const settings = '../../../deepseek-harness/packages/client/ui-settings-general/src/client/';

async function moduleCss(path, prefix) {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, outdir: '/tmp/commander-footer-test', logLevel: 'silent' });
  return result.outputFiles.find(file => file.path.endsWith('.css')).text.replace(new RegExp('\\.' + prefix + '_', 'g'), '.test_');
}

test('all six footer launchers request tooltip space above their buttons', () => {
  const source = read('../client/index.jsx');
  const settingsLauncher = source.slice(source.indexOf('function SettingsLauncher('), source.indexOf('function Hint('));
  assert.match(settingsLauncher, /<Tooltip label="设置" side="top" gap=\{10\}/);
  assert.match(settingsLauncher, /<Hint side="top" gap=\{10\}/);
  assert.match(settingsLauncher, /<Tooltip label="GitHub" side="top" gap=\{10\}/);
  for (const file of ['theme-launcher.jsx', 'updates.jsx', 'usage.jsx']) assert.match(read('../client/' + file), /<Tooltip[^>]*side="top" gap=\{10\}/);
});

test('actual native install/restart button is above the shortcut row at wide, narrow, rail and mobile sizes', {
  skip: !existsSync(process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()) && 'Requires installed Playwright Chromium or CHROMIUM_EXECUTABLE_PATH',
}, async () => {
  const code = transformSync(read(settings + 'DesktopUpdateIndicator.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: id => id === 'react/jsx-runtime' ? require('react/jsx-runtime') : id.includes('ui-primitives') ? { Tooltip: ({ children }) => children, IconDownloadOutlineRegular: () => React.createElement('svg'), IconLoadingOutlineRegular: () => React.createElement('svg') } : id.endsWith('.css') ? { indicator: 'test_indicator', icon: 'test_icon' } : {} });
  const install = renderToStaticMarkup(React.createElement(module.exports.DesktopUpdateIndicator, { wide: true, hidden: false, t: key => key === 'desktop.update.ready' ? '安装并重启' : key, view: { presentation: { phase: 'ready', version: '2026.10' }, failed: false, opening: false }, onOpen() {} }));
  const css = await moduleCss(settings + 'SettingsRoot.module.css', 'SettingsRoot');
  const updateCss = await moduleCss(settings + 'DesktopUpdateIndicator.module.css', 'DesktopUpdateIndicator');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    for (const [width, rail, viewport] of [[280, false, 1024], [180, false, 1024], [36, true, 1024], [260, false, 390]]) {
      await page.setViewportSize({ width: viewport, height: 780 });
      await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}${css}${updateCss}${read('../client/style.css')}</style><aside style="position:absolute;bottom:10px;left:12px;width:${width}px"><div class="test_triggerRow ${rail ? 'test_railRow' : ''} cmd-sidebar-footer"><div class="cmd-sidebar-status">${install}</div><div class="cmd-settings-row ${rail ? 'cmd-settings-row-rail' : ''}">${['设置', '主题', '更新', '用量', '归档', 'GitHub'].map(label => `<button class="cmd-archive-launcher">${label}</button>`).join('')}</div></div></aside>`);
      const state = await page.evaluate(() => {
        const rect = node => { const value = node.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width }; };
        return { action: rect(document.querySelector('.cmd-sidebar-status button')), row: rect(document.querySelector('.cmd-settings-row')), buttons: [...document.querySelectorAll('.cmd-settings-row > button')].map(rect), sidebar: rect(document.querySelector('aside')), scroll: document.documentElement.scrollWidth };
      });
      assert(state.action.bottom + 5 <= state.row.top, `${width}/${rail}: native update action reserves a separate line`);
      assert(state.action.width > 0);
      for (const button of state.buttons) {
        assert(button.top >= state.row.top && button.bottom <= state.row.bottom);
        assert(button.left >= state.sidebar.left - 3 && button.right <= state.sidebar.right + 3);
      }
      assert(state.scroll <= viewport, `${width}/${rail}: footer does not overflow viewport`);
    }
    await page.close();
  } finally { await browser.close(); }
});
