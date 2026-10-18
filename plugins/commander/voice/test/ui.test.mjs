import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { transformSync } = require('esbuild');
const source = readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/style.css', import.meta.url), 'utf8');
const code = transformSync(source + '\nexport { ProviderSettings };', { loader: 'jsx', format: 'cjs' }).code;
function mount(overrides = {}) {
  const state = { config: { dictation: true, readAloud: true, call: true, asr: { configured: true, model: 'asr' }, tts: { configured: true, model: 'tts' } }, sessionId: 'session', mode: 'call', phase: 'listening', muted: false, level: .3, readEnabled: true, ...overrides };
  const effects = [], actions = [], registrations = [], refs = [];
  const controller = { state: { subscribe: () => () => {}, getSnapshot: () => state }, load: async () => {}, dispose: async () => {}, hangup: async () => { actions.push('hangup'); }, setMuted: async value => { actions.push(['muted', value]); } };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x !== false && x != null) }), useEffect: effect => { effects.push(effect); }, useRef: value => { const ref = { current: value }; refs.push(ref); return ref; }, useState: value => [value, () => {}], useSyncExternalStore: (_, get) => get(), useId: () => 'id' };
  const primitives = new Proxy({}, { get: (_, name) => name });
  const document = { createElement: () => ({ remove() {} }), head: { append() {} } };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, document, console, require: path => path === 'react' ? react : path.includes('ui-primitives') ? primitives : path.endsWith('controller.mjs') ? { createVoiceController: () => controller } : path.endsWith('.css') ? { default: css } : (() => { throw Error(path); })() });
  module.exports.apply({ effect() {}, slots: { inject: (_, action) => action(), register: (options, component) => { registrations.push({ options, component }); } } });
  const component = registrations.find(item => item.options.name === 'conversation.input.activity').component;
  const render = (sessionId = 'session') => component({ controller, sessionId, locked: false, inputActions: {}, onActiveChange() {} });
  return { render, effects, refs, actions, state, exports: module.exports };
}
const nodes = root => root && typeof root === 'object' ? [root, ...root.children.flatMap(nodes)] : [];
test('call composer contains only microphone and hangup controls, never read or send', async () => {
  const h = mount();
  const tree = h.render(), buttons = nodes(tree).filter(node => node.type === 'button');
  assert.deepEqual(buttons.map(node => node.props['aria-label']), ['关闭麦克风', '结束语音通话']);
  await buttons[0].props.onClick(); await buttons[1].props.onClick();
  assert.deepEqual(h.actions, [['muted', true], 'hangup']);
  const orb = nodes(tree).find(node => node.type?.name === 'CallOrb');
  const rendered = orb.type(orb.props);
  assert.equal(rendered.props.className, 'voice-call-orb voice-orb-listening');
  assert.equal(rendered.props.style['--voice-level'], .3);
});
test('muted call keeps playback phase and microphone can be enabled', async () => {
  const h = mount({ muted: true, phase: 'speaking', playbackLevel: .65 });
  const tree = h.render(), buttons = nodes(tree).filter(node => node.type === 'button');
  assert.equal(buttons[0].props['aria-label'], '开启麦克风');
  await buttons[0].props.onClick();
  assert.deepEqual(h.actions, [['muted', false]]);
  const orb = nodes(tree).find(node => node.type?.name === 'CallOrb');
  const rendered = orb.type(orb.props);
  assert.equal(rendered.props.className, 'voice-call-orb voice-orb-speaking');
  assert.equal(rendered.props.style['--voice-level'], .65);
});
test('TTS speed defaults to 1.2, stays in the supported range, and is round-tripped by settings', () => {
  const h = mount();
  assert.equal(h.exports.normalizeTtsSpeed(undefined), 1.2);
  assert.equal(h.exports.normalizeTtsSpeed('1.375'), 1.38);
  assert.equal(h.exports.normalizeTtsSpeed(0.1), 1.2);
  assert.equal(h.exports.normalizeTtsSpeed(4.5), 1.2);
  assert.equal(h.exports.draftFrom({ tts: { model: 'speaker', speed: 1.65 } }).tts.speed, 1.65);
  assert.equal(h.exports.draftFrom({ tts: { model: 'speaker' } }).tts.speed, 1.2);
});
test('reselecting a voice provider preserves choices; switching providers resets borrowed settings', () => {
  const h = mount();
  for (const name of ['asr', 'tts']) {
    const updates = [];
    const tree = h.exports.ProviderSettings({ name, draft: { providerId: 'current', model: 'chosen', protocol: name === 'asr' ? 'step-websocket' : 'step-speech' }, providers: [{ id: 'current' }, { id: 'next', baseURL: 'https://next.test/v1' }], update: value => updates.push(value) });
    const select = nodes(tree).find(node => node.props.label === '模型供应商');
    select.props.onChange('current');
    assert.equal(updates.length, 0);
    select.props.onChange('next');
    assert.equal(updates[0].providerId, 'next');
    assert.equal(updates[0].model, '');
    assert.equal(updates[0].apiKey, '');
    assert.equal(updates[0].protocol, name === 'asr' ? 'transcriptions-sse' : 'speech');
  }
});
test('editing a realtime URL preserves saved routing query and model placeholders', () => {
  const h = mount(), updates = [];
  const realtime = { url: 'wss://old.test/realtime', query: { model: '{model}', exit_id: 'chosen.route' } };
  const tree = h.exports.ProviderSettings({ name: 'asr', draft: { providerId: '', model: 'step-asr', protocol: 'step-websocket', realtime }, providers: [], update: value => updates.push(value) });
  const input = nodes(tree).find(node => node.type === 'input' && node.props.value === realtime.url);
  input.props.onChange({ target: { value: 'wss://new.test/realtime' } });
  assert.equal(updates[0].realtime.url, 'wss://new.test/realtime');
  assert.deepEqual(updates[0].realtime.query, realtime.query);
  assert.equal(realtime.url, 'wss://old.test/realtime');
});
test('call takeover restores editor inert flags and card class after cleanup', () => {
  const h = mount(); const tree = h.render();
  const activity = {}, classes = new Set(), editor = { inert: false, contains: () => false }, attachment = { inert: true, contains: () => false }, row = { contains: node => node === activity };
  const card = { children: [editor, attachment, row], classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  activity.closest = () => card; tree.props.ref.current = activity;
  const cleanup = h.effects[0]();
  assert(classes.has('voice-call-composer')); assert.equal(editor.inert, true);
  cleanup(); assert.equal(classes.size, 0); assert.equal(editor.inert, false); assert.equal(attachment.inert, true);
});
test('other sessions retain ordinary composer and no call takeover', () => {
  const h = mount(), tree = h.render('other');
  assert(!tree.props.className.includes('voice-calling'));
  assert.equal(h.effects[0](), undefined);
  assert(!nodes(tree).some(node => node.props['aria-label'] === '结束语音通话'));
});
test('voice palette and motion use blue theme and honor reduced motion', () => {
  assert(!css.includes('state-success'));
  assert(css.includes('--voice-blue:var(--dsw-alias-state-business-primary'));
  assert(css.includes('.voice-call-composer [class*="_trailing"]>:not(:has(.voice-call-panel))'));
  assert(css.includes('@media(prefers-reduced-motion:reduce){.voice-call-orb'));
});
