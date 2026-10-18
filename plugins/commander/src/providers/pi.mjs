import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { LineProcess } from '../line-process.mjs';
import { commandCatalog, compactCommand } from '../commands.mjs';

export class PiProvider {
  static capabilities = { stream: true, resume: true, steer: true, approvals: true, discover: false };
  constructor(config = {}) { this.config = config; }

  async connect(session, host) {
    if (session.nativeId) {
      try { await access(session.nativeId); }
      catch { throw new Error('Pi native session file is missing; refusing to create a replacement session'); }
    }
    // Do not silently remove proxy settings: Pi uses undici and needs an HTTP
    // proxy. A user can supply config.env with a compatible proxy explicitly.
    const args = [...(this.config.commandArgs ?? []), '--mode', 'rpc', '--extension', fileURLToPath(new URL('./pi-permissions.ts', import.meta.url))];
    if (session.nativeId) args.push('--session', session.nativeId);
    if (session.model) args.push('--model', session.model);
    const wire = new LineProcess(this.config.command ?? 'pi', args, { cwd: session.cwd, env: { ...this.config.env, ...(host.delegation ? { COMMANDER_DELEGATE_URL: host.delegation.url, COMMANDER_DELEGATE_TOKEN: host.delegation.token } : {}) }, dialect: 'pi' });
    let promptGeneration = 0;
    let agentStarted = false;
    const driver = {
      nativeId: session.nativeId,
      async setModel(model) {
        if (typeof model !== 'string' || !model.includes('/')) throw new Error('Pi model must include provider/model');
        const [provider, ...parts] = model.split('/');
        if (!provider || !parts.length) throw new Error('Pi model must include provider/model');
        await wire.request('set_model', { provider, modelId: parts.join('/') });
        session.model = model;
      },
      async submit(text) {
        const generation = ++promptGeneration;
        agentStarted = false;
        const ack = await wire.request('prompt', { message: text });
        if (ack?.agentInvoked === false) {
          await new Promise(resolve => setImmediate(resolve));
          if (generation === promptGeneration && !agentStarted) host.event('turn.completed', { status: 'completed', agentInvoked: false });
        } else if (ack?.agentInvoked === undefined && /^\s*\//.test(text)) {
          // Older RPC releases do not acknowledge whether an extension invoked
          // the model. Like Paseo, check state after queued events have arrived.
          await new Promise(resolve => setImmediate(resolve));
          const state = await wire.request('get_state');
          if (generation === promptGeneration && !agentStarted && state.isStreaming === false) host.event('turn.completed', { status: 'completed', agentInvoked: false });
        }
      },
      async commands() { const result = await wire.request('get_commands'); return commandCatalog(result?.commands, [compactCommand]); },
      async command({ name, arguments: args }) {
        if (name === 'compact') {
          await wire.request('compact', args ? { customInstructions: args } : {}, 30 * 60_000);
          host.event('turn.completed', { status: 'completed' });
        } else await driver.submit(`/${name}${args ? ` ${args}` : ''}`);
      },
      async steer(text) { await wire.request('steer', { message: text }); },
      async interrupt() { await wire.request('abort'); },
      async history() { return wire.request('get_messages'); },
      close: () => wire.close(),
    };
    wire.on('failure', error => host.failure(error));
    wire.on('notification', message => {
      void (async () => {
        switch (message.type) {
          case 'agent_start': agentStarted = true; host.event('turn.started', {}); break;
          case 'agent_end':
            // A new Pi session file may only become durable after the first turn.
            { const state = await wire.request('get_state');
              if (state.sessionFile) { driver.nativeId = state.sessionFile; host.nativeId(state.sessionFile); }
              host.event('turn.completed', { status: message.messages?.some(m => m.stopReason === 'error') ? 'failed' : 'completed' }); }
            break;
          case 'message_update':
            if (message.assistantMessageEvent?.type === 'text_delta') host.event('text.delta', { text: message.assistantMessageEvent.delta });
            break;
          case 'message_end':
            if (message.message?.role === 'assistant' && message.message.usage) host.event('usage', { id: message.message.timestamp ?? message.message.id ?? host.turnId, model: message.message.model, usage: message.message.usage });
            break;
          case 'command_output':
            if (typeof message.text === 'string' && message.text) host.event('text.delta', { text: message.text });
            break;
          case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': host.event('item', message); break;
          case 'extension_ui_request': {
            if (['confirm', 'select', 'input', 'editor'].includes(message.method)) {
              const answer = await host.approval({ kind: message.method === 'confirm' ? 'permission' : 'question', method: message.method, nativeRequestId: message.id, details: message });
              wire.send({ type: 'extension_ui_response', id: message.id, ...(message.method === 'confirm' ? { confirmed: answer.allow === true } : { value: answer.value, cancelled: answer.value === undefined }) });
            } else host.event('ui.notice', message);
            break;
          }
        }
      })().catch(error => host.failure(error));
    });
    try {
      const state = await wire.request('get_state');
      if (session.nativeId && state.sessionFile !== session.nativeId) throw new Error('Pi resumed a different session file');
      driver.nativeId = state.sessionFile;
      return driver;
    } catch (error) { await wire.close(); throw error; }
  }
}
