import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as TOML from 'smol-toml';
import { parseDocument } from 'yaml';
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser';
import JSON5 from 'json5';

export class ToolConfigError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const TOOL_IDS = ['claude', 'claude-desktop', 'codex', 'gemini', 'grok', 'opencode', 'openclaw', 'hermes', 'pi', 'mcode'];
const protocols = { claude: ['anthropic'], 'claude-desktop': ['anthropic'], codex: ['responses'], gemini: ['gemini'], grok: ['responses', 'openai'], opencode: ['openai', 'anthropic', 'responses'], openclaw: ['openai', 'anthropic', 'responses'], hermes: ['openai', 'anthropic', 'responses'], pi: ['openai', 'anthropic', 'responses'], mcode: ['anthropic', 'openai', 'responses'] };
export const toolCapabilities = () => TOOL_IDS.map(tool => ({ tool, configSupported: true, sessionSupported: ['claude', 'codex', 'pi', 'opencode', 'gemini', 'hermes', 'grok', 'mcode'].includes(tool), protocols: protocols[tool], modelSelection: tool !== 'mcode' }));
export function toolId(value) { const id = ({ grokbuild: 'grok', 'grok-build': 'grok', minimax: 'mcode', 'minimax-code': 'mcode', claudecode: 'claude' })[value] || value; if (!TOOL_IDS.includes(id)) throw new ToolConfigError('不支持的工具'); return id; }
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
export function validateObject(value, { overrides = false } = {}, depth = 0) {
  if (depth > 24) throw new ToolConfigError('配置嵌套过深');
  if (Array.isArray(value)) { for (const x of value) validateObject(x, { overrides }, depth + 1); return; }
  if (!plain(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ToolConfigError('配置含不安全字段');
    if (overrides && /(?:api.?key|(?:auth|access|bearer|refresh|id)[_-]?token|^token$|secret|password|authorization|credential|base.?url|endpoint|url|headers|^env$|command|executable)/iu.test(key)) throw new ToolConfigError('高级配置不能保存密钥、端点或执行入口，请引用官方供应商');
    validateObject(child, { overrides }, depth + 1);
  }
}
export function mergeConfig(target, patch) {
  validateObject(patch);
  for (const [key, value] of Object.entries(patch)) {
    if (plain(value)) { if (target[key] !== undefined && !plain(target[key])) throw new ToolConfigError('配置结构冲突，请检查高级配置'); target[key] ??= {}; mergeConfig(target[key], value); }
    else if (Array.isArray(value) && Array.isArray(target[key]) && value.every(item => plain(item) && typeof item.id === 'string')) {
      const previous = target[key]; target[key] = previous.map(item => structuredClone(item));
      for (const item of value) { const index = target[key].findIndex(old => old?.id === item.id); if (index < 0) target[key].push(structuredClone(item)); else mergeConfig(target[key][index], item); }
    } else target[key] = structuredClone(value);
  }
  return target;
}
const file = (role, path, format) => ({ role, path, format });
export function nativeConfigFiles(tool, { home = homedir(), env = process.env, platform = process.platform } = {}) {
  tool = toolId(tool); const config = env.XDG_CONFIG_HOME || join(home, '.config');
  switch (tool) {
    case 'claude': return [file('settings', join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'), 'jsonc')];
    case 'codex': return [file('config', join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), 'toml')];
    case 'gemini': { const dir = env.GEMINI_CLI_HOME ? join(env.GEMINI_CLI_HOME, '.gemini') : join(home, '.gemini'); return [file('settings', join(dir, 'settings.json'), 'jsonc'), file('env', join(dir, '.env'), 'env')]; }
    case 'grok': return [file('config', join(env.GROK_HOME || join(home, '.grok'), 'config.toml'), 'toml')];
    case 'opencode': { const dir = env.OPENCODE_CONFIG_DIR || join(config, 'opencode'); return [file('config', env.OPENCODE_CONFIG || join(dir, existsSync(join(dir, 'opencode.jsonc')) ? 'opencode.jsonc' : 'opencode.json'), 'jsonc')]; }
    case 'openclaw': return [file('config', env.OPENCLAW_CONFIG_PATH || join(env.OPENCLAW_STATE_DIR || join(home, '.openclaw'), 'openclaw.json'), 'json5')];
    case 'hermes': return [file('config', join(env.HERMES_HOME?.trim() || (platform === 'win32' ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'hermes') : join(home, '.hermes')), 'config.yaml'), 'yaml')];
    case 'pi': { const dir = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'); return [file('config', join(dir, 'models.json'), 'jsonc'), file('settings', join(dir, 'settings.json'), 'jsonc')]; }
    case 'mcode': return [file('config', join(env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR || join(home, '.minimax'), 'config.yaml'), 'yaml')];
    case 'claude-desktop': { const root = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'win32' ? env.LOCALAPPDATA || join(home, 'AppData', 'Local') : config; const dir = join(root, 'Claude-3p', 'configLibrary'); return [file('settings', join(root, 'Claude', 'claude_desktop_config.json'), 'jsonc'), file('config', join(root, 'Claude-3p', 'claude_desktop_config.json'), 'jsonc'), file('profile', join(dir, '36da542a-1436-49c2-8426-66287831dc66.json'), 'jsonc'), file('meta', join(dir, '_meta.json'), 'jsonc')]; }
  }
}
const api = protocol => ({ openai: 'openai-completions', responses: 'openai-responses', anthropic: 'anthropic-messages' })[protocol];
export function nativePatches(profile, provider, current = {}) {
  const tool = toolId(profile.tool), protocol = profile.protocol || protocols[tool][0];
  if (!protocols[tool].includes(protocol)) throw new ToolConfigError('工具不支持此 API 协议');
  const { baseURL, apiKey } = provider, model = profile.model, id = 'dsh-plus', node = { id: model, name: model }; let patches;
  switch (tool) {
    case 'claude': patches = { settings: { env: { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_MODEL: model } } }; break;
    case 'codex': patches = { config: { model, model_provider: id, model_providers: { [id]: { name: 'DSH-Plus', base_url: baseURL, wire_api: 'responses', requires_openai_auth: false, experimental_bearer_token: apiKey } } } }; break;
    case 'gemini': patches = { settings: { security: { auth: { selectedType: 'gemini-api-key' } }, model: { name: model } }, env: { GEMINI_API_KEY: apiKey, GOOGLE_GEMINI_BASE_URL: baseURL, GEMINI_MODEL: model } }; break;
    case 'grok': patches = { config: { models: { default: id }, model: { [id]: { model, name: model, base_url: baseURL, api_key: apiKey, api_backend: protocol === 'openai' ? 'chat_completions' : 'responses', context_window: profile.contextWindow || 500000 } } } }; break;
    case 'opencode': patches = { config: { model: id + '/' + model, provider: { [id]: { npm: protocol === 'anthropic' ? '@ai-sdk/anthropic' : protocol === 'responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible', name: 'DSH-Plus', options: { baseURL, apiKey }, models: { [model]: { name: model } } } } } }; break;
    case 'openclaw': patches = { config: { models: { mode: 'merge', providers: { [id]: { baseUrl: baseURL, apiKey, api: api(protocol), models: [node] } } }, agents: { defaults: { model: { primary: id + '/' + model } } } } }; break;
    case 'hermes': { const providers = current.config?.custom_providers || []; if (!Array.isArray(providers)) throw new ToolConfigError('Hermes custom_providers 应为数组'); const entry = mergeConfig(structuredClone(providers.find(x => x.name === id) || {}), { name: id, base_url: baseURL, api_key: apiKey, model, models: { [model]: {} }, api_mode: protocol === 'responses' ? 'codex_responses' : protocol === 'anthropic' ? 'anthropic_messages' : 'chat_completions' }); patches = { config: { model: { provider: id, default: model, base_url: baseURL }, custom_providers: [...providers.filter(x => x.name !== id), entry] } }; break; }
    case 'pi': patches = { config: { providers: { [id]: { baseUrl: baseURL, apiKey, api: api(protocol), models: [node] } } }, settings: { defaultProvider: id, defaultModel: model } }; break;
    case 'mcode': patches = { config: { custom_provider: { [id]: { kind: 'custom', name: 'DSH-Plus', api: api(protocol), options: { baseURL, apiKey }, models: { [model]: { name: model } } } } } }; break;
    case 'claude-desktop': { const profileId = '36da542a-1436-49c2-8426-66287831dc66', entries = current.meta?.entries || []; if (!Array.isArray(entries)) throw new ToolConfigError('Desktop entries 应为数组'); patches = { settings: { deploymentMode: '3p' }, config: { deploymentMode: '3p' }, profile: { inferenceGatewayApiKey: apiKey, inferenceGatewayAuthScheme: 'bearer', inferenceGatewayBaseUrl: baseURL, inferenceProvider: 'gateway', inferenceModels: [{ name: model }] }, meta: { entries: [...entries.filter(x => x.id !== profileId), mergeConfig(structuredClone(entries.find(x => x.id === profileId) || {}), { id: profileId, name: 'DSH-Plus' })], appliedId: profileId } }; break; }
  }
  for (const [role, patch] of Object.entries(profile.overrides || {})) { if (!patches[role]) throw new ToolConfigError('无效的配置文件角色'); mergeConfig(patches[role], patch); }
  return patches;
}
export function parseConfig(raw, format) {
  try { let value;
    if (format === 'toml') value = TOML.parse(raw);
    else if (format === 'yaml') { const doc = parseDocument(raw, { uniqueKeys: true }); if (doc.errors.length) throw Error(); value = doc.toJS({ maxAliasCount: 50 }) ?? {}; }
    else if (format === 'jsonc') { const errors = []; value = raw.trim() ? parseJsonc(raw, errors, { allowTrailingComma: true }) : {}; if (errors.length) throw Error(); }
    else if (format === 'json5') value = raw.trim() ? JSON5.parse(raw) : {};
    else return {};
    if (!plain(value)) throw Error(); validateObject(value); return value;
  } catch { throw new ToolConfigError('原生配置格式无效，请先修复文件', 409); }
}
export function renderConfig(raw, format, patch) {
  const current = parseConfig(raw, format), merged = mergeConfig(structuredClone(current), patch);
  const preserveArrays = (value, before) => { for (const [key, child] of Object.entries(value)) { if (Array.isArray(child)) value[key] = mergedValue(before, key, child); else if (plain(child)) preserveArrays(child, before?.[key]); } };
  const mergedValue = (before, key, child) => Array.isArray(child) && child.every(item => plain(item) && typeof item.id === 'string') ? mergeConfig({ value: structuredClone(before?.[key] || []) }, { value: child }).value : child;
  patch = structuredClone(patch); preserveArrays(patch, current);
  if (format === 'env') { const remaining = { ...patch }, lines = raw.split(/\r?\n/u).map(line => { const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u); if (!match || !Object.hasOwn(patch, match[1])) return line; delete remaining[match[1]]; return match[1] + '=' + JSON.stringify(String(patch[match[1]])); }); for (const [key, value] of Object.entries(remaining)) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value === 'object') throw new ToolConfigError('无效的环境配置'); lines.push(key + '=' + JSON.stringify(String(value))); } return lines.join('\n').replace(/\n*$/u, '\n'); }
  if (format === 'toml') return TOML.stringify(merged);
  if (format === 'json5') return JSON.stringify(merged, null, 2) + String.fromCharCode(10);
  if (format === 'yaml') { const doc = parseDocument(raw || '{}\n', { uniqueKeys: true }); const visit = (value, path = []) => { for (const [key, child] of Object.entries(value)) { const next = [...path, key]; if (plain(child)) { if (!Object.keys(child).length && !doc.hasIn(next)) doc.setIn(next, {}); else visit(child, next); } else doc.setIn(next, child); } }; visit(patch); return doc.toString(); }
  let result = raw.trim() ? raw : '{}\n'; const visit = (value, path = []) => { for (const [key, child] of Object.entries(value)) { const next = [...path, key]; if (plain(child) && Object.keys(child).length) visit(child, next); else result = applyEdits(result, modify(result, next, child, { formattingOptions: { insertSpaces: true, tabSize: 2 } })); } }; visit(patch); parseConfig(result, format); return result;
}
