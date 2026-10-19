import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as tar from 'tar';

export const NODE_VERSION = '22.22.1';
// Pinned from https://nodejs.org/dist/v22.22.1/SHASUMS256.txt; never trust mirror metadata.
export const NODE_SHA256 = Object.freeze({
  'linux-x64': '07c8aafa60644fb81adefa1ee7da860eb1920851ffdc9a37020ab0be47fbc10e',
  'linux-arm64': '1d1690e9aba47e887a275abc6d8f7317e571a0700deaef493f768377e99155f5',
  'darwin-x64': '07b13722d558790fca20bb1ecf61bde24b7a4863111f7be77fc57251a407359a',
  'darwin-arm64': '679ad4966339e4ef4900f57996714864e4211b898825bb840c3086c419fbcef2',
  'win32-x64': '877cb93829e14fffbbc7903e7d8037336c9a79f3ea43c5d0b8c2379b79da56de',
  'win32-arm64': 'd0722fcdefa1c08e4af31809e91ad4f23282f6c535c261607e8aa372d0ce61dd',
});
const hosts = new Set(['nodejs.org', 'npmmirror.com', 'cdn.npmmirror.com', 'registry.npmmirror.com']);
const cancelled = signal => { if (signal?.aborted) throw signal.reason ?? new Error('已取消'); };
const compatible = value => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? ''); return !!m && (+m[1] > 22 || +m[1] === 22 && +m[2] >= 19); };
const safeEntry = (name, top) => !/[\\\0]/.test(name) && !name.startsWith('/') && !/^[A-Za-z]:/.test(name) && !name.split('/').includes('..') && (name === top || name.startsWith(top + '/'));
async function execute(command, args, { env, cwd, signal, onOutput } = {}) {
  cancelled(signal);
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { env, cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timer;
    const stop = () => { const kill = sig => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {} }; kill('SIGTERM'); timer = setTimeout(() => kill('SIGKILL'), 1000); timer.unref(); };
    const done = () => { signal?.removeEventListener('abort', stop); clearTimeout(timer); };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8192); onOutput?.(chunk.toString()); });
    signal?.addEventListener('abort', stop, { once: true }); child.once('error', error => { done(); reject(error); });
    child.once('close', code => { done(); if (signal?.aborted) reject(signal.reason ?? new Error('已取消')); else if (code !== 0) reject(new Error('Node.js 命令失败 (' + code + ')')); else accept({ stdout: output }); });
  });
}
// Paths are environment values, never shell interpolation. Extract only regular files required by Node/npm.
const windowsExtract = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  '$zip = [System.IO.Compression.ZipFile]::OpenRead($env:DSH_NODE_ARCHIVE)',
  'try { $total = [int64]0; $count = 0; foreach ($entry in $zip.Entries) {',
  '$name = $entry.FullName; $count++',
  "if ($count -gt 30000 -or $name.Contains('\\') -or $name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name.Split('/') -contains '..' -or -not ($name -eq $env:DSH_NODE_TOP -or $name.StartsWith($env:DSH_NODE_TOP + '/'))) { throw 'Unsafe Node.js ZIP entry' }",
  '$mode = ([int64]$entry.ExternalAttributes -shr 16) -band 61440',
  "if ($mode -eq 40960 -or ($entry.ExternalAttributes -band 1024) -ne 0) { throw 'Node.js ZIP links are not allowed' }",
  "$relative = $name.Substring($env:DSH_NODE_TOP.Length).TrimStart('/')",
  "if (-not ($relative -eq 'node.exe' -or $relative -in @('npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1') -or $relative.StartsWith('node_modules/npm/'))) { continue }",
  '$target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($env:DSH_NODE_DEST, $relative))',
  "if (-not $target.StartsWith([System.IO.Path]::GetFullPath($env:DSH_NODE_DEST) + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe Node.js ZIP path' }",
  "if ($name.EndsWith('/')) { [System.IO.Directory]::CreateDirectory($target) | Out-Null; continue }",
  "if ($entry.Length -gt [int64]$env:DSH_NODE_MAX_EXPANDED) { throw 'Node.js ZIP entry too large' }",
  '[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null',
  '$inputStream = $entry.Open(); $outputStream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew)',
  'try { $buffer = New-Object byte[] 65536; while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {',
  "$total += $read; if ($total -gt [int64]$env:DSH_NODE_MAX_EXPANDED) { throw 'Node.js ZIP expanded size limit exceeded' }; $outputStream.Write($buffer, 0, $read)",
  '} } finally { $outputStream.Dispose(); $inputStream.Dispose() }',
  '} } finally { $zip.Dispose() }',
].join('\n');

