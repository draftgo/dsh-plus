// Explicit, credential-free settings shared by the editor and launch adapters.
const choices = values => values.map(value => ({ value, label: value }));
const field = (key, label, type, path, options = {}) => ({ key, label, type, group: '快捷配置', role: 'config', path, ...options });
const claude = [
  field('agentTeams', '多 Agent 协作', 'boolean', ['env', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'], { role: 'settings', group: '通用配置', description: '开启 Claude Code 实验性 Agent Teams；由工具版本决定是否支持。' }),
  field('agentWindow', 'Agent 窗口', 'select', ['teammateMode'], { role: 'settings', group: '通用配置', options: [{ value: 'in-process', label: '当前进程' }, { value: 'auto', label: '自动' }, { value: 'tmux', label: 'tmux 分屏' }, { value: 'iterm2', label: 'iTerm2 分屏' }], description: '分屏模式需要本机相应终端支持。' }),
  field('thinking', '扩展思考', 'boolean', ['alwaysThinkingEnabled'], { role: 'settings' }),
  field('effort', '推理强度', 'select', ['effortLevel'], { role: 'settings', options: choices(['low', 'medium', 'high', 'xhigh']) }),
  field('disableHooks', '禁用 Hooks', 'boolean', ['disableAllHooks'], { role: 'settings' }),
];
const schema = {
  claude,
  codex: [
    field('multiAgent', '多 Agent 协作', 'boolean', ['features', 'multi_agent'], { group: '通用配置' }),
    field('agentThreads', '并发 Agent 数', 'number', ['agents', 'max_threads'], { group: '通用配置', min: 1, max: 32 }),
    field('agentDepth', 'Agent 最大深度', 'number', ['agents', 'max_depth'], { group: '通用配置', min: 1, max: 8 }),
    field('effort', '推理强度', 'select', ['model_reasoning_effort'], { options: choices(['minimal', 'low', 'medium', 'high', 'xhigh']) }),
    field('contextWindow', '上下文窗口', 'number', ['model_context_window'], { min: 1024, max: 10000000 }),
    field('compactLimit', '自动压缩阈值', 'number', ['model_auto_compact_token_limit'], { min: 1024, max: 10000000 }),
  ],
  gemini: [
    field('previewFeatures', '预览功能', 'boolean', ['general', 'previewFeatures'], { role: 'settings' }),
    field('promptCompletion', '提示词自动补全', 'boolean', ['general', 'enablePromptCompletion'], { role: 'settings' }),
    field('maxTurns', '会话最大轮数', 'number', ['model', 'maxSessionTurns'], { role: 'settings', min: 1, max: 10000 }),
  ],
  opencode: [
    field('autoUpdate', '自动更新', 'boolean', ['autoupdate']),
    field('snapshot', '文件快照', 'boolean', ['snapshot']),
    field('share', '会话分享', 'select', ['share'], { options: [{ value: 'disabled', label: '关闭' }, { value: 'manual', label: '手动' }, { value: 'auto', label: '自动' }] }),
  ],
  openclaw: [
    field('concurrency', '并发 Agent 数', 'number', ['agents', 'defaults', 'maxConcurrent'], { group: '通用配置', min: 1, max: 32 }),
    field('contextWindow', '上下文窗口', 'number', ['agents', 'defaults', 'contextTokens'], { min: 1024, max: 10000000 }),
  ],
  pi: [
    field('thinking', '思考级别', 'select', ['defaultThinkingLevel'], { role: 'settings', options: choices(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) }),
    field('compaction', '自动压缩', 'boolean', ['compaction', 'enabled'], { role: 'settings' }),
    field('retry', '失败重试', 'boolean', ['retry', 'enabled'], { role: 'settings' }),
  ],
  hermes: [
    field('maxTurns', 'Agent 最大轮数', 'number', ['agent', 'max_turns'], { min: 1, max: 10000 }),
    field('effort', '推理强度', 'select', ['agent', 'reasoning_effort'], { options: choices(['low', 'medium', 'high']) }),
  ],
  grok: [
    field('contextWindow', '上下文窗口', 'number', ['model', 'dsh-plus', 'context_window'], { min: 1024, max: 10000000 }),
  ],
};
export function quickSettingsFor(tool) { return structuredClone(schema[tool] || []); }
export function validateQuickSettings(tool, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('快捷配置必须为对象');
  const fields = schema[tool] || [], result = {};
  for (const [key, value] of Object.entries(input)) {
    const spec = fields.find(item => item.key === key);
    if (!spec) throw new Error('此工具不支持快捷配置：' + key);
    if (spec.type === 'boolean' && typeof value !== 'boolean' || spec.type === 'select' && !spec.options.some(option => option.value === value) || spec.type === 'number' && (!Number.isSafeInteger(value) || value < spec.min || value > spec.max)) throw new Error('无效的快捷配置：' + spec.label);
    result[key] = value;
  }
  if (result.compactLimit && result.contextWindow && result.compactLimit > result.contextWindow) throw new Error('自动压缩阈值不能超过上下文窗口');
  return result;
}
export function quickSettingsPatches(tool, input = {}) {
  const values = validateQuickSettings(tool, input), result = {};
  for (const spec of schema[tool] || []) {
    if (!Object.hasOwn(values, spec.key)) continue;
    let target = result[spec.role] ??= {};
    for (const key of spec.path.slice(0, -1)) target = target[key] ??= {};
    target[spec.path.at(-1)] = spec.key === 'agentTeams' ? (values[spec.key] ? '1' : '0') : values[spec.key];
  }
  return result;
}
