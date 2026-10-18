import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Commander } from '../src/runtime.mjs';
import { mountWeb } from '../src/web.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'commander-web-'));
  const c = await new Commander({ dataDir: dir }).open();
  const effects = []; let route;
  const projects = new Map([['shared', { id: 'shared', path: dir, title: 'Shared', sessionIds: ['harness-session'] }]]);
  const ctx = { effect(fn) { const dispose = fn(); effects.push(dispose); }, workspaceRegistry: { list: () => [...projects.values()], get: id => projects.get(id), create: async path => { const p = { id: 'new', path, title: 'New', sessionIds: [] }; projects.set(p.id,p); return p; } }, connection: { fetch: { register(r) { route = r; return async () => {}; } } } };
  const api = await mountWeb(ctx, c);
  const provider = { config: {}, constructor: { capabilities: {} }, async connect(s,h) { return { nativeId: s.id, async submit(text) { h.event('turn.started'); h.event('text.delta',{text:`Result: ${text}`}); h.event('turn.completed',{status:'completed'}); }, async close() {} }; } };
  c.providers.set('codex',provider); c.providers.set('pi',provider);
  t.after(async () => { await c.close(); for (const dispose of effects.reverse()) await dispose?.(); await rm(dir,{recursive:true,force:true}); });
  return { c, api, dir, route, ctx };
}

test('direct sessions share Harness projects, submit without a model router, and retain native identity', async t => {
  const { c, api, dir, route } = await setup(t);
  assert.equal(route.path,'/api/commander');
  assert.deepEqual(route.methods,['POST']);
  const a=(await api({action:'create',provider:'codex',projectId:'shared',model:'native-model'})).session;
  const b=(await api({action:'create',provider:'pi',projectId:'shared'})).session;
  assert.equal(a.cwd,dir); assert.equal(b.cwd,dir); assert.equal(a.projectId,b.projectId);
  await api({action:'send',id:a.id,text:'hello',requestId:'unique'});
  const events=await api({action:'events',id:a.id});
  assert(events.events.some(e=>e.type==='text.delta'&&e.data.text==='Result: hello'));
  assert.equal(events.session.status,'idle');
  await api({action:'close',id:a.id});
  assert.equal(c.snapshot(a.id).status,'closed');
  await api({action:'send',id:a.id,text:'again',requestId:'second'});
  assert.equal(c.snapshot(a.id).nativeId,a.nativeId);
  await api({action:'archive',id:a.id});
  assert.equal(c.snapshot(a.id).archived,true);
  await api({action:'archive',id:a.id,archived:false});
  await api({action:'connect',id:a.id});
  assert.equal(c.snapshot(a.id).archived,false);
  assert.equal(c.snapshot(a.id).nativeId,a.nativeId);
  await assert.rejects(api({action:'create',provider:'codex',projectId:'missing'}),/Project/);
  const hidden=await c.create({provider:'codex',cwd:dir,ownerSessionId:'harness-owner'});
  await assert.rejects(api({action:'send',id:hidden.id,text:'x',requestId:'r'}),/Harness conversation/);
});

test('binding lookup returns the owning native session identity for the model lock and activity view', async t => {
  const { c, api, dir } = await setup(t);
  assert.deepEqual(await api({ action: 'binding', harnessSessionId: 'harness-owner' }), { bound: false });
  const session = await c.create({ provider: 'codex', model: 'gpt-test', cwd: dir, ownerSessionId: 'harness-owner' });
  const binding = await api({ action: 'binding', harnessSessionId: 'harness-owner' });
  assert.deepEqual(binding, { bound: true, id: session.id, cursor: session.cursor, provider: 'codex', model: 'gpt-test', route: null });
});

test('native delegation requires human approval, inherits project and returns child results; unrelated results are rejected', async t => {
  const { c,api,dir }=await setup(t);
  const parent=(await api({action:'create',provider:'codex',projectId:'shared'})).session;
  const pending=c.delegate(parent.id,{provider:'pi',text:'child task',cwd:'/ignored'});
  const approval=c.snapshot(parent.id).pendingApprovals[0];
  assert.equal(c.list().length,1);
  await api({action:'approve',id:parent.id,approvalId:approval.id,answer:{allow:true}});
  const result=await pending;
  assert.equal(result.session.parentId,parent.id); assert.equal(result.session.cwd,dir);
  assert.equal(result.session.projectId,'shared');
  assert.equal(result.text,'Result: child task');
  assert.equal((await c.delegate(parent.id,{operation:'result',sessionId:result.session.id})).session.id,result.session.id);
  await assert.rejects(c.delegate(result.session.id,{operation:'result',sessionId:parent.id}),/direct delegated/);
  const denied=c.delegate(parent.id,{provider:'pi',text:'denied'});
  c.approve(parent.id,c.snapshot(parent.id).pendingApprovals[0].id,{allow:false});
  await assert.rejects(denied,/denied/);
  assert.equal(c.list().length,2);
});

