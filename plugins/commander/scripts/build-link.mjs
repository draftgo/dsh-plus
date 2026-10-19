import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { writeLinkLicenses } from './link-licenses.mjs';
import { fileURLToPath } from 'node:url';

/** Ship Link inside the plugin artifact; no sibling checkout is needed at runtime. */
export async function buildLink() {
  await import('../../link/scripts/build-web.mjs');
  const output = new URL('../lib/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeLinkLicenses(output);
  await build({
    entryPoints: [fileURLToPath(new URL('../../link/src/index.mjs', import.meta.url))],
    outfile: fileURLToPath(new URL('link.mjs', output)), bundle: true,
    platform: 'node', format: 'esm', target: 'node22', minify: true, external: ['ssh2', 'ws'],
    banner: { js: "import { createRequire as linkCreateRequire } from 'node:module'; const require = linkCreateRequire(import.meta.url);" },
    logLevel: 'warning', legalComments: 'eof',
  });
  await cp(new URL('../../link/dist/web/', import.meta.url), new URL('link-web/', output), { recursive: true });
}
