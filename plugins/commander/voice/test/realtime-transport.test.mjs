import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { RealtimeRecognizer } from '../client/asr.mjs';
import { createVoiceHandlers, mountWeb } from '../src/web.mjs';
import { createWorkbench } from '../../../link/src/transport/workbench.mjs';

const frame = value => new Int16Array(480).fill(value);
class BrowserSocket extends EventTarget {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(raw) { this.sent.push(typeof raw === 'string' ? JSON.parse(raw) : raw); }
  event(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { this.readyState = 3; }
}
async function browser() {
  let now = 1000; const ws = new BrowserSocket(), warnings = [], errors = [];
  const recognizer = new RealtimeRecognizer({ request: async (_url, options) => Response.json(JSON.parse(options.body).action === 'asr.start' ? { id: 's', ticket: 't' } : {}), endpoint: path => 'https://test/' + path, headers: () => ({}), openSocket: () => { queueMicrotask(() => { ws.dispatchEvent(new Event('open')); ws.event({ type: 'ready', epoch: 0 }); }); return ws; }, onError: error => errors.push(error), onWarning: value => warnings.push(value), now: () => now });
  await recognizer.start();
  return { recognizer, ws, warnings, errors, clock: value => { now = value; } };
}
const binary = ws => ws.sent.filter(value => value instanceof Uint8Array);
const pcm = packet => new DataView(packet.buffer, packet.byteOffset).getInt16(12, true);

test('continuous PCM sends before ACK and bounds the in-flight window under delayed network', async t => {
  const h = await browser(); t.after(() => h.recognizer.close());
  for (let i = 0; i < 50; i++) h.recognizer.append([frame(i)], 1, () => {});
  assert.equal(binary(h.ws).length, 12); assert.equal(h.recognizer.inflight.size, 12);
  assert.equal(h.recognizer.queue.length, 30); assert.equal(h.warnings.length, 1);
  h.ws.event({ type: 'ack', epoch: 0, sequence: 1, accepted: true });
  assert.equal(pcm(binary(h.ws).at(-1)), 20); // Old unsent frames, not recent speech, are discarded.
  assert.equal(h.recognizer.inflight.size, 12);
});

test('stale pending audio expires and commit stays ordered across overlapping utterances', async t => {
  const h = await browser(); t.after(() => h.recognizer.close());
  h.recognizer.append([frame(1)], 1, () => {}); const first = h.recognizer.commit(1);
  h.recognizer.append([frame(2)], 2, () => {}); const second = h.recognizer.commit(2);
  assert.equal(binary(h.ws).length, 1);
  h.clock(1700); h.recognizer.pump();
  assert.equal(h.recognizer.queue.filter(item => item.type === 'audio').length, 0);
  h.ws.event({ type: 'final', epoch: 0, utteranceId: 1, text: '第一句' });
  assert.equal(await first, '第一句');
  assert.equal(h.ws.sent.at(-1).utteranceId, 2);
  h.ws.event({ type: 'final', epoch: 0, utteranceId: 2, text: '' });
  assert.equal(await second, ''); assert.equal(h.recognizer.utterances.size, 0);
});

test('clear bypasses congested audio, rejects old final and gates fresh audio until ready', async t => {
  const h = await browser(); t.after(() => h.recognizer.close());
  h.ws.bufferedAmount = 5000;
  h.recognizer.append([frame(1)], 1, () => {}); const old = h.recognizer.commit(1);
  const clearing = h.recognizer.clear(); assert.equal(h.ws.sent.at(-1).type, 'clear');
  await assert.rejects(old, { name: 'AbortError' });
  h.recognizer.append([frame(2)], 2, () => {}); const next = h.recognizer.commit(2);
  h.ws.event({ type: 'final', epoch: 0, utteranceId: 2, text: 'stale' });
  h.ws.bufferedAmount = 0; h.ws.event({ type: 'ready', epoch: 1 }); await clearing;
  assert.deepEqual(binary(h.ws).map(pcm), [2]);
  h.ws.event({ type: 'final', epoch: 1, utteranceId: 2, text: '新' }); assert.equal(await next, '新');
});

test('upstream congestion warnings do not hang up and lost ACK eventually closes media', async t => {
  const h = await browser(); t.after(() => h.recognizer.close());
  h.recognizer.append([frame(1)], 1, () => {});
  h.ws.event({ type: 'ack', epoch: 0, sequence: 1, accepted: false });
  assert.equal(h.recognizer.closed, false); assert.equal(h.warnings.length, 1);
  h.recognizer.append([frame(2)], 1, () => {}); h.clock(14000); h.recognizer.pump();
  assert.equal(h.recognizer.closed, true); assert.equal(h.errors.length, 1); assert.equal(h.recognizer.queue.length, 0);
});

class Upstream extends EventEmitter {
  constructor() { super(); this.sent = []; this.bufferedAmount = 0; queueMicrotask(() => this.emit('open')); }
  send(raw) { const event = JSON.parse(raw); this.sent.push(event); this.emit('sent', event); if (event.type === 'session.update') queueMicrotask(() => this.event({ type: 'session.updated' })); }
  event(event) { this.emit('message', JSON.stringify(event)); }
  close() { this.closed = true; }
}
async function fixture(t, { link = false } = {}) {
  const upstreams = [], value = { dictation: true, call: true, readAloud: true, asr: { protocol: 'step-websocket', model: 'exact-provider-model', baseURL: 'https://upstream.test' }, tts: { model: 'exact-speaker', baseURL: 'https://tts.test' } };
  const store = { value, snapshot: () => value }, handlers = createVoiceHandlers(store, { socket: () => { const ws = new Upstream(); upstreams.push(ws); return ws; } });
  const server = createServer(), wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  let workbench, context, cookie;
  if (link) {
    context = new Context(); context.provide('connection', { createPeer: () => ({ dispose: async () => {} }) });
    await context.inject(['connection'], child => { child.provide('voice', { acceptRealtimeSocket: handlers.acceptRealtimeSocket }); });
    await context.inject(['connection'], child => { workbench = createWorkbench(child, { state: { devices: [{ id: 'device', tokenHash: 'hash' }] } }); });
    workbench.begin({ id: 'device', tokenHash: 'hash' }, { setHeader(_key, value) { cookie = value.split(';')[0]; } });
  }
  server.on('upgrade', (req, socket, head) => link ? workbench.upgrade(req, socket, head) : wss.handleUpgrade(req, socket, head, handlers.acceptRealtimeSocket));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => { handlers.dispose(); for (const ws of clients) ws.terminate(); await workbench?.close(); await context?.fiber.dispose(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  const action = async (action, extra = {}, callId = '') => handlers.config(new Request('http://test/api/voice', { method: 'POST', headers: { 'content-type': 'application/json', ...(callId ? { 'x-voice-call-id': callId } : {}) }, body: JSON.stringify({ action, ...extra }) }));
  const start = async callId => (await action('asr.start', {}, callId)).json();
  const openSocket = () => { const ws = new WebSocket('ws://127.0.0.1:' + server.address().port, { headers: cookie ? { cookie } : {} }); clients.push(ws); ws.on('error', () => {}); return ws; };
  const connect = async () => { const ws = openSocket(); await once(ws, 'open'); return ws; };
  const attach = async (session, callId = '') => { const ws = await connect(), ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'attach', ...session, callId })); const [raw] = await ready; assert.equal(JSON.parse(String(raw)).type, 'ready'); return ws; };
  return { handlers, action, start, connect, attach, openSocket, upstreams };
}
const message = async ws => JSON.parse(String((await once(ws, 'message'))[0]));
const packet = (epoch, id, seq, sample = 123) => { const bytes = Buffer.alloc(972); bytes.writeUInt32LE(epoch, 0); bytes.writeUInt32LE(id, 4); bytes.writeUInt32LE(seq, 8); bytes.writeInt16LE(sample, 12); return bytes; };

