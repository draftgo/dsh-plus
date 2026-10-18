import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const empty = { async *[Symbol.asyncIterator]() {} };
const string = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
};
const plainText = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const liveText = stream => (stream ?? []).map(record => record.type === 'text-chunks' ? record.texts.join('') : record.type === 'chunk' && record.chunk.type === 'text-delta' ? record.chunk.text : '').join('');

/** Adapt the paired human's narrow Link API to the official Harness gateway. */
export function createSessionAdapter(ctx, _options = {}) {
  const peers = new Map();
  const creates = new Map();
  const projects = () => ctx.workspaceRegistry.list();
  const projectOf = id => projects().find(project => project.sessionIds.includes(id));
  const requireSession = id => {
    string(id, 'session id');
    const project = projectOf(id);
    if (!project) throw new Error('Session is not registered in an available workspace');
    return project;
  };
  const invoke = (record, namespace, method, args) => ctx.typertGateway.invoke({ peer: record.peer, namespace, method, args });
  const release = record => {
    // Evict synchronously; an old stream's eventual teardown must not remove its replacement.
    if (peers.get(record.id) === record) peers.delete(record.id);
    clearTimeout(record.timer);
    record.abort.abort();
    for (const abort of record.waits.values()) abort.abort();
    record.pending.clear();
    return record.cleanup ??= Promise.resolve().then(() => record.peer.dispose());
  };
  const drop = async id => {
    const record = peers.get(id);
    if (!record) return;
    await release(record);
    await record.loop?.catch(() => {});
  };
  const eventOutcome = async (record, eventId, outcome) => {
    const handler = ctx.connection.createSharedFetchHandler('/api');
    const response = await handler.fetch(new Request('http://localhost/api/$events/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId: record.clientId, eventId, outcome } } }) }), record.peer);
    const result = await response.json();
    if (!response.ok || result.result?.ok === false || result.ok === false) throw new Error(result.result?.error?.message || result.error?.message || 'Harness rejected interaction');
  };
  const touch = record => {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => { if (record.active) touch(record); else void drop(record.id).catch(() => {}); }, 45_000);
    record.timer.unref?.();
  };
  const holdQuestion = async (record, frame) => {
    const abort = new AbortController();
    record.waits.set(frame.eventId, abort);
    try {
      const stream = await ctx.typertGateway.stream({ peer: record.peer, namespace: 'userQuestions', method: 'attachWait', args: { agentId: frame.agentId, callId: frame.request.wait.callId }, signal: AbortSignal.any([record.abort.signal, abort.signal]) });
      for await (const _item of stream) { /* Holding this stream claims the foreground wait. */ }
    } catch (error) { if (!abort.signal.aborted && !record.abort.signal.aborted) record.waitErrors.set(frame.eventId, error); }
    finally { record.waits.delete(frame.eventId); }
  };
  const getPeer = async device => {
    const id = string(device?.id, 'device id');
    let record = peers.get(id);
    if (record) { if (record.error) throw record.error; touch(record); return record; }
    record = { id, peer: ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' }), abort: new AbortController(), pending: new Map(), waits: new Map(), waitErrors: new Map(), active: 0 };
    peers.set(id, record);
    touch(record);
    let resolveReady, rejectReady;
    record.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Most actions do not await readiness; keep a background stream failure
    // observable through record.error without creating an unhandled rejection.
    record.ready.catch(() => {});
    record.loop = (async () => {
      try {
        const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, empty, record.peer, record.abort.signal);
        for await (const frame of stream) {
          if (frame.type === 'ready') { record.clientId = frame.clientId; resolveReady(); }
          if (frame.type === 'cancel') { record.pending.delete(frame.eventId); record.waits.get(frame.eventId)?.abort(); record.waitErrors.delete(frame.eventId); }
          if (frame.type === 'waterfall') {
            if (!projectOf(frame.agentId) || !['approval/request', 'user-questions/request'].includes(frame.event) || record.pending.size >= 100) {
              await eventOutcome(record, frame.eventId, { kind: 'next' });
              continue;
            }
            record.pending.set(frame.eventId, frame);
            if (frame.event === 'user-questions/request' && frame.request.wait?.timed) void holdQuestion(record, frame);
          }
        }
        if (!record.abort.signal.aborted) throw new Error('Harness interaction stream ended');
      } catch (error) {
        record.error = error;
        // release() never waits for this loop: failure before ready can safely reject its caller.
        const cleanup = release(record);
        rejectReady(error);
        await cleanup.catch(() => {});
      } finally {
        await release(record).catch(() => {});
        if (!record.clientId) rejectReady(new Error('Harness interaction stream is unavailable'));
      }
    })();
    // The interaction stream is independent from ordinary session/model RPCs.
    // Do not hold the first state request on its readiness; only surface a
    // synchronous startup failure so callers can retry with a fresh peer.
    await Promise.resolve();
    if (record.error) throw record.error;
    return record;
  };
  const waitForEvents = async record => {
    try { await record.ready; }
    catch (error) { throw record.error ?? error; }
  };
  const catalog = async record => {
    const result = await invoke(record, 'session', 'modelCatalog', {});
    return result.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, label: `${group.name} · ${model.name}` })));
  };
  const rows = async record => {
    const result = await invoke(record, 'session', 'list', { _request: {} });
    return result.items.filter(row => !row.parentSessionId && row.origin !== 'subagent' && projectOf(row.sessionId)).map(row => ({ id: row.sessionId, projectId: projectOf(row.sessionId).id, title: row.projections?.values?.title?.title || row.projections?.values?.title || '新会话', running: row.running, updatedAt: row.updatedAt }));
  };
  const snapshot = async (record, id) => {
    const abort = new AbortController();
    let iterator;
    try {
      const stream = await ctx.typertGateway.stream({ peer: record.peer, namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: id }, assistantStream: true, maxMessages: 100 } }, signal: AbortSignal.any([abort.signal, record.abort.signal]) });
      iterator = stream[Symbol.asyncIterator]();
      const opening = await iterator.next();
      if (opening.done || opening.value.type !== 'snapshot') throw new Error('Harness history snapshot is unavailable');
      return opening.value;
    } finally { abort.abort(); await iterator?.return?.(); }
  };
  const pendingView = (record, id) => [...record.pending.values()].filter(frame => frame.agentId === id).map(frame => frame.event === 'approval/request'
    ? { id: frame.eventId, kind: 'permission', title: frame.request.reason || frame.request.toolName || '需要批准', toolName: frame.request.toolName, options: [{ id: 'allow', label: '允许一次' }, { id: 'reject', label: '拒绝' }] }
    : { id: frame.eventId, kind: 'question', title: '需要你的回答', questions: frame.request.questions, ...(record.waitErrors.has(frame.eventId) ? { error: 'Unable to claim timed question; answer in the desktop application' } : {}) });
  const respond = async (record, input) => {
    const interactionId = string(input.interactionId, 'interaction id');
    if (interactionId.startsWith('continued:')) {
      const callId = interactionId.slice('continued:'.length);
      const opening = await snapshot(record, input.id);
      const question = opening.projections?.values?.userQuestions?.active?.find(question => question.callId === callId && question.state === 'continued');
      if (!question) throw new Error('Question is no longer pending');
      validateAnswer(input.answer, question.questions);
      const accepted = await invoke(record, 'userQuestions', 'answer', { agentId: input.id, callId, answer: input.answer });
      if (!accepted) throw new Error('Question is no longer pending');
      return { accepted: true };
    }
    const pending = record.pending.get(interactionId);
    if (!pending || pending.agentId !== input.id) throw new Error('Interaction expired or belongs to another session');
    if (record.waitErrors.has(interactionId)) throw new Error('Timed question could not be claimed; answer in the desktop application');
    let value = input.answer;
    if (pending.event === 'approval/request') {
      if (typeof value?.allow !== 'boolean') throw new Error('Expected an explicit allow decision');
      value = value.allow ? 'allowed-once' : 'rejected';
    } else validateAnswer(value, pending.request.questions);
    await eventOutcome(record, interactionId, { kind: 'result', value });
    record.pending.delete(interactionId);
    record.waits.get(interactionId)?.abort();
    return { accepted: true };
  };
  const handle = async (input, device) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object');
    const action = string(input.action, 'action');
    if (!['state', 'models', 'create', 'history', 'send', 'cancel', 'respond'].includes(action)) throw new Error('Unsupported Link action');
    const record = await getPeer(device);
    if (action === 'models') return { models: await catalog(record) };
    if (action === 'state') {
      const [sessions, models] = await Promise.all([rows(record), catalog(record)]);
      return { host: { name: hostname() }, projects: projects().map(project => ({ id: project.id, name: project.title || project.id, path: project.path })), sessions, models };
    }
    if (action === 'create') {
      const project = projects().find(project => project.id === string(input.projectId, 'project id'));
      if (!project) throw new Error('Project is unavailable');
      const requestId = string(input.requestId, 'request id');
      if ((input.provider === undefined) !== (input.model === undefined)) throw new Error('Provider and model must be selected together');
      if (input.provider !== undefined) { string(input.provider, 'provider'); string(input.model, 'model'); }
      const key = `${record.id}:${requestId}`;
      const fingerprint = JSON.stringify([project.id, input.provider ?? null, input.model ?? null]);
      const prior = creates.get(key);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('Request id was used for another session configuration'); return prior.promise; }
      if (creates.size > 2000) throw new Error('Creation receipt capacity reached; reconnect the host before creating more sessions');
      const digest = createHash('sha256').update(key).digest('hex');
      const stableId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const promise = (async () => {
        if (projectOf(stableId)?.id === project.id) return { id: stableId, title: '新会话', projectId: project.id };
        const result = await invoke(record, 'session', 'create', { request: { workspaceId: project.id, sessionId: stableId } });
        if (input.provider !== undefined) await invoke(record, 'session', 'selectModel', { request: { sessionId: result.sessionId, provider: input.provider, model: input.model } });
        return { id: result.sessionId, title: '新会话', projectId: project.id };
      })();
      creates.set(key, { fingerprint, promise });
      return promise;
    }
    requireSession(input.id);
    if (action === 'send') return invoke(record, 'session', 'prompt', { request: { sessionId: input.id, requestId: string(input.requestId, 'request id'), mode: 'queue', content: [{ type: 'text', text: string(input.text, 'text', 20_000) }] } });
    if (action === 'cancel') return invoke(record, 'session', 'cancel', { request: { sessionId: input.id } });
    if (action === 'respond') { await waitForEvents(record); return respond(record, input); }
    const opening = await snapshot(record, input.id);
    let page = opening;
    if (input.before !== undefined) {
      if (!Number.isSafeInteger(input.before) || input.before < 0) throw new Error('Invalid history cursor');
      page = await invoke(record, 'session', 'page', { request: { address: { kind: 'session', sessionId: input.id }, throughSeq: opening.cursor, beforeSeq: input.before, maxMessages: 100 } });
    }
    const messages = page.records.flatMap(({ event }) => {
      if (event.surfaceOp !== 'append' || !['user/message', 'assistant/message', 'tool/result'].includes(event.type)) return [];
      const message = event.type === 'user/message' ? event.data : event.data.message;
      const value = plainText(message);
      return value ? [{ id: `${input.id}:${event.seq}`, role: event.type === 'user/message' ? 'user' : event.type === 'tool/result' ? 'tool' : 'assistant', text: value }] : [];
    });
    const attempt = opening.assistantStream?.activeAttempt;
    if (input.before === undefined && attempt) { const text = liveText(attempt.stream); if (text) messages.push({ id: `live:${attempt.attemptId}`, role: 'assistant', text }); }
    const interactions = pendingView(record, input.id);
    const continued = opening.projections?.values?.userQuestions?.active ?? [];
    for (const question of continued.filter(question => question.state === 'continued')) interactions.push({ id: `continued:${question.callId}`, kind: 'question', title: '需要你的回答', questions: question.questions });
    const session = (await rows(record)).find(row => row.id === input.id);
    return { messages, interactions, running: Boolean(attempt || session?.running), hasMore: page.hasMore, cursor: page.records[0]?.event.seq ?? 0 };
  };
  const dispatch = async (input, device) => {
    const record = await getPeer(device);
    record.active++;
    try { return await handle(input, device); }
    finally { record.active--; if (peers.get(record.id) === record) touch(record); }
  };
  return { dispatch, revoke: drop, close: async () => { await Promise.all([...peers.keys()].map(drop)); creates.clear(); } };
}

export function validateAnswer(answer, questions) {
  if (!Array.isArray(answer?.answers) || !Array.isArray(questions)) throw new Error('Expected a structured question answer');
  const ids = new Set();
  for (const item of answer.answers) {
    const question = questions.find(question => question.id === item.id);
    if (!question || ids.has(item.id) || !Array.isArray(item.selected) || item.selected.some(value => typeof value !== 'string') || (item.custom !== undefined && typeof item.custom !== 'string')) throw new Error('Invalid question answer');
    ids.add(item.id);
    if (!question.multiSelect && item.selected.length > 1) throw new Error('Question allows only one selection');
    if (item.selected.some(value => !question.options?.some(option => option.label === value))) throw new Error('Unknown question option');
    if (!item.selected.length && !item.custom?.trim()) throw new Error('Answer cannot be empty');
  }
  if (ids.size !== questions.length) throw new Error('Answer each question exactly once');
}
