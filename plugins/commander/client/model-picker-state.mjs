const list = value => Array.isArray(value) ? value : [];
export const builtinTool = { id: 'deepseek', name: 'DeepSeek', installed: true, chatSupported: true, routeSupported: true };
export function availableTools(catalog) {
  const seen = new Set(['deepseek']);
  return [builtinTool, ...list(catalog?.tools).filter(tool => {
    if (!tool?.id || seen.has(tool.id) || !tool.installed || !tool.chatSupported) return false;
    seen.add(tool.id); return true;
  })];
}
export function currentToolId(provider) { return typeof provider === 'string' && provider.startsWith('commander-') ? provider.slice('commander-'.length) : 'deepseek'; }
/** Retain a prior choice only while the exact model still advertises it. */
export function selectionReasoningEffort(provider, model, current, requested) {
  const supported = effort => model.reasoning?.efforts?.some(entry => entry.id === effort);
  if (requested !== undefined) {
    if (!supported(requested)) throw Error('该模型不支持所选思考强度，请重新选择');
    return requested;
  }
  if (current?.provider === provider && current.model === model.id && supported(current.reasoningEffort)) return current.reasoningEffort;
  return supported(model.reasoning?.defaultEffort) ? model.reasoning.defaultEffort : undefined;
}
/** Route IDs are opaque; metadata determines provider ownership. */
export function providersForTool(groups, catalog, tool) {
  const result = new Map();
  const add = (id, name, group, model, nativeModelId) => {
    if (!result.has(id)) result.set(id, { id, name: name || id, models: [] });
    const entry = result.get(id);
    if (!entry.models.some(item => item.group.id === group.id && item.model.id === model.id)) entry.models.push({ group, model, nativeModelId });
  };
  for (const group of list(groups)) {
    if (tool === 'deepseek') {
      if (group.id.startsWith('commander-')) continue;
      for (const model of list(group.models)) add(group.id, group.name, group, model, model.id);
      if (!list(group.models).length) result.set(group.id, { id: group.id, name: group.name || group.id, models: [] });
    } else if (group.id === 'commander-' + tool) {
      for (const route of list(catalog?.routes).filter(route => route.tool === tool)) {
        const model = list(group.models).find(model => model.id === route.modelId);
        if (model) add(route.providerId, route.providerName, group, model, route.nativeModelId);
      }
    }
  }
  return [...result.values()].map(entry => {
    const identity = list(catalog?.providers).find(provider => provider.id === entry.id);
    return identity?.declared === true ? { ...entry, declared: true } : entry;
  });
}
