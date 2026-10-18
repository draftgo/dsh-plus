export function nativeActivityLabel(event) {
  if (event.type === 'tool.output') return { label: '命令输出', detail: String(event.data?.text || '').trim().slice(-180), state: 'running' };
  if (event.type !== 'item') return null;
  const item = event.data?.item || event.data?.part || event.data;
  const type = item?.type || item?.kind;
  const phase = event.data?.phase || event.data?.delta?.type;
  if (/reasoning|thought/i.test(type || '')) return { label: '正在思考', detail: '', state: 'running' };
  if (/commandExecution|command_execution|tool_call|mcpTool|webSearch|image|browser/i.test(type || '')) {
    const command = item.command || item.rawInput || item.input || item.title || '';
    const done = /completed|end|update/i.test(phase || '') || /completed|success|failed/i.test(item.status || '');
    const name = /commandExecution|command_execution/i.test(type) ? '命令' : /file/i.test(type) ? '文件操作' : /mcp/i.test(type) ? 'MCP 工具' : /webSearch|browser/i.test(type) ? '网页搜索' : /image/i.test(type) ? '图像工具' : '工具';
    return { label: done ? `${name}已完成` : `正在调用${name}`, detail: typeof command === 'string' ? command.slice(0, 180) : JSON.stringify(command).slice(0, 180), state: done ? 'done' : 'running' };
  }
  if (/fileChange|file_change/i.test(type || '')) return { label: '文件变更', detail: String(item.title || item.status || '').slice(0, 180), state: 'running' };
  return null;
}
