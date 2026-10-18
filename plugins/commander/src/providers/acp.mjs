import { randomUUID } from 'node:crypto';
import { LineProcess } from '../line-process.mjs';
import { commandCatalog, normalizeCommand } from '../commands.mjs';

// Launch arguments verified against Paseo d57096a45 acp-provider-catalog.ts.
// Original adapter implementation: ACP JSON-RPC, no filesystem/terminal client privileges.
export const ACP_TOOL_DEFAULTS = Object.freeze({
  gemini: Object.freeze({ command: 'gemini', args: Object.freeze(['--acp']) }),
  hermes: Object.freeze({ command: 'hermes', args: Object.freeze(['acp']) }),
  grok: Object.freeze({ command: 'grok', args: Object.freeze(['agent', 'stdio']) }),
  mcode: Object.freeze({ command: 'mcode', args: Object.freeze(['acp']) }),
});
const safeModels = state => Array.isArray(state?.availableModels) ? state.availableModels.filter(item => typeof item?.modelId === 'string').map(item => ({ id: item.modelId, name: item.name || item.modelId, ...(item.description ? { description: item.description } : {}) })) : [];
export class ACPProvider {
  static capabilities = { stream: true, resume: true, steer: false, approvals: true, discover: true };
  constructor(config = {}, toolId = 'gemini') { this.config = config; this.toolId = toolId; }
  async models({ cwd = process.cwd(), nativeId } = {}) {
    // Probe creates one short-lived native session when no resumable id is supplied.
    const driver = await this.connect({ cwd, nativeId }, { event() {}, nativeId() {}, failure() {}, approval: async () => ({ allow: false }) });
    try { return await driver.models(); } finally { await driver.close(); }
  }
  async connect(session, host) {
    const defaults = ACP_TOOL_DEFAULTS[this.toolId];
    if (!defaults) throw new Error('Unknown ACP tool');
    const delegation = host.delegation;
    if (delegation && ['command', 'script', 'url', 'token'].some(key => typeof delegation[key] !== 'string' || !delegation[key].trim() || delegation[key].includes(String.fromCharCode(0)))) throw new Error('ACP delegation requires a valid command, script, URL and token');
    // ACP stdio MCP is baseline protocol support; HTTP/SSE flags do not gate it.
    const mcpServers = delegation ? [{ name: 'commander', command: delegation.command, args: [delegation.script], env: [{ name: 'COMMANDER_DELEGATE_URL', value: delegation.url }, { name: 'COMMANDER_DELEGATE_TOKEN', value: delegation.token }] }] : [];
    const wire = new LineProcess(this.config.command ?? defaults.command, [...(this.config.args ?? []), ...defaults.args], { cwd: session.cwd, env: this.config.env, timeout: this.config.timeout ?? 30_000 });
    const life = new AbortController(), pendingPermissions = new Set();
    let closing = false, connected = false, busy = false, caps = {}, modelsState, configOptions = [], commandList = [], commandsReady = false, commandTimer, cancelTimer, settleCommands;
    const earlyUpdates = [];
    const commandsGate = new Promise(resolve => { settleCommands = resolve; });
    const driver = {
      nativeId: session.nativeId, turnId: undefined,
      async models() { return safeModels(modelsState); },
      async setModel(modelId) {
        if (!safeModels(modelsState).some(model => model.id === modelId)) throw new Error('Requested model is not advertised by ACP agent: ' + modelId);
        const option = modelConfig();
        if (option) await wire.request('session/set_config_option', { sessionId: driver.nativeId, configId: option.id, value: modelId });
        else if (caps.sessionCapabilities?.setModel !== false) await wire.request('session/set_model', { sessionId: driver.nativeId, modelId });
        else throw new Error('ACP agent does not support changing models in an existing session');
        modelsState.currentModelId = modelId;
        session.model = modelId;
      },
      async commands() { if (!commandsReady) await commandsGate; return commandCatalog(commandList); },
      async command(value) { const cmd = normalizeCommand(value.name, value.arguments); const catalog = await driver.commands(); if (!catalog.some(item => item.name === cmd.name)) throw new Error('Unsupported native ACP command: /' + cmd.name); return driver.submit('/' + cmd.name + (cmd.arguments ? ' ' + cmd.arguments : '')); },
      async submit(text) {
        if (!connected || closing) throw new Error('ACP session is disconnected');
        if (busy) throw new Error('ACP session is already running');
        if (typeof text !== 'string' || !text.trim()) throw new Error('Prompt must not be empty');
        busy = true; driver.turnId = randomUUID(); host.event('turn.started', {});
        void wire.request('session/prompt', { sessionId: driver.nativeId, prompt: [{ type: 'text', text }] }, thisProvider.config.promptTimeout ?? 15 * 60_000).then(result => {
          busy = false; clearTimeout(cancelTimer); cancelTimer = undefined;
          if (!closing) host.event('turn.completed', { status: result?.stopReason === 'cancelled' ? 'cancelled' : 'completed', stopReason: result?.stopReason ?? null });
        }).catch(async error => {
          if (!closing) { host.event('turn.completed', { status: 'failed', message: error.message }); host.failure(error); await driver.close(); }
        }).finally(() => { busy = false; });
      },
      async interrupt() {
        if (busy && !closing) {
          for (const request of pendingPermissions) request.abort(); wire.notify('session/cancel', { sessionId: driver.nativeId });
          if (!cancelTimer) { cancelTimer = setTimeout(() => { if (busy && !closing) { const error = new Error('ACP cancellation was not acknowledged; session execution outcome may be unknown'); host.event('turn.completed', { status: 'failed', message: error.message }); host.failure(error); void driver.close(); } }, thisProvider.config.cancelTimeout ?? 8000); cancelTimer.unref(); }
        }
      },
      async history() { throw new Error('ACP history is replayed by session/load; standalone history is not advertised.'); },
      async discover() { if (!caps.sessionCapabilities?.list) throw new Error('This ACP agent does not advertise session listing'); return wire.request('session/list', { cwd: session.cwd }); },
      async close() { if (closing) return; closing = true; connected = false; clearTimeout(commandTimer); clearTimeout(cancelTimer); settleCommands(); life.abort(); for (const request of pendingPermissions) request.abort(); await wire.close(); },
    };
    const thisProvider = this;
    const modelConfig = () => configOptions.find(option => option?.category === 'model' || option?.id === 'model' || option?.id === 'model_id');
    const optionModels = option => (option?.options ?? []).flatMap(item => item?.options ?? [item]).filter(item => typeof item?.value === 'string').map(item => ({ modelId: item.value, name: item.name ?? item.value }));
    const update = message => {
      if (message.method !== 'session/update' || closing) return;
      if (!driver.nativeId) { if (earlyUpdates.length < 500) earlyUpdates.push(message); return; }
      if (message.params?.sessionId !== driver.nativeId) return;
      const value = message.params.update; if (!value || typeof value !== 'object') return;
      switch (value.sessionUpdate) {
        case 'available_commands_update': commandList = (value.availableCommands ?? []).slice(0, 500).map(cmd => ({ ...cmd, argumentHint: cmd.input?.hint ?? '' })); commandsReady = true; settleCommands(); break;
        case 'config_option_update': configOptions = value.configOptions ?? []; if (modelConfig()) modelsState = { availableModels: optionModels(modelConfig()), currentModelId: modelConfig().currentValue }; break;
        case 'agent_message_chunk': if (connected && busy && value.content?.type === 'text') host.event('text.delta', { text: value.content.text }); break;
        case 'agent_thought_chunk': if (connected && busy && value.content?.type === 'text') host.event('item', { type: 'reasoning', text: value.content.text }); break;
        case 'tool_call': case 'tool_call_update': case 'plan': if (connected && busy) host.event('item', value); break;
        case 'usage_update': if (connected && busy) host.event('item', { type: 'acp.context_usage', ...value }); break;
      }
    };
    wire.on('notification', update);
    wire.on('failure', error => { if (!closing) { life.abort(); for (const request of pendingPermissions) request.abort(); host.failure(error); } });
    wire.on('request', request => {
      void (async () => {
        if (request.method !== 'session/request_permission') { wire.reject(request.id, 'Client filesystem and terminal methods are unsupported'); return; }
        const params = request.params ?? {}, once = params.options?.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string');
        const denied = () => ({ outcome: { outcome: 'cancelled' } });
        if (!connected || closing || !busy || params.sessionId !== driver.nativeId || !once || !host.approval) { wire.respond(request.id, denied()); return; }
        const controller = new AbortController(); pendingPermissions.add(controller);
        const abort = () => controller.abort(); life.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, this.config.approvalTimeout ?? 120_000); timer.unref();
        try {
          const answer = await Promise.race([Promise.resolve().then(() => host.approval({ kind: 'permission', method: params.toolCall?.kind ?? 'tool', nativeRequestId: request.id, details: params.toolCall ?? {} }, controller.signal)), new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ allow: false }), { once: true }))]);
          if (!closing && !wire.closed) wire.respond(request.id, answer?.allow === true && !controller.signal.aborted ? { outcome: { outcome: 'selected', optionId: once.optionId } } : denied());
        } catch { if (!closing && !wire.closed) wire.respond(request.id, denied()); }
        finally { clearTimeout(timer); pendingPermissions.delete(controller); life.signal.removeEventListener('abort', abort); }
      })().catch(error => { if (!closing) host.failure(error); });
    });
    try {
      const initialized = await wire.request('initialize', { protocolVersion: 1, clientInfo: { name: 'dsh-plus', version: '0.1.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
      caps = initialized.agentCapabilities ?? {};
      if (session.nativeId && !caps.loadSession) throw new Error('This ACP agent does not support session resume; refusing to create a replacement session');
      let result;
      try {
        result = await wire.request(session.nativeId ? 'session/load' : 'session/new', { ...(session.nativeId ? { sessionId: session.nativeId } : {}), cwd: session.cwd, mcpServers });
      } catch (error) {
        if (delegation) throw new Error('ACP session with DSH-Plus delegation MCP failed: ' + error.message, { cause: error });
        throw error;
      }
      if (!session.nativeId && (typeof result?.sessionId !== 'string' || !result.sessionId)) throw new Error('ACP agent did not return a durable session id');
      if (session.nativeId && result?.sessionId && result.sessionId !== session.nativeId) throw new Error('ACP resume returned a different session id');
      driver.nativeId = session.nativeId ?? result.sessionId;
      // Persist the real native session before optional model changes can fail.
      await host.nativeId?.(driver.nativeId);
      modelsState = result.models; configOptions = result.configOptions ?? [];
      for (const message of earlyUpdates) update(message); earlyUpdates.length = 0;
      if (!modelsState && modelConfig()) modelsState = { availableModels: optionModels(modelConfig()), currentModelId: modelConfig().currentValue };
      if (session.model && session.model !== modelsState?.currentModelId) {
        if (!safeModels(modelsState).some(model => model.id === session.model)) throw new Error('Requested model is not advertised by ACP agent: ' + session.model);
        const option = modelConfig();
        if (option) await wire.request('session/set_config_option', { sessionId: driver.nativeId, configId: option.id, value: session.model });
        else await wire.request('session/set_model', { sessionId: driver.nativeId, modelId: session.model });
        modelsState.currentModelId = session.model;
      }
      connected = true;
      commandTimer = setTimeout(settleCommands, this.config.commandsTimeout ?? 300); commandTimer.unref();
      return driver;
    } catch (error) { await driver.close(); throw error; }
  }
}
export const acpProviderClasses = Object.fromEntries(Object.keys(ACP_TOOL_DEFAULTS).map(id => [id, class extends ACPProvider { constructor(config = {}) { super(config, id); } }]));
