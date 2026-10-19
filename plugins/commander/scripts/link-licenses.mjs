import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const resolve = createRequire(new URL('../../link/package.json', import.meta.url));
const collected = new Map();
async function visit(name, from = resolve) {
  let path;
  try { path = from.resolve(`${name}/package.json`); } catch { return; }
  const record = JSON.parse(await readFile(path, 'utf8'));
  if (collected.has(`${record.name}@${record.version}`)) return;
  const files = (await readdir(dirname(path))).filter(file => /^(license|copying|notice)(?:\b|[-.])/i.test(file));
  const licenses = [];
  for (const file of files) { try { licenses.push(`${file}\n${(await readFile(new URL(file, `file://${dirname(path)}/`), 'utf8')).replace(/\r\n/g, '\n').trimEnd()}`); } catch {} }
  collected.set(`${record.name}@${record.version}`, `${record.name}@${record.version} (${record.license ?? 'see license'})\n${licenses.join('\n\n')}`);
  const local = createRequire(path);
  for (const dependency of Object.keys(record.dependencies ?? {})) await visit(dependency, local);
}
export async function writeLinkLicenses(output) {
  for (const name of ['selfsigned', 'react', 'react-dom', 'qrcode', 'ssh2', 'ws']) await visit(name);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('LINK-THIRD-PARTY-LICENSES.txt', output), [...collected.values()].join('\n\n====================\n\n') + '\n');
}
