import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSessionRoutes, sessionRouteSupport } from '../src/session-routes.mjs';
import { Commander } from '../src/runtime.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-routes-'));
  const entries = { a: { baseURL: 'https://a.example/v1', apiKey: 'secret-a', protocol: 'openai-completions', credentialRef: 'a-key' }, b: { baseURL: 'https://b.example/v1', apiKey: 'secret-b', protocol: 'openai-completions', credentialRef: 'b-key' } };
  const providers = { resolve: async id => entries[id], describeRoute: async id => entries[id] };
  const routes = createSessionRoutes({ directory, providers });
  return { directory, entries, routes };
}

test('managed launches isolate both config and history without copying or mutating native files', async t => {
  const { directory, routes } = await fixture(t);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = join(directory, 'native'); await mkdir(native);
  const before = 'native configuration and old history'; await writeFile(join(native, 'config.toml'), before);
  const oldEnv = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const route = await routes.capture({ tool: 'codex', providerId: 'a', model: 'model-a', apiKey: 'injected' });
  assert.equal(JSON.stringify(route).includes('secret-a'), false);
  assert.equal(JSON.stringify(route).includes('injected'), false);
  const a = await routes.launch({ tool: 'codex', route, sessionId: randomUUID() });
  const b = await routes.launch({ tool: 'codex', route, sessionId: randomUUID() });
  assert.notEqual(a.env.CODEX_HOME, b.env.CODEX_HOME);
  assert.equal(a.env.HOME, undefined);
  assert.equal(a.commandArgs.join(' ').includes('secret-a'), false);
  assert.equal(a.env.DSH_PLUS_SESSION_API_KEY, 'secret-a');
  assert.equal((await stat(a.env.CODEX_HOME)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(native, 'config.toml'), 'utf8'), before);
  assert.deepEqual({ HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, oldEnv);
  const claudeRoute = await routes.capture({ tool: 'claude', providerId: 'a', model: 'claude-model' });
  const c = await routes.launch({ tool: 'claude', route: claudeRoute, sessionId: randomUUID() });
  assert.match(c.env.CLAUDE_CONFIG_DIR, /managed-runs/);
  assert.deepEqual(c.settingSources, []);
  assert.equal(c.settings.env.ANTHROPIC_BASE_URL, claudeRoute.baseURL);
});

test('endpoint, source protocol and credential identity changes refuse reconnect while key rotation is allowed', async t => {
  const { directory, routes, entries } = await fixture(t), route = await routes.capture({ tool: 'codex', providerId: 'a', model: 'm' }), sessionId = randomUUID();
  t.after(() => rm(directory, { recursive: true, force: true }));
  entries.a.apiKey = 'rotated';
  assert.equal((await routes.launch({ tool: 'codex', route, sessionId })).env.DSH_PLUS_SESSION_API_KEY, 'rotated');
  const original = { ...entries.a };
  for (const change of [{ baseURL: 'https://new.example' }, { protocol: 'other' }, { credentialRef: 'new-key' }]) {
    Object.assign(entries.a, original, change);
    await assert.rejects(routes.launch({ tool: 'codex', route, sessionId }), /已更改/);
  }
  Object.assign(entries.a, original);
  await assert.rejects(routes.launch({ tool: 'codex', route: { ...route, model: 'changed' }, sessionId }), /绑定无效/);
  await assert.rejects(routes.capture({ tool: 'pi', providerId: 'a', model: 'm' }), /尚未验证/);
  await assert.rejects(routes.capture({ tool: 'codex', providerId: 'a', model: 'm', overrides: { config: {} } }), /高级配置/);
  assert.equal(sessionRouteSupport('pi').supported, false);
});

test('managed directory symlinks are refused without touching target', async t => {
  const { directory, routes } = await fixture(t), target = join(directory, 'external'); await mkdir(target);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(target, join(directory, 'managed-runs'));
  const route = await routes.capture({ tool: 'codex', providerId: 'a', model: 'm' });
  await assert.rejects(routes.launch({ tool: 'codex', route, sessionId: randomUUID() }), /符号链接/);
});

test('quick settings are captured per session and cannot override credentials or routing', async t => {
  const { directory, routes } = await fixture(t); t.after(() => rm(directory, { recursive: true, force: true }));
  const quickSettings = { multiAgent: true, agentThreads: 3, effort: 'high' };
  const route = await routes.capture({ tool: 'codex', providerId: 'a', model: 'm', quickSettings });
  quickSettings.effort = 'low';
  const launch = await routes.launch({ tool: 'codex', route, sessionId: randomUUID() });
  assert.equal(launch.commandArgs.includes('features.multi_agent=true'), true);
  assert.equal(launch.commandArgs.includes('agents.max_threads=3'), true);
  assert.equal(launch.commandArgs.includes('model_reasoning_effort="high"'), true);
  await assert.rejects(routes.launch({ tool: 'codex', route: { ...route, quickSettings: { effort: 'low' } }, sessionId: randomUUID() }), /绑定无效/);
  await assert.rejects(routes.capture({ tool: 'codex', providerId: 'a', model: 'm', quickSettings: { env: {} } }), /不支持/);
  const claude = await routes.capture({ tool: 'claude', providerId: 'a', model: 'm', quickSettings: { agentTeams: false, agentWindow: 'in-process', effort: 'high' } });
  const c = await routes.launch({ tool: 'claude', route: claude, sessionId: randomUUID() });
  assert.equal(c.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '0');
  assert.equal(c.settings.teammateMode, 'in-process'); assert.equal(c.settings.effortLevel, 'high');
  assert.equal(c.env.ANTHROPIC_AUTH_TOKEN, 'secret-a');
});

test('A/B sessions and restart retain routes; default changes only affect new sessions and errors cannot persist keys', async t => {
  const { directory, routes, entries } = await fixture(t);
  let defaults = [{ tool: 'codex', providerId: 'a', model: 'model-a' }], fail = false;
  const launches = [];
  class Fake {
    config = {};
    async connect(session) {
      if (fail) throw new Error('argv contains secret-a');
      launches.push({ id: session.id, env: this.config.env, model: session.model });
      return { nativeId: session.nativeId || 'native-' + session.id, close: async () => {} };
    }
  }
  let runtime = await new Commander({ dataDir: join(directory, 'state'), routeService: routes }).open();
  runtime.providers.set('codex', new Fake()); runtime.toolProfiles = { list: async () => ({ defaults }), runtime: () => { throw Error('must never read global profile'); } };
  const a = await runtime.create({ provider: 'codex' });
  defaults = [{ tool: 'codex', providerId: 'b', model: 'model-b' }];
  const b = await runtime.create({ provider: 'codex' });
  await runtime.disconnect(a.id); await runtime.connect(a.id);
  assert.equal(launches.at(-1).env.DSH_PLUS_SESSION_API_KEY, 'secret-a');
  assert.equal(launches.at(-1).model, 'model-a');
  await runtime.close();
  runtime = await new Commander({ dataDir: join(directory, 'state'), routeService: routes }).open();
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); }); runtime.providers.set('codex', new Fake());
  runtime.toolProfiles = { list: () => { throw Error('reconnect must not read default'); } };
  await runtime.connect(a.id); await runtime.connect(b.id);
  assert.equal(launches.at(-2).env.DSH_PLUS_SESSION_API_KEY, 'secret-a');
  assert.equal(launches.at(-1).env.DSH_PLUS_SESSION_API_KEY, 'secret-b');
  await runtime.disconnect(a.id); fail = true;
  await assert.rejects(runtime.connect(a.id), /隔离工具启动失败/);
  assert.equal(JSON.stringify(runtime.list()).includes('secret-a'), false);
  await runtime.persist();
  assert.equal((await readFile(join(directory, 'state', 'sessions.json'), 'utf8')).includes('secret-a'), false);
  fail = false; entries.a.baseURL = 'https://changed.example';
  await assert.rejects(runtime.connect(a.id), /已更改/);
});

