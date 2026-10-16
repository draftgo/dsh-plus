import { LineProcess } from './line-process.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ACP_TOOL_DEFAULTS } from './providers/acp.mjs';

/** Discover models from the installed engine, never from the Harness provider catalog. */
export async function discoverModels(provider, config = {}, cwd = process.cwd()) {
  if (ACP_TOOL_DEFAULTS[provider]) {
    // Never create empty native sessions just to open the model menu.
    const model = config.managedProfile?.model;
    return model ? [{ id: model, name: model }] : [];
  }
  if (provider === 'codex' || provider === 'pi') {
    const pi = provider === 'pi';
    const wire = new LineProcess(config.command ?? provider, [...(config.commandArgs ?? []), ...(pi ? ['--mode', 'rpc', '--no-session'] : ['app-server', '--listen', 'stdio://'])], { cwd, env: config.env, dialect: pi ? 'pi' : 'jsonrpc' });
    try {
      if (!pi) { await wire.request('initialize', { clientInfo: { name: 'commander_models', version: '0.2.0' } }); wire.notify('initialized'); }
      const result = await wire.request(pi ? 'get_available_models' : 'model/list', pi ? {} : { limit: 100 });
      return (pi ? result.models : result.data).map(m => ({ id: pi ? `${m.provider}/${m.id}` : m.model ?? m.id, name: m.displayName ?? m.name ?? m.model ?? m.id, ...(Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}) }));
    } finally { await wire.close(); }
  }
  if (provider === 'claude') {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const controller = new AbortController();
    const q = sdk.query({ prompt: (async function* () { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); })(), options: { cwd, pathToClaudeCodeExecutable: config.command ?? 'claude', env: { ...process.env, ...config.env }, settingSources: ['user', 'project', 'local'] } });
    let timer;
    try {
      const models = await Promise.race([q.supportedModels(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude model discovery timed out')), 30000); })]);
      return models.map(m => ({ id: m.value, name: m.displayName ?? m.value }));
    } finally { clearTimeout(timer); controller.abort(); q.close(); }
  }
  if (provider === 'opencode') {
    const { stdout } = await promisify(execFile)(config.command ?? 'opencode', [...(config.commandArgs ?? []), 'models'], { cwd, env: { ...process.env, ...config.env }, timeout: 30000, maxBuffer: 1024 * 1024 });
    return stdout.split('\n').map(s => s.trim()).filter(s => /^[\w.-]+\/\S+$/.test(s)).map(id => ({ id, name: id }));
  }
  throw new Error(`Unknown provider: ${provider}`);
}
