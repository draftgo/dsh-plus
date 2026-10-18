import { subscriptionTool } from './provider-access.mjs';

/** Credential-free catalog shared by the official picker and native adapters. */
const PREFIX = 'dsh-route-v1:';
const cleanId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
export function encodeRouteModelId(providerId, nativeModelId) {
  if (!cleanId(providerId) || !cleanId(nativeModelId)) throw new Error('Invalid provider/model route');
  return PREFIX + Buffer.from(JSON.stringify([providerId, nativeModelId]), 'utf8').toString('base64url');
}
export function decodeRouteModelId(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  if (value.length > 8192) throw new Error('Invalid provider/model route');
  try {
    const pair = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(cleanId) || encodeRouteModelId(...pair) !== value) throw Error();
    return { providerId: pair[0], model: pair[1] };
  } catch { throw new Error('Invalid provider/model route'); }
}
const positive = value => Number.isSafeInteger(value) && value > 0;
function safeReasoning(value) {
  if (!Array.isArray(value?.efforts)) return undefined;
  const efforts = value.efforts.filter(item => cleanId(item?.id)).map(item => ({ id: item.id, name: cleanId(item.name) ? item.name : item.id, ...(cleanId(item.description) ? { description: item.description } : {}) }));
  return efforts.length ? { efforts, ...(efforts.some(item => item.id === value.defaultEffort) ? { defaultEffort: value.defaultEffort } : {}) } : undefined;
}
export function createPickerCatalog({ commander, installer, profiles, providers, routeService, llm, cacheMs = 5000 } = {}) {
  let installCache, installAt = 0, installationJob, catalogJob;
  const installations = async () => {
    if (installCache && Date.now() - installAt < cacheMs) return installCache;
    if (!installationJob) installationJob = Promise.resolve(installer?.list?.() ?? []).then(rows => { installCache = rows; installAt = Date.now(); return rows; }).finally(() => { installationJob = undefined; });
    return installationJob;
  };
  const capability = tool => { const value = (routeService ?? commander?.routeService)?.supports?.(tool); return tool === 'deepseek' ? { supported: true } : value === true ? { supported: true } : value && typeof value === 'object' ? value : { supported: false }; };
  const supports = tool => capability(tool).supported === true;
  const providerModels = async providerId => {
    const rows = llm?.listModels ? await llm.listModels(providerId) : await providers.models(providerId);
    return Promise.all(rows.filter(row => cleanId(row?.id) && !row.kinds?.length && (!row.inputModalities || row.inputModalities.includes('text'))).map(async row => {
      let resolved = row;
      if (llm?.resolveModelInfo) { try { resolved = { ...row, ...await llm.resolveModelInfo(providerId, row.id) }; } catch { /* Configured directory metadata remains usable. */ } }
      const contextWindow = resolved.context?.contextWindow ?? resolved.contextWindow, reasoning = safeReasoning(resolved.reasoning);
      return { id: row.id, name: cleanId(row.name) ? row.name : row.id, ...(positive(contextWindow) ? { context: { contextWindow } } : {}), ...(reasoning ? { reasoning } : {}) };
    }));
  };
  const build = async () => {
    const [installed, state, configured] = await Promise.all([installations(), profiles?.list?.({ includeNative: false }) ?? {}, providers?.list?.() ?? []]);
    const tools = [{ id: 'deepseek', name: 'DeepSeek', installed: true, chatSupported: true, routeSupported: true }, ...installed.map(tool => ({ id: tool.id, name: tool.name || tool.id, installed: tool.installed === true, chatSupported: tool.chatSupported === true, routeSupported: tool.chatSupported === true && supports(tool.id), ...(!tool.chatSupported ? { routeReason: '此工具暂未接入对话' } : !supports(tool.id) ? { routeReason: capability(tool.id).reason || '此工具暂未支持独立供应商路由，现有本机配置保持不变' } : {}) }))];
    const allowed = new Set(tools.filter(tool => tool.installed && tool.chatSupported && tool.routeSupported).map(tool => tool.id));
    // Match the official provider editor: legacy providers start eligible for
    // all tools. An explicitly saved empty binding remains an intentional opt-out.
    const providerRows = configured.filter(provider => cleanId(provider.id) && !provider.id.startsWith('commander-')).map(provider => {
      const binding = Object.hasOwn(state.bindings ?? {}, provider.id) ? state.bindings[provider.id] : [...allowed];
      const subscribed = provider.authMode === 'subscription', onlyTool = subscriptionTool(provider);
      const eligibility = subscribed ? onlyTool ? [onlyTool] : [] : Array.isArray(binding) ? binding : [];
      return { id: provider.id, name: cleanId(provider.name) ? provider.name : provider.id, ...(provider.declared === true ? { declared: true } : {}), ...(subscribed ? { authMode: 'subscription', harnessTools: onlyTool ? [onlyTool] : [], configured: provider.configured === true, nativeRequired: true, routeReason: provider.routeReason || '请在对应 Harness 工具中使用本机订阅登录。' } : {}), tools: [...new Set(eligibility)].map(tool => tool === 'harness' ? 'deepseek' : tool).filter(tool => allowed.has(tool)) };
    });
    const routes = [];
    await Promise.all(providerRows.map(async provider => {
      if (!provider.tools.length || provider.authMode === 'subscription' && (!provider.configured || !llm?.listModels)) return;
      let rows; try { rows = await providerModels(provider.id); } catch { return; }
      // API adapter effort IDs (including custom wire mappings) are not native
      // CLI capabilities. Native effort stays in the tool's saved quick settings.
      for (const tool of provider.tools) for (const model of rows) routes.push({ tool, providerId: provider.id, providerName: provider.name, modelId: tool === 'deepseek' ? model.id : encodeRouteModelId(provider.id, model.id), nativeModelId: model.id, name: model.name, ...(provider.authMode === 'subscription' ? { authMode: 'subscription' } : {}), ...(model.context ? { context: model.context } : {}), ...(tool === 'deepseek' && model.reasoning ? { reasoning: model.reasoning } : {}) });
    }));
    routes.sort((a, b) => a.tool.localeCompare(b.tool) || a.providerId.localeCompare(b.providerId) || a.nativeModelId.localeCompare(b.nativeModelId));
    return { tools, providers: providerRows, routes };
  };
  // The official catalog asks every native adapter concurrently. Share only
  // in-flight work; the next read still sees current bindings and credentials.
  const list = () => {
    if (!catalogJob) {
      const job = build().finally(() => { if (catalogJob === job) catalogJob = undefined; });
      catalogJob = job;
    }
    return catalogJob.then(value => structuredClone(value));
  };
  return {
    list, decodeModelId: decodeRouteModelId, invalidate() { installCache = undefined; catalogJob = undefined; },
    async models(tool) {
      const catalog = await list();
      return catalog.routes.filter(row => row.tool === tool).map(row => ({ provider: 'commander-' + tool, id: row.modelId, name: row.name, inputModalities: ['text'], providerId: row.providerId, providerName: row.providerName, nativeModelId: row.nativeModelId, ...(row.context ? { context: structuredClone(row.context) } : {}), ...(row.reasoning ? { reasoning: structuredClone(row.reasoning) } : {}) }));
    },
  };
}
