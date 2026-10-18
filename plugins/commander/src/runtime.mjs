import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, workingDirectory } from './store.mjs';
import { CodexProvider } from './providers/codex.mjs';
import { ClaudeProvider } from './providers/claude.mjs';
import { PiProvider } from './providers/pi.mjs';
import { OpenCodeProvider } from './providers/opencode.mjs';
import { normalizeCommand } from './commands.mjs';
import { acpProviderClasses, ACP_TOOL_DEFAULTS } from './providers/acp.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const terminal = new Set(['idle', 'failed', 'disconnected', 'closed']);
export const providerClasses = { codex: CodexProvider, claude: ClaudeProvider, pi: PiProvider, opencode: OpenCodeProvider, ...acpProviderClasses };

export class Commander extends EventEmitter {
  constructor({ dataDir = join(homedir(), '.dowork', 'commander'), providers = {}, approvalTimeout = 120_000, eventLimit = 2000, routeService } = {}) {
    super();
    this.store = new Store(dataDir);
    this.routeService = routeService;
    this.sessions = new Map(); this.drivers = new Map(); this.pending = new Map(); this.connecting = new Map();
    this.providers = new Map(Object.entries(providerClasses).map(([name, Type]) => [name, new Type(providers[name])]));
    this.approvalTimeout = approvalTimeout; this.eventLimit = eventLimit;
    this.fault = undefined; this.closing = false;
    this.generations = new Map();
    this.submissions = new Map(); this.activeSubmissions = new Set();
    this.removals = new Map();
    this.archiving = new Set();
  }

  async open() {
    const data = await this.store.open();
    if (data.version !== 1 || !Array.isArray(data.sessions)) { await this.store.close(); throw new Error('Unsupported Commander state format'); }
    for (const record of data.sessions) {
      if (['running', 'waiting', 'connecting'].includes(record.status)) {
        for (const entry of Object.values(record.receipts)) {
          if (entry.receipt.turnId === record.turnId) entry.receipt.status = 'uncertain';
        }
      }
      record.status = record.archived ? 'closed' : 'disconnected';
      if (!record.route) record.routeMode = 'native-unbound';
      record.pendingApprovals = [];
      this.sessions.set(record.id, record);
    }
    return this;
  }

  healthy() {
    if (this.closing) throw new Error('Commander is shutting down');
    if (this.fault) throw new Error(`Commander persistence failed: ${this.fault.message}`);
  }
  get(id) { const session = this.sessions.get(id); if (!session) throw new Error(`Unknown Commander session: ${id}`); return session; }
  list() { return [...this.sessions.values()].map(s => this.snapshot(s.id)); }
  snapshot(id) { const { events, receipts, ...value } = this.get(id); return copy(value); }
  catalog() { return [...this.providers].map(([name, provider]) => ({ name, capabilities: provider.constructor.capabilities })); }
  async providerConfig(name, session) {
    const base = this.providers.get(name)?.config ?? {};
    const installed = this.toolInstaller ? await this.toolInstaller.resolveLaunch(name) : null;
    // Reconnecting never reads mutable tool defaults or global applied profiles.
    const route = session?.route;
    if (route && !this.routeService) throw new Error('会话绑定服务不可用，拒绝回退到本机配置。');
    const launch = route ? await this.routeService.launch({ tool: name, route, sessionId: session.id }) : {};
    const profile = launch.managedProfile;
    return { ...base, ...(installed && !base.command ? { command: name === 'claude' && installed.args.length ? installed.args[0] : installed.command, commandArgs: name === 'claude' ? [] : installed.args } : {}),
      ...(ACP_TOOL_DEFAULTS[name] ? { args: base.args ?? installed?.args ?? base.commandArgs ?? [] } : {}),
      ...launch, commandArgs: [...(base.commandArgs ?? (name === 'claude' ? [] : installed?.args) ?? []), ...(launch.commandArgs ?? [])],
      env: { ...base.env, ...launch.env }, ...(profile?.configured ? { managedProfile: profile } : {}) };
  }
  async doctor() {
    const run = promisify(execFile);
    return Promise.all([...this.providers].map(async ([name, provider]) => {
      const config = await this.providerConfig(name);
      const command = config.command ?? ACP_TOOL_DEFAULTS[name]?.command ?? (name === 'claude' ? 'claude' : name);
      try {
        const { stdout } = await run(command, [...(config.commandArgs ?? []), '--version'], { env: { ...process.env, ...config.env }, timeout: 8000, maxBuffer: 32_768, windowsHide: true });
        return { name, available: true, version: stdout.trim().slice(0, 200), login: 'not-checked' };
      } catch (error) { return { name, available: false, error: error.code === 'ENOENT' ? 'not-installed' : 'version-check-failed', login: 'not-checked' }; }
    }));
  }
  persist() {
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    return this.store.save([...this.sessions.values()]);
  }

