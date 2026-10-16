import { harnessSelection } from './harness-selection.mjs';
/** Native commands use the official Harness command UI and human-only result cards. */
export function mountHarnessCommands(ctx, commander, { bindOwner } = {}) {
  ctx.effect(() => ctx.commands.register({
    name: 'native',
    description: '查看或执行当前编码工具的原生命令',
    input: { hint: '命令名与参数；留空查看可用命令' },
    async handler(invocation) {
      const { agent, signal, commandId } = invocation;
      const selection = harnessSelection(ctx, agent);
      const provider = selection.provider?.replace(/^commander-/, '');
      if (!selection.provider?.startsWith('commander-')) return { kind: 'error', text: '请先在模型菜单中选择 Codex、Claude Code、Pi 或 OpenCode。' };
      const id = String(agent.session.id);
      const model = selection.model;
      const session = commander.list().find(s => s.ownerSessionId === id && (!s.parentId || s.harnessAdopted) && !s.archived && s.provider === provider && (s.model || 'native-default') === model);
      if (!session) return { kind: 'error', text: '先发送一条消息建立原生会话，再使用 /native。' };
      bindOwner?.(session.id, agent);
      signal.throwIfAborted();
      if (['disconnected', 'closed', 'failed'].includes(session.status)) await commander.connect(session.id);
      const line = invocation.rawInput.trim();
      if (!line) {
        const catalog = await commander.commands(session.id);
        return { kind: 'success', text: catalog.length ? catalog.map(c => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}${c.description ? ` — ${c.description}` : ''}`).join('\n') : '此工具没有提供可执行的原生命令。' };
      }
      const match = line.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const abort = () => { commander.interrupt(session.id).catch(error => ctx.logger.warn(error.message)); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const cursor = commander.snapshot(session.id).cursor;
        const receipt = await commander.command(session.id, { name: match[1], arguments: match[2] || '', requestId: `harness-command:${commandId}` });
        const result = await commander.wait(session.id, { timeout: 55000, signal });
        const events = commander.events(session.id, cursor, 500).events.filter(e => e.turnId === receipt.turnId);
        const text = events.filter(e => e.type === 'text.delta').map(e => e.data.text).join('') || events.findLast(e => e.type === 'turn.completed')?.data.result;
        if (['failed', 'closed', 'disconnected'].includes(result.status)) return { kind: 'error', text: text || '原生命令未正常完成，请检查工具状态。' };
        return { kind: 'success', text: text || (['running', 'waiting', 'connecting'].includes(result.status) ? '原生命令仍在执行，请勿重复提交。' : '原生命令已完成。') };
      } finally { signal.removeEventListener('abort', abort); }
    },
  }));
}
