import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../../', import.meta.url));
test('bootstrap rejects a modified payload before creating an installation or running commands', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'scripts/server/bootstrap.mjs'), join(directory, 'bootstrap.mjs'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, harnessVersion: '0.2.1-alpha.3', pluginVersion: '0.1.5', sha256: '0'.repeat(64) }));
  await writeFile(join(directory, 'server-seed.tar.gz'), 'modified');
  const result = spawnSync(process.execPath, [join(directory, 'bootstrap.mjs'), 'mirror', 'connect'], { env: { ...process.env, HOME: join(directory, 'home') }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /插件包校验失败/); assert.equal(result.stdout, '');
});
test('installer fails closed for unsupported source and never accepts command-shaped parameters', () => {
  const result = spawnSync('bash', [join(root, 'scripts/server/bootstrap.sh'), 'mirror;touch /tmp/not-allowed', 'connect'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /无效下载源/);
});
test('generated launcher is valid JavaScript and redacts split token chunks before journald', async t => {
  const source = await readFile(join(root, 'scripts/server/bootstrap.mjs'), 'utf8');
  const functionText = source.slice(source.indexOf('function launchServer('));
  const directory = await mkdtemp(join(tmpdir(), 'dsh-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = join(directory, 'runtime/node_modules/@deepseek-ai/dsh/lib'); await mkdir(fake, { recursive: true });
  await writeFile(join(fake, 'bin.js'), "process.stdout.write('dsh web: http://127.0.0.1:3456/?tok');setTimeout(()=>{process.stdout.write('en=sensitive-server-secret\\n');process.exit(0)},20)");
  const launcher = join(directory, 'start.mjs'), owner = join(directory, 'owner.json');
  const args = [process.execPath, join(directory, 'runtime'), owner, directory, 3456].map(JSON.stringify).join(',');
  await writeFile(launcher, '(' + functionText + ')(' + args + ');');
  const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert(!result.stdout.includes('sensitive-server-secret')); assert.match(result.stdout, /redacted/);
  assert.equal(JSON.parse(await readFile(owner, 'utf8')).url, 'http://127.0.0.1:3456/?token=sensitive-server-secret');
});
