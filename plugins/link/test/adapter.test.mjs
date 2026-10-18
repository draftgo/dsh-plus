import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionAdapter } from '../src/session/adapter.mjs';

function fixture() {
  const calls = [], eventStreams = [], results = [], peers = [];
  const project = { id: 'project', title: 'Project', path: '/project', sessionIds: ['session'] };
  const opening = { type: 'snapshot', cursor: 7, hasMore: false, projections: { values: {} }, records: [
    { event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hello' }] } } },
    { event: { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'answer' }] } } } },
    { event: { seq: 3, type: 'tool/result', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'tool output' }] } } } },
    { event: { seq: 4, type: 'assistant/message', surfaceOp: { op: 'replace' }, data: { message: { content: [{ type: 'text', text: 'hidden replacement' }] } } } },
  ], assistantStream: { activeAttempt: { attemptId: 'attempt', stream: [{ type: 'text-chunks', texts: ['live ', 'output'] }] } } };
  const ctx = {
    workspaceRegistry: { list: () => [project] },
    connection: {
      createPeer({ principal, interactions }) {
        assert.deepEqual(principal, { kind: 'owner' }); assert.equal(interactions, 'answer');
        const controller = new AbortController(); const peer = { id: `peer-${peers.length}`, signal: controller.signal, dispose: async () => controller.abort() }; peers.push(peer); return peer;
      },
      createSharedFetchHandler(channel) { assert.equal(channel, '/api'); return { async fetch(request, peer) { results.push({ body: await request.json(), peer }); return Response.json({ type: 'server-response', result: { ok: true } }); } }; },
    },
    typertGateway: {
      async invoke(call) {
        calls.push(call);
        if (call.method === 'list') return { items: [{ sessionId: 'session', projections: { values: { title: 'Session' } }, running: true }, { sessionId: 'private', running: false }] };
        if (call.method === 'modelCatalog') return { groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }] };
        if (call.method === 'create') { project.sessionIds.push(call.args.request.sessionId); return { sessionId: call.args.request.sessionId }; }
        if (call.method === 'page') return { records: opening.records.slice(0, 1), hasMore: false };
        if (call.namespace === 'userQuestions' && call.method === 'answer') return true;
        return { accepted: true };
      },
      async stream(call) {
        calls.push(call);
        return (async function* () { yield opening; })();
      },
      wireStream: { async open(endpoint, payload, _uplink, peer, signal) {
        assert.equal(endpoint, '$events'); assert.deepEqual(payload, { args: {} });
        const queue = []; let wake, failure;
        const stream = { push(value) { queue.push(value); wake?.(); }, fail(error) { failure = error; wake?.(); } }; eventStreams.push(stream);
        return (async function* () {
          yield { type: 'ready', clientId: `client-${peer.id}` };
          while (!signal.aborted) {
            if (failure) throw failure;
            if (queue.length) { yield queue.shift(); continue; }
            await new Promise(resolve => {
              const abort = () => { signal.removeEventListener('abort', abort); resolve(); };
              signal.addEventListener('abort', abort, { once: true });
              wake = () => { signal.removeEventListener('abort', abort); resolve(); };
            });
          }
        })();
      } },
    },
  };
  const adapter = createSessionAdapter(ctx);
  return { adapter, ctx, calls, results, peers, opening, eventStreams, project, device: { id: 'phone' } };
}

test('state lists registered Harness sessions and maps official model catalog', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const state = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.deepEqual(state.sessions.map(session => session.id), ['session']);
  assert.equal(state.models[0].model, 'model');
  assert.deepEqual(f.calls.find(call => call.method === 'list').args, { _request: {} });
});

test('state does not wait for a slow interaction stream', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const open = f.ctx.typertGateway.wireStream.open;
  f.ctx.typertGateway.wireStream.open = (...args) => new Promise(resolve => {
    setTimeout(() => resolve(open(...args)), 100);
  });
  const started = Date.now();
  const state = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.deepEqual(state.sessions.map(session => session.id), ['session']);
  assert.ok(Date.now() - started < 80, 'state should not wait for interaction stream readiness');
});

test('send/cancel use official gateway, rejects foreign sessions and unsupported actions', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.dispatch({ action: 'send', id: 'session', requestId: 'request', text: 'hello' }, f.device);
  assert.deepEqual(f.calls.at(-1).args, { request: { sessionId: 'session', requestId: 'request', mode: 'queue', content: [{ type: 'text', text: 'hello' }] } });
  await f.adapter.dispatch({ action: 'cancel', id: 'session' }, f.device);
  assert.deepEqual(f.calls.at(-1).args, { request: { sessionId: 'session' } });
  await assert.rejects(f.adapter.dispatch({ action: 'send', id: 'private', requestId: 'r', text: 'x' }, f.device), /not registered/);
  await assert.rejects(f.adapter.dispatch({ action: 'shell', command: 'echo' }, f.device), /Unsupported/);
});

test('history parses committed and live text, excludes replacement and pages at real cursor', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const result = await f.adapter.dispatch({ action: 'history', id: 'session' }, f.device);
  assert.deepEqual(result.messages.map(message => message.text), ['hello', 'answer', 'tool output', 'live output']);
  assert.equal(result.running, true);
  await f.adapter.dispatch({ action: 'history', id: 'session', before: 3 }, f.device);
  assert.deepEqual(f.calls.find(call => call.method === 'page').args.request, { address: { kind: 'session', sessionId: 'session' }, throughSeq: 7, beforeSeq: 3, maxMessages: 100 });
});

