import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { TOOL_CATALOG, getTool, normalizeToolId } from './tool-catalog.mjs';
const finished = new Set(['succeeded', 'failed', 'cancelled']);
const clone = value => JSON.parse(JSON.stringify(value));
export function redactToolOutput(value, env = process.env) {
  let text = String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const [key, secret] of Object.entries(env)) if (/(?:key|token|secret|password|authorization|credential)/i.test(key) && typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@').replace(/\b(?:sk|dg|api)[_-][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]');
}
export function executeToolCommand(command, args, { env, cwd, signal, onOutput } = {}) {
  return new Promise((accept, reject) => {
    if (signal?.aborted) return reject(new Error('Operation cancelled'));
    const child = spawn(command, args, { env, cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', killTimer;
    const kill = () => {
      const send = sig => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
      send('SIGTERM'); killTimer = setTimeout(() => send('SIGKILL'), 1200); killTimer.unref();
    };
    const cleanup = () => { signal?.removeEventListener('abort', kill); clearTimeout(killTimer); };
    const data = chunk => { const value = chunk.toString(); tail = (tail + value).slice(-8192); onOutput?.(value); };
    child.stdout.on('data', data); child.stderr.on('data', data); signal?.addEventListener('abort', kill, { once: true });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); if (signal?.aborted) reject(new Error('Operation cancelled')); else if (code !== 0) reject(new Error('Command exited with code ' + code + ': ' + tail)); else accept({ code, stdout: tail }); });
  });
}
export class ToolInstaller extends EventEmitter {
  constructor({ root = join(homedir(), '.dowork', 'tools'), platform = process.platform, env = process.env, executor = executeToolCommand, isRunning = () => false, maxConcurrent = 2, timeoutMs = 15 * 60_000 } = {}) {
    super(); this.root = resolve(root); this.platform = platform; this.env = { ...env }; this.executor = executor; this.isRunning = isRunning;
    this.maxConcurrent = Math.max(1, Math.min(4, Math.floor(maxConcurrent) || 2)); this.timeoutMs = Math.max(1, timeoutMs);
    this.records = new Map(); this.controllers = new Map(); this.active = 0; this.pending = []; this.closed = false; this.tasks = new Set();
  }
  prefix(id) { return join(this.root, normalizeToolId(id)); }
  managedExecutable(id) { const tool = getTool(id); return tool.command ? join(this.prefix(id), this.platform === 'win32' && tool.installer === 'npm' ? '' : 'bin', tool.command + (this.platform === 'win32' ? '.cmd' : '')) : null; }
  async usable(path) { if (!path) return false; try { await access(path, this.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; } }
  contains(parent, path) { const child = relative(parent, path); return child === '' || !/^\.\.[\\/]/.test(child) && child !== '..' && !isAbsolute(child); }
  async findExecutable(command, { externalOnly = false } = {}) {
    if (!command) return null;
    const suffixes = this.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    const extra = this.platform === process.platform ? [join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'), join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin')] : [];
    for (const dir of [...String(this.env.PATH ?? this.env.Path ?? '').split(this.platform === 'win32' ? ';' : delimiter).filter(Boolean), ...extra]) for (const suffix of suffixes) {
      const path = resolve(dir, command + suffix);
      if (!(await this.usable(path))) continue;
      if (externalOnly && (this.contains(this.root, path) || this.contains(this.root, await realpath(path).catch(() => path)))) continue;
      return path;
    }
    return null;
  }
  async systemExecutable(id) { return this.findExecutable(getTool(id).command, { externalOnly: true }); }
  async resolveExecutable(id) {
    const system = await this.systemExecutable(id); if (system) return system;
    const managed = this.managedExecutable(id); return await this.receipt(id) && await this.usable(managed) ? managed : null;
  }
  async resolveLaunch(id, { managed = false } = {}) {
    if (!managed && [...this.records.values()].some(job => job.toolId === normalizeToolId(id) && (!finished.has(job.status) || this.controllers.has(job.id)))) throw new Error('工具正在安装、更新或卸载，请等待任务结束后启动会话。');
    const command = managed ? this.managedExecutable(id) : await this.resolveExecutable(id); if (!command) return null;
    if (this.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args: [] };
    const tool = getTool(id), packageDir = join(command === this.managedExecutable(id) ? this.prefix(id) : dirname(command), 'node_modules', tool.packageName ?? '');
    try {
      const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')); const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[tool.command];
      if (bin) { const path = resolve(packageDir, bin); if (path.startsWith(packageDir + '/') || path.startsWith(packageDir + '\\')) { await access(path); return { command: process.execPath, args: [path] }; } }
    } catch {}
    throw new Error('Windows 命令需要原生可执行文件或可解析的 npm JS 启动入口。');
  }
  async receipt(id) {
    try {
      const prefix = this.prefix(id), file = join(prefix, 'dsh-install.json');
      if ((await lstat(prefix)).isSymbolicLink() || !(await lstat(file)).isFile()) return null;
      const value = JSON.parse(await readFile(file, 'utf8')); return value.toolId === normalizeToolId(id) && value.owner === 'dsh-plus' ? value : null;
    } catch { return null; }
  }
  async npmCommand() {
    if (this.platform !== 'win32') { const command = await this.findExecutable('npm'); if (!command) throw new Error('需要可用的 Node.js 与 npm。'); return { command, args: [] }; }
    for (const path of [this.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean)) { try { await access(path); return { command: process.execPath, args: [path] }; } catch {} }
    throw new Error('Windows 需要可用的 npm-cli.js；请安装包含 npm 的 Node.js。');
  }
  async support(tool) {
    if (!tool.platforms.includes(this.platform)) return { supported: false, reason: tool.name + ' 暂不支持此平台的一键安装 (' + this.platform + ')。' };
    if (!tool.installer) return { supported: false, reason: tool.installReason };
    if (tool.installer === 'uv' && !(await this.findExecutable('uv'))) return { supported: false, reason: 'Hermes 隔离安装需要 uv；请先安装 uv。' };
    if (tool.installer === 'npm') try { await this.npmCommand(); } catch (error) { return { supported: false, reason: error.message }; }
    return { supported: true, reason: null };
  }
  async list() {
    return Promise.all(TOOL_CATALOG.map(async tool => {
      const systemExecutable = await this.systemExecutable(tool.id), managedPath = this.managedExecutable(tool.id);
      const receipt = await this.receipt(tool.id), support = await this.support(tool), running = await this.isRunning(tool.id);
      const managedInstalled = !!receipt && await this.usable(managedPath), executable = systemExecutable ?? (managedInstalled ? managedPath : null);
      const job = [...this.records.values()].find(value => value.toolId === tool.id && (!finished.has(value.status) || this.controllers.has(value.id)));
      const locked = running ? '工具正在运行，请先结束会话。' : job ? '工具已有进行中的安装任务。' : null;
      const managedReason = locked ?? (!receipt ? '仅支持管理 DSH-Plus 安装的独立副本；系统安装与账户配置保持原样。' : support.reason);
      return { ...tool, source: systemExecutable ? 'external' : managedInstalled ? 'managed' : 'none', installed: !!executable, executable, version: !systemExecutable && managedInstalled ? receipt.version ?? null : null,
        systemExecutable, managedExecutable: managedPath, managedInstalled, managedVersion: receipt?.version ?? null,
        canInstall: support.supported && !locked && !receipt, installReason: locked ?? (receipt ? '独立副本已安装，可更新或重新安装。' : support.reason),
        canUpdate: support.supported && !!receipt && !locked, updateReason: managedReason,
        canReinstall: support.supported && !!receipt && !locked, reinstallReason: managedReason,
        canUninstall: !!receipt && !locked, uninstallReason: locked ?? (!receipt ? '仅支持卸载 DSH-Plus 安装的独立副本；系统安装与账户配置保持原样。' : null), ...(job ? { job: clone(job) } : {}) };
    }));
  }
  install(id) { return this.enqueue(id, 'install'); }
  updateTool(id) { return this.enqueue(id, 'update'); }
  reinstall(id) { return this.enqueue(id, 'reinstall'); }
  uninstall(id) { return this.enqueue(id, 'uninstall'); }
  enqueue(id, action) {
    if (this.closed) throw new Error('Installer is shutting down'); id = normalizeToolId(id);
    if ([...this.records.values()].some(job => job.toolId === id && (!finished.has(job.status) || this.controllers.has(job.id)))) throw new Error('工具已有进行中的安装任务。');
    if (this.records.size >= 100) { const stale = [...this.records.values()].find(job => finished.has(job.status) && !this.controllers.has(job.id)); if (stale) this.records.delete(stale.id); else throw new Error('安装队列已满。'); }
    const job = { id: randomUUID(), toolId: id, action, status: 'queued', message: '等待执行', logs: [], error: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
    this.records.set(job.id, job); this.pending.push(job.id); this.emit('job', clone(job)); queueMicrotask(() => this.drain()); return clone(job);
  }
  jobs() { return [...this.records.values()].map(clone); }
  job(id) { const job = this.records.get(id); if (!job) throw new Error('Unknown installation job'); return clone(job); }
  update(job, patch) { Object.assign(job, patch); this.emit('job', clone(job)); }
  cancel(id) {
    const job = this.records.get(id); if (!job) throw new Error('Unknown installation job');
    if (!finished.has(job.status)) { this.controllers.get(id)?.abort(); this.update(job, { status: 'cancelled', message: '已取消', finishedAt: new Date().toISOString() }); } return clone(job);
  }
  drain() {
    while (!this.closed && this.active < this.maxConcurrent && this.pending.length) {
      const job = this.records.get(this.pending.shift()); if (!job || finished.has(job.status)) continue;
      this.active++; const task = this.run(job).finally(() => { this.active--; this.tasks.delete(task); this.drain(); }); this.tasks.add(task);
    }
  }
  async safePrefix(id) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const prefix = this.prefix(id);
    if (await realpath(this.root) !== this.root) throw new Error('工具安装根目录不能使用符号链接。');
    try { if ((await lstat(prefix)).isSymbolicLink()) throw new Error('拒绝管理符号链接工具目录。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return prefix;
  }
  async run(job) {
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    const timer = setTimeout(() => controller.abort(new Error('安装任务超时。')), this.timeoutMs); timer.unref();
    let partial = '';
    const log = chunk => { partial += String(chunk); const lines = partial.split(/[\r\n]+/); partial = lines.pop().slice(-8192); for (const line of lines) if (line) job.logs.push(redactToolOutput(line, this.env).slice(0, 1000)); if (job.logs.length > 80) job.logs.splice(0, job.logs.length - 80); this.emit('job', clone(job)); };
    let installEnv = Object.fromEntries(Object.entries(this.env).filter(([key]) => !/(?:key|token|secret|password|authorization|credential)/i.test(key) && !/^(?:CODEX_HOME|CLAUDE_CONFIG_DIR|HERMES_HOME|GEMINI_CLI_HOME|PI_CODING_AGENT_DIR|OPENCODE_CONFIG(?:_DIR)?|OPENCLAW_CONFIG_PATH|OPENCLAW_STATE_DIR)$/i.test(key)));
    const execute = async (command, args, env = installEnv) => { if (controller.signal.aborted) throw controller.signal.reason ?? new Error('已取消'); return this.executor(command, args, { env, cwd: this.root, signal: controller.signal, onOutput: log }); };
    try {
      const labels = { install: '安装', update: '更新', reinstall: '重新安装', uninstall: '卸载' };
      this.update(job, { status: 'running', message: '正在' + labels[job.action], startedAt: new Date().toISOString() });
      const tool = getTool(job.toolId), prefix = await this.safePrefix(tool.id);
      if (await this.isRunning(tool.id)) throw new Error('工具正在运行，请先结束会话后重试。');
      const receipt = await this.receipt(tool.id);
      if (job.action === 'uninstall') {
        if (!receipt) throw new Error('拒绝卸载外部安装或没有 DSH-Plus 安装凭据的工具。');
        if (controller.signal.aborted) throw new Error('已取消'); await rm(prefix, { recursive: true, force: true });
      } else {
        const support = await this.support(tool); if (!support.supported) throw new Error(support.reason);
        if (job.action !== 'install' && !receipt) throw new Error('仅支持更新或重装 DSH-Plus 安装的独立副本；请先安装独立副本。');
        if (job.action === 'install' && receipt) throw new Error('独立副本已安装，请选择更新或重新安装。');
        try { await lstat(prefix); if (!receipt) throw new Error('安装目录已有内容且不属于 DSH-Plus，拒绝覆盖。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (job.action === 'reinstall') { if (controller.signal.aborted) throw new Error('已取消'); await rm(prefix, { recursive: true, force: true }); }
        await mkdir(prefix, { recursive: true, mode: 0o700 });
        if (job.action !== 'update') await writeFile(join(prefix, 'dsh-install.json'), JSON.stringify({ owner: 'dsh-plus', toolId: tool.id, version: null }), { mode: 0o600 });
        // Installer hooks and version probes must not read or migrate the user's account/configuration.
        const installHome = join(prefix, '.install-home'); await mkdir(installHome, { recursive: true, mode: 0o700 });
        installEnv = { ...installEnv, HOME: installHome, USERPROFILE: installHome, XDG_CONFIG_HOME: join(installHome, 'config'), XDG_DATA_HOME: join(installHome, 'data'), XDG_CACHE_HOME: join(installHome, 'cache'), APPDATA: join(installHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(installHome, 'AppData', 'Local') };
        if (tool.installer === 'npm') {
          const npm = await this.npmCommand(); await execute(npm.command, [...npm.args, 'install', '--global', '--prefix', prefix, '--include=optional', '--engine-strict', '--no-audit', '--no-fund', ...tool.installArgs, tool.packageName + '@latest']);
        } else {
          await execute(await this.findExecutable('uv'), ['tool', 'install', '--force', ...(job.action === 'update' ? ['--upgrade'] : []), '--python', '3.14', tool.source], { ...installEnv, UV_TOOL_DIR: join(prefix, 'tools'), UV_TOOL_BIN_DIR: join(prefix, 'bin'), UV_PYTHON_INSTALL_DIR: join(prefix, 'python'), UV_NO_CONFIG: '1' });
        }
        if (controller.signal.aborted) throw new Error('已取消');
        const executable = this.managedExecutable(tool.id); if (!(await this.usable(executable))) throw new Error('安装命令已结束，但工具入口不可用。');
        const launch = await this.resolveLaunch(tool.id, { managed: true }); const result = await execute(launch.command, [...launch.args, '--version']); const version = redactToolOutput(result?.stdout ?? '', this.env).trim().slice(0, 200);
        await writeFile(join(prefix, 'dsh-install.json'), JSON.stringify({ owner: 'dsh-plus', toolId: tool.id, version: version || null, installedAt: new Date().toISOString() }), { mode: 0o600 });
      }
      if (!controller.signal.aborted) this.update(job, { status: 'succeeded', message: labels[job.action] + '完成，系统安装与用户配置已保留', finishedAt: new Date().toISOString() });
    } catch (error) {
      if (job.status !== 'cancelled') this.update(job, { status: 'failed', error: redactToolOutput(controller.signal.aborted ? controller.signal.reason?.message ?? '任务已中止或超时' : error.message, this.env).slice(0, 1200), message: '操作失败', finishedAt: new Date().toISOString() });
    } finally { if (partial) log('\n'); clearTimeout(timer); this.controllers.delete(job.id); }
  }
  async close() { this.closed = true; for (const job of this.records.values()) if (!finished.has(job.status)) this.cancel(job.id); await Promise.allSettled([...this.tasks]); }
}