test('delegation bridge rejects missing/wrong capabilities and revokes session capability on disconnect', async t => {
  const {c,api}=await setup(t);
  const s=(await api({action:'create',provider:'codex',projectId:'shared'})).session;
  const cap=c.delegationBridge.forSession(s.id);
  assert.equal((await fetch(cap.url,{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(cap.url,{method:'POST',headers:{authorization:'Bearer bad'},body:'{}'})).status,403);
  await c.disconnect(s.id);
  assert.equal((await fetch(cap.url,{method:'POST',headers:{authorization:`Bearer ${cap.token}`},body:'{}'})).status,403);
});

test('start does not allocate a session for an empty first message', async t => {
  const { c, api } = await setup(t);
  await assert.rejects(api({ action: 'start', provider: 'codex', projectId: 'shared', requestId: 'empty', text: '   ' }), /Invalid text/);
  assert.equal(c.list().length, 0);
  await assert.rejects(api({ action: 'start', provider: 'codex', projectId: 'shared', requestId: '', text: 'hello' }), /Invalid requestId/);
  assert.equal(c.list().length, 0);
});

test('concurrent start requests with one requestId create and submit only once', async t => {
  const { c, api } = await setup(t);
  const original = c.providers.get('codex');
  let submissions = 0;
  c.providers.set('codex', { ...original, async connect(session, host) {
    return { nativeId: session.id, async submit(text) { submissions++; await new Promise(resolve => setTimeout(resolve, 15)); host.event('turn.started'); host.event('text.delta', { text: `Result: ${text}` }); host.event('turn.completed', { status: 'completed' }); }, async close() {} };
  } });
  const input = { action: 'start', provider: 'codex', projectId: 'shared', model: 'm', requestId: 'same', text: 'hello' };
  const [a, b] = await Promise.all([api(input), api(input)]);
  assert.equal(a.session.id, b.session.id);
  assert.equal(c.list().length, 1);
  assert.equal(submissions, 1);
});

test('start exposes the created session after connection failure and retries it without changing identity', async t => {
  const { c, api } = await setup(t);
  const original = c.providers.get('codex');
  let connects = 0;
  c.providers.set('codex', { ...original, async connect(session, host) {
    connects++;
    if (connects === 1) { host.nativeId(session.id); throw new Error('connection unavailable'); }
    return { nativeId: session.id, async submit(text) { host.event('turn.started'); host.event('text.delta', { text: `Result: ${text}` }); host.event('turn.completed', { status: 'completed' }); }, async close() {} };
  } });
  const input = { action: 'start', provider: 'codex', projectId: 'shared', requestId: 'retry', text: 'recover me' };
  let failure;
  await assert.rejects(api(input), error => { failure = error; return /connection unavailable/.test(error.message) && Boolean(error.session); });
  assert.equal(c.list().length, 1);
  const firstId = failure.session.id;
  const retried = await api(input);
  assert.equal(retried.session.id, firstId);
  assert.equal(retried.session.status, 'idle');
  assert.equal(connects, 2);
});

test('start rejects reusing a requestId for different first-message parameters', async t => {
  const { c, api } = await setup(t);
  const input = { action: 'start', provider: 'codex', projectId: 'shared', requestId: 'collision', text: 'one' };
  const pending = api(input);
  await assert.rejects(api({ ...input, text: 'two' }), /different first message/);
  await pending;
  for (const change of [{ text: 'two' }, { provider: 'pi' }, { model: 'another-model' }]) {
    await assert.rejects(api({ ...input, ...change }), /different first message/);
  }
  assert.equal(c.list().length, 1);
});

test('start preserves an uncertain native submission across retries and restart', async t => {
  const { c, api, dir } = await setup(t);
  const original = c.providers.get('codex');
  let submissions = 0;
  c.providers.set('codex', { ...original, async connect(session) {
    return { nativeId: session.id, async submit() { submissions++; throw new Error('native acknowledgement lost'); }, async close() {} };
  } });
  const input = { action: 'start', provider: 'codex', projectId: 'shared', requestId: 'uncertain', text: 'do this once' };
  let id;
  await assert.rejects(api(input), error => { id = error.session?.id; return /acknowledgement lost/.test(error.message) && Boolean(id); });
  assert.equal((await api(input)).session.id, id);
  assert.equal(submissions, 1);
  assert.equal(c.get(id).receipts.uncertain.receipt.status, 'uncertain');
  await c.close();
  const restored = await new Commander({ dataDir: dir }).open();
  const disposals = [];
  const restoredApi = await mountWeb({ effect(fn) { disposals.push(fn()); }, workspaceRegistry: { get: key => key === 'shared' ? { id: 'shared', path: dir } : undefined }, connection: { fetch: { register() { return () => {}; } } } }, restored);
  try {
    const retried = await restoredApi(input);
    assert.equal(retried.session.id, id);
    assert.equal(restored.list().length, 1);
    assert.equal(restored.get(id).receipts.uncertain.receipt.status, 'uncertain');
    assert.equal(restored.drivers.size, 0);
    assert.equal(submissions, 1);
  } finally { for (const dispose of disposals.reverse()) await dispose?.(); await restored.close(); }
});

test('start refuses replacing a failed connection with no durable native identity', async t => {
  const { c, api, route } = await setup(t);
  c.providers.set('codex', { config: {}, constructor: { capabilities: {} }, async connect() { throw new Error('cannot connect'); } });
  const input = { action: 'start', provider: 'codex', projectId: 'shared', requestId: 'no-native', text: 'first message' };
  const response = await route.fetch(new Request('http://localhost/api/commander', { method: 'POST', body: JSON.stringify(input) }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /cannot connect/);
  assert.ok(body.session.id);
  await assert.rejects(api(input), error => /No durable native handle/.test(error.message) && error.session?.id === body.session.id);
  assert.equal(c.list().length, 1);
});


test('idle delegated sessions adopt an official conversation without losing native identity', async t => {
  const { c, api, dir, ctx } = await setup(t);
  const parent = await c.create({ provider: 'codex', cwd: dir, ownerSessionId: 'parent-harness' });
  const child = await c.create({ provider: 'pi', cwd: dir, parentId: parent.id, ownerSessionId: 'parent-harness' });
  const agent = { session: { header: { cwd: dir } }, options: { provider: 'commander-pi', model: 'native-default' } };
  ctx.get = name => name === 'agents' ? { get: id => id === 'child-harness' ? agent : undefined } : undefined;
  await assert.rejects(api({ action: 'adopt', id: parent.id, harnessSessionId: 'child-harness' }), /Only legacy or delegated/);
  await assert.rejects(api({ action: 'adopt', id: child.id, harnessSessionId: 'missing' }), /same project/);
  const adopted = await api({ action: 'adopt', id: child.id, harnessSessionId: 'child-harness' });
  assert.equal(adopted.session.ownerSessionId, 'child-harness');
  assert.equal(adopted.session.parentId, parent.id);
  assert.equal(adopted.session.harnessAdopted, true);
  assert.equal(adopted.session.nativeId, child.nativeId);
});

test('owner Web may archive, restore and delete Harness-owned native records without deleting Harness projects or sessions', async t => {
  const { c, api, dir } = await setup(t);
  const native = await c.create({ provider: 'codex', cwd: dir, projectId: 'shared', ownerSessionId: 'harness-session' });
  assert.equal((await api({ action: 'archive', id: native.id })).archived, true);
  assert.equal((await api({ action: 'archive', id: native.id, archived: false })).archived, false);
  assert.deepEqual(await api({ action: 'delete', id: native.id }), { id: native.id, removed: true });
  const state = await api({ action: 'state' });
  assert.equal(state.sessions.length, 0);
  assert.deepEqual(state.projects[0].sessionIds, ['harness-session']);
  assert.equal(state.projects[0].path, dir);
});

test('dismiss hides official conversation IDs durably without touching Harness sessions or native records', async t => {
  const { c, api, dir, ctx } = await setup(t);
  const native = await c.create({ provider: 'codex', cwd: dir, ownerSessionId: 'official-one' });
  await Promise.all([api({ action: 'dismiss', harnessSessionId: 'official-one' }), api({ action: 'dismiss', harnessSessionId: 'official-two' })]);
  assert.deepEqual((await api({ action: 'state' })).deletedHarnessIds, ['official-one', 'official-two']);
  assert.deepEqual((await api({ action: 'dismiss', harnessSessionId: 'official-one' })).deletedHarnessIds, ['official-one', 'official-two']);
  assert.equal(c.snapshot(native.id).ownerSessionId, 'official-one');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'dismissed-harness.json'), 'utf8')), ['official-one', 'official-two']);
  const restoredApi = await mountWeb(ctx, c);
  assert.deepEqual((await restoredApi({ action: 'state' })).deletedHarnessIds, ['official-one', 'official-two']);
  assert.deepEqual((await restoredApi({ action: 'state' })).projects[0].sessionIds, ['harness-session']);
});

test('owner Web exposes directory browsing and rejects invalid clone repositories', async t => {
  const { api, dir } = await setup(t);
  const directory = await api({ action: 'browse', path: dir });
  assert.equal(directory.path, dir);
  assert.ok(Array.isArray(directory.entries));
  await assert.rejects(api({ action: 'clone', url: 'http://github.com/owner/repo' }), /HTTPS GitHub/);
});
