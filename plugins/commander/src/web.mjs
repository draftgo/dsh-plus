import { harnessSelection } from './harness-selection.mjs';
import { realpath, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { discoverModels } from './models.mjs';
import { DelegationBridge } from './delegation.mjs';
import { projectActions } from './projects.mjs';
import { mountFonts } from './fonts.mjs';

const webOwner = id => `commander-web:${id}`;
const text = (value, name, max = 20000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
};

/** Mount direct-engine controls on the existing authenticated owner-only Connection carrier. */
export async function mountWeb(ctx, commander, config = {}) {
  const maxDepth = config.maxDelegationDepth ?? 3;
  const maxChildren = config.maxDelegationChildren ?? 12;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) throw new Error('maxDelegationDepth must be an integer from 1 to 8');
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 1 || maxChildren > 64) throw new Error('maxDelegationChildren must be an integer from 1 to 64');
  const models = new Map();
  const starts = new Map();
  const projects = projectActions(ctx);
  const dismissedPath = join(commander.store.directory, 'dismissed-harness.json');
  let deletedHarnessIds = [];
  try {
    const saved = JSON.parse(await readFile(dismissedPath, 'utf8'));
    if (!Array.isArray(saved) || saved.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Invalid dismissed Harness session list');
    deletedHarnessIds = [...new Set(saved)];
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let dismissWrites = Promise.resolve();
  ctx.effect(() => () => dismissWrites);
  const bridge = await new DelegationBridge(commander).open();
  commander.delegationBridge = bridge;
  ctx.effect(() => async () => { commander.delegationBridge = undefined; await bridge.close(); });
  const project = id => {
    const p = ctx.workspaceRegistry.get(text(id, 'projectId', 200));
    if (!p) throw new Error('Project no longer exists');
    return p;
  };
  const owned = id => {
    const s = commander.snapshot(text(id, 'sessionId', 200));
    if (!s.ownerSessionId?.startsWith('commander-web:')) throw new Error('This session belongs to a Harness conversation; control it there');
    return s;
  };
  const state = () => ({
    projects: ctx.workspaceRegistry.list().map(p => ({ id: p.id, path: p.path, title: p.title, sessionIds: p.sessionIds })),
    sessions: commander.list(),
    deletedHarnessIds: [...deletedHarnessIds],
  });
  const result = id => {
    const s = commander.snapshot(id);
    const events = commander.get(id).events.filter(e => e.turnId === s.turnId);
    return { session: s, text: events.filter(e => e.type === 'text.delta').map(e => e.data.text).join('').slice(-60000),
      events: events.filter(e => ['turn.completed', 'session.error', 'provider.error'].includes(e.type)).slice(-10), cursor: s.cursor,
      pending: !['idle', 'failed', 'disconnected', 'closed'].includes(s.status),
      ...(s.status === 'running' || s.status === 'waiting' ? { next: 'Read again with operation=result and sessionId; do not create a duplicate child.' } : {}),
    };
  };
  commander.delegate = async (parentId, args) => {
    const parent = commander.snapshot(parentId);
    if (!parent.ownerSessionId) throw new Error('Native delegation requires an owning conversation');
    if (!args || typeof args !== 'object') throw new Error('Invalid delegation arguments');
    if (args.operation === 'result') {
      const child = commander.snapshot(text(args.sessionId, 'sessionId', 200));
      if (child.parentId !== parentId) throw new Error('Only direct delegated children can be read');
      return result(child.id);
    }
    const provider = text(args.provider, 'provider', 100);
    const prompt = text(args.text, 'text');
    let depth = 0, ancestor = parent;
    while (ancestor.parentId) { ancestor = commander.snapshot(ancestor.parentId); depth++; }
    if (depth >= maxDepth) throw new Error('Delegation depth limit reached');
    if (commander.list().filter(s => s.parentId === parentId && !s.archived).length >= maxChildren) throw new Error('Delegation child limit reached');
    const answer = await commander.ask(parentId, { kind: 'permission', method: 'commander_delegate', details: { provider, model: args.model, text: prompt, cwd: parent.cwd } });
    if (!answer.allow) throw new Error('Delegation denied by user');
    if (!commander.drivers.has(parentId)) throw new Error('Parent session was disconnected');
    // Re-resolve the registered project: native engines cannot choose another directory.
    const p = parent.projectId ? project(parent.projectId) : ctx.workspaceRegistry.list().find(p => p.path === parent.cwd);
    if (!p) throw new Error('Parent project is no longer registered');
    const child = await commander.create({ provider, model: args.model, cwd: p.path, projectId: p.id, parentId, ownerSessionId: parent.ownerSessionId, title: prompt.slice(0, 60) });
    commander.event(parentId, 'delegation.created', { sessionId: child.id, provider, model: args.model ?? null });
    await commander.submit(child.id, prompt);
    await commander.wait(child.id, { timeout: 55000 });
    const value = result(child.id);
    commander.event(parentId, 'delegation.result', { sessionId: child.id, status: value.session.status });
    return value;
  };
  const dispatch = async input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object');
    const { action } = input;
    if (action === 'state') return state();
    if (action === 'binding') {
      const ownerSessionId = text(input.harnessSessionId, 'harnessSessionId', 200);
      const session = commander.list().find(item => !item.archived && (!item.parentId || item.harnessAdopted) && item.ownerSessionId === ownerSessionId);
      return { bound: !!session, ...(session ? { id: session.id, cursor: session.cursor, provider: session.provider, model: session.model ?? 'native-default', route: session.route ? { providerId: session.route.providerId, model: session.route.model } : null } : {}) };
    }
    if (action === 'browse') return projects.browse(input);
    if (action === 'clone') return projects.clone(input);
    if (action === 'dismiss') {
      const id = text(input.harnessSessionId, 'harnessSessionId', 200);
      const task = dismissWrites.then(async () => {
        if (deletedHarnessIds.includes(id)) return { deletedHarnessIds: [...deletedHarnessIds] };
        if (deletedHarnessIds.length >= 10000) throw new Error('Dismissed session limit reached');
        const next = [...deletedHarnessIds, id];
        const temp = `${dismissedPath}.${randomUUID()}.tmp`;
        try { await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, dismissedPath); }
        finally { await rm(temp, { force: true }); }
        deletedHarnessIds = next;
        return { deletedHarnessIds: [...next] };
      });
      dismissWrites = task.catch(() => {});
      return task;
    }
    if (action === 'doctor') return { providers: await commander.doctor() };
    if (action === 'project') {
      const path = text(input.path, 'path', 4096);
      if (!path.startsWith('/')) throw new Error('Project path must be absolute');
      const p = await ctx.workspaceRegistry.create(await realpath(path));
      return { project: { id: p.id, path: p.path, title: p.title } };
    }
    if (action === 'models') {
      const p = project(input.projectId);
      const provider = text(input.provider, 'provider', 100);
      if (!commander.providers.has(provider)) throw new Error('Unknown provider');
      const key = `${provider}:${p.path}`;
      let promise = models.get(key);
      if (!promise) { promise = discoverModels(provider, await commander.providerConfig(provider), p.path); models.set(key, promise); promise.catch(() => models.delete(key)); }
      return { models: await promise };
    }
    if (action === 'create') {
      const p = project(input.projectId);
      const provider = text(input.provider, 'provider', 100);
      if (input.model !== undefined && typeof input.model !== 'string') throw new Error('Invalid model');
      return { session: await commander.create({ provider, cwd: p.path, projectId: p.id, model: input.model, title: input.title, ownerSessionId: webOwner(p.id) }) };
    }
    if (action === 'start') {
      // Validate before creating anything. The durable owner identifies this
      // first message even if connecting fails or the HTTP response is lost.
      const prompt = text(input.text, 'text');
      const requestId = text(input.requestId, 'requestId', 200);
      const p = project(input.projectId);
      const provider = text(input.provider, 'provider', 100);
      if (!commander.providers.has(provider)) throw new Error('Unknown provider');
      if (input.model !== undefined && typeof input.model !== 'string') throw new Error('Invalid model');
      const prefix = `commander-web:start:${encodeURIComponent(requestId)}:`;
      const fingerprint = createHash('sha256').update(JSON.stringify([p.id, provider, input.model || null, prompt])).digest('hex');
      const ownerSessionId = `${prefix}${fingerprint}`;
      const inFlight = starts.get(requestId);
      if (inFlight) {
        if (inFlight.ownerSessionId !== ownerSessionId) throw new Error('requestId was already used for a different first message');
        return inFlight.promise;
      }
      const existing = commander.list().find(s => s.ownerSessionId?.startsWith(prefix));
      if (existing && existing.ownerSessionId !== ownerSessionId) throw new Error('requestId was already used for a different first message');
      const promise = (async () => {
        let session = existing;
        try {
          if (!session) session = await commander.create({ provider, cwd: p.path, projectId: p.id, model: input.model, title: prompt.slice(0, 60), ownerSessionId });
          // A durable receipt means the native process may already have seen
          // this message. Ask submit for its receipt without reconnecting or
          // blindly executing the prompt again, including after a restart.
          if (!Object.hasOwn(commander.get(session.id).receipts, requestId) && !commander.drivers.has(session.id)) await commander.connect(session.id);
          await commander.submit(session.id, prompt, { requestId });
          return { session: commander.snapshot(session.id) };
        } catch (error) {
          session ??= commander.list().find(s => s.ownerSessionId === ownerSessionId);
          if (session) error.session = commander.snapshot(session.id);
          throw error;
        }
      })();
      starts.set(requestId, { ownerSessionId, promise });
      try { return await promise; } finally { starts.delete(requestId); }
    }
    if (action === 'events') {
      // Owner-authenticated human may inspect conversation-owned delegations as well.
      const id = text(input.id, 'sessionId', 200);
      return { session: commander.snapshot(id), ...commander.events(id, input.after ?? 0, 500) };
    }
    if (action === 'adopt') {
      const s = commander.snapshot(text(input.id, 'sessionId', 200));
      if (!s.ownerSessionId?.startsWith('commander-web:') && !s.parentId) throw new Error('Only legacy or delegated sessions can be adopted');
      if (['running', 'waiting', 'connecting'].includes(s.status)) throw new Error('Finish or interrupt the active native session before opening it in Harness');
      const harnessId = text(input.harnessSessionId, 'harnessSessionId', 200);
      const agent = ctx.get('agents')?.get(harnessId);
      if (!agent || agent.session.header.cwd !== s.cwd) throw new Error('Harness session must be open in the same project');
      const selection = harnessSelection(ctx, agent);
      if (selection.provider !== `commander-${s.provider}` || selection.model !== (s.model || 'native-default')) throw new Error('Harness session must select the same native tool and model');
      const record = commander.get(s.id);
      record.ownerSessionId = harnessId;
      record.harnessAdopted = true;
      await commander.persist();
      return { session: commander.snapshot(s.id) };
    }
    // The Connection route is owner-authenticated. Humans may manage native
    // records owned by Harness too; model-side tools retain their own scope.
    if (action === 'archive') {
      const id = text(input.id, 'sessionId', 200);
      if (input.archived !== undefined && typeof input.archived !== 'boolean') throw new Error('Invalid archived flag');
      return commander.archive(id, input.archived ?? true);
    }
    if (action === 'delete') return commander.remove(text(input.id, 'sessionId', 200));
    const s = owned(input.id);
    if (action === 'send') {
      const prompt = text(input.text, 'text');
      if (['disconnected', 'closed'].includes(s.status)) await commander.connect(s.id);
      if (!s.title) { commander.get(s.id).title = prompt.slice(0, 60); await commander.persist(); }
      return commander.submit(s.id, prompt, { requestId: text(input.requestId, 'requestId', 200) });
    }
    if (action === 'connect') return commander.connect(s.id);
    if (action === 'interrupt') { await commander.interrupt(s.id); return commander.snapshot(s.id); }
    if (action === 'steer') { await commander.steer(s.id, text(input.text, 'text')); return commander.snapshot(s.id); }
    if (action === 'close') return commander.disconnect(s.id);
    if (action === 'history') return { history: await commander.history(s.id) };
    if (action === 'approve') { commander.approve(s.id, text(input.approvalId, 'approvalId', 200), input.answer); return commander.snapshot(s.id); }
    throw new Error(`Unknown Commander action: ${action}`);
  };
  await mountFonts(ctx);
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try { return Response.json(await dispatch(await request.json()), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return Response.json({ error: error.message, ...(error.session ? { session: error.session } : {}) }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  return dispatch;
}