test('real socket forwards binary PCM, partial/final, congestion ACK and reset epoch', { timeout: 10000 }, async t => {
  const f = await fixture(t), session = await f.start(), ws = await f.attach(session);
  let pending = message(ws); ws.send(packet(0, 1, 1)); assert.equal((await pending).accepted, true);
  assert.equal(Buffer.from(f.upstreams[0].sent.at(-1).audio, 'base64').readInt16LE(), 123);
  const committed = once(f.upstreams[0], 'sent');
  ws.send(JSON.stringify({ type: 'commit', epoch: 0, utteranceId: 1 })); assert.equal((await committed)[0].type, 'input_audio_buffer.commit');
  pending = message(ws); f.upstreams[0].event({ type: 'conversation.item.input_audio_transcription.completed', transcript: '你好' });
  assert.deepEqual(await pending, { type: 'final', text: '你好', utteranceId: 1, epoch: 0 });
  f.upstreams[0].bufferedAmount = 20000; pending = message(ws); ws.send(packet(0, 2, 2)); assert.equal((await pending).accepted, false);
  pending = message(ws); ws.send(JSON.stringify({ type: 'commit', epoch: 0, utteranceId: 2 })); assert.equal((await pending).text, '');
  pending = message(ws); ws.send(JSON.stringify({ type: 'clear', epoch: 1 })); assert.deepEqual(await pending, { type: 'ready', epoch: 1 });
  assert.equal(f.upstreams[0].closed, true);
  pending = message(ws); ws.send(packet(1, 3, 3)); assert.equal((await pending).epoch, 1);
  const closed = once(ws, 'close'); ws.close(); await closed; assert.equal(f.upstreams[1].closed, true);
  assert.equal((await f.action('asr.events', { id: session.id })).status, 400);
  assert.equal((await f.action('asr.commit', { id: session.id, utteranceId: 1 })).status, 400);
});

