const activeStates = new Set(['queued', 'running']);
const roleNames = new Set(['config', 'settings', 'auth', 'profile', 'meta']);
export const jobLabels = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
export function activeJob(job) { return !!job && activeStates.has(job.status); }
export function toolState(tool, capability = {}) {
  return {
    installed: !!tool.installed,
    installation: tool.installed ? (tool.source === 'managed' ? '插件管理' : '外部安装') : '未安装',
    configSupported: capability.configSupported ?? tool.configSupported ?? false,
    chatSupported: capability.sessionSupported ?? tool.chatSupported ?? false,
    canInstall: !!tool.canInstall && !activeJob(tool.job),
    canUninstall: !!tool.canUninstall && !activeJob(tool.job),
  };
}
export function parseOverrides(text) {
  let value;
  try { value = JSON.parse(text || '{}'); } catch { throw Error('高级配置必须是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('高级配置必须是 JSON 对象');
  for (const key of Object.keys(value)) if (!roleNames.has(key)) throw Error('配置顶层仅支持 config、settings、auth、profile、meta');
  const walk = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('高级配置含不安全字段');
      if (/(?:api.?key|(?:auth|access|bearer|refresh|id)[_-]?token|^token$|secret|password|authorization|credential|base.?url|endpoint|url|headers|^env$|command|executable)/i.test(key)) throw Error('密钥、地址、环境和执行入口请在官方供应商设置中维护');
      walk(child);
    }
  };
  walk(value); return value;
}
export function profileDraft(profile) { return { providerId: profile?.providerId || '', model: profile?.model || '', protocol: profile?.protocol || '', overrides: JSON.stringify(profile?.overrides || {}, null, 2), revision: profile?.revision }; }
export function eligibleProviders(providers, bindings, tool) { return providers.filter(provider => !Array.isArray(bindings?.[provider.id]) || bindings[provider.id].includes(tool)); }
export function previewChecksums(preview) { return Object.fromEntries((preview?.files || []).map(file => [file.path, file.checksum ?? null])); }
