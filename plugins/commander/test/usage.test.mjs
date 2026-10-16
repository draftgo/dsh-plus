import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/plugin.mjs';
import { UsageLedger, normalizeUsage, mountUsage } from '../src/usage.mjs';

test('actual Cordis keeps the usage route mounted after the injection callback settles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-cordis-'));
  const ctx = new Context(), routes = new Map();
  ctx.provide('tools', { register() {} });
  ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path); }; } } });
  try {
    await ctx.plugin(plugin, { dataDir: dir, usage: { enabled: false } });
    for (let attempt = 0; !routes.has('/api/commander/usage') && attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(routes.has('/api/commander/usage'), true);
    const response = await routes.get('/api/commander/usage').fetch(new Request('http://app.test/api/commander/usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: '2026-10-01', end: '2026-10-17' }) }));
    assert.equal(response.status, 200);
    await ctx.fiber.dispose(); assert.equal(routes.size, 0);
  } finally { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('native usage conventions preserve exact counts and unknown buckets', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 100, cached_input_tokens: 60, outputTokens: 20, totalTokens: 120 }, 'inclusive'), { inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: null, totalTokens: 120, contextTokens: 100, contextWindow: null, reasoningTokens: null });
  const unknown = normalizeUsage({ input_tokens: 100, output_tokens: 20 });
  assert.equal(unknown.totalTokens, null); assert.equal(unknown.cacheReadTokens, null); assert.equal(unknown.contextWindow, null);
  assert.equal(normalizeUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }).totalTokens, 180);
});

