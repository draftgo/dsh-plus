import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { openStartupWindow } from './startup-window.mjs';
import { startupWindowPlugin } from './prepare-startup.mjs';

function fixture(fail = false) {
  const app = new EventEmitter();
  app.quit = () => { app.quits = (app.quits ?? 0) + 1; };
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      app.emit('browser-window-created', {}, this);
    }
    async loadFile(page) { this.page = page; if (fail) throw new Error('missing page'); }
    isDestroyed() { return Boolean(this.destroyed); }
    isVisible() { return Boolean(this.visible); }
    show() { this.visible = true; this.emit('show'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const nativeImage = { createFromPath: path => ({ path, isEmpty: () => !path }) };
  return { app, BrowserWindow, nativeImage, windows, page: '/renderer/splash.html', iconPath: 'icon.png' };
}

test('splash covers hidden backend startup and disposes only when another window appears', async () => {
  const env = fixture();
  const close = await openStartupWindow(env);
  const splash = env.windows[0];
  const main = new env.BrowserWindow({ show: false });
  assert.equal(splash.isVisible(), true);
  assert.equal(splash.isDestroyed(), false);
  assert.equal(splash.options.icon.path, 'icon.png');
  assert.equal(splash.options.webPreferences.sandbox, true);
  assert.equal(splash.options.webPreferences.preload, undefined);
  assert.deepEqual(splash.openHandler(), { action: 'deny' });
  main.show();
  assert.equal(splash.isDestroyed(), true);
  assert.equal(env.app.quits, undefined);
  assert.equal(env.app.listenerCount('browser-window-created'), 0);
  assert.equal(main.listenerCount('closed'), 0);
  close();
});

test('fatal cleanup and quit dispose the card without an extra quit request', async () => {
  for (const action of ['fatal', 'quit']) {
    const env = fixture();
    const close = await openStartupWindow(env);
    if (action === 'fatal') close(); else env.app.emit('will-quit');
    assert.equal(env.windows[0].isDestroyed(), true);
    assert.equal(env.app.quits, undefined);
    assert.equal(env.app.listenerCount('will-quit'), 0);
  }
});

test('a user close quits; an unavailable splash still allows official startup', async () => {
  const env = fixture();
  await openStartupWindow(env);
  env.windows[0].destroy();
  assert.equal(env.app.quits, 1);
  const failed = fixture(true);
  await openStartupWindow(failed);
  assert.equal(failed.windows[0].isDestroyed(), true);
  assert.equal(failed.app.quits, undefined);
});

test('compile integration targets one official entry and rejects changed lifecycle anchors', async () => {
  const path = new URL('../../deepseek-harness/apps/desktop/lib/types/main.js', import.meta.url);
  const source = await readFile(path, 'utf8');
  const plugin = startupWindowPlugin(path.pathname);
  plugin.buildStart();
  assert.equal(plugin.transform(source, '/other.js'), null);
  assert.throws(() => plugin.generateBundle(), /got 0/);
  const code = plugin.transform(source, path.pathname).code;
  assert.ok(code.indexOf('closeXiaojiaoStartup = await') < code.indexOf('const desktopSettings ='));
  assert.match(code, /function reportFatal\(error, source\) \{\n    closeXiaojiaoStartup\?\.\(\);/);
  plugin.generateBundle();
  assert.throws(() => plugin.transform(source.replace('async function main()', 'async function changed()'), path.pathname), /Official startup changed/);
});
