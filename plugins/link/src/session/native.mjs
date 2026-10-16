import { askNativeQuestion } from '../../../commander/src/questions.mjs';
import { validateAnswer } from './adapter.mjs';
import { text } from '../pairing/store.mjs';

/** Legacy direct coding sessions keep Commander ownership and approval handling. */
export function createNativeAdapter(ctx) {
  const commander = ctx.get('commander');
  const projectOf = session => ctx.workspaceRegistry.list().find(p => p.id === session.projectId && p.path === session.cwd);
  const visible = session => session.ownerSessionId?.startsWith('commander-web:') && !session.archived && projectOf(session);
  const wire = s => ({ id: `native:${s.id}`, projectId: s.projectId, title: s.title || s.provider, running: ['running', 'waiting', 'connecting'].includes(s.status), updatedAt: s.updatedAt, engine: s.provider });
  const list = () => commander ? commander.list().filter(visible).map(wire) : [];
  const dispatch = async input => {
    if (!commander || !input.id?.startsWith('native:')) throw new Error('会话不存在');
    const id = input.id.slice('native:'.length);
    const session = commander.snapshot(id);
    if (!visible(session)) throw new Error('会话不属于可用的直接工作区，请通过官方 Harness 会话操作');
    if (input.action === 'send') {
      text(input.text, '消息', 20_000); text(input.requestId, 'requestId');
      if (['disconnected', 'closed'].includes(session.status)) await commander.connect(id);
      return commander.submit(id, input.text, { requestId: input.requestId });
    }
    if (input.action === 'cancel') { await commander.interrupt(id); return { accepted: true }; }
    if (input.action === 'respond') {
      const pending = session.pendingApprovals.find(p => p.id === input.interactionId);
      if (!pending) throw new Error('审批已处理或过期');
      if (pending.kind === 'permission' && typeof input.answer?.allow !== 'boolean') throw new Error('需要明确允许或拒绝');
      let answer = input.answer;
      if (pending.kind === 'question') answer = await askNativeQuestion(session.provider, pending, async ({ questions }) => { validateAnswer(input.answer, questions); return input.answer; });
      commander.approve(id, pending.id, answer);
      return { accepted: true };
    }
    if (input.action !== 'history') throw new Error('不支持的原生会话操作');
    const records = commander.get(id).events;
    const messages = [];
    let assistant;
    for (const event of records) {
      if (event.type === 'input.accepted' || event.type === 'input.steer') {
        messages.push({ id: `${input.id}:${event.seq}`, role: 'user', text: event.data.text }); assistant = undefined;
      }
      if (event.type === 'text.delta') {
        if (!assistant || assistant.turnId !== event.turnId) { assistant = { id: `${input.id}:${event.seq}`, role: 'assistant', text: '', turnId: event.turnId }; messages.push(assistant); }
        assistant.text += event.data.text;
      }
      if (event.type === 'session.error' || event.type === 'provider.error') messages.push({ id: `${input.id}:${event.seq}`, role: 'system', text: event.data.message || '原生工具连接失败' });
    }
    const questionsOf = p => session.provider === 'pi' ? [{ id: 'value', question: p.details?.title || 'Pi 问题', options: p.details?.options?.map(label => ({ label })) }] : (p.details?.questions || []).map((q, index) => ({ ...q, id: session.provider === 'codex' ? q.id : String(index), multiSelect: q.multiSelect === true || q.multiple === true }));
    const interactions = session.pendingApprovals.map(p => ({ id: p.id, kind: p.kind, title: p.details?.title || p.method || '等待确认', details: p.details, ...(p.kind === 'question' ? { questions: questionsOf(p) } : {}) }));
    return { messages, running: wire(session).running, interactions, hasMore: false, cursor: records[0]?.seq ?? 0, truncated: records[0]?.seq > 1 };
  };
  return { list, dispatch };
}
