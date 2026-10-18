import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createPreviewRuntime } from '../client/preview.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const root = new URL('../', import.meta.url);

async function pair(runtime) {
  runtime.completeScan();
  const context = runtime.pairingContext(runtime.contextUri(runtime.bootstrap()));
  runtime.saveIdentity({ ...context, name: '演示手机' });
  const pending = await runtime.call('pair', { code: context.code, name: '演示手机' });
  runtime.decide('approved');
  const approved = await runtime.call('pair/status', pending);
  runtime.saveIdentity({ ...context, token: approved.token, deviceId: approved.deviceId, name: '演示手机' });
  return approved;
}

test('preview pairing requires explicit desktop approval and supports rejection and expiry', async () => {
  const runtime = createPreviewRuntime();
  let notifications = 0; const unsubscribe = runtime.subscribe(() => notifications++);
  runtime.completeScan(); assert.equal(notifications, 1); unsubscribe();
  assert.equal(runtime.bootstrap().token, undefined);
  const pending = await runtime.call('pair', { code: 'DEMO-ONLY' });
  assert.equal((await runtime.call('pair/status', pending)).status, 'pending');
  await assert.rejects(runtime.call('state'), /先完成演示配对/);
  runtime.decide('rejected'); assert.equal((await runtime.call('pair/status', pending)).token, undefined);
  assert.equal((await runtime.call('pair/status', pending)).status, 'rejected');
  runtime.decide('expired'); assert.equal((await runtime.call('pair/status', pending)).status, 'expired');
  assert.equal((await pair(runtime)).token, 'demo-token-in-memory');
  assert.equal((await runtime.call('state')).projects.length, 2);
});

test('preview model selection, create and message retries are idempotent', async () => {
  const runtime = createPreviewRuntime(); runtime.enterWorkspace();
  const state = await runtime.call('state');
  const args = { projectId: state.projects[0].id, provider: 'demo', model: 'creative', requestId: 'create-1' };
  const session = await runtime.call('create', args);
  assert.deepEqual(await runtime.call('create', args), session);
  assert.equal((await runtime.call('state')).sessions.filter(item => item.id === session.id).length, 1);
  const message = { id: session.id, text: '优化手机连接', requestId: 'send-1' };
  await runtime.call('send', message); await runtime.call('send', message);
  const history = await runtime.call('history', { id: session.id });
  assert.equal(history.messages.length, 2); assert.equal(history.messages[0].text, message.text);
  assert.match(history.messages[1].text, /创意模式.*固定演示回复/s);
  state.projects[0].name = 'overwritten';
  assert.equal((await runtime.call('state')).projects[0].name, 'Dowork');
});