test('legacy native sessions never capture defaults or move native handles into managed homes', async t => {
  const { directory, routes } = await fixture(t);
  const runtime = await new Commander({ dataDir: join(directory, 'legacy'), routeService: routes }).open();
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  let nativeConfig;
  runtime.providers.set('codex', { config: {}, async connect(session) { nativeConfig = this.config; return { nativeId: session.nativeId, close: async () => {} }; } });
  runtime.toolProfiles = { list: () => { throw Error('native import must not read defaults'); }, runtime: () => { throw Error('must not read profiles'); } };
  const old = await runtime.create({ provider: 'codex', nativeId: 'old-native-handle' });
  assert.equal(old.route, undefined); assert.equal(old.routeMode, 'native-unbound');
  assert.equal(nativeConfig.env.CODEX_HOME, undefined);
  const explicit = await runtime.create({ provider: 'codex', nativeMode: true });
  assert.equal(explicit.routeMode, 'native-unbound');
  await runtime.disconnect(old.id); await runtime.connect(old.id);
  await assert.rejects(runtime.create({ provider: 'codex', nativeId: 'other-native', route: { providerId: 'a', model: 'm' } }), /已有原生会话/);
});

test('explicit model routes inherit tool quick settings once without changing their supplier', async t => {
  const { directory, routes } = await fixture(t);
  const runtime = await new Commander({ dataDir: join(directory, 'quick-default'), routeService: routes }).open();
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  let defaults = [{ tool: 'codex', providerId: 'a', model: 'default-a', quickSettings: { effort: 'high' } }];
  runtime.toolProfiles = { list: async () => ({ defaults }) };
  runtime.providers.set('codex', { config: {}, async connect(session) { return { nativeId: session.id, close: async () => {} }; } });
  const session = await runtime.create({ provider: 'codex', route: { providerId: 'b', model: 'explicit-b' } });
  assert.equal(session.route.providerId, 'b'); assert.equal(session.model, 'explicit-b');
  assert.equal(session.route.quickSettings.effort, 'high');
  defaults[0].quickSettings.effort = 'low';
  await runtime.disconnect(session.id); await runtime.connect(session.id);
  assert.equal(runtime.snapshot(session.id).route.quickSettings.effort, 'high');
});

