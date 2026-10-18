import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { officialModelsUi } from './official-models-ui.mjs';
import { shellUi } from './shell-ui.mjs';
import { buildLink } from './build-link.mjs';
await buildLink();
// Bundle only Commander; React retains the shell's shared module identity.
const out = fileURLToPath(new URL('../lib/client.js', import.meta.url));
// Match the installed official frontend metadata without exposing server environment variables.
let record;
try {
  record = JSON.parse(await readFile(new URL('../../../deepseek-harness/.dsh-build/client-build-environment.json', import.meta.url), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // A fresh source checkout can build the plugin before building the entire official app.
  const upstream = JSON.parse(await readFile(new URL('../../../upstream.json', import.meta.url), 'utf8'));
  record = { environment: { DSH_CLIENT_VERSION: upstream.version, DSH_CLIENT_COMMIT_HASH: upstream.commit.slice(0, 7) } };
}
record.environment.DSH_CLIENT_TITLE = 'DSH-Plus';
const define = Object.fromEntries(['DSH_CLIENT_TITLE', 'DSH_CLIENT_VERSION', 'DSH_CLIENT_COMMIT_HASH', 'DSH_CLIENT_GIT_DIRTY'].map(key => ['process.env.' + key, JSON.stringify(record.environment[key]) ?? 'undefined']));
const result = await build({ entryPoints: [fileURLToPath(new URL('../client/index.jsx', import.meta.url))], bundle: true, minify: true, write: false, format: 'cjs', platform: 'browser', define, external: ['react-dom', 'react', 'react/jsx-runtime', '@deepseek-ai/*'], plugins: [officialModelsUi(), shellUi()], jsx: 'automatic', target: 'es2022', loader: { '.css': 'text', '.svg': 'text' }, logLevel: 'warning' });
if (/process.env.DSH_CLIENT_/.test(result.outputFiles[0].text)) throw Error('Unresolved official browser build metadata');
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await writeFile(out, `window.__ModuleLoader__.load({id: 'dsh-plus', factory: (require) => { const module = {exports:{}}; const exports = module.exports;\n${result.outputFiles[0].text}\nreturn module.exports; }});\n`);
console.log('DSH-Plus client built');