test('one-use ticket cannot be replayed or attached to a different call', async t => {
  const f = await fixture(t), session = await f.start(), owner = await f.attach(session);
  const replay = await f.connect(), rejection = message(replay); replay.send(JSON.stringify({ type: 'attach', ...session })); assert.equal((await rejection).type, 'error');
  assert.equal(owner.readyState, 1); assert.equal(f.upstreams[0].closed, undefined);
  const another = await f.start(), wrong = await f.connect(), rejected = message(wrong); wrong.send(JSON.stringify({ type: 'attach', ...another, callId: 'wrong' })); assert.equal((await rejected).type, 'error');
});

test('ending call lease closes both media sockets immediately', async t => {
  const f = await fixture(t), call = await (await f.action('call.start', { sessionId: 'chat', deviceId: 'device' })).json();
  const session = await f.start(call.call.callId), ws = await f.attach(session, call.call.callId), closed = once(ws, 'close');
  assert.equal((await f.action('call.end', call.call)).status, 200); await closed; assert.equal(f.upstreams[0].closed, true);
});

test('Web/Desktop upgrade route uses official owner admission before accepting socket', () => {
  const effects = [], upgrades = [], store = { value: {}, snapshot: () => ({}) };
  const ctx = { effect: fn => effects.push(fn()), connection: { fetch: { register: () => () => {} }, requestRejection: () => 403 }, inject: (_names, fn) => fn(ctx), webServer: { registerUpgrade: route => { upgrades.push(route); return () => {}; } } };
  mountWeb(ctx, store); assert.equal(upgrades[0].path, '/api/voice/realtime');
  let response; upgrades[0].handler({}, { end: value => { response = value; } }, Buffer.alloc(0)); assert.match(response, /^HTTP\/1.1 403/);
  for (const cleanup of effects.reverse()) cleanup?.(); assert.equal(store.acceptRealtimeSocket, undefined);
});

test('repeated mute while reset is pending discards newly captured frames too', async t => {
  const h = await browser(); t.after(() => h.recognizer.close());
  const first = h.recognizer.clear();
  h.recognizer.append([frame(1)], 1, () => {}); const old = h.recognizer.commit(1);
  const second = h.recognizer.clear(); assert.equal(first, second);
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(h.recognizer.queue.length, 0); assert.equal(h.recognizer.utterances.size, 0);
  h.ws.event({ type: 'ready', epoch: 1 }); await second;
  h.recognizer.append([frame(2)], 2, () => {}); assert.deepEqual(binary(h.ws).map(pcm), [2]);
});

for (const link of [false, true]) test('client PCM to upstream final over real ' + (link ? 'Cordis Link' : 'owner') + ' socket', { timeout: 10000 }, async t => {
  const f = await fixture(t, { link }), errors = [];
  const recognizer = new RealtimeRecognizer({ request: (_url, options) => f.handlers.config(new Request('http://test/api/voice', options)), endpoint: () => 'http://test/api/voice', headers: () => ({}), openSocket: f.openSocket, onError: error => errors.push(error) });
  t.after(() => recognizer.close()); await recognizer.start();
  const upstream = f.upstreams[0];
  const committed = new Promise(resolve => { const sent = event => { if (event.type === 'input_audio_buffer.commit') { upstream.off('sent', sent); resolve(event); } }; upstream.on('sent', sent); });
  recognizer.append([frame(321)], 1, () => {}); const final = recognizer.commit(1);
  assert.equal((await committed).type, 'input_audio_buffer.commit');
  assert.equal(Buffer.from(f.upstreams[0].sent.find(event => event.type === 'input_audio_buffer.append').audio, 'base64').readInt16LE(), 321);
  f.upstreams[0].event({ type: 'conversation.item.input_audio_transcription.completed', transcript: '连续上行成功' });
  assert.equal(await final, '连续上行成功'); assert.deepEqual(errors, []);
  await recognizer.clear(); assert.equal(f.upstreams[0].closed, true);
  await recognizer.close(); assert.equal(f.upstreams[1].closed, true);
});

test('closing while start response is pending releases its late session without opening socket', async () => {
  let resolve, opens = 0; const actions = [], response = new Promise(r => { resolve = r; });
  const recognizer = new RealtimeRecognizer({ request: async (_url, options) => { const action = JSON.parse(options.body); actions.push(action); return action.action === 'asr.start' ? response : Response.json({}); }, endpoint: () => 'http://test/api/voice', headers: () => ({}), openSocket: () => { opens++; } });
  const start = recognizer.start(); await recognizer.close(); resolve(Response.json({ id: 'late-session', ticket: 'ticket' }));
  await assert.rejects(start, { name: 'AbortError' }); assert.equal(opens, 0);
  assert.deepEqual(actions.map(({ action, id }) => ({ action, ...(id ? { id } : {}) })), [{ action: 'asr.start' }, { action: 'asr.end', id: 'late-session' }]);
});
