import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeLinkLicenses } from './link-licenses.mjs';
import { fileURLToPath } from 'node:url';

// A rejected addon can still introduce another libnode and crash on process exit.
// Remove only generated optional artifacts; ssh2 already has a complete JS fallback.
export async function prepareSshRuntime(packageFile) {
  const require = createRequire(packageFile);
  const ssh = require.resolve('ssh2/package.json');
  await rm(join(dirname(ssh), 'lib/protocol/crypto/build'), { recursive: true, force: true });
  let cpu;
  try { cpu = createRequire(ssh).resolve('cpu-features/package.json'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (cpu) await rm(join(dirname(cpu), 'build'), { recursive: true, force: true });
}

/** Ship Link inside the plugin artifact; no sibling checkout is needed at runtime. */
export async function buildLink() {
  for (const packageFile of [new URL('../package.json', import.meta.url), new URL('../../link/package.json', import.meta.url)]) await prepareSshRuntime(packageFile);
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
  // Keep the self-hosted relay tools in the shipped plugin, not only in the checkout.
  await build({
    entryPoints: ['run-relay-server', 'ip-certificate'].map(name => fileURLToPath(new URL(`../../link/scripts/${name}.mjs`, import.meta.url))),
    outdir: fileURLToPath(new URL('relay/', output)), outExtension: { '.js': '.mjs' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['ws'],
    logLevel: 'warning', legalComments: 'eof',
  });
  await cp(new URL('../../link/config/relay.example.json', import.meta.url), new URL('relay/relay.example.json', output));
}
