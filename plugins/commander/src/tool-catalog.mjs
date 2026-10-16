/** Fixed sources audited against CC Switch 51ac86f. */
const npm = (id, name, packageName, command = id, extra = {}) => ({ id, name, command, packageName, installer: 'npm', platforms: ['linux', 'darwin', 'win32'], configSupported: true, chatSupported: ['claude', 'codex', 'pi', 'opencode', 'gemini', 'hermes', 'grok', 'mcode'].includes(id), ...extra });
export const TOOL_CATALOG = Object.freeze([
  npm('claude', 'Claude Code', '@anthropic-ai/claude-code', 'claude', { installArgs: ['--ignore-scripts=false', '--allow-scripts=@anthropic-ai/claude-code'] }),
  { id: 'claude-desktop', name: 'Claude Desktop', command: null, installer: null, platforms: ['darwin', 'win32'], configSupported: true, chatSupported: false, installReason: 'Claude Desktop 使用官方图形安装器；当前不提供自动安装或卸载。' },
  npm('codex', 'Codex', '@openai/codex'),
  npm('gemini', 'Gemini CLI', '@google/gemini-cli'),
  npm('grok', 'Grok Build', '@xai-official/grok'),
  npm('opencode', 'OpenCode', 'opencode-ai'),
  npm('openclaw', 'OpenClaw', 'openclaw'),
  { id: 'hermes', name: 'Hermes', command: 'hermes', installer: 'uv', platforms: ['linux', 'darwin'], configSupported: true, chatSupported: true, source: 'git+https://github.com/NousResearch/hermes-agent.git' },
  npm('pi', 'Pi', '@earendil-works/pi-coding-agent'),
  npm('mcode', 'MiniMax Code', '@minimax-ai/code', 'mcode', { configSupported: true, installArgs: ['--ignore-scripts=false', '--allow-scripts=@minimax-ai/code,better-sqlite3'] }),
].map(tool => Object.freeze({ ...tool, platforms: Object.freeze([...tool.platforms]), installArgs: Object.freeze([...(tool.installArgs ?? [])]) })));
const aliases = { grokbuild: 'grok', 'grok-build': 'grok', minimax: 'mcode', 'minimax-code': 'mcode', 'claude-code': 'claude' };
export function normalizeToolId(value) {
  if (typeof value !== 'string') throw new Error('Invalid tool id');
  const id = Object.hasOwn(aliases, value) ? aliases[value] : value;
  if (!TOOL_CATALOG.some(tool => tool.id === id)) throw new Error('Unknown tool: ' + String(value).slice(0, 80));
  return id;
}
export function getTool(value) { return TOOL_CATALOG.find(tool => tool.id === normalizeToolId(value)); }
