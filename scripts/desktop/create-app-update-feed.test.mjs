import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAppUpdateFeed } from './create-app-update-feed.mjs';

for (const prefix of ['xiaojiao', 'dsh-plus']) test(`${prefix} application feed keeps installer names and electron-updater hashes`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-app-feed-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const installer = join(directory, `${prefix}-0.1.2-win-x64-setup.exe`), bytes = Buffer.from('MZtest executable');
  await writeFile(installer, bytes);
  const feed = await createAppUpdateFeed({ installer, outDir: directory, version: '0.1.2' });
  assert.equal(feed.files[0].url, `${prefix}-0.1.2-win-x64-setup.exe`);
  assert.equal(feed.sha512, createHash('sha512').update(bytes).digest('base64'));
  assert.equal(feed.files[0].size, bytes.length);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'latest.yml'))), feed);
  await assert.rejects(createAppUpdateFeed({ installer, outDir: directory, version: '0.1.3' }), /matching/);
  await writeFile(installer, 'not an executable');
  await assert.rejects(createAppUpdateFeed({ installer, outDir: directory, version: '0.1.2' }), /matching/);
});