  event(id, type, data = {}) {
    const session = this.get(id);
    if (type === 'turn.started' && session.status !== 'closed') session.status = session.pendingApprovals.length ? 'waiting' : 'running';
    if (type === 'turn.completed') {
      session.status = data.status === 'failed' ? 'failed' : 'idle';
      this.denyPending(id);
    }
    const event = copy({ seq: ++session.cursor, time: new Date().toISOString(), sessionId: id, turnId: session.turnId ?? null, type, data });
    session.events.push(event);
    if (session.events.length > this.eventLimit) session.events.splice(0, session.events.length - this.eventLimit);
    session.updatedAt = event.time;
    // Save snapshots in order. A failed write prevents subsequent mutations;
    // it is observable and never silently reported as durable acceptance.
    if (!this.flushTimer) this.flushTimer = setTimeout(() => {
      this.persist().catch(error => { this.fault = error; this.emit('fault', error); });
    }, 50);
    this.emit('event', copy(event));
    return event;
  }

  events(id, after = 0, limit = 200) {
    const session = this.get(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor');
    const first = session.events[0]?.seq ?? session.cursor + 1;
    const selected = session.events.filter(e => e.seq > after).slice(0, Math.min(Math.max(limit, 1), 500));
    return copy({ events: selected, cursor: selected.at(-1)?.seq ?? after, latest: session.cursor, truncated: after < first - 1 });
  }

  async create({ provider, cwd, model, parentId, nativeId, ownerSessionId, projectId, title, route, nativeMode = false } = {}) {
    this.healthy();
    if (!this.providers.has(provider)) throw new Error(`Unknown provider: ${provider}`);
    if (parentId) this.get(parentId);
    if (nativeId && [...this.sessions.values()].some(s => s.provider === provider && s.nativeId === nativeId && this.drivers.has(s.id))) throw new Error('Native session already owned by Commander');
    if (route && nativeId) throw new Error('不能为已有原生会话自动绑定隔离供应商，请新建会话。');
    if (nativeMode && route) throw new Error('原生配置模式不能同时指定托管供应商。');
    if (!nativeMode && !nativeId && this.routeService && this.toolProfiles?.list) {
      const defaults = (await this.toolProfiles.list({ includeNative: false })).defaults;
      const selected = Array.isArray(defaults) ? defaults.find(item => item.tool === provider) : defaults?.[provider];
      if (!route && selected) route = selected;
      else if (route && route.quickSettings === undefined && selected?.quickSettings) route = { ...route, quickSettings: selected.quickSettings };
    }
    if (route && !this.routeService) throw new Error('会话绑定服务不可用');
    const binding = route ? await this.routeService.capture({ ...route, tool: provider, model: route.model ?? model }) : undefined;
    const session = {
      ...(binding ? { route: binding, routeMode: binding.mode } : { routeMode: 'native-unbound' }),
      id: randomUUID(), provider, cwd: await workingDirectory(cwd), ...((binding?.model ?? model) ? { model: binding?.model ?? model } : {}),
      ...(parentId ? { parentId } : {}), ...(nativeId ? { nativeId } : {}),
      ...(ownerSessionId ? { ownerSessionId } : {}),
      ...(projectId ? { projectId } : {}), ...(title ? { title: String(title).slice(0, 120) } : {}),
      status: 'disconnected', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      cursor: 0, events: [], receipts: {}, pendingApprovals: [],
    };
    this.sessions.set(session.id, session);
    await this.persist();
    await this.connect(session.id);
    return this.snapshot(session.id);
  }

  async connect(id) {
    this.healthy();
    if (this.removals.has(id)) throw new Error('Session is being deleted');
    if (this.archiving.has(id)) throw new Error('Session is being archived');
    if (this.connecting.has(id)) return this.connecting.get(id);
    if (this.drivers.has(id)) {
      if (this.get(id).status !== 'failed') return this.snapshot(id);
      await this.disconnect(id);
    }
    const task = this.connectInternal(id);
    this.connecting.set(id, task);
    try { return await task; } finally { this.connecting.delete(id); }
  }

  async connectInternal(id) {
    const session = this.get(id);
    if (session.archived) throw new Error('Unarchive session before connecting');
    if (session.cursor && !session.nativeId) throw new Error('No durable native handle; refusing to create a replacement session');
    if (session.nativeId && [...this.sessions.values()].some(s => s.id !== id && s.provider === session.provider && s.nativeId === session.nativeId && (this.drivers.has(s.id) || this.connecting.has(s.id)))) throw new Error('Native session already owned by Commander');
    session.status = 'connecting';
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    const current = () => this.generations.get(id) === generation && !this.closing && session.status !== 'closed';
    let failed;
    const host = {
      ...(this.delegationBridge ? { delegation: this.delegationBridge.forSession(id), delegate: args => { if (!current()) throw new Error('Native connection was released'); return this.delegate(id, args); } } : {}),
      event: (type, data) => { if (current()) this.event(id, type, data); },
      nativeId: value => { if (current()) { session.nativeId = value; this.event(id, 'session.native', { nativeId: value }); if (ACP_TOOL_DEFAULTS[session.provider]) return this.persist(); } },
      failure: error => {
        failed = session.route ? new Error('隔离工具连接失败，请检查工具运行状态。') : error;
        if (current()) {
          session.status = 'failed'; this.denyPending(id); this.event(id, 'session.error', { message: failed.message });
        }
      },
      approval: (request, signal) => current() ? this.ask(id, request, signal) : Promise.resolve({ allow: false }),
    };
    let driver;
    try {
      const original = this.providers.get(session.provider), config = await this.providerConfig(session.provider, session);
      const provider = Object.assign(Object.create(Object.getPrototypeOf(original)), original, { config });
      const nativeSession = copy(session), managed = config.managedProfile;
      if (managed?.configured && !nativeSession.model && !ACP_TOOL_DEFAULTS[session.provider]) nativeSession.model = managed.provider ? managed.provider + '/' + managed.model : managed.model;
      driver = await provider.connect(nativeSession, host);
      if (failed) throw failed;
      if (driver.nativeId) session.nativeId = driver.nativeId;
      this.drivers.set(id, driver); session.status = 'idle';
      this.event(id, 'session.connected', { nativeId: session.nativeId ?? null });
      await this.persist();
      return this.snapshot(id);
    } catch (error) {
      await driver?.close();
      this.delegationBridge?.revoke(id);
      const safe = session.route ? Object.assign(new Error(error.code === 'SESSION_ROUTE' ? error.message : '隔离工具启动失败，请检查安装、协议和供应商配置。'), { code: error.code }) : error;
      session.status = 'failed'; this.event(id, 'session.error', { message: safe.message });
      throw safe;
    }
  }

  async submit(id, text, { requestId = randomUUID() } = {}) {
    return this.acceptInput(id, text, requestId, () => this.drivers.get(id).submit(text), 'prompt');
  }

  async commands(id) {
    this.healthy(); this.get(id);
    const driver = this.drivers.get(id);
    if (!driver?.commands) throw new Error('Native command discovery is unavailable; connect a supported provider first');
    return driver.commands();
  }

  async command(id, { name, arguments: args = '', requestId = randomUUID() } = {}) {
    this.healthy();
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new Error('Invalid requestId');
    const command = normalizeCommand(name, args);
    const prompt = `/${command.name}${command.arguments ? ` ${command.arguments}` : ''}`;
    const session = this.get(id);
    // Durable retries never need a native connection or another catalog read.
    if (Object.hasOwn(session.receipts, requestId)) return this.acceptInput(id, prompt, requestId, undefined, 'command');
    if (session.status !== 'idle' || this.activeSubmissions.has(id)) throw new Error(`Session is ${session.status}; connect or wait for idle and native acknowledgement first`);
    const driver = this.drivers.get(id);
    if (!driver?.command) throw new Error('Native command execution is unavailable; connect a supported provider first');
    const catalog = await this.commands(id);
    if (!catalog.some(entry => entry.name === command.name)) throw new Error(`Unsupported native command: /${command.name}`);
    driver.validateCommand?.(command);
    if (this.drivers.get(id) !== driver) throw new Error('Native connection changed while discovering commands; retry');
    return this.acceptInput(id, prompt, requestId, () => driver.command(command), 'command');
  }

  async acceptInput(id, text, requestId, dispatch, kind) {
    this.healthy();
    if (this.removals.has(id)) throw new Error('Session is being deleted');
    if (this.archiving.has(id)) throw new Error('Session is being archived');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Prompt must not be empty');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new Error('Invalid requestId');
    const session = this.get(id);
    if (Object.hasOwn(session.receipts, requestId)) {
      const previous = session.receipts[requestId];
      if (previous.text !== text || (previous.kind ?? 'prompt') !== kind) throw new Error('requestId was already used for a different prompt or command');
      const inFlight = this.submissions.get(`${id}:${requestId}`);
      if (inFlight) return inFlight;
      return copy(previous.receipt);
    }
    if (session.status !== 'idle' || !this.drivers.has(id) || this.activeSubmissions.has(id)) throw new Error(`Session is ${session.status}; connect or wait for idle and native acknowledgement first`);
    if (Object.keys(session.receipts).length >= 10_000) throw new Error('Session input receipt limit reached; create another session');
    session.turnId = randomUUID(); session.status = 'running';
    const receipt = { requestId, sessionId: id, turnId: session.turnId, status: 'accepted' };
    let resolveSubmission, rejectSubmission;
    const acceptance = new Promise((resolve, reject) => { resolveSubmission = resolve; rejectSubmission = reject; });
    acceptance.catch(() => {});
    this.submissions.set(`${id}:${requestId}`, acceptance); this.activeSubmissions.add(id);
    session.receipts[requestId] = { text, receipt, kind };
    this.event(id, 'input.accepted', { text, requestId, kind });
    // Persist BEFORE the irreversible native submission. A crash can produce
    // an uncertain receipt, but retries never blindly execute it twice.
    try {
      try { await this.persist(); }
      catch (error) { this.fault = error; session.status = 'failed'; throw error; }
      try { await dispatch(); }
      catch (error) {
        receipt.status = 'uncertain'; session.status = 'failed';
        this.denyPending(id);
        this.event(id, 'input.uncertain', { requestId, message: error.message });
        await this.persist(); throw error;
      }
      await this.persist();
      resolveSubmission(copy(receipt)); return copy(receipt);
    } catch (error) { rejectSubmission(error); throw error; }
    finally { this.submissions.delete(`${id}:${requestId}`); this.activeSubmissions.delete(id); }
  }

  async steer(id, text) {
    this.healthy(); const session = this.get(id);
    const driver = this.drivers.get(id);
    if (session.status !== 'running' || !driver?.steer) throw new Error('Steering is unavailable for this session');
    await driver.steer(text); this.event(id, 'input.steer', { text });
  }
  async interrupt(id) {
    this.healthy(); const session = this.get(id);
    if (!['running', 'waiting'].includes(session.status)) throw new Error('No active turn to interrupt');
    this.denyPending(id);
    await this.drivers.get(id).interrupt();
    this.event(id, 'turn.interrupt-requested', {});
  }

  ask(id, request, signal) {
    if (this.closing || signal?.aborted) return Promise.resolve({ allow: false });
    const session = this.get(id); const approvalId = randomUUID();
    return new Promise(resolve => {
      const finish = answer => {
        if (!this.pending.delete(approvalId)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        session.pendingApprovals = session.pendingApprovals.filter(p => p.id !== approvalId);
        if (session.status === 'waiting' && !session.pendingApprovals.length) session.status = 'running';
        this.event(id, 'approval.resolved', { id: approvalId, answer });
        resolve(answer);
      };
      const abort = () => finish({ allow: false });
      const timer = setTimeout(abort, this.approvalTimeout);
      this.pending.set(approvalId, { sessionId: id, finish });
      session.status = 'waiting';
      const approval = copy({ id: approvalId, sessionId: id, turnId: session.turnId ?? null, ...request });
      session.pendingApprovals.push(approval);
      signal?.addEventListener('abort', abort, { once: true });
      this.event(id, 'approval.requested', approval);
    });
  }

  // Trusted human/controller API only: deliberately NOT exposed as a model tool.
  approve(id, approvalId, answer) {
    this.healthy(); const pending = this.pending.get(approvalId);
    if (!pending || pending.sessionId !== id) throw new Error('Approval expired, already answered, or belongs to another session');
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Approval answer must be an object');
    if (Object.hasOwn(answer, 'allow') && typeof answer.allow !== 'boolean') throw new Error('Approval allow must be boolean');
    pending.finish(copy(answer));
  }
  denyPending(id) { for (const pending of [...this.pending.values()]) if (pending.sessionId === id) pending.finish({ allow: false }); }

  async history(id) {
    const driver = this.drivers.get(id); if (!driver?.history) throw new Error('Native history unavailable; use Commander events');
    return driver.history();
  }
  async discover(id) {
    const driver = this.drivers.get(id); if (!driver?.discover) throw new Error('Native session discovery unavailable for this provider');
    return driver.discover();
  }

  async wait(id, { timeout = 30_000, signal } = {}) {
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 60_000) throw new Error('wait timeout must be 0..60000 ms');
    signal?.throwIfAborted();
    if (terminal.has(this.get(id).status)) return this.snapshot(id);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('event', listener); signal?.removeEventListener('abort', abort); };
      const listener = event => { if (event.sessionId === id && terminal.has(this.get(id).status)) { cleanup(); resolve(this.snapshot(id)); } };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); resolve(this.snapshot(id)); }, timeout);
      this.on('event', listener); signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async disconnect(id) {
    if (this.connecting.has(id)) await this.connecting.get(id).catch(() => {});
    const session = this.get(id); session.status = 'closed';
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.delegationBridge?.revoke(id);
    this.denyPending(id);
    const driver = this.drivers.get(id); this.drivers.delete(id);
    await driver?.close();
    this.event(id, 'session.closed', {}); await this.persist();
    return this.snapshot(id);
  }
  async archive(id, archived = true) {
    this.healthy();
    if (this.removals.has(id)) throw new Error('Session is being deleted');
    if (this.archiving.has(id)) throw new Error('Session is being archived');
    if (archived && (['running', 'waiting', 'connecting'].includes(this.get(id).status) || this.activeSubmissions.has(id) || this.connecting.has(id))) throw new Error('Finish or interrupt the active native session before archiving it');
    this.archiving.add(id);
    try {
      if (archived) await this.disconnect(id);
      this.get(id).archived = archived;
      await this.persist(); return this.snapshot(id);
    } finally { this.archiving.delete(id); }
  }

  async remove(id) {
    this.healthy();
    if (this.removals.has(id)) return this.removals.get(id);
    if (this.archiving.has(id)) throw new Error('Session is being archived');
    const session = this.get(id);
    if (['running', 'waiting', 'connecting'].includes(session.status) || this.activeSubmissions.has(id) || this.connecting.has(id)) throw new Error('Finish or interrupt the active native session before deleting it');
    const task = (async () => {
      await this.disconnect(id);
      // Descendants remain independent conversations. Do not leave references
      // to a parent record that no longer exists, and never delete their work.
      const children = [...this.sessions.values()].filter(record => record.parentId === id);
      const childOwners = children.map(child => ({ child, ownerSessionId: child.ownerSessionId, hadOwner: Object.hasOwn(child, 'ownerSessionId') }));
      for (const child of children) {
        delete child.parentId;
        // A delegated child shared its parent's Harness owner. Once orphaned,
        // it must not masquerade as that owner's primary native conversation.
        // Independently adopted children keep their explicit Harness binding.
        if (!child.harnessAdopted && child.ownerSessionId === session.ownerSessionId) child.ownerSessionId = `commander-web:detached:${child.id}`;
      }
      this.sessions.delete(id);
      try { await this.persist(); }
      catch (error) {
        this.sessions.set(id, session);
        for (const { child, ownerSessionId, hadOwner } of childOwners) {
          child.parentId = id;
          if (hadOwner) child.ownerSessionId = ownerSessionId;
          else delete child.ownerSessionId;
        }
        this.fault = error;
        throw error;
      }
      this.generations.delete(id);
      return { id, removed: true };
    })();
    this.removals.set(id, task);
    try { return await task; } finally { this.removals.delete(id); }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.removals.values()]);
    await Promise.allSettled([...this.connecting.values()]);
    const results = await Promise.allSettled([...this.drivers.keys()].map(id => this.disconnect(id)));
    await Promise.allSettled([...this.submissions.values()]);
    try { await this.persist(); } finally { clearTimeout(this.flushTimer); await this.store.close(); }
    const failure = results.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
  }
}
