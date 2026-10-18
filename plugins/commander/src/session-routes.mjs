import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { resolve, join, dirname, parse } from 'node:path';
import { validateQuickSettings, quickSettingsPatches } from '../shared/tool-quick-settings.mjs';
import { assertProviderToolAccess } from './provider-access.mjs';

const supported = new Set(['codex', 'claude']);
export const sessionRouteSupport = tool => supported.has(tool) ? { supported: true } : { supported: false, reason: '此工具尚未验证会话配置与历史隔离，请使用原生配置模式。' };
const fail = message => { const error = new Error(message); error.code = 'SESSION_ROUTE'; throw error; };
const text = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f]/u.test(value)) fail('无效的' + label); return value.trim(); };
const endpoint = value => { let url; try { url = new URL(value); } catch { fail('供应商地址无效'); } if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('供应商地址无效'); return url.href.replace(/\/$/u, ''); };
const fingerprint = route => createHash('sha256').update(JSON.stringify([route.tool, route.providerId, route.model, route.baseURL, route.protocol, route.sourceProtocol ?? null, route.credentialRef ?? null, ...(route.mode === 'subscription' ? ['subscription'] : []), ...(route.quickSettings && Object.keys(route.quickSettings).length ? [route.quickSettings] : [])])).digest('hex');
const configArgs = config => {
  const flatten = (value, path = []) => Object.entries(value).flatMap(([key, child]) => child && typeof child === 'object' ? flatten(child, [...path, key]) : [[...path, key].join('.') + '=' + JSON.stringify(child)]);
  return flatten(config).flatMap(value => ['-c', value]);
};
async function privateDirectory(directory) {
  const target = resolve(directory); let part = target;
  while (part !== parse(part).root) { try { if ((await lstat(part)).isSymbolicLink()) fail('隔离目录不能经过符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; } part = dirname(part); }
  await mkdir(target, { recursive: true, mode: 0o700 }); await chmod(target, 0o700); return target;
}
export function createSessionRoutes({ directory, providers, profiles } = {}) {
  if (!directory || !providers?.resolve) throw new TypeError('directory and providers.resolve are required');
  const describe = async providerId => { try { return await (providers.describeRoute ? providers.describeRoute(providerId) : providers.resolve(providerId)); } catch { fail('无法读取绑定供应商，请检查供应商配置。'); } };
  const checkBinding = async (tool, providerId) => {
    const access = await providers.describeAccess?.(providerId);
    assertProviderToolAccess(access, tool);
    if (profiles?.list) {
      const { bindings } = await profiles.list({ includeNative: false });
      if (bindings?.[providerId] && !bindings[providerId].includes(tool)) fail('此供应商未授权用于当前工具。');
    }
    return access;
  };
  const descriptor = (tool, providerId, model, value, requestedProtocol) => {
    const protocol = tool === 'codex' ? 'responses' : 'anthropic';
    const aliases = { 'openai-responses': 'responses', 'anthropic-messages': 'anthropic' };
    if (requestedProtocol && (aliases[requestedProtocol] || requestedProtocol) !== protocol) fail('所选协议不适用于此工具。');
    return { version: 1, mode: 'managed', tool, providerId, model, baseURL: endpoint(value.baseURL), protocol, ...(value.protocol ? { sourceProtocol: text(value.protocol, '供应商协议') } : {}), ...(value.credentialRef ? { credentialRef: text(value.credentialRef, '凭据引用') } : {}) };
  };
  return {
    supports: sessionRouteSupport,
    async capture({ tool, providerId, model, protocol, overrides, quickSettings } = {}) {
      if (!sessionRouteSupport(tool).supported) fail(sessionRouteSupport(tool).reason);
      if (overrides && Object.keys(overrides).length) fail('会话隔离暂不支持高级配置覆盖；请移除覆盖项后重试。');
      providerId = text(providerId, '供应商'); model = text(model, '模型');
      const access = await checkBinding(tool, providerId);
      if (access?.authMode === 'subscription' && access.configured !== true) fail('请先完成对应供应商及 Harness 工具的订阅登录。');
      const route = access?.authMode === 'subscription'
        ? { version: 1, mode: 'subscription', tool, providerId, model }
        : descriptor(tool, providerId, model, await describe(providerId), protocol);
      const settings = validateQuickSettings(tool, quickSettings);
      if (Object.keys(settings).length) route.quickSettings = settings;
      return { ...route, revision: randomUUID(), fingerprint: fingerprint(route) };
    },
    async launch({ tool, route, sessionId } = {}) {
      if (!sessionRouteSupport(tool).supported) fail(sessionRouteSupport(tool).reason);
      if (!route || route.tool !== tool || !['managed', 'subscription'].includes(route.mode) || route.version !== 1 || fingerprint(route) !== route.fingerprint || !/^[a-f0-9-]{36}$/iu.test(sessionId || '')) fail('会话绑定无效，拒绝使用当前默认配置替代。');
      const access = await checkBinding(tool, route.providerId);
      if (route.mode === 'subscription') {
        if (access?.authMode !== 'subscription' || access.configured !== true) fail('绑定供应商的订阅登录已失效，请重新登录。');
        const quick = quickSettingsPatches(tool, route.quickSettings), managedProfile = { configured: true, isolated: false, subscription: true, providerId: route.providerId, model: route.model };
        if (tool === 'codex') return { managedProfile, commandArgs: [...configArgs({ ...quick.config, model: route.model, model_provider: 'openai', force_login_method: 'chatgpt' }), '-c', 'model_providers.openai={name="OpenAI",base_url="https://api.openai.com/v1",wire_api="responses",requires_openai_auth=true}'], env: { OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined, CODEX_API_KEY: undefined, DSH_PLUS_SESSION_API_KEY: undefined } };
        const env = { ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: route.model, ANTHROPIC_DEFAULT_SONNET_MODEL: undefined, ANTHROPIC_DEFAULT_OPUS_MODEL: undefined, ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined, CLAUDE_CODE_SUBAGENT_MODEL: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined, ...quick.settings?.env };
        return { managedProfile, env, settings: { ...quick.settings, forceLoginMethod: 'claudeai', model: route.model, env }, settingSources: [] };
      }
      const value = await describe(route.providerId), current = descriptor(tool, route.providerId, route.model, value);
      if (route.quickSettings && Object.keys(route.quickSettings).length) current.quickSettings = validateQuickSettings(tool, route.quickSettings);
      if (fingerprint(current) !== route.fingerprint) fail('绑定供应商的地址、协议或凭据引用已更改，请新建会话或恢复原配置。');
      if (typeof value.apiKey !== 'string' || !value.apiKey || /[\r\n\u0000]/u.test(value.apiKey)) fail('绑定供应商没有可用密钥。');
      const quick = quickSettingsPatches(tool, route.quickSettings);
      const root = await privateDirectory(join(directory, 'managed-runs')), run = await privateDirectory(join(root, sessionId));
      const managedProfile = { configured: true, isolated: true, providerId: route.providerId, model: route.model, directory: run };
      if (tool === 'codex') {
        const home = await privateDirectory(join(run, 'codex'));
        const providerId = 'dsh_plus_' + sessionId.replaceAll('-', '');
        const providerConfig = '{name="DSH-Plus Session",base_url=' + JSON.stringify(route.baseURL) + ',wire_api="responses",env_key="DSH_PLUS_SESSION_API_KEY",requires_openai_auth=false}';
        const overrides = { model: route.model, model_provider: providerId };
        const quickArgs = configArgs(quick.config || {});
        const commandArgs = [...quickArgs, ...Object.entries(overrides).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]), '-c', 'model_providers.' + providerId + '=' + providerConfig];
        return { env: { CODEX_HOME: home, DSH_PLUS_SESSION_API_KEY: value.apiKey }, commandArgs, managedProfile };
      }
      const home = await privateDirectory(join(run, 'claude'));
      const env = { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_API_KEY_HELPER_TTL_MS: undefined, ANTHROPIC_BASE_URL: route.baseURL, ANTHROPIC_AUTH_TOKEN: value.apiKey, ANTHROPIC_API_KEY: value.apiKey, ANTHROPIC_MODEL: route.model, ANTHROPIC_DEFAULT_SONNET_MODEL: route.model, ANTHROPIC_DEFAULT_OPUS_MODEL: route.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: route.model, CLAUDE_CODE_SUBAGENT_MODEL: route.model };
      Object.assign(env, quick.settings?.env);
      const settings = { ...quick.settings, env, model: route.model };
      return { env, settings, settingSources: [], managedProfile };
    },
  };
}