test('preview simulates connection failure and recovery without network or storage calls', async () => {
  const touched = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { touched.push('fetch'); throw new Error('unexpected fetch'); };
  try {
    const runtime = createPreviewRuntime(); runtime.enterWorkspace();
    runtime.setNetworkFailure(true); await assert.rejects(runtime.call('state'), /暂时无法连接/);
    runtime.setNetworkFailure(false); assert.ok((await runtime.call('state')).sessions.length);
    runtime.clearIdentity(); assert.equal(runtime.bootstrap(), null);
    await assert.rejects(runtime.call('state'), /先完成演示配对/);
    const source = await readFile(new URL('../client/preview.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /sessionStorage|localStorage|LinkNative|fetch\(|from ['"].*api/);
    assert.deepEqual(touched, []);
  } finally { globalThis.fetch = oldFetch; }
});

test('preview browser mode stays same-origin while scan and workspace remain local fixtures', async () => {
  const runtime = createPreviewRuntime({ native: false });
  assert.equal(runtime.isNative(), false);
  const context = runtime.pairingContext('demo-code'); assert.equal(context.code, 'DEMO-ONLY');
  assert.equal(context.url, globalThis.location?.origin || 'https://preview.invalid');
  runtime.enterWorkspace(); assert.equal(runtime.bootstrap().deviceId, 'demo-device');
});

test('shared mobile view renders compact pairing and accessible navigation; /mobile enters the real Link flow', async () => {
  const result = await build({
  stdin: { contents: "import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { LinkMobileApp } from './client/mobile.jsx'; import { MobileSidebar, SessionList } from './client/mobile-navigation.jsx'; import { createPreviewRuntime } from './client/preview.mjs'; export const renderNavigation = () => { const state={ projects:[{id:'a',name:'项目甲'},{id:'b',name:'项目乙'}], sessions:[{id:'one',projectId:'a',title:'第一项工作',updatedAt:Date.now()},{id:'two',projectId:'b',title:'第二项工作',running:true,updatedAt:Date.now()}] }; return renderToStaticMarkup(<><MobileSidebar state={state} screen='recent' selectedId='two' connectionLabel='已连接' connectionState='running' theme='light' /><SessionList sessions={state.sessions} projects={state.projects} /></>); }; export const renderPair = () => renderToStaticMarkup(<LinkMobileApp runtime={createPreviewRuntime()} />); export const renderHome = () => { const runtime=createPreviewRuntime(); runtime.enterWorkspace(); return renderToStaticMarkup(<LinkMobileApp runtime={runtime} />); };", resolveDir: root.pathname, loader: 'jsx' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', loader: { '.css': 'text', '.svg': 'text' }, nodePaths: [new URL('../node_modules', import.meta.url).pathname], logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const module = { exports: {} }; new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  const pairing = module.exports.renderPair();
  assert.match(pairing, /扫描桌面二维码/); assert.match(pairing, /这台设备的名称/); assert.match(pairing, /link-mobile-backup/);
  assert.doesNotMatch(pairing, /YOUR WORKSPACE|不必留在桌面|<h1>.*<br/);
  const home = module.exports.renderHome(); assert.match(home, /aria-label="打开侧边栏"/); assert(home.includes('<h1>最近</h1>')); assert.match(home, /aria-label="搜索会话或项目"/); assert.match(home, /aria-label="新建会话"/);
  assert.doesNotMatch(home, /aria-label="选择项目"|class="link-mobile-nav"/);
  const navigation = module.exports.renderNavigation();
  assert.match(navigation, /role="dialog" aria-modal="true" aria-label="会话导航"/);
  assert.match(navigation, /aria-label="主导航"/); assert.match(navigation, /搜索侧边栏会话/);
  for (const text of ['第一项工作', '第二项工作', '项目甲', '项目乙', '连接管理', '切换深色主题']) assert(navigation.includes(text));
  const entry = await readFile(new URL('../scripts/build-preview.mjs', import.meta.url), 'utf8');
  assert.match(entry, /location\.replace\("\/link\/" \+ location\.search \+ location\.hash\)/);
  assert.match(entry, /href="\/link\/"/);
});

test('mobile icons exist in the shared catalog and component keeps pairing generation guards', async () => {
  const source = await readFile(new URL('../client/mobile.jsx', import.meta.url), 'utf8');
  const catalog = JSON.parse(await readFile(new URL('../../commander/client/assets/iconsax/catalog.json', import.meta.url), 'utf8'));
  const navigation = await readFile(new URL('../client/mobile-navigation.jsx', import.meta.url), 'utf8');
  const names = [...(source + navigation).matchAll(/(?:name|icon)="([A-Za-z]+)"/g)].map(match => match[1]);
  for (const name of names) assert.ok(catalog[name], 'missing icon ' + name);
  assert.match(source, /isLocalIdentitySave\(next\)/);
  assert.match(source, /generation !== pairGeneration\.current/);
  assert.match(source, /runtime\.subscribe/);
  assert.match(source, /retry \? sendPending/);
  assert.match(source, /pendingCreate\.current\.requestId/);
});
