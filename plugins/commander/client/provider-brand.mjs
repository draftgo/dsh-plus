const aliases = { 'deepseek-account': 'deepseek', 'deepseek-api': 'deepseek', 'openai-api': 'openai', claude: 'anthropic', 'anthropic-api': 'anthropic', gemini: 'google', 'google-gemini': 'google', 'google-generative-ai': 'google', 'google-vertex': 'google', dashscope: 'qwen', alibaba: 'qwen', zai: 'zhipu', 'z-ai': 'zhipu', moonshot: 'kimi', mimo: 'xiaomimimo' };
const known = new Set(['deepseek', 'openai', 'anthropic', 'google', 'openrouter', 'siliconflow', 'qwen', 'zhipu', 'minimax', 'stepfun', 'xiaomimimo', 'kimi', 'mistral', 'ollama', 'xai']);
/** Exact registered identities only: a custom route is never guessed from its display name. */
export function providerBrand(id, declared = false) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (key === 'deepseek-official') return 'deepseek';
  if (declared) return null;
  return aliases[key] || (known.has(key) ? key : null);
}
export function providerInitial(name, id) {
  const text = String(name || id || '?').trim();
  return Array.from(text)[0]?.toLocaleUpperCase() || '?';
}