export class NodeRuntime {
  constructor({ root = join(homedir(), '.dowork', 'tools', '.runtime'), platform = process.platform, arch = process.arch, env = process.env, executor = execute, fetcher = globalThis.fetch, hostExecutable = process.execPath, hostVersions = process.versions, checksums = NODE_SHA256, extractor, timeoutMs = 300_000, probeTimeoutMs = 5000, maxBytes = 160 * 1024 * 1024, maxExpandedBytes = 512 * 1024 * 1024, maxBytesPerSecond = 24 * 1024 * 1024, lockPollMs = 80 } = {}) {
    Object.assign(this, { root: resolve(root), platform, arch, env: { ...env }, executor, fetcher, hostExecutable, hostVersions, checksums, extractor, timeoutMs, probeTimeoutMs, maxBytes, maxExpandedBytes, maxBytesPerSecond, lockPollMs });
  }
  supported() { return Object.hasOwn(NODE_SHA256, this.platform + '-' + this.arch); }
  artifact() { const top = 'node-v' + NODE_VERSION + '-' + (this.platform === 'win32' ? 'win' : this.platform) + '-' + this.arch; return { top, filename: top + (this.platform === 'win32' ? '.zip' : '.tar.gz') }; }
  get directory() { return join(this.root, this.artifact().top); }
  runtime(directory) { const binDir = this.platform === 'win32' ? directory : join(directory, 'bin'); return { command: join(binDir, this.platform === 'win32' ? 'node.exe' : 'node'), args: [join(directory, this.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'npm', 'bin', 'npm-cli.js')], binDir }; }
  async usable(file) { try { await access(file, this.platform === 'win32' ? constants.F_OK : constants.X_OK); const stat = await lstat(file); return stat.isFile() || stat.isSymbolicLink(); } catch { return false; } }
  isolatedEnv(home, source = this.env) {
    const keep = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_ALL)$/i;
    return { ...Object.fromEntries(Object.entries(source).filter(([key]) => keep.test(key))), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'npmrc') };
  }
  async probe(command, npmCli, { signal, env = this.env } = {}) {
    let home, timer; const controller = new AbortController(), abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true });
    try {
      cancelled(signal); home = await mkdtemp(join(tmpdir(), 'dsh-node-probe-')); timer = setTimeout(() => controller.abort(new Error('Node.js 检测超时')), this.probeTimeoutMs);
      const options = { env: this.isolatedEnv(home, env), cwd: home, signal: controller.signal };
      const result = await this.executor(command, ['-p', 'JSON.stringify({node:process.versions.node,electron:!!process.versions.electron})'], options), version = JSON.parse(String(result?.stdout ?? '').trim());
      if (version.electron || !compatible(version.node)) return false;
      if (npmCli) { await access(npmCli); const npm = await this.executor(command, [npmCli, '--version'], options); if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(npm?.stdout ?? '').trim())) return false; }
      cancelled(controller.signal); return true;
    } catch { cancelled(signal); return false; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (home) await rm(home, { recursive: true, force: true }); }
  }
  async candidates() {
    const paths = String(this.env.PATH ?? this.env.Path ?? '').split(this.platform === 'win32' ? ';' : delimiter).filter(Boolean).map(path => join(path, this.platform === 'win32' ? 'node.exe' : 'node'));
    if (this.platform === process.platform && this.arch === process.arch && !this.hostVersions?.electron && this.hostExecutable) paths.push(this.hostExecutable);
    if (this.supported()) paths.push(this.runtime(this.directory).command); return [...new Set(paths)];
  }
  async managedSafe() {
    try {
      if (await realpath(this.root) !== this.root || (await lstat(this.directory)).isSymbolicLink()) return false;
      const runtime = this.runtime(this.directory), receipt = join(this.directory, 'dsh-node.json');
      for (const path of [runtime.command, runtime.args[0], receipt]) if (await realpath(path) !== path || !(await lstat(path)).isFile()) return false;
      const value = JSON.parse(await readFile(receipt, 'utf8')); return value.owner === 'dsh-plus' && value.version === NODE_VERSION && value.platform === this.platform && value.arch === this.arch && value.sha256 === this.checksums[this.platform + '-' + this.arch];
    } catch { return false; }
  }
  async npmCandidates(command) {
    const bin = dirname(command), candidates = [join(bin, 'node_modules/npm/bin/npm-cli.js'), join(bin, '../lib/node_modules/npm/bin/npm-cli.js'), join(bin, '../share/nodejs/npm/bin/npm-cli.js')];
    for (const name of ['npm', 'npm-cli.js']) try { const path = await realpath(join(bin, name)); if (basename(path) === 'npm-cli.js') candidates.unshift(path); } catch {}
    return [...new Set(candidates)];
  }
  async resolveNode(options = {}) {
    for (const command of await this.candidates()) {
      if (command === this.runtime(this.directory).command && !(await this.managedSafe())) continue;
      if (await this.usable(command) && await this.probe(command, null, options)) return command;
    } return null;
  }
  async resolve(options = {}) {
    for (const command of await this.candidates()) {
      if (command === this.runtime(this.directory).command && !(await this.managedSafe())) continue;
      if (!(await this.usable(command))) continue;
      for (const npmCli of await this.npmCandidates(command)) if (await access(npmCli).then(() => true, () => false) && await this.probe(command, npmCli, options)) return { command, args: [npmCli], binDir: dirname(command) };
    } return null;
  }
  async safeRoot() { await mkdir(this.root, { recursive: true, mode: 0o700 }); if (await realpath(this.root) !== this.root) throw new Error('Node.js 运行时目录不能使用符号链接。'); }
  async lock(signal) {
    const directory = join(this.root, '.node-install.lock'), token = randomUUID();
    while (true) {
      cancelled(signal);
      try { await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await lstat(directory).catch(() => null); if (!stat) continue; if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('拒绝符号链接 Node.js 安装锁。');
        if (Date.now() - stat.mtimeMs > this.timeoutMs + 60_000) {
          let owner; try { owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')); } catch {}
          let alive = false; if (Number.isInteger(owner?.pid) && owner.pid > 0) try { process.kill(owner.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
          if (!alive) { await rm(directory, { recursive: true, force: true }); continue; }
        } await delay(this.lockPollMs, undefined, { signal });
      }
    }
    return async () => { try { const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')); if (owner.token === token) await rm(directory, { recursive: true, force: true }); } catch {} };
  }
  async download(url, file, expected, { signal, onOutput }) {
    let response;
    for (let redirects = 0; redirects <= 4; redirects++) {
      cancelled(signal); const parsed = new URL(url); if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.username || parsed.password) throw new Error('Node.js 下载地址不受信任。');
      response = await this.fetcher(url, { signal, redirect: 'manual' }); if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel?.(); const location = response.headers?.get?.('location'); if (!location || redirects === 4) throw new Error('Node.js 下载重定向异常。'); url = new URL(location, url).href;
    }
    if (!response.ok || !response.body) throw new Error('Node.js 下载失败 (HTTP ' + response.status + ')。');
    if (Number(response.headers?.get?.('content-length')) > this.maxBytes) { await response.body.cancel?.(); throw new Error('Node.js 下载超过大小限制。'); }
    const output = await open(file, 'wx', 0o600), hash = createHash('sha256'); let size = 0, reported = 0; const started = Date.now();
    try {
      for await (const chunk of response.body) {
        cancelled(signal); const bytes = Buffer.from(chunk); size += bytes.length; if (size > this.maxBytes) throw new Error('Node.js 下载超过大小限制。'); hash.update(bytes); await output.write(bytes);
        if (size - reported >= 8 * 1024 * 1024) { reported = size; onOutput?.('Node.js 已下载 ' + Math.floor(size / 1024 / 1024) + ' MB\n'); }
        if (this.maxBytesPerSecond > 0) { const wait = size / this.maxBytesPerSecond * 1000 - (Date.now() - started); if (wait > 0) await delay(wait, undefined, { signal }); }
      } if (hash.digest('hex') !== expected) throw new Error('Node.js SHA-256 校验失败，已停止安装。');
    cancelled(signal);
    } finally { await output.close(); }
  }
  async extract(archive, destination, { signal, env, onOutput }) {
    const { top } = this.artifact(); if (this.extractor) return this.extractor(archive, destination, { signal, env, onOutput, top, platform: this.platform });
    if (this.platform === 'win32') {
      const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? this.env.SystemRoot ?? this.env.SYSTEMROOT ?? 'C:\\Windows';
      await this.executor(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsExtract, 'utf16le').toString('base64')], { env: { ...env, DSH_NODE_ARCHIVE: archive, DSH_NODE_DEST: destination, DSH_NODE_TOP: top, DSH_NODE_MAX_EXPANDED: String(this.maxExpandedBytes) }, cwd: destination, signal, onOutput }); return;
    }
    let entries = 0, expanded = 0;
    await tar.x({ file: archive, cwd: destination, strip: 1, strict: true, noMtime: true, filter: (path, entry) => {
      cancelled(signal); if (++entries > 30000 || !safeEntry(path, top)) throw new Error('Node.js 压缩包包含不安全路径。');
      const relative = path.slice(top.length + 1), needed = relative === 'bin/node' || relative.startsWith('lib/node_modules/npm/');
      if (!needed || !['File', 'OldFile', 'Directory'].includes(entry.type)) return false;
      expanded += Number(entry.size) || 0; if (expanded > this.maxExpandedBytes) throw new Error('Node.js 解压大小超过限制。'); return true;
    } }); await chmod(join(destination, 'bin', 'node'), 0o755);
    for (const name of ['npm', 'npx']) {
      const wrapper = '#!/bin/sh\nbasedir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec \"$basedir/node\" \"$basedir/../lib/node_modules/npm/bin/' + (name === 'npm' ? 'npm-cli.js' : 'npx-cli.js') + '\" \"$@\"\n';
      await writeFile(join(destination, 'bin', name), wrapper, { flag: 'wx', mode: 0o755 });
    }
  }
  async ensure({ source = 'mirror', signal, onMessage, onOutput, env = this.env } = {}) {
    if (!['mirror', 'official'].includes(source)) throw new Error('无效 Node.js 下载源。'); cancelled(signal);
    const available = await this.resolve({ signal, env }); if (available) return available;
    if (!this.supported()) throw new Error('Node.js 自动安装暂不支持 ' + this.platform + '/' + this.arch + '。');
    const controller = new AbortController(), abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Node.js 环境准备超时。')), this.timeoutMs); let unlock, temporary, backup;
    try {
      await this.safeRoot(); unlock = await this.lock(controller.signal); const existing = await this.resolve({ signal: controller.signal, env }); if (existing) return existing;
      cancelled(controller.signal); temporary = await mkdtemp(join(this.root, '.node-download-'));
      const { filename } = this.artifact(), archive = join(temporary, filename), stage = join(temporary, 'runtime'); await mkdir(stage, { mode: 0o700 });
      onMessage?.('正在准备 Node.js 与 npm（' + (source === 'mirror' ? '国内加速' : '官方直连') + '）');
      const origin = source === 'mirror' ? 'https://npmmirror.com/mirrors/node' : 'https://nodejs.org/dist';
      await this.download(origin + '/v' + NODE_VERSION + '/' + filename, archive, this.checksums[this.platform + '-' + this.arch], { signal: controller.signal, onOutput });
      onMessage?.('正在校验并配置 Node.js 环境'); const safeEnv = this.isolatedEnv(join(temporary, 'home'), env); await mkdir(safeEnv.HOME, { recursive: true, mode: 0o700 });
      await this.extract(archive, stage, { signal: controller.signal, env: safeEnv, onOutput }); cancelled(controller.signal);
      const inspect = async directory => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error('Node.js 环境包含不安全文件。'); if (entry.isDirectory()) await inspect(path); } }; await inspect(stage);
      const runtime = this.runtime(stage); if (!(await this.probe(runtime.command, runtime.args[0], { signal: controller.signal, env }))) throw new Error('Node.js 或 npm 环境验证失败。');
      await writeFile(join(stage, 'dsh-node.json'), JSON.stringify({ owner: 'dsh-plus', version: NODE_VERSION, platform: this.platform, arch: this.arch, sha256: this.checksums[this.platform + '-' + this.arch] }), { flag: 'wx', mode: 0o600 }); cancelled(controller.signal);
      try { await lstat(this.directory); if (!(await this.managedSafe())) throw new Error('Node.js 目标目录已有非托管内容，拒绝覆盖。'); backup = join(temporary, 'previous'); await rename(this.directory, backup); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { cancelled(controller.signal); await rename(stage, this.directory); } catch (error) { if (backup) { await rename(backup, this.directory); backup = null; } throw error; }
      onMessage?.('Node.js 与 npm 已准备完成'); return this.runtime(this.directory);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (temporary) await rm(temporary, { recursive: true, force: true }); await unlock?.(); }
  }
}
