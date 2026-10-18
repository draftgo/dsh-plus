import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** electron-updater accepts JSON as YAML; keep the channel independent of plugin releases. */
export async function createAppUpdateFeed({ installer, outDir, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid application version');
  const bytes = await readFile(installer), name = basename(installer);
  if (bytes.subarray(0, 2).toString() !== 'MZ' || name !== `dsh-plus-${version}-win-x64-setup.exe`) throw new Error('Expected matching DSH-Plus Windows installer');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const data = { version, files: [{ url: name, sha512, size: bytes.length }], path: name, sha512, releaseDate: new Date().toISOString() };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'latest.yml'), `${JSON.stringify(data, null, 2)}\n`);
  return data;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installer, version] = process.argv.slice(2);
  if (!installer || !version) throw new Error('Usage: create-app-update-feed.mjs <installer.exe> <version>');
  await createAppUpdateFeed({ installer, version, outDir: resolve(installer, '..') });
}
