/** Authentication evidence is supplied by the official provider credential seam. */
const subscriptionTools = new Map([['openai-codex', 'codex'], ['anthropic', 'claude'], ['google-gemini-cli', 'gemini']]);
export const subscriptionHarnessTool = id => subscriptionTools.get(id);
export function subscriptionTool(provider) {
  return provider?.authMode === 'subscription' && Array.isArray(provider.harnessTools) && provider.harnessTools.length === 1 ? provider.harnessTools[0] : undefined;
}
export function assertProviderToolAccess(provider, tool) {
  if (!provider || provider.authMode !== 'subscription') return;
  const requested = tool === 'deepseek' ? 'harness' : tool;
  if (!provider.harnessTools?.includes(requested)) throw Object.assign(new Error('此订阅登录仅允许使用对应的 Harness 工具，不能转用于其他工具。'), { status: 409, code: 'SUBSCRIPTION_TOOL_MISMATCH' });
}
