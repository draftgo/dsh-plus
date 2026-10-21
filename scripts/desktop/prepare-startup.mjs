import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compile startup presentation into the staged entry without modifying upstream files. */
export function startupWindowPlugin(mainPath) {
  const target = resolve(mainPath);
  const helper = fileURLToPath(new URL('./startup-window.mjs', import.meta.url));
  let transformed = 0;
  return {
    name: 'xiaojiao-startup-window',
    buildStart() { transformed = 0; },
    transform(source, id) {
      if (resolve(id) !== target) return null;
      let code = source.replaceAll('\r\n', '\n');
      for (const [before, after] of [
        ['async function main() {', "async function main() {\n    closeXiaojiaoStartup = await openStartupWindow({ app, BrowserWindow, nativeImage, page: join(app.getAppPath(), 'renderer', 'splash.html'), iconPath: join(process.resourcesPath, 'icon.png') });"],
        ['function reportFatal(error, source) {', 'function reportFatal(error, source) {\n    closeXiaojiaoStartup?.();'],
      ]) {
        if (code.split(before).length !== 2) throw new Error('Official startup changed; review startup window integration');
        code = code.replace(before, after);
      }
      transformed++;
      return { code: `import { openStartupWindow } from ${JSON.stringify(helper)};\nlet closeXiaojiaoStartup;\n${code}`, map: null };
    },
    generateBundle() {
      if (transformed !== 1) throw new Error(`Official startup changed: expected one main entry, got ${transformed}`);
    },
  };
}

export function verifyStartupBundle(source) {
  const missing = [];
  if (!source.includes('splash.html')) missing.push('splash page');
  // Bundling rewrites join() and quotes, so match the surviving resource path pieces.
  if (!source.includes('resourcesPath') || !source.includes('icon.png')) missing.push('window icon');
  if (!/closeXiaojiaoStartup\s*=\s*await openStartupWindow\(/.test(source)) missing.push('startup open');
  if (!/function reportFatal\(error, source\)\s*\{\s*closeXiaojiaoStartup\?\.\(\)/.test(source)) missing.push('fatal cleanup');
  if (missing.length) throw new Error(`Compiled desktop is missing the startup window lifecycle: ${missing.join(', ')}`);
}
