import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startupWindowPlugin, verifyStartupBundle } from './prepare-startup.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Compile only the tray's localized labels; changed upstream anchors stop packaging. */
export function prepareTrayInput(source) {
  let code = source.replaceAll('\r\n', '\n');
  const substitutions = [
    ['export class DesktopTray {', 'export class DesktopTray {'],
    ['const { messages } = this.options.locale();', 'const { id, messages } = this.options.locale();'],
    ['{ label: messages.openApplication, click: () => { this.options.open(); } }', "{ label: id === 'zh-CN' ? '主窗口' : 'Main Window', click: () => { this.options.open(); } }"],
    ['{ label: messages.quitApplication, click: () => { this.options.quit(); } }', "{ label: id === 'zh-CN' ? '退出' : 'Quit', click: () => { this.options.quit(); } }"],
  ];
  for (const [before, after] of substitutions) {
    if (code.split(before).length !== 2) throw new Error(`Official tray changed: expected one ${before}; review packaging labels`);
    code = code.replace(before, after);
  }
  return code;
}

/** Limit compile-time substitutions to the official tray module, exactly once per main build. */
export function trayLabelsPlugin(trayPath) {
  const target = resolve(trayPath);
  let transformed = 0;
  return {
    name: 'xiaojiao-tray-labels',
    buildStart() { transformed = 0; },
    transform(source, id) {
      if (resolve(id) !== target) return null;
      transformed++;
      return { code: prepareTrayInput(source), map: null };
    },
    generateBundle() {
      if (transformed !== 1) throw new Error(`Official tray changed: expected one compiled tray module, got ${transformed}`);
    },
  };
}

/** Reject a staged or packed main bundle whose tray labels no longer match the reviewed menu. */
export function verifyTrayBundle(source) {
  const matches = [...source.matchAll(/[/][/]#region [^\n]*lib[/]types[/]tray\.js\n([\s\S]*?)[/][/]#endregion/g)];
  if (matches.length !== 1) throw new Error('Compiled desktop tray section changed; review packaging verification');
  const tray = matches[0][1];
  for (const label of ['label: id === "zh-CN" ? "主窗口" : "Main Window"', 'label: id === "zh-CN" ? "退出" : "Quit"']) {
    if (tray.split(label).length !== 2) throw new Error('Compiled desktop tray is missing localized 小角 labels');
  }
  if (tray.includes('label: messages.openApplication') || tray.includes('label: messages.quitApplication')) throw new Error('Compiled desktop tray still uses upstream menu labels');
}

/** Build the official main entry into a root-owned staging directory; no upstream files change. */
export async function prepareDesktopTray(repositoryRoot, output) {
  const engine = join(repositoryRoot, 'deepseek-harness');
  const desktop = join(engine, 'apps/desktop');
  const require = createRequire(join(engine, 'package.json'));
  const [{ build }, { default: configs }] = await Promise.all([
    import(pathToFileURL(require.resolve('tsdown')).href),
    import(pathToFileURL(join(desktop, 'tsdown.config.ts')).href),
  ]);
  const main = configs.filter(config => Array.isArray(config.entry) && config.entry.length === 1 && config.entry[0] === 'lib/types/main.js');
  if (main.length !== 1 || typeof main[0].onSuccess !== 'function') throw new Error('Official desktop main bundle configuration changed; review tray compilation');
  const { onSuccess: _rendererBuild, ...config } = main[0];
  // The official full build already prepared welcome assets and preloads. Reuse its
  // main-process settings and import checks without rebuilding unrelated renderers.
  await mkdir(output, { recursive: true });
  await build({
    ...config, config: false, cwd: desktop, entry: [join(desktop, 'lib/types/main.js')],
    outDir: output, clean: true, plugins: [...config.plugins, trayLabelsPlugin(join(desktop, 'lib/types/tray.js')), startupWindowPlugin(join(desktop, 'lib/types/main.js'))],
  });
  const code = await readFile(join(output, 'main.js'), 'utf8');
  verifyTrayBundle(code);
  verifyStartupBundle(code);
  return join(output, 'main.js');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDesktopTray(root, join(root, '.local/desktop/main'));
}