test('creation retries share one result and reject changed input for same request id', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const input = { action: 'create', projectId: 'project', requestId: 'first', provider: 'p', model: 'm' };
  const [a, b] = await Promise.all([f.adapter.dispatch(input, f.device), f.adapter.dispatch(input, f.device)]);
  assert.equal(a.id, b.id); assert.equal(f.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(f.calls.find(call => call.method === 'create').args.request.workspaceId, 'project');
  await assert.rejects(f.adapter.dispatch({ ...input, model: 'different' }, f.device), /another session configuration/);
});

test('approval uses same owner peer and official event result, prevents cross-session reply', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.dispatch({ action: 'state' }, f.device);
  f.eventStreams[0].push({ type: 'waterfall', event: 'approval/request', eventId: 'approval', agentId: 'session', request: { toolName: 'shell', reason: 'Execute command?' } });
  await new Promise(resolve => setImmediate(resolve));
  const history = await f.adapter.dispatch({ action: 'history', id: 'session' }, f.device);
  assert.equal(history.interactions[0].kind, 'permission');
  await f.adapter.dispatch({ action: 'respond', id: 'session', interactionId: 'approval', answer: { allow: true } }, f.device);
  assert.deepEqual(f.results[0].body.payload.args, { clientId: 'client-peer-0', eventId: 'approval', outcome: { kind: 'result', value: 'allowed-once' } });
  assert.equal(f.results[0].peer, f.peers[0]);
  await assert.rejects(f.adapter.dispatch({ action: 'respond', id: 'session', interactionId: 'approval', answer: { allow: true } }, f.device), /expired/);
});

test('continued questions use userQuestions answer with agentId lookup', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  f.opening.projections.values.userQuestions = { active: [{ callId: 'call', state: 'continued', questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] }] };
  const answer = { answers: [{ id: 'q', selected: ['Yes'] }] };
  await f.adapter.dispatch({ action: 'respond', id: 'session', interactionId: 'continued:call', answer }, f.device);
  assert.deepEqual(f.calls.at(-1).args, { agentId: 'session', callId: 'call', answer });
});

test('revoke/close dispose peers and permit later service reconfiguration', async () => {
  const f = fixture();
  await f.adapter.dispatch({ action: 'state' }, f.device);
  await f.adapter.revoke('phone'); assert.equal(f.peers[0].signal.aborted, true);
  await f.adapter.dispatch({ action: 'state' }, f.device); assert.equal(f.peers.length, 2);
  await f.adapter.close(); assert.equal(f.peers[1].signal.aborted, true);
  await f.adapter.dispatch({ action: 'state' }, f.device); assert.equal(f.peers.length, 3);
  await f.adapter.close();
});

test('failed interaction stream before ready disposes its peer and allows retry', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const open = f.ctx.typertGateway.wireStream.open;
  let first = true;
  f.ctx.typertGateway.wireStream.open = (...args) => {
    if (first) { first = false; throw new Error('Interaction source unavailable'); }
    return open(...args);
  };
  await assert.rejects(f.adapter.dispatch({ action: 'state' }, f.device), /source unavailable/);
  assert.equal(f.peers[0].signal.aborted, true);
  const state = await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(state.sessions[0].id, 'session');
  assert.equal(f.peers.length, 2);
});

test('stream failure after ready evicts immediately and delayed teardown preserves replacement', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.dispatch({ action: 'state' }, f.device);
  let finishDisposal;
  const disposal = new Promise(resolve => { finishDisposal = resolve; });
  t.after(finishDisposal);
  const dispose = f.peers[0].dispose;
  f.peers[0].dispose = async () => { await disposal; await dispose(); };
  f.eventStreams[0].fail(new Error('Connection lost'));
  await new Promise(resolve => setImmediate(resolve));
  await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(f.peers.length, 2, 'retry uses a new peer before prior disposal completes');
  finishDisposal();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.peers[0].signal.aborted, true);
  assert.equal(f.peers[1].signal.aborted, false);
  await f.adapter.dispatch({ action: 'state' }, f.device);
  assert.equal(f.peers.length, 2, 'old finally did not evict replacement');
});

test('unsupported, unregistered and capacity-exceeding waterfalls delegate via official next', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.dispatch({ action: 'state' }, f.device);
  const push = (eventId, agentId = 'session', event = 'approval/request') => f.eventStreams[0].push({ type: 'waterfall', event, eventId, agentId, request: { toolName: 'shell' } });
  push('foreign', 'private');
  push('unknown', 'session', 'unrelated/request');
  for (let index = 0; index < 101; index++) push(`approval-${index}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.results.map(result => result.body.payload.args), ['foreign', 'unknown', 'approval-100'].map(eventId => ({ clientId: 'client-peer-0', eventId, outcome: { kind: 'next' } })));
  assert.ok(f.results.every(result => result.peer === f.peers[0]));
  const history = await f.adapter.dispatch({ action: 'history', id: 'session' }, f.device);
  assert.equal(history.interactions.length, 100);
});
