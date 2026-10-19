// Opt-in integration smoke against an isolated real Harness profile. No GUI or external model requests.
import { access, mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:http';
import { X509Certificate, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeBinary = resolve(process.env.LINK_TEST_NODE || join(root, 'node_modules/.toolchain/node_modules/node/bin/node'));
const profileDependencies = resolve(process.env.LINK_HARNESS_NODE_MODULES || join(root, '.local/web/home/profiles/web/node_modules'));
const tsxImport = join(root, 'deepseek-harness/node_modules/tsx/dist/esm/index.mjs');
for (const [path, mode, hint] of [
  [nodeBinary, constants.X_OK, 'Set LINK_TEST_NODE to a Node.js 24 executable'],
  [join(profileDependencies, 'dsh-plus/package.json'), constants.R_OK, 'Set LINK_HARNESS_NODE_MODULES to prepared profile node_modules containing dsh-plus'],
  [tsxImport, constants.R_OK, 'Install the official Harness workspace dependencies (tsx is required)'],
  [join(root, 'plugins/commander/lib/link.mjs'), constants.R_OK, 'Build the DSH-Plus and Link bundle first'],
]) {
  try { await access(path, mode); }
  catch { console.error(`Link live smoke prerequisite missing: ${path}. ${hint}.`); process.exit(1); }
}
const directory = await mkdtemp(join(tmpdir(), 'dsh-link-live-'));
let child;
let output = '';
let failed = false;
let modelServer;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const profile = join(directory, 'home/profiles/web');
  const workspace = join(directory, 'workspace');
  modelServer = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'link-smoke-model' }] })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const approvalPrompt = payload.messages?.findLast(message => message.role === 'user' && JSON.stringify(message.content).includes('Request a test approval'));
    const afterPrompt = approvalPrompt ? payload.messages.slice(payload.messages.indexOf(approvalPrompt)) : [];
    if (approvalPrompt && !afterPrompt.some(message => message.role === 'tool')) {
      response.write(`data: ${JSON.stringify({ id: 'smoke-approval', object: 'chat.completion.chunk', model: 'link-smoke-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'smoke-approval-call', type: 'function', function: { name: 'commander_create', arguments: JSON.stringify({ provider: 'codex', cwd: workspace }) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'smoke-approval', object: 'chat.completion.chunk', model: 'link-smoke-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      response.end('data: [DONE]\n\n'); return;
    }
    response.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', model: 'link-smoke-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Link integration passed.' }, finish_reason: null }] })}\n\n`);
    await wait(1200);
    response.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', model: 'link-smoke-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  await mkdir(profile, { recursive: true }); await mkdir(workspace);
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-link-live-profile', private: true, dependencies: { 'dsh-plus': `link:${root}/plugins/commander` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plus'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), [
    '- id: commander', `  config:`, `    dataDir: ${JSON.stringify(join(directory, 'commander'))}`,
    '- id: session-log-deepseek', '  config:', '    enabled: false',
    '- id: session-telemetry-otel', '  disabled: true',
    '- id: ui-theme', '  config:', '    preference: light',
    '- id: agent-default-model', '  config:', '    provider: link-smoke', '    model: link-smoke-model',
    '- id: llm-pi-ai', '  config:', `    providers: ${JSON.stringify({ 'link-smoke': { api: 'openai-completions', baseURL: modelUrl, headers: { Authorization: 'Bearer isolated-test-placeholder' }, models: [{ id: 'link-smoke-model', name: 'Link smoke model' }] } })}`,
  ].join('\n'));
  await symlink(profileDependencies, join(profile, 'node_modules'), 'dir');
  child = spawn(nodeBinary, ['--import', tsxImport, join(root, 'deepseek-harness/apps/cli/src/bin.ts'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: workspace,
    env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: join(root, 'deepseek-harness/tsconfig.json'), DSH_HOME: join(directory, 'home'), DSH_AGENTS_HOME: join(directory, 'agents'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  let login;
  for (let i = 0; i < 180; i++) {
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (match) { login = new URL(match[1]); break; }
    if (child.exitCode !== null) throw new Error(`Harness exited ${child.exitCode}: ${safe(output).slice(-6000)}`);
    await wait(500);
  }
  if (!login) throw new Error(`Harness startup timed out: ${safe(output).slice(-6000)}`);
  const signed = await fetch(login, { redirect: 'manual' });
  const cookie = signed.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Harness issued owner cookie');
  const registration = await fetch(`${login.origin}/api/workspace/create`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'workspace-smoke', method: 'workspace/create', payload: { args: { request: { path: workspace } } } }) });
  const registrationValue = await registration.json();
  assert.equal(registrationValue.result?.ok, true, `Workspace registration: ${JSON.stringify(registrationValue)}`);
  const admin = async input => {
    const response = await fetch(`${login.origin}/api/commander-link`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const value = await response.json(); if (!response.ok) throw new Error(`Link admin ${input.action}: ${JSON.stringify(value)}`); return value;
  };
  await admin({ action: 'status' });
  const enabled = await admin({ action: 'configure', enabled: true, host: '127.0.0.1', port: 0, publicUrl: '' });
  const pair = await admin({ action: 'pairing', mode: 'lan' });
  const expectedPin = new URL(pair.uri).searchParams.get('pin');
  const ca = JSON.parse(await readFile(join(directory, 'commander/link/tls.json'), 'utf8')).cert;
  assert.equal(createHash('sha256').update(new X509Certificate(ca).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'), expectedPin);
  const remote = async (path, input, token, headers = {}, onHeaders) => new Promise((resolve, reject) => {
    const req = httpsRequest(`https://127.0.0.1:${enabled.port}${path}`, { method: 'POST', ca, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, res => {
      onHeaders?.(res.headers);
      let bytes = ''; res.on('data', chunk => { bytes += chunk; }); res.on('end', () => { try { const value = JSON.parse(bytes); if (res.statusCode >= 400) reject(new Error(`Remote ${input.action || path}: ${JSON.stringify(value)}`)); else resolve(value); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(JSON.stringify(input));
  });
  const pending = await remote('/link/api/pair', { code: pair.code, name: 'Integration smoke' });
  assert.equal((await remote('/link/api/pair/status', pending)).status, 'pending');
  await admin({ action: 'confirm', id: pending.requestId });
  const authorized = await remote('/link/api/pair/status', pending);
  assert.equal(authorized.status, 'approved');
  const rpc = input => remote('/link/api/rpc', input, authorized.token);
  let workbenchCookie;
  await remote('/link/api/workbench', {}, authorized.token, {}, headers => { workbenchCookie = headers['set-cookie']?.[0]?.split(';')[0]; });
  assert.ok(workbenchCookie, 'paired device receives its own workbench cookie');
  const updates = input => remote('/link/workbench/api/commander/updates', input, undefined, { cookie: workbenchCookie });
  const updateStatus = await updates({ action: 'status' });
  assert.equal(updateStatus.current.plugin, JSON.parse(await readFile(join(root, 'plugins/commander/package.json'))).version);
  assert.equal(updateStatus.installation, 'server');
  assert.equal(updateStatus.managed, false, 'source profiles never falsely offer Windows self-updating');
  const configuredUpdates = await updates({ action: 'configure', source: 'github' });
  assert.equal(configuredUpdates.config.source, 'github', 'phone saves update preference on the connected host');
  await updates({ action: 'configure', source: 'mirror' });
  await assert.rejects(updates({ action: 'install' }), /服务器部署管理/);
  const state = await rpc({ action: 'state' });
  assert.ok(state.projects.length, 'Official runtime registered workspace');
  assert.ok(Array.isArray(state.models));
  const created = await rpc({ action: 'create', projectId: state.projects[0].id, requestId: 'live-smoke-create' });
  assert.ok(created.id);
  const again = await rpc({ action: 'create', projectId: state.projects[0].id, requestId: 'live-smoke-create' });
  assert.equal(created.id, again.id);
  const history = await rpc({ action: 'history', id: created.id });
  assert.ok(Array.isArray(history.messages));
  assert.ok(Array.isArray(history.interactions));
  await rpc({ action: 'send', id: created.id, text: 'Reply with the fixed test sentence.', requestId: 'live-smoke-send' });
  let answered, sawLive = false;
  for (let i = 0; i < 40; i++) {
    answered = await rpc({ action: 'history', id: created.id });
    sawLive ||= answered.messages.some(message => message.id.startsWith('live:') && message.text.includes('Link integration passed.'));
    if (!answered.running && answered.messages.some(message => message.role === 'assistant' && message.text.includes('Link integration passed.'))) break;
    await wait(250);
  }
  assert.ok(answered.messages.some(message => message.role === 'user' && message.text === 'Reply with the fixed test sentence.'), 'official user message is visible');
  assert.ok(answered.messages.some(message => message.role === 'assistant' && message.text.includes('Link integration passed.')), `official assistant message is visible: ${JSON.stringify(answered)}`);
  assert.ok(sawLive, 'official transient assistant stream is visible before turn completion');
  await rpc({ action: 'send', id: created.id, text: 'Request a test approval for a coding agent; the human will deny it.', requestId: 'live-smoke-approval' });
  let approval;
  for (let i = 0; i < 40; i++) {
    const pendingHistory = await rpc({ action: 'history', id: created.id });
    approval = pendingHistory.interactions.find(interaction => interaction.kind === 'permission');
    if (approval) break;
    await wait(250);
  }
  assert.ok(approval, 'real official approval waterfall reaches paired device');
  await rpc({ action: 'respond', id: created.id, interactionId: approval.id, answer: { allow: false } });
  let afterApproval;
  for (let i = 0; i < 40; i++) {
    afterApproval = await rpc({ action: 'history', id: created.id });
    if (!afterApproval.running && !afterApproval.interactions.length) break;
    await wait(250);
  }
  assert.equal(afterApproval.interactions.length, 0);
  assert.ok(afterApproval.messages.some(message => message.role === 'tool' && message.text.includes('not approved')), 'denied launch produced an official tool result without launching a native CLI');
  // Same official owner channel used by the desktop device launcher.
  const launchResponse = await fetch(login.origin + '/api/commander-devices', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch', parentOrigin: login.origin }) });
  assert.equal(launchResponse.status, 200);
  const launch = await launchResponse.json();
  const entry = await fetch(launch.url, { redirect: 'manual' });
  assert.equal(entry.status, 303);
  const centreBase = new URL(entry.headers.get('location'), launch.url);
  const centreCall = async input => {
    const response = await fetch(new URL('api/devices', centreBase), { method: 'POST', headers: { origin: centreBase.origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  assert.equal((await centreCall({ action: 'list' })).devices[0].id, 'local');
  const nextPair = await admin({ action: 'pairing', mode: 'lan' });
  const waiting = await centreCall({ action: 'pair', uri: nextPair.uri, name: 'Second computer' });
  assert.equal((await centreCall({ action: 'pairStatus', requestId: waiting.requestId })).status, 'pending');
  const request = (await admin({ action: 'status' })).pending.find(value => value.name === 'Second computer');
  await admin({ action: 'confirm', id: request.id });
  const paired = await centreCall({ action: 'pairStatus', requestId: waiting.requestId });
  assert.equal(paired.status, 'approved'); assert.ok(paired.device.id); assert.equal(paired.device.token, undefined);
  const selected = await centreCall({ action: 'select', deviceId: paired.device.id });
  const workspaceEntry = await fetch(selected.url, { redirect: 'manual' });
  const workspaceBase = new URL(workspaceEntry.headers.get('location'), selected.url);
  const workspacePage = await fetch(workspaceBase);
  const html = await workspacePage.text(); assert.equal(workspacePage.status, 200); assert.ok(html.includes('/s/')); assert.ok(html.includes('/local-proxy.js'));
  const bridge = await fetch(new URL('workbench.js', workspaceBase)); assert.equal(bridge.status, 200); assert.ok((await bridge.text()).includes('__DSH_LINK_LOCAL_PROXY__'));
  const hostStatus = await fetch(new URL('api/commander', workspaceBase), { method: 'POST', headers: { origin: workspaceBase.origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'state' }) });
  assert.equal(hostStatus.status, 200);
  const blocked = await fetch(new URL('api/commander-devices', workspaceBase), { method: 'POST', headers: { origin: workspaceBase.origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch' }) });
  assert.equal(blocked.status, 403);
  await centreCall({ action: 'select', deviceId: 'local' });
  await centreCall({ action: 'remove', deviceId: paired.device.id });
  assert.equal((await centreCall({ action: 'list' })).devices.length, 1);
  await admin({ action: 'revoke', id: authorized.deviceId });
  await assert.rejects(rpc({ action: 'state' }), /授权/);
  await assert.rejects(updates({ action: 'status' }), /授权/);
  await admin({ action: 'configure', enabled: false });
  console.log(JSON.stringify({ passed: ['real Harness boot', 'owner admin', 'TLS trusted CA and SPKI binding', 'pair confirm', 'remote state/models', 'paired workbench plugin update API and host preferences', 'official create idempotency', 'official history snapshot', 'mock model send and live/final assistant history', 'official approval deny and tool result', 'device revoke', 'local centre launch and host pairing', 'isolated desktop workbench and owner API boundary'], models: state.models.length, sessions: state.sessions.length }));
} catch (error) {
  failed = true;
  console.error(safe(error.message));
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(10_000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  await rm(directory, { recursive: true, force: true });
  if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)); }
}
if (failed) process.exitCode = 1;

function safe(value) { return String(value).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').replace(/(Bearer\s+)[\w.-]+/g, '$1[redacted]'); }
