import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { officialModelsUi } from '../scripts/official-models-ui.mjs';
import { shellUi } from '../scripts/shell-ui.mjs';

const require = createRequire(new URL('../scripts/build-client.mjs', import.meta.url));
const { build } = require('esbuild');
const upstream = fileURLToPath(new URL('../../../deepseek-harness/packages/client/', import.meta.url));
const registrations = factory => {
  const handlers = [];
  factory().setup({ onLoad(options, callback) { handlers.push({ ...options, callback }); } });
  return handlers;
};
const models = registrations(officialModelsUi);
const shell = registrations(shellUi);
const scripts = [
  [models, 'ui-settings-models/src/client/ModelsSection.tsx', '<ProviderSelect'],
  [models, 'ui-settings-models/src/client/CustomProviderCard.tsx', '<ProviderHarnessField'],
  [models, 'ui-settings-models/src/client/ProviderEditor.tsx', '<ProviderHarnessField'],
  [shell, 'ui-settings-general/src/client/SettingsRoot.tsx', 'harness-tools'],
  [shell, 'ui-sidebar/src/client/SidebarRoot.tsx', 'cmd-shell-sidebar'],
  [shell, 'ui-layout/src/client/AppFrame.tsx', 'data-plus-shell'],
];
const styles = [
  [models, 'ui-settings-models/src/client/ModelsSection.module.css', 'commander-official-models-style', 'addModes'],
  [shell, 'ui-layout/src/client/AppFrame.module.css', 'commander-shell-AppFrame.module.css', 'frame'],
  [shell, 'ui-sidebar/src/client/SidebarRoot.module.css', 'commander-shell-SidebarRoot.module.css', 'root'],
  [shell, 'ui-settings-general/src/client/SettingsRoot.module.css', 'commander-shell-SettingsRoot.module.css', 'navIcon'],
];

test('all official TSX and CSS hooks route POSIX and Windows absolute filenames', () => {
  for (const [handlers, filename] of [...scripts, ...styles]) {
    for (const path of ['/workspace/' + filename, 'C:\\workspace\\' + filename.replaceAll('/', '\\')]) {
      assert.equal(handlers.filter(handler => handler.filter.test(path)).length, 1, path);
    }
  }
});

test('official source adaptations also accept Windows CRLF checkouts without touching upstream', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'commander-ui-crlf-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const [handlers, filename, expected] of scripts) {
    const original = await readFile(join(upstream, filename), 'utf8');
    const path = join(temporary, ...filename.split('/'));
    await mkdir(dirname(path), { recursive: true });
    const source = original.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
    await writeFile(path, source);
    const result = await handlers.find(handler => handler.filter.test(path)).callback({ path });
    assert.equal(result.loader, 'tsx');
    assert(result.contents.includes(expected), filename);
    assert.equal(result.contents.includes('\r'), false, filename);
    assert.equal(await readFile(path, 'utf8'), source, 'build adaptation must not mutate its input');
    assert.equal(await readFile(join(upstream, filename), 'utf8'), original);
  }
});

test('official CSS builds remain scoped and inject each stylesheet only once without an output file', async () => {
  for (const [handlers, filename, id, key] of styles) {
    const path = join(upstream, ...filename.split('/'));
    const { contents } = await handlers.find(handler => handler.filter.test(path)).callback({ path });
    const nodes = new Map();
    const document = {
      getElementById: id => nodes.get(id),
      createElement: () => ({}),
      head: { append(style) { assert(!nodes.has(style.id)); nodes.set(style.id, style); } },
    };
    const execute = new Function('document', contents.replace('export default ', 'return '));
    const classes = execute(document);
    assert.equal(typeof classes[key], 'string', filename);
    assert.deepEqual(execute(document), classes);
    assert.equal(nodes.size, 1);
    assert(nodes.get(id).textContent.includes(classes[key]));
    const result = await build({
      stdin: { contents: 'import styles from ' + JSON.stringify(path) + '; console.log(styles);', resolveDir: upstream },
      bundle: true, write: false, format: 'cjs', platform: 'browser', logLevel: 'silent',
      plugins: [officialModelsUi(), shellUi()],
    });
    assert.equal(result.outputFiles.length, 1, 'CSS must be adapted to JS before the outer in-memory build');
    assert(result.outputFiles[0].text.includes(id));
  }
});
