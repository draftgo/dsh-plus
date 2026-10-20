import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareSshRuntime } from '../scripts/build-link.mjs';

test('source build removes both optional SSH ABI artifacts and preserves dependency source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (path, value) => { const file = join(directory, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, value); return file; };
  const anchor = await put('package.json', '{}');
  const ssh = 'node_modules/ssh2';
  const cpu = 'node_modules/cpu-features';
  await put(ssh + '/package.json', '{"name":"ssh2","version":"1.17.0"}');
  await put(cpu + '/package.json', '{"name":"cpu-features","version":"0.0.10"}');
  const source = await put(ssh + '/lib/protocol/crypto.js', 'original-js-fallback');
  const cryptoBuild = await put(ssh + '/lib/protocol/crypto/build/Release/sshcrypto.node', 'wrong-abi');
  const cpuBuild = await put(cpu + '/build/Release/cpufeatures.node', 'wrong-abi');
  await prepareSshRuntime(anchor);
  await assert.rejects(access(cryptoBuild), { code: 'ENOENT' });
  await assert.rejects(access(cpuBuild), { code: 'ENOENT' });
  assert.equal(await readFile(source, 'utf8'), 'original-js-fallback');
  await prepareSshRuntime(anchor);
  await rm(join(directory, cpu), { recursive: true });
  await prepareSshRuntime(anchor);
});
