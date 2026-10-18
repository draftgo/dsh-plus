import { commandCatalog } from '../commands.mjs';
import { isolatedClaudeHistory } from '../isolated-launch.mjs';

export class ClaudeProvider {
  static capabilities = { stream: true, resume: true, steer: false, approvals: true, discover: true };
  constructor(config = {}) { this.config = config; }

  async connect(session, host) {
    let sdk;
    try { sdk = await import('@anthropic-ai/claude-agent-sdk'); }
    catch { throw new Error('Claude Agent SDK is not installed; run npm install in plugins/commander'); }
    const isolatedHome = this.config.managedProfile?.isolated ? this.config.env.CLAUDE_CONFIG_DIR : null;
    const historyInfo = id => isolatedHome ? isolatedClaudeHistory(isolatedHome, 'info', id, session.cwd) : sdk.getSessionInfo(id, { dir: session.cwd });
    if (session.nativeId && !await historyInfo(session.nativeId)) {
      throw new Error('Claude native history is missing or unreadable; refusing to create a replacement session');
    }
    let query;
    let wake;
    let stopped = false;
    let hasAssistantText = false;
    const queue = [];
    async function* input() {
      while (!stopped) {
        if (!queue.length) await new Promise(resolve => { wake = resolve; });
        if (stopped) return;
        yield queue.shift();
      }
    }
    const driver = {
      nativeId: session.nativeId,
      async setModel(model) {
        if (typeof query.setModel !== 'function') throw new Error('Claude Agent SDK does not support changing models in this session');
        await query.setModel(model || undefined);
        session.model = model || undefined;
      },
      async submit(text) {
        hasAssistantText = false;
        queue.push({ type: 'user', session_id: driver.nativeId ?? '', message: { role: 'user', content: text }, parent_tool_use_id: null });
        wake?.(); wake = undefined;
      },
      async commands() { return commandCatalog(await query.supportedCommands()); },
      async command({ name, arguments: args }) { await driver.submit(`/${name}${args ? ` ${args}` : ''}`); },
      async interrupt() { await query.interrupt(); },
      async close() {
        stopped = true; wake?.();
        query.close();
        await pump;
      },
    };
    query = sdk.query({ prompt: input(), options: {
      cwd: session.cwd,
      ...(session.nativeId ? { resume: session.nativeId } : {}),
      ...(session.model ? { model: session.model } : {}),
      pathToClaudeCodeExecutable: this.config.command ?? 'claude',
      env: { ...process.env, ...this.config.env },
      permissionMode: 'default',
      includePartialMessages: true,
      settingSources: this.config.settingSources ?? ['user', 'project', 'local'],
      ...(this.config.settings ? { settings: this.config.settings } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(host.delegation ? { mcpServers: { commander: { command: host.delegation.command, args: [host.delegation.script], env: { COMMANDER_DELEGATE_URL: host.delegation.url, COMMANDER_DELEGATE_TOKEN: host.delegation.token } } } } : {}),
      canUseTool: async (toolName, toolInput, options) => {
        const isQuestion = toolName === 'AskUserQuestion';
        const answer = await host.approval({ kind: isQuestion ? 'question' : 'permission', method: toolName, nativeRequestId: options.toolUseID, details: isQuestion ? toolInput : { toolName, input: toolInput } }, options.signal);
        return answer.allow === true ? { behavior: 'allow', updatedInput: isQuestion ? { ...toolInput, answers: answer.answers } : toolInput } : { behavior: 'deny', message: 'Denied by Commander user' };
      },
    } });
    const pump = (async () => {
      try {
        for await (const message of query) {
          if (message.parent_tool_use_id) {
            host.event('subagent.event', { type: message.type, parentToolUseId: message.parent_tool_use_id, message });
            continue;
          }
          if (message.session_id && message.session_id !== driver.nativeId) {
            if (driver.nativeId) throw new Error('Claude returned a different native session');
            driver.nativeId = message.session_id;
            host.nativeId(message.session_id);
          }
          if (message.type === 'stream_event') {
            if (message.event.type === 'message_start') host.event('turn.started', {});
            if (message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') { hasAssistantText = true; host.event('text.delta', { text: message.event.delta.text }); }
            if (message.event.type === 'content_block_start' && message.event.content_block.type === 'tool_use') host.event('item', message.event.content_block);
          } else if (message.type === 'result') {
            if (!hasAssistantText && message.usage?.output_tokens === 0 && typeof message.result === 'string' && message.result.trim()) host.event('text.delta', { text: message.result });
            host.event('turn.completed', { status: message.is_error ? 'failed' : 'completed', result: message.result ?? null, errors: message.errors ?? [] });
          } else if (message.type === 'assistant' || message.type === 'user') {
            host.event('message', { type: message.type, message: message.message });
          } else if (message.type === 'system' && message.subtype === 'api_retry') {
            host.event('provider.retry', { attempt: message.attempt ?? null, maxRetries: message.max_retries ?? null, delayMs: message.retry_delay_ms ?? null, status: message.error_status ?? null });
          }
        }
        if (!stopped) host.failure(new Error('Claude session stream ended'));
      } catch (error) { if (!stopped) host.failure(error); }
    })();
    let timer;
    try {
      await Promise.race([
        query.initializationResult(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude initialization timed out')), 30_000); }),
      ]);
      if (this.config.managedProfile?.subscription) {
        const account = await query.accountInfo();
        if (!account?.subscriptionType || account.subscriptionType === 'none' || account.apiKeySource && account.apiKeySource !== 'none' || account.apiProvider && account.apiProvider !== 'firstParty') throw new Error('请先在本机 Claude Code 中完成 Claude 订阅登录，不能用 API 密钥替代订阅。');
      }
    } catch (error) { await driver.close(); throw error; }
    finally { clearTimeout(timer); }
    driver.history = async () => {
      if (!driver.nativeId) throw new Error('Claude has not persisted a native session yet');
      return isolatedHome ? isolatedClaudeHistory(isolatedHome, 'messages', driver.nativeId, session.cwd) : sdk.getSessionMessages(driver.nativeId, { dir: session.cwd });
    };
    driver.discover = () => isolatedHome ? isolatedClaudeHistory(isolatedHome, 'list', '', session.cwd) : sdk.listSessions({ dir: session.cwd, limit: 50 });
    return driver;
  }
}
