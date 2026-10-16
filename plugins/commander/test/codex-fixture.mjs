#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let turn = 0;
let approvalId;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const result = value => send({ id: m.id, result: value });
  const done = status => send({ method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: `turn-${turn}`, status } } });
  if (!m.method) {
    if (m.id === approvalId) { send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture', delta: m.result.decision } }); done('completed'); }
    return;
  }
  switch (m.method) {
    case 'initialize': result({ userAgent: 'codex/fixture' }); break;
    case 'thread/start': case 'thread/resume': result({ thread: { id: m.params.threadId ?? 'thread-fixture' } }); break;
    case 'thread/read': result({ thread: { id: 'thread-fixture', turns: [] } }); break;
    case 'thread/list': result({ data: [{ id: 'thread-fixture' }] }); break;
    case 'turn/start': {
      turn++; result({ turn: { id: `turn-${turn}` } });
      send({ method: 'turn/started', params: { threadId: 'thread-fixture', turn: { id: `turn-${turn}` } } });
      if (m.params.input[0].text === 'approval') {
        approvalId = `approval-${turn}`;
        send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: `turn-${turn}`, command: 'echo test', availableDecisions: ['accept', 'decline'] } });
      } else if (m.params.input[0].text !== 'hang') {
        if (m.params.input[0].text === 'usage') {
          const publish = (total, last) => send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-fixture', turnId: 'turn-' + turn, tokenUsage: { total, last, modelContextWindow: 200000 } } });
          const first = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, totalTokens: 110 };
          publish(first, first); publish(first, first);
          publish({ inputTokens: 300, outputTokens: 30, cachedInputTokens: 100, totalTokens: 330 }, { inputTokens: 200, outputTokens: 20, cachedInputTokens: 60, totalTokens: 220 });
        }
        send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture', delta: 'fixture-output' } }); done('completed');
      }
      break;
    }
    case 'turn/interrupt': result({}); done('interrupted'); break;
    case 'turn/steer': result({ turnId: `turn-${turn}` }); break;
  }
});
