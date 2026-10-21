import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Geometry assertions only; no app/server launch, screenshot or visual review.
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const file = path => new URL(path, import.meta.url);
const read = path => readFileSync(file(path), 'utf8');
const official = '../../../deepseek-harness/packages/client/ui-conversation/src/client/skeleton/';

async function cssModule(path) {
  const result = await build({ entryPoints: [file(path).pathname], bundle: true, write: false, outdir: '/tmp/commander-layout-test', logLevel: 'silent' });
  const output = result.outputFiles.find(item => item.path.endsWith('.css'));
  return output.text.replace(/(?<![\w-])\.(?:InputBar|PermissionSelect)_([A-Za-z][\w-]*)/g, (_, name) => '.test_' + name);
}

test('mobile composer keeps permission, opaque model, voice and send on one line at 320/390/767', {
  skip: !existsSync(process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()) && 'Requires installed Playwright Chromium or CHROMIUM_EXECUTABLE_PATH',
}, async () => {
  const inputCss = await cssModule(official + 'InputBar.module.css');
  const permissionCss = await cssModule('../../../deepseek-harness/packages/client/ui-permission-presets/src/client/PermissionSelect.module.css');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const model = 'opaque:deepseek-v4.1-flash-with-a-very-long-provider-model-id';
    for (const width of [320, 390, 767]) {
      await page.setViewportSize({ width, height: 780 });
      await page.setContent(`<style>body{margin:0}*{box-sizing:border-box}svg{width:14px;height:14px;flex:none}${inputCss}${permissionCss}${read('../client/model-picker.css')}${read('../voice/client/style.css')}${read('../client/mobile-workbench.css')}</style>
        <div class="cmd-shell-frame"><section style="padding:10px"><div data-composer-card class="test_card"><div class="test_row">
        <div class="test_tools"><button class="test_add" aria-label="添加">+</button><div class="test_modes">
        <button class="test_trigger" aria-label="权限：超长无图标的自定义权限模式名称"><span class="test_triggerLabel">超长无图标的自定义权限模式名称</span><span class="test_chevron"><svg></svg></span></button>
        <button class="test_trigger" aria-label="计划模式"><span class="test_triggerIcon"><svg></svg></span><span class="test_triggerLabel">计划</span></button></div></div>
        <div class="test_trailing"><div class="test_standardControls"><button class="cmd-model-trigger" aria-label="${model}"><span class="cmd-model-caption">${model}</span><span class="cmd-ui-icon"><svg></svg></span></button></div>
        <div class="test_activity"><div class="voice-activity">${['听写','朗读','通话'].map(label => `<button class="voice-icon-button" aria-label="${label}"><svg></svg></button>`).join('')}</div></div>
        <button class="test_primary" aria-label="发送">↑</button></div></div></div></section></div>`);
      const state = await page.evaluate(() => {
        const row = document.querySelector('.test_row');
        const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, height: box.height, width: box.width, right: box.right }; };
        const buttons = [...row.querySelectorAll('button')].map(node => ({ label: node.getAttribute('aria-label'), ...rect(node) }));
        const caption = document.querySelector('.cmd-model-caption');
        return { row: rect(row), buttons, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, overflow: getComputedStyle(row).overflow, caption: { width: caption.clientWidth, scroll: caption.scrollWidth, ellipsis: getComputedStyle(caption).textOverflow }, id: document.querySelector('.cmd-model-trigger').getAttribute('aria-label') };
      });
      assert.equal(state.id, model, `${width}: model ID remains intact`);
      assert.equal(state.buttons.length, 8);
      assert(state.scrollWidth <= state.clientWidth + 1, `${width}: row must fit ${JSON.stringify(state)}`);
      assert(!['hidden', 'clip'].includes(state.overflow), `${width}: controls cannot be cropped`);
      for (const button of state.buttons) {
        assert(button.width > 0, `${width}: ${button.label} remains visible`);
        assert(button.x >= state.row.x - 1 && button.right <= state.row.right + 1, `${width}: ${button.label} stays within row`);
        assert(Math.abs(button.y + button.height / 2 - state.buttons[0].y - state.buttons[0].height / 2) < 3, `${width}: ${button.label} stays on the same line ${JSON.stringify(state)}`);
      }
      assert.equal(state.caption.ellipsis, 'ellipsis');
      if (width < 400) assert(state.caption.scroll > state.caption.width, `${width}: model text truncates`);
      for (const button of state.buttons.filter(item => ['听写','朗读','通话','发送'].includes(item.label))) assert(button.width >= 30, `${width}: ${button.label} preserves its target`);
      await page.evaluate(() => {
        document.querySelector('.voice-activity').insertAdjacentHTML('beforeend', '<span class="voice-inline-error">语音配置尚未完成，请在设置页面补充供应商与模型</span>');
      });
      assert(await page.$eval('.test_row', node => node.scrollWidth <= node.clientWidth + 1), `${width}: inline voice errors cannot push controls outside row`);
      await page.evaluate(() => {
        document.querySelector('.test_tools').hidden = true;
        document.querySelector('.test_standardControls').hidden = true;
        document.querySelector('.test_activity').className = 'test_activityExpanded';
        const activity = document.querySelector('.voice-activity');
        activity.className = 'voice-activity voice-expanded voice-dictating';
        activity.innerHTML = '<div class="voice-recording-strip"><span class="voice-recording-pulse">••••••</span><span class="voice-recording-caption">这是一段很长的正在转录文字</span><button class="voice-icon-button" aria-label="停止转录"><svg></svg></button></div><span class="voice-inline-error">服务连接中断，请重试</span>';
      });
      assert(await page.$eval('.test_row', node => node.scrollWidth <= node.clientWidth + 1), `${width}: dictation and errors stay inside row`);
      await page.evaluate(() => {
        document.querySelector('[data-composer-card]').classList.add('voice-call-composer');
        document.querySelector('.voice-activity').innerHTML = '<div class="voice-call-panel"><div class="voice-call-controls">通话</div></div>';
      });
      assert.equal(await page.$eval('.test_row', node => getComputedStyle(node).display), 'block', `${width}: call panel keeps expanded layout`);
    }
    await page.close();
  } finally { await browser.close(); }
});
