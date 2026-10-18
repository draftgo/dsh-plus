import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);
const commanderRequire = createRequire(new URL('../../commander/package.json', import.meta.url));
let build;
try { ({ build } = localRequire('esbuild')); } catch { ({ build } = commanderRequire('esbuild')); }

const out = fileURLToPath(new URL('../dist/web/', import.meta.url));
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: [fileURLToPath(new URL('../client/main.jsx', import.meta.url))], bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', write: false,
  nodePaths: [fileURLToPath(new URL('../node_modules/', import.meta.url))], loader: { '.css': 'text', '.json': 'json', '.svg': 'text' }, logLevel: 'warning', define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(`${out}/app.js`, result.outputFiles[0].text);
await writeFile(`${out}/workbench.js`, await (await import('node:fs/promises')).readFile(new URL('../client/workbench-bridge.mjs', import.meta.url), 'utf8'));
const style = await (await import('node:fs/promises')).readFile(fileURLToPath(new URL('../client/style.css', import.meta.url)), 'utf8');
await writeFile(`${out}/app.css`, style);
await writeFile(`${out}/index.html`, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#fffdf8"><meta name="color-scheme" content="light dark"><title>DSH-Plus</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(await (await import('node:fs/promises')).readFile(new URL('../../../assets/brand/favicon.svg', import.meta.url), 'utf8'))}"><link id="dsh-link-style" rel="stylesheet" href="./app.css"></head><body style="margin:0"><div id="root"></div><script src="./app.js"></script></body></html>`);
console.log(`Link web built: ${out}`);
