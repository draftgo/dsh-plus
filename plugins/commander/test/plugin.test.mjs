import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as plugin from '../src/plugin.mjs';
import { Commander } from '../src/runtime.mjs';
import { readJsonResponse } from '../client/http-response.mjs';

test('a live owner blocks writes but keeps startup failure diagnosable on the sidebar API', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-startup-'));
  const owner = await new Commander({ dataDir: directory }).open();
  const record = await readFile(join(directory, 'owner.lock'), 'utf8');
  const ctx = new Context(), routes = new Map(), tools = new Map();
  ctx.provide('tools', { register(value) { tools.set(value.name, value); } });
  ctx.provide('connection', { fetch: { register(route) {
    assert.equal(routes.has(route.path), false); routes.set(route.path, route);
    return async () => { routes.delete(route.path); };
  } } });
  t.after(async () => { await ctx.fiber.dispose(); await owner.close(); await rm(directory, { recursive: true, force: true }); });
  const fiber = ctx.plugin(plugin, { dataDir: directory }); await fiber;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.commander, undefined);
  assert.equal(tools.size, 0);
  assert.equal(await readFile(join(directory, 'owner.lock'), 'utf8'), record);
  const response = await routes.get('/api/commander').fetch(new Request('http://localhost/api/commander', { method: 'POST' }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.clone().json();
  assert.equal(body.code, 'COMMANDER_UNAVAILABLE');
  assert.match(body.error, /already in use/);
  await assert.rejects(readJsonResponse(response, 'http://localhost/api/commander'), /already in use.*HTTP 503/);
  await fiber.dispose();
  assert.equal(routes.size, 0);
});

test('invalid saved state stays intact and exposes its cause without publishing tools', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-invalid-startup-'));
  const data = '{corrupt sessions';
  await writeFile(join(directory, 'sessions.json'), data);
  const ctx = new Context(), routes = new Map();
  ctx.provide('tools', { register() { assert.fail('must not register tools with an unavailable store'); } });
  // Also cover Connection becoming available after Store initialization fails.
  await ctx.plugin(plugin, { dataDir: directory });
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path); } } });
  await new Promise(resolve => setImmediate(resolve));
  const response = await routes.get('/api/commander').fetch(new Request('http://localhost/api/commander', { method: 'POST' }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /DSH-Plus 启动失败/);
  assert.equal(await readFile(join(directory, 'sessions.json'), 'utf8'), data);
  await assert.rejects(readFile(join(directory, 'owner.lock')), { code: 'ENOENT' });
});

test('actual Cordis loads/unloads the service and tools; conversations cannot access each other or self-approve', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-plugin-'));
  const ctx = new Context(); const tools = new Map();
  ctx.provide('tools', { register(definition) { tools.set(definition.name, definition); } });
  try {
    await ctx.plugin(plugin, { dataDir: directory });
    assert.ok(ctx.commander);
    assert.ok(tools.has('commander_create'));
    assert.equal(tools.has('commander_approve'), false);
    const exec = { signal: new AbortController().signal, agent: { session: { id: 'owner' } } };
    await assert.rejects(tools.get('commander_create').execute({ provider: 'codex', cwd: directory }, exec), /approval service/);
    ctx.commander.providers.set('test', { async connect() { return { nativeId: 'native', close: async () => {} }; } });
    const { id } = await ctx.commander.create({ provider: 'test', ownerSessionId: 'someone-else' });
    await assert.rejects(tools.get('commander_events').execute({ id }, exec), /different Harness session/);
    assert.deepEqual(await tools.get('commander_sessions').execute({}, exec), { sessions: [] });
    const catalog = await tools.get('commander_providers').execute({}, exec);
    assert.equal(catalog.providers.length, 9);
  } finally {
    await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test('official Harness ToolRuntime validates and executes Commander tool output; unload removes registrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-harness-tools-'));
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {}, section() {} });
  try {
    await ctx.plugin(ToolRuntime);
    const fiber = ctx.plugin(plugin, { dataDir: directory }); await fiber;
    assert.equal(ctx.tools.schemas().filter(s => s.name.startsWith('commander_')).length, 14);
    const result = await ctx.tools.execute({ callId: 'test-call', name: 'commander_providers', arguments: {}, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.content[0].text, /codex/);
    await fiber.dispose();
    assert.equal(ctx.tools.schemas().filter(s => s.name.startsWith('commander_')).length, 0);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('native permissions and questions go to human services associated with the owning Harness agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-human-'));
  const ctx = new Context(); const tools = new Map(); const grants = []; const questions = [];
  ctx.provide('tools', { register(definition) { tools.set(definition.name, definition); } });
  ctx.provide('approval', { async request(request) { grants.push(request); return 'allowed-once'; } });
  ctx.provide('userQuestions', { async ask(request) { questions.push(request); return { answers: [{ id: 'q1', selected: ['B'] }] }; } });
  try {
    await ctx.plugin(plugin, { dataDir: directory });
    ctx.commander.providers.set('codex', { async connect() { return { nativeId: 'native', close: async () => {} }; } });
    const agent = { session: { id: 'owner' } };
    const exec = { agent, callId: 'human-test', signal: new AbortController().signal };
    const session = await tools.get('commander_create').execute({ provider: 'codex', cwd: directory }, exec);
    assert.deepEqual(await ctx.commander.ask(session.id, { kind: 'permission', method: 'bash', details: { command: 'echo safe' } }), { allow: true });
    const reply = await ctx.commander.ask(session.id, { kind: 'question', details: { questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'B' }] }] } });
    assert.deepEqual(reply, { allow: false, answers: { q1: { answers: ['B'] } } });
    assert.equal(grants.length, 2); assert.equal(questions.length, 1);
    assert.equal(grants[1].agent, agent); assert.equal(questions[0].agent, agent);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('full Commander composition registers native engines in the official model catalog', async () => {
  const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
  const directory = await mkdtemp(join(tmpdir(), 'commander-catalog-'));
  const ctx = new Context();
  ctx.provide('tools', { register() { return () => {}; } });
  ctx.provide('agents', {});
  ctx.provide('workspaceRegistry', { list: () => [] });
  try {
    await ctx.plugin(LlmRuntime);
    const fiber = ctx.plugin(plugin, { dataDir: directory }); await fiber;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ctx.llm.listProviders().map(p => p.id).sort(), ['commander-claude', 'commander-codex', 'commander-gemini', 'commander-grok', 'commander-hermes', 'commander-mcode', 'commander-opencode', 'commander-pi']);
    assert.equal((await ctx.llm.listModels('commander-codex'))[0].id, 'native-default');
    await fiber.dispose();
    assert.deepEqual(ctx.llm.listProviders(), []);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