test('collection imports own official history once, excludes routed duplicate and blocks cross-site reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-route-'));
  const commander = new EventEmitter(); commander.store = { directory: dir }; commander.sessions = new Map();
  const effects = [], hooks = {}, routes = []; const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
  const ctx = { effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose); }, on(name, fn) { hooks[name] = fn; }, inject(_keys, fn) { fn({ sessionQuery: { listSessions: async () => [{ header: { id: 'history' } }], readSession: async () => ({ inheritedEventCount: 1, events: [
    { seq: 0, type: 'assistant/message', time: Date.parse('2026-10-16'), data: { turn: 0, usage, message: { source: { provider: 'deepseek', model: 'test' } } } },
    { seq: 1, type: 'assistant/message', time: Date.parse('2026-10-16'), data: { turn: 1, usage, message: { source: { provider: 'deepseek', model: 'test' } } } },
    { seq: 2, type: 'assistant/message', time: Date.parse('2026-10-16'), data: { turn: 2, usage, message: { source: { provider: 'commander-codex', model: 'test' } } } },
  ] }) } }); }, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } };
  try {
    const ledger = await mountUsage(ctx, commander, { enabled: false }); const route = routes[0];
    commander.sessions.set('native', { id: 'native', provider: 'codex', model: 'model', status: 'idle', events: [] });
    const emit = (type, time, data) => commander.emit('event', { sessionId: 'native', turnId: 'one', type, time: new Date(Date.parse('2026-10-16') + time).toISOString(), data });
    emit('turn.started', 0, {}); emit('usage', 500, { id: 'one', scope: 'request', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } });
    emit('text.delta', 1000, { text: 'a' }); emit('usage', 2000, { id: 'two', scope: 'request', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }); emit('turn.completed', 4000, { status: 'completed' });
    const nativeRows = [...ledger.rows.values()].filter(row => row.sessionId === 'native');
    assert.equal(nativeRows.filter(row => row.durationMs !== null).length, 0);
    const query = headers => new Request('http://app.test/api/commander/usage', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ start: '2026-10-16', end: '2026-10-17' }) });
    const response = await route.fetch(query()); assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.recordCount, 3); assert.equal(data.summary.totalTokens, 242); assert.equal(data.summary.tokensPerSecond, null);
    hooks['session/event']({ id: 'history', inheritedEventCount: 1 }, { seq: 1, type: 'assistant/message', time: Date.parse('2026-10-16'), data: { turn: 1, usage, message: { source: { provider: 'deepseek', model: 'test' } } } });
    assert.equal(ledger.rows.size, 3);
    hooks['session/event']({ id: 'history' }, { seq: 3, type: 'request/header', data: { header: { config: { provider: 'router', model: 'real' } } } });
    const attemptedStream = [{ type: 'text-chunks', time0: 1000, dt: [500], texts: ['a', 'b'] }, { type: 'chunk', time: 3000, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } }];
    hooks['session/event']({ id: 'history' }, { seq: 4, type: 'assistant/attempt', time: 3000, data: { turn: 3, step: 0, stream: attemptedStream } });
    hooks['session/event']({ id: 'history' }, { seq: 5, type: 'assistant/attempt', time: 4000, data: { turn: 3, step: 0, stream: [{ type: 'text-chunks', time0: 3500, dt: [], texts: ['retry'] }] } });
    assert.equal(ledger.rows.has('harness:history:4'), false); assert.equal(ledger.rows.has('harness:history:5'), false); assert.equal(ledger.rows.size, 3);
    hooks['session/event']({ id: 'history' }, { seq: 6, type: 'assistant/message', time: 5000, data: { turn: 3, step: 0, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, stream: [{ type: 'text-chunks', time0: 4500, dt: [], texts: ['settled'] }] } });
    const settled = ledger.rows.get('harness:history:6'); assert.equal(settled.tool, 'router'); assert.equal(settled.model, 'real'); assert.equal(settled.durationMs, 4000); assert.equal(ledger.rows.size, 4);
    hooks['session/event']({ id: 'history' }, { seq: 7, type: 'assistant/message', time: 6000, data: { turn: 3, step: 1, usage } });
    assert.equal(ledger.rows.get('harness:history:7').durationMs, null);
    assert.equal((await route.fetch(query({ origin: 'https://attacker.test' }))).status, 400);
    for (const dispose of effects.reverse()) await dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledger deduplicates, filters exclusive end and never stores content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-'));
  try {
    const ledger = await new UsageLedger(dir).open();
    const row = { id: 'a', tool: 'codex', model: 'test', time: '2026-10-16T00:00:00Z', prompt: 'private', response: 'secret', durationMs: 2000, ...normalizeUsage({ inputTokens: 100, outputTokens: 20, cached_input_tokens: 50, totalTokens: 120 }, 'inclusive') };
    ledger.put(row); ledger.put(row); ledger.put({ ...row, id: 'b', time: '2026-10-17T00:00:00Z' }); await ledger.flush();
    const result = ledger.query({ start: '2026-10-16', end: '2026-10-17' });
    assert.equal(result.recordCount, 1); assert.equal(result.summary.totalTokens, 120); assert.equal(result.summary.cacheHitRate, 0.5); assert.equal(result.summary.tokensPerSecond, 10);
    const stored = await readFile(ledger.path, 'utf8'); assert.doesNotMatch(stored, /private|secret|prompt|response/);
    assert.equal((await new UsageLedger(dir).open()).rows.size, 2);
    ledger.put({ ...row, durationMs: null }); assert.equal(ledger.rows.get('a').durationMs, 2000);
    ledger.put({ id: 'unknown', tool: 'pi', time: row.time }); assert.equal(ledger.query({ start: '2026-10-16', end: '2026-10-17' }).summary.totalTokens, null);
    assert.throws(() => ledger.query({ start: 'bad', end: 'bad' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('server pagination returns 50 records while overview aggregates the full interval',()=>{
 const ledger=new UsageLedger('/unused');for(let i=0;i<123;i++)ledger.put({id:String(i),tool:'codex',model:'m',time:new Date(Date.UTC(2026,9,16,0,0,i)).toISOString(),...normalizeUsage({inputTokens:10,outputTokens:1,totalTokens:11})});
 const range={start:'2026-10-16',end:'2026-10-17'};
 const first=ledger.query(range),second=ledger.query({...range,page:2}),last=ledger.query({...range,page:3});
 assert.equal(first.records.length,50);assert.equal(first.pageCount,3);assert.equal(first.summary.totalTokens,1353);assert.equal(second.records.length,50);assert.equal(last.records.length,23);assert.equal(first.records.some(row=>second.records.some(other=>other.id===row.id)),false);assert.equal(ledger.query({...range,page:999}).page,3);for(const page of [0,-1,1.2,'2'])assert.throws(()=>ledger.query({...range,page}));assert.throws(()=>ledger.query({...range,pageSize:100000}));
});
