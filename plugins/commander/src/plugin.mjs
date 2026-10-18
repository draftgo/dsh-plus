import { Commander } from './runtime.mjs';
import { askNativeQuestion } from './questions.mjs';
import { mountWeb } from './web.mjs';
import { mountHarnessCommands } from './harness-commands.mjs';
import { mountHarnessAdapter } from './harness-adapter.mjs';
import { apply as applyVoice } from '../voice/src/plugin.mjs';
import { createModelProviders } from './model-providers.mjs';
import { mountUsage } from './usage.mjs';
import { mountTooling } from './tooling.mjs';
import { mountLink } from '../lib/link.mjs';

export const name = 'commander';
export const inject = ['tools'];

const string = description => ({ type: 'string', description });
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

export async function apply(ctx, config = {}) {
  const commander = await new Commander(config).open();
  ctx.effect(() => () => commander.close());
  ctx.provide('commander', commander);
  ctx.inject(['connection', 'settings', 'credentials', 'llm'], async child => {
    const providers = createModelProviders(child);
    await mountTooling(child, commander, providers);
    await applyVoice(child, { ...config.voice, providers });
  });
  ctx.inject(['connection'], async child => { await mountUsage(child, commander, config.usage ?? {}); });
  ctx.inject(['connection', 'workspaceRegistry'], async child => { await mountWeb(child, commander, config); });
  ctx.inject(['connection', 'workspaceRegistry', 'typertGateway', 'sessionController', 'webServer', 'clientModules'], async child => {
    await mountLink(child, { ...config.link, directory: config.link?.directory, webRoot: new URL('../lib/link-web/', import.meta.url) });
  });
  const owners = new Map();
  ctx.inject(['commands'], child => mountHarnessCommands(child, commander, { bindOwner: (id, agent) => owners.set(id, agent) }));
  ctx.inject(['llm', 'agents', 'workspaceRegistry'], child => { mountHarnessAdapter(child, commander, { bindOwner: (id, agent) => owners.set(id, agent) }); });
  const ownerId = exec => {
    const id = exec.agent?.session?.id;
    if (!id) throw new Error('Commander tools require a Harness Agent session');
    return String(id);
  };
  const owned = (id, exec) => {
    const session = commander.snapshot(id);
    if (session.ownerSessionId !== ownerId(exec)) throw new Error('Commander session belongs to a different Harness session');
    owners.set(id, exec.agent);
    return session;
  };

  // A native permission is always routed to the real human approval seam.
  // There is deliberately no commander_approve model tool.
  const pendingApprovals = new Set();
  const controllers = new Map();
  const listener = event => {
    if (event.type === 'approval.resolved') { controllers.get(event.data.id)?.abort(); return; }
    if (event.type !== 'approval.requested') return;
    // Direct browser sessions own their approval UI; never auto-deny them for lacking a Harness Agent.
    if (commander.snapshot(event.sessionId).ownerSessionId?.startsWith('commander-web:')) return;
    const task = (async () => {
      const controller = new AbortController(); controllers.set(event.data.id, controller);
      try {
        const owner = commander.snapshot(event.sessionId).ownerSessionId;
        const agent = owners.get(event.sessionId) ?? ctx.get('agents')?.get(owner);
        const approval = ctx.get('approval');
        let allow = false;
        if (agent && approval && event.data.kind === 'permission') {
          const result = await approval.request({
            agent, toolName: `commander:${event.data.method}`, signal: controller.signal,
            reason: `Native ${commander.snapshot(event.sessionId).provider} request:\n${JSON.stringify(event.data.details)}`,
          });
          allow = result === 'allowed-once';
        }
        let answer = { allow };
        const questions = ctx.get('userQuestions');
        if (agent && questions && event.data.kind === 'question') {
          answer = await askNativeQuestion(commander.snapshot(event.sessionId).provider, event.data, request => questions.ask({ ...request, agent, signal: controller.signal }));
        }
        commander.approve(event.sessionId, event.data.id, answer);
      } catch {
        // The native timeout/interrupt may already have resolved this request.
        try { commander.approve(event.sessionId, event.data.id, { allow: false }); } catch {}
      } finally { controllers.delete(event.data.id); }
    })();
    pendingApprovals.add(task); task.finally(() => pendingApprovals.delete(task));
  };
  commander.on('event', listener);
  ctx.effect(() => async () => {
    commander.off('event', listener);
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled(pendingApprovals);
  });

  const register = (name, description, properties, required, execute) => ctx.tools.register({
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output,
    async execute(args, exec) { exec.signal.throwIfAborted(); return execute(args, exec); },
  });
  register('commander_providers', 'List native coding-agent providers and protocol capabilities. Does not prove installation or login.', {}, [], async () => ({ providers: commander.catalog() }));
  register('commander_doctor', 'Check native coding-agent executables and versions. Does not inspect credentials or prove login.', {}, [], async () => ({ providers: await commander.doctor() }));
  register('commander_sessions', 'List external sessions owned by this Harness conversation.', {}, [], async (_args, exec) => ({ sessions: commander.list().filter(s => s.ownerSessionId === ownerId(exec)) }));
  register('commander_create', 'Create or import a persistent native coding-agent session. Starting an external coding engine requires user approval. Use commander_send for tasks.', {
    provider: { type: 'string', enum: ['codex', 'claude', 'pi', 'opencode', 'gemini', 'hermes', 'grok', 'mcode'] },
    cwd: string('Absolute working directory'), model: string('Optional native model ID'), providerId: string('Optional configured DSH supplier ID; requires model and creates an isolated session, never changes the local CLI profile'),
    nativeId: string('Existing native thread/session handle to resume, only after its original writer is stopped'),
    parentId: string('Optional Commander parent session for delegation'),
  }, ['provider', 'cwd'], async (args, exec) => {
    const ownerSessionId = ownerId(exec);
    if (args.parentId) owned(args.parentId, exec);
    const approval = ctx.get('approval');
    if (!approval) throw new Error('A human approval service is required to start external agents');
    const grant = await approval.request({ agent: exec.agent, toolName: 'commander_create', callId: exec.callId, signal: exec.signal, reason: `Start ${args.provider} in ${args.cwd}. It uses its native credentials and tool policy; native permissions will be forwarded separately.` });
    if (grant !== 'allowed-once') throw new Error('External agent launch was not approved');
    exec.signal.throwIfAborted();
    const { providerId, ...createArgs } = args;
    if (providerId && !args.model) throw new Error('An explicit model is required for a managed supplier route');
    const session = await commander.create({ ...createArgs, ...(providerId ? { route: { providerId, model: args.model } } : {}), ownerSessionId });
    owners.set(session.id, exec.agent);
    return session;
  });
  register('commander_connect', 'Reconnect a previously owned native session using its saved handle. Never recreates a missing handle.', { id: string('Commander session ID') }, ['id'], async ({ id }, exec) => { owned(id, exec); return commander.connect(id); });
  register('commander_send', 'Submit another prompt to an idle native session. Returns an enqueue receipt; inspect events/wait for completion. Reuse requestId when retrying; never resubmit an uncertain receipt blindly.', {
    id: string('Commander session ID'), text: string('Task or follow-up text'), requestId: string('Stable unique idempotency key for this input'),
  }, ['id', 'text', 'requestId'], async ({ id, text, requestId }, exec) => { owned(id, exec); return commander.submit(id, text, { requestId }); });
  register('commander_events', 'Read streamed text, native tool activity and completion events after a cursor. If truncated is true, older Commander events have been pruned; inspect native history.', {
    id: string('Commander session ID'), after: { type: 'integer', minimum: 0 },
  }, ['id'], async ({ id, after }, exec) => { owned(id, exec); return commander.events(id, after); });
  register('commander_wait', 'Wait at most 60 seconds for a native session to become idle or fail. Task continues if this wait is cancelled or times out.', {
    id: string('Commander session ID'), timeout: { type: 'integer', minimum: 0, maximum: 60000 },
  }, ['id'], async ({ id, timeout }, exec) => { owned(id, exec); return commander.wait(id, { timeout, signal: exec.signal }); });
  register('commander_interrupt', 'Interrupt an active native turn. Does not roll back completed tool side effects.', { id: string('Commander session ID') }, ['id'], async ({ id }, exec) => { owned(id, exec); await commander.interrupt(id); return commander.snapshot(id); });
  register('commander_steer', 'Steer an active native turn only if the provider supports it.', { id: string('Commander session ID'), text: string('Steering text') }, ['id', 'text'], async ({ id, text }, exec) => { owned(id, exec); await commander.steer(id, text); return commander.snapshot(id); });
  register('commander_close', 'Release a native session process while retaining its history and handle.', { id: string('Commander session ID') }, ['id'], async ({ id }, exec) => { owned(id, exec); return commander.disconnect(id); });
  register('commander_history', 'Read the owned session native conversation history. Requires an active connection and provider support.', { id: string('Commander session ID') }, ['id'], async ({ id }, exec) => { owned(id, exec); return { history: await commander.history(id) }; });
  register('commander_discover', 'Discover native session handles in the owned session working directory, when the provider supports it. Stop other writers before importing.', { id: string('Commander session ID') }, ['id'], async ({ id }, exec) => { owned(id, exec); return { sessions: await commander.discover(id) }; });
  register('commander_archive', 'Archive an owned external session and release its process, or unarchive it without automatically running tasks.', { id: string('Commander session ID'), archived: { type: 'boolean' } }, ['id'], async ({ id, archived = true }, exec) => { owned(id, exec); return commander.archive(id, archived); });
}
