import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { prepareTrayInput, trayLabelsPlugin, prepareDesktopTray, verifyTrayBundle } from './prepare-tray.mjs';
import config from './electron-builder.config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const trayPath = join(root, 'deepseek-harness/apps/desktop/lib/types/tray.js');

test('upstream tray anchor changes or duplicates stop compilation', async () => {
  const source = await readFile(trayPath, 'utf8');
  assert.ok(prepareTrayInput(source.replaceAll('\n', '\r\n')).includes("id === 'zh-CN' ? '主窗口'"));
  for (const invalid of [source.replace('messages.openApplication', 'messages.openWindow'), source.replace('this.options.quit();', 'this.options.exit();'), source + source]) {
    assert.throws(() => prepareTrayInput(invalid), /Official tray changed/);
  }
});

test('compile transform only accepts the exact official tray input and exactly once', async () => {
  const source = await readFile(trayPath, 'utf8');
  const plugin = trayLabelsPlugin(trayPath);
  plugin.buildStart();
  assert.equal(plugin.transform(source, trayPath + '.other'), null);
  assert.throws(() => plugin.generateBundle(), /got 0/);
  assert.ok(plugin.transform(source, trayPath).code.includes('Main Window'));
  plugin.generateBundle();
  plugin.transform(source, trayPath);
  assert.throws(() => plugin.generateBundle(), /got 2/);
});

test('the actual main bundle preserves show, quit, relabel and disposal through package mapping', async t => {
  const output = await mkdtemp(join(tmpdir(), 'xiaojiao-tray-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const officialMain = join(root, 'deepseek-harness/apps/desktop/lib/main.js');
  const originals = await Promise.all([readFile(trayPath), readFile(officialMain)]);
  const built = await prepareDesktopTray(root, join(output, 'compiled'));
  const code = await readFile(built, 'utf8');
  verifyTrayBundle(code);
  const section = code.match(/[/][/]#region [^\n]*lib[/]types[/]tray\.js\n([\s\S]*?)[/][/]#endregion/)[1];
  let nativeTray;
  class Tray {
    constructor(icon) { this.icon = icon; this.events = {}; nativeTray = this; }
    on(event, handler) { this.events[event] = handler; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const DesktopTray = runInNewContext(section + '\nDesktopTray;', { Tray, nativeImage: { createFromPath: path => path }, Menu: { buildFromTemplate: items => items } });
  let locale = { id: 'zh-CN', messages: { aboutProduct: 'DeepSeek Harness', openApplication: 'upstream-open', quitApplication: 'upstream-quit' } };
  let opened = 0; let quit = 0;
  const tray = new DesktopTray({ iconPath: 'tray.ico', locale: () => locale, open: () => opened++, quit: () => quit++ });
  assert.equal(nativeTray.menu[0].label, '主窗口');
  assert.equal(nativeTray.menu[1].type, 'separator');
  assert.equal(nativeTray.menu[2].label, '退出');
  assert.equal(nativeTray.tooltip, 'DeepSeek Harness');
  nativeTray.events.click(); nativeTray.menu[0].click(); nativeTray.menu[2].click();
  assert.equal(opened, 2); assert.equal(quit, 1);
  locale = { ...locale, id: 'en' }; tray.relabel();
  assert.equal(nativeTray.menu[0].label, 'Main Window');
  assert.equal(nativeTray.menu[2].label, 'Quit');
  tray.dispose(); assert.equal(nativeTray.destroyed, true);
  assert.deepEqual(await Promise.all([readFile(trayPath), readFile(officialMain)]), originals);
  // Exercise the same staged file mapping and ASAR extraction as the installer.
  const app = join(output, 'app');
  await mkdir(join(app, 'lib'), { recursive: true });
  await writeFile(join(app, 'lib/main.js'), code);
  const require = createRequire(join(root, 'deepseek-harness/apps/desktop/package.json'));
  const { createPackage, extractFile } = createRequire(require.resolve('app-builder-lib'))('@electron/asar');
  await createPackage(app, join(output, 'app.asar'));
  verifyTrayBundle(extractFile(join(output, 'app.asar'), 'lib/main.js').toString('utf8'));
  assert.throws(() => verifyTrayBundle(code.replace('label: id === "zh-CN" ? "主窗口" : "Main Window"', 'label: messages.openApplication')), /missing localized/);
});

test('formal Windows packaging stages the compiled main inside the app dir only while files are collected', async () => {
  const source = await readFile(new URL('./package-windows.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf("await pm(['run', 'build:official'])") < source.indexOf("await run([join(root, 'scripts/desktop/prepare-tray.mjs')]"));
  assert.ok(source.indexOf('prepare-tray.mjs') < source.indexOf("await pm(['exec', 'electron-builder'"));
  assert.equal(config.files.includes('lib/main.js'), true);
  assert.equal(config.files.some(file => typeof file === 'object' && file.to === 'lib/main.js'), false);
  assert.equal(typeof config.beforePack, 'function');
  assert.equal(typeof config.afterAllArtifactBuild, 'function');
  const configSource = await readFile(new URL('./electron-builder.config.mjs', import.meta.url), 'utf8');
  assert.ok(configSource.indexOf('await copyFile(stagedMain, desktopMain)') < configSource.indexOf('config.afterAllArtifactBuild'));
  assert.match(configSource, /afterAllArtifactBuild[\s\S]*writeFile\(desktopMain, officialMainBytes\)/);
  assert.match(configSource, /process\.once\('exit'/);
});
