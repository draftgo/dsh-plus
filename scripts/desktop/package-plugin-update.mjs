/** Package the complete production dependency closure, never an npm source-only pack. */
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stagePluginBundle } from './plugin-bundle.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' }, runtime: { type: 'string' } } });
const plugin = join(root, 'plugins/commander');
const manifest = JSON.parse(await readFile(join(plugin, 'package.json')));
const output = resolve(values.out || join(root, 'artifacts/plugins'));
const tar = createRequire(join(plugin, 'package.json'))('tar');
const temporary = await mkdtemp(join(tmpdir(), 'dsh-plus-release-'));
try {
  const seed = join(temporary, 'seed');
  stagePluginBundle({ runtime: values.runtime, plugin, output: seed });
  await mkdir(output, { recursive: true });
  const filename = join(output, `dsh-plus-${manifest.version}-plugin.tar.gz`);
  await tar.c({ file: filename, cwd: seed, gzip: true, portable: true, noMtime: true }, ['release.json', 'node_modules']);
  console.log(`DSH-Plus complete plugin payload: ${filename}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