test('subscription routes retain native login homes, reject cross-tool use and never resolve API secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-routes-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const access = { id: 'subscription', authMode: 'subscription', configured: true, harnessTools: ['codex'] };
  const routes = createSessionRoutes({ directory, providers: { resolve() { throw Error('must not resolve API secrets'); }, describeAccess: async () => access } });
  const route = await routes.capture({ tool: 'codex', providerId: 'subscription', model: 'subscription-model' });
  assert.equal(route.mode, 'subscription'); assert.equal(route.baseURL, undefined);
  const launch = await routes.launch({ tool: 'codex', route, sessionId: randomUUID() });
  assert.equal(launch.env.CODEX_HOME, undefined); assert.equal(Object.hasOwn(launch.env, 'CODEX_HOME'), false);
  assert.equal(launch.managedProfile.subscription, true); assert.equal(launch.managedProfile.isolated, false);
  assert.equal(launch.commandArgs.includes('model_provider="openai"'), true);
  assert.equal(launch.commandArgs.includes('force_login_method="chatgpt"'), true);
  await assert.rejects(routes.capture({ tool: 'claude', providerId: 'subscription', model: 'm' }), /对应/);
  access.configured = false;
  await assert.rejects(routes.launch({ tool: 'codex', route, sessionId: randomUUID() }), /失效/);
  access.configured = true; access.harnessTools = ['claude'];
  const c = await routes.capture({ tool: 'claude', providerId: 'subscription', model: 'claude-model' });
  const claude = await routes.launch({ tool: 'claude', route: c, sessionId: randomUUID() });
  assert.equal(Object.hasOwn(claude.env, 'CLAUDE_CONFIG_DIR'), false);
  assert.equal(claude.settings.forceLoginMethod, 'claudeai');
  assert.deepEqual(claude.settingSources, []);
});
