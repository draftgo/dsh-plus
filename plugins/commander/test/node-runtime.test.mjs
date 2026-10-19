import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import { NodeRuntime, NODE_SHA256, NODE_VERSION } from '../src/node-runtime.mjs';
const bytes = Buffer.from('fixture verified archive'), digest = createHash('sha256').update(bytes).digest('hex');
async function file(path, body = 'fixture') { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); await chmod(path, 0o755); return path; }
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-node-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [], urls = [], platform = options.platform ?? 'linux', arch = options.arch ?? 'x64';
  const executor = async (command, args, opts) => { calls.push({ command, args, ...opts }); return { stdout: args[0] === '-p' ? JSON.stringify({ node: NODE_VERSION, electron: false }) : '10.9.4' }; };
  const fetcher = async url => { urls.push(url); return new Response(bytes); };
  const extractor = async (_, destination, { platform }) => {
    await file(join(destination, platform === 'win32' ? 'node.exe' : 'bin/node'));
    await file(join(destination, platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js'));
  };
  const runtime = new NodeRuntime({ root: join(dir, 'runtime'), platform, arch, env: { PATH: '', API_KEY: 'never-forward', CODEX_HOME: '/account', NODE_OPTIONS: '--require=/bad' }, executor, fetcher, hostExecutable: null, checksums: { [platform + '-' + arch]: digest }, extractor, maxBytesPerSecond: 0, lockPollMs: 2, ...options });
  return { dir, calls, urls, runtime, extractor, executor };
}
test('missing Node/npm automatically installs verified runtime and survives restart', async t => {
  const { dir, calls, urls, runtime } = await fixture(t); assert.equal(await runtime.resolve(), null); assert.equal(await runtime.resolveNode(), null);
  const messages = [], installed = await runtime.ensure({ onMessage: message => messages.push(message) });
  assert.match(urls[0], /^https:\/\/npmmirror.com\/mirrors\/node\/v22.22.1\/node-v22.22.1-linux-x64.tar.gz$/);
  assert.match(installed.command, /runtime.node-v22.22.1-linux-x64.bin.node$/); assert.equal(installed.args.length, 1); assert.equal(messages.length, 3);
  for (const call of calls) { assert.equal(call.env.API_KEY, undefined); assert.equal(call.env.CODEX_HOME, undefined); assert.equal(call.env.NODE_OPTIONS, undefined); assert.notEqual(call.env.HOME, '/account'); }
  const restart = new NodeRuntime({ ...runtime, env: { PATH: '' }, hostExecutable: null });
  assert.deepEqual(await restart.resolve(), installed); assert.equal(await restart.resolveNode(), installed.command);
  assert.deepEqual(await readdir(join(dir, 'runtime')), ['node-v22.22.1-linux-x64']);
});
test('reuses compatible system Node and its npm without downloads', async t => {
  const { dir, runtime, urls } = await fixture(t); const bin = join(dir, 'system/bin');
  const command = await file(join(bin, 'node')); const npm = await file(join(bin, '../lib/node_modules/npm/bin/npm-cli.js')); runtime.env.PATH = bin;
  const installed = await runtime.ensure(); assert.deepEqual(installed, { command, args: [npm], binDir: bin }); assert.equal(urls.length, 0);
});
test('real host Node is reusable while Electron host is excluded', async t => {
  const { dir, runtime } = await fixture(t); const host = await file(join(dir, 'host/bin/node')); await file(join(dir, 'host/lib/node_modules/npm/bin/npm-cli.js'));
  runtime.platform = process.platform; runtime.arch = process.arch; runtime.hostExecutable = host; runtime.hostVersions = { node: NODE_VERSION };
  assert.equal((await runtime.resolve()).command, host); runtime.hostVersions = { node: NODE_VERSION, electron: '40.0.0' }; assert.equal(await runtime.resolve(), null);
});
test('old or Electron system Node never satisfies CLI runtime', async t => {
  for (const version of [{ node: '18.20.0', electron: false }, { node: '22.18.0', electron: false }, { node: NODE_VERSION, electron: true }]) {
    const { dir, runtime } = await fixture(t); const bin = join(dir, 'bin'); await file(join(bin, 'node')); await file(join(bin, '../lib/node_modules/npm/bin/npm-cli.js')); runtime.env.PATH = bin;
    runtime.executor = async () => ({ stdout: JSON.stringify(version) }); assert.equal(await runtime.resolve(), null); assert.equal(await runtime.resolveNode(), null);
  }
});
test('Node without npm is usable only through resolveNode and ensure supplies npm', async t => {
  const { dir, runtime, urls } = await fixture(t); const bin = join(dir, 'bin'), node = await file(join(bin, 'node')); runtime.env.PATH = bin;
  assert.equal(await runtime.resolveNode(), node); assert.equal(await runtime.resolve(), null); assert.notEqual((await runtime.ensure()).command, node); assert.equal(urls.length, 1);
});
test('platforms and architecture map to fixed official archives', async t => {
  for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
    const { runtime, urls } = await fixture(t, { platform, arch }); assert.equal(runtime.supported(), true); assert.match(NODE_SHA256[platform + '-' + arch], /^[a-f0-9]{64}$/);
    const result = await runtime.ensure({ source: 'official' }); assert.ok(urls[0].startsWith('https://nodejs.org/dist/')); assert.ok(urls[0].endsWith((platform === 'win32' ? 'win' : platform) + '-' + arch + (platform === 'win32' ? '.zip' : '.tar.gz'))); assert.equal(result.command.endsWith('node.exe'), platform === 'win32');
  }
  const { runtime } = await fixture(t, { platform: 'freebsd' }); assert.equal(runtime.supported(), false); await assert.rejects(runtime.ensure(), /暂不支持/); await assert.rejects(runtime.ensure({ source: 'bad' }), /无效/);
});
test('SHA mismatch and download limits never publish runtime or retain temporary content', async t => {
  for (const options of [{ checksums: { 'linux-x64': '0'.repeat(64) } }, { maxBytes: 1 }]) {
    const { runtime } = await fixture(t, options); await assert.rejects(runtime.ensure(), /SHA-256|大小限制/); assert.deepEqual(await readdir(runtime.root), []);
  }
});
test('same runtime is shared under concurrent installers', async t => {
  const { runtime, urls } = await fixture(t); const second = new NodeRuntime({ ...runtime });
  assert.deepEqual(...await Promise.all([runtime.ensure(), second.ensure()])); assert.equal(urls.length, 1); assert.deepEqual(await readdir(runtime.root), ['node-v22.22.1-linux-x64']);
});
test('cancelled downloads clean locks and temporary archives before retry', async t => {
  const { runtime } = await fixture(t); const controller = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  runtime.fetcher = async (_, { signal }) => { started(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const pending = runtime.ensure({ signal: controller.signal }); await ready; controller.abort(new Error('test cancelled')); await assert.rejects(pending, /test cancelled/); assert.deepEqual(await readdir(runtime.root), []);
  runtime.fetcher = async () => new Response(bytes); assert.ok(await runtime.ensure());
});
test('download timeout cleans artifacts and untrusted redirects are rejected', async t => {
  const { runtime } = await fixture(t, { timeoutMs: 20 });
  runtime.fetcher = async (_, { signal }) => { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  await assert.rejects(runtime.ensure(), /超时/); assert.deepEqual(await readdir(runtime.root), []);
  runtime.fetcher = async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/node.tar.gz' } }); await assert.rejects(runtime.ensure(), /不受信任/);
});
test('symlink roots, target directories and extracted links are refused', async t => {
  const { dir, runtime, extractor } = await fixture(t); const target = join(dir, 'elsewhere'); await mkdir(target); await symlink(target, runtime.root);
  await assert.rejects(runtime.ensure(), /符号链接/); await rm(runtime.root); await mkdir(runtime.root); await symlink(target, runtime.directory); await assert.rejects(runtime.ensure(), /非托管/); assert.equal((await lstat(runtime.directory)).isSymbolicLink(), true); await rm(runtime.directory);
  runtime.extractor = async (...args) => { await extractor(...args); await symlink('/tmp', join(args[1], 'unsafe')); }; await assert.rejects(runtime.ensure(), /不安全文件/); assert.deepEqual(await readdir(runtime.root), []);
});
test('real tar extraction keeps only Node/npm regular files and drops link entries', async t => {
  const { dir, runtime } = await fixture(t); runtime.extractor = undefined;
  const source = join(dir, 'source'), top = runtime.artifact().top; await file(join(source, top, 'bin/node')); await file(join(source, top, 'lib/node_modules/npm/bin/npm-cli.js')); await file(join(source, top, 'include/node.h')); await symlink('/outside', join(source, top, 'lib/node_modules/npm/evil'));
  const archive = join(dir, 'node.tar.gz'); await tar.c({ file: archive, gzip: true, cwd: source }, [top]); const payload = await readFile(archive); runtime.checksums['linux-x64'] = createHash('sha256').update(payload).digest('hex'); runtime.fetcher = async () => new Response(payload);
  const installed = await runtime.ensure(); assert.equal(await readFile(installed.command, 'utf8'), 'fixture');
  for (const name of ['npm', 'npx']) {
    const wrapper = await readFile(join(runtime.directory, 'bin', name), 'utf8'); assert.ok(wrapper.startsWith('#!/bin/sh\n')); await promisify(execFile)('/bin/sh', ['-n', join(runtime.directory, 'bin', name)]);
  } await assert.rejects(lstat(join(runtime.directory, 'include/node.h')), { code: 'ENOENT' }); await assert.rejects(lstat(join(runtime.directory, 'lib/node_modules/npm/evil')), { code: 'ENOENT' });
});
test('Windows extractor uses fixed encoded script with paths as environment values', async t => {
  const { runtime, calls } = await fixture(t, { platform: 'win32' }); runtime.extractor = undefined;
  const base = runtime.executor; runtime.executor = async (command, args, options) => {
    if (args.includes('-EncodedCommand')) {
      calls.push({ command, args, ...options }); const script = Buffer.from(args.at(-1), 'base64').toString('utf16le'); assert.match(script, /ZipFile/); assert.ok(script.includes('\n')); assert.ok(!script.includes(options.env.DSH_NODE_ARCHIVE)); assert.ok(script.includes("$name.Contains('\\')"));
      await file(join(options.env.DSH_NODE_DEST, 'node.exe')); await file(join(options.env.DSH_NODE_DEST, 'node_modules/npm/bin/npm-cli.js')); return { stdout: '' };
    } return base(command, args, options);
  };
  await runtime.ensure(); assert.ok(calls.some(call => call.command.endsWith('powershell.exe')));
});

test('cancel just before publication leaves no committed runtime', async t => {
  const { runtime, extractor } = await fixture(t); const controller = new AbortController();
  runtime.extractor = async (...args) => { await extractor(...args); controller.abort(new Error('cancel before publish')); };
  await assert.rejects(runtime.ensure({ signal: controller.signal }), /cancel before publish/); assert.deepEqual(await readdir(runtime.root), []);
});
