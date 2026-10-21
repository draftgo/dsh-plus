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
        ['async function main() {', "async function main() {\n    closeXiaojiaoStartup = await openStartupWindow({ app, BrowserWindow, page: join(app.getAppPath(), 'renderer', 'splash.html') });"],
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
  if (!source.includes('splash.html') || !/closeXiaojiaoStartup\s*=\s*await openStartupWindow\(/.test(source)
    || !/function reportFatal\(error, source\)\s*\{\s*closeXiaojiaoStartup\?\.\(\)/.test(source)) {
    throw new Error('Compiled desktop is missing the startup window lifecycle');
  }
}
