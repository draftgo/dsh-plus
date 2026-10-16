import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceConfig, updateConfig, publicConfig, migrateLegacyConfig } from '../src/config.mjs';
import { createVoiceHandlers, mountWeb } from '../src/web.mjs';
import { validateWav } from '../src/media.mjs';
import { CallLeases } from '../src/calls.mjs';

const json = (path, input, extras = {}) => new Request(`http://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...extras.headers }, body: JSON.stringify(input), ...extras });
function wav(samples = 2400, rate = 24000) {
  const bytes = Buffer.alloc(44 + samples * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40); return bytes;
}
const input = bytes => new Request('http://app.test/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: bytes });

test('shared provider references clear borrowed secrets and resolve server-side only', async () => {
  const store = memory();
  await store.configure({ asr: { providerId: 'routergo', baseURL: 'https://ignored.test', apiKey: 'clear-me', model: 'whisper-test' } });
  assert.equal(store.value.asr.apiKey, ''); assert.equal(store.value.asr.baseURL, '');
  const handlers = createVoiceHandlers(store, { providers: {
    resolve: async () => ({ baseURL: 'https://shared.test/v1', apiKey: 'server-only-key' }),
  }, fetcher: async (url, options) => {
    assert.equal(url, 'https://shared.test/v1/audio/transcriptions');
    assert.equal(options.headers.authorization, 'Bearer server-only-key');
    return Response.json({ text: 'shared success' });
  } });
  const safe = await (await handlers.config(json('/api/voice', { action: 'config' }))).json();
  assert.equal(safe.config.asr.baseURL, 'https://shared.test/v1');
  assert.equal(safe.config.asr.configured, true);
  assert.equal(JSON.stringify(safe).includes('server-only-key'), false);
  const result = await handlers.transcribe(input(wav())); assert.equal(result.status, 200);
  assert.equal((await result.json()).text, 'shared success'); handlers.dispose();
});

test('unavailable shared provider disables voice without exposing resolver errors', async () => {
  const store = memory(); await store.configure({ asr: { providerId: 'removed' } });
  const handlers = createVoiceHandlers(store, { providers: { resolve: async () => { throw Error('private-error'); } } });
  const safe = await (await handlers.config(json('/api/voice', { action: 'config' }))).json();
  assert.equal(safe.config.asr.configured, false);
  const result = await handlers.transcribe(input(wav())); assert.equal(result.status, 409);
  assert.equal((await result.text()).includes('private-error'), false); handlers.dispose();
});
const memory = () => ({
  value: { dictation: true, readAloud: true, call: true, asr: { baseURL: 'https://asr.test/v1', model: 'recognizer', apiKey: 'secret-for-test' }, tts: { baseURL: 'https://tts.test/v1', model: 'speaker', apiKey: 'other-secret', voice: 'alloy' } },
  snapshot() { return publicConfig(this.value); }, async configure(patch) { this.value = updateConfig(this.value, patch); return this.snapshot(); },
});

test('configuration is durable, private, masked and serialized without losing concurrent changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-config-'));
  try {
    const store = await new VoiceConfig({ dataDir: directory }).open();
    await Promise.all([store.configure({ dictation: true, asr: { baseURL: 'http://localhost:8000/v1/', apiKey: 'keep-me', model: 'whisper' } }), store.configure({ readAloud: true })]);
    const publicValue = store.snapshot();
    assert.equal(publicValue.asr.apiKey, undefined); assert.equal(publicValue.asr.apiKeyMasked, '••••••••'); assert.equal(publicValue.asr.configured, true);
    assert.equal(JSON.stringify(publicValue).includes('keep-me'), false);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    const reopened = await new VoiceConfig({ dataDir: directory }).open();
    assert.equal(reopened.value.dictation, true); assert.equal(reopened.value.readAloud, true); assert.equal(reopened.value.asr.apiKey, 'keep-me');
    await reopened.configure({ asr: { model: 'new-model' } }); assert.equal(reopened.value.asr.apiKey, 'keep-me');
    await reopened.configure({ asr: { apiKey: '' } }); assert.equal(reopened.snapshot().asr.apiKeyConfigured, false);
    assert.equal(JSON.parse(await readFile(store.path, 'utf8')).asr.model, 'new-model');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('configuration rejects unsafe URL shapes, unknown fields and header injection', () => {
  const value = memory().value;
  for (const baseURL of ['file:///etc/passwd', 'https://user:password@example.test', 'https://example.test/?key=secret', 'https://example.test/#secret']) assert.throws(() => updateConfig(value, { asr: { baseURL } }));
  assert.throws(() => updateConfig(value, { asr: { apiKey: 'x\r\nsecret' } }));
  assert.throws(() => updateConfig(value, { typo: true }));
  assert.throws(() => updateConfig(value, { call: 'true' }));
});

test('routes inherit official owner-only Connection routes and use streaming bounded request bodies', () => {
  const registered = [], effects = [];
  mountWeb({ effect(fn) { effects.push(fn()); }, connection: { fetch: { register(route) { registered.push(route); return () => {}; } } } }, memory());
  assert.deepEqual(registered.map(route => route.path), ['/api/voice', '/api/voice/transcribe', '/api/voice/speech', '/api/voice/realtime/audio', '/api/voice/worklet']);
  assert.equal(registered.slice(0, 4).every(route => route.requestBody === 'streaming' && route.methods.join() === 'POST'), true);
  assert.deepEqual(registered[4].methods, ['GET']);
  for (const cleanup of effects) cleanup?.();
});

test('config API blocks cross-site requests while accepting trusted proxy Host', async () => {
  const handlers = createVoiceHandlers(memory());
  assert.equal((await handlers.config(json('/api/voice', { action: 'config' }, { headers: { 'content-type': 'application/json', origin: 'https://attacker.test' } }))).status, 403);
  assert.equal((await handlers.config(json('/api/voice', { action: 'config' }, { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }))).status, 403);
  const response = await handlers.config(json('/api/voice', { action: 'config' }, { headers: { 'content-type': 'application/json', host: 'dsh.test', origin: 'https://dsh.test' } }));
  assert.equal(response.status, 200); assert.equal(JSON.stringify(await response.json()).includes('secret-for-test'), false);
});

test('ASR verifies WAV, forwards configured model and returns only transcription', async () => {
  let seen = false;
  const handlers = createVoiceHandlers(memory(), { fetcher: async (url, options) => {
    seen = true; assert.equal(url, 'https://asr.test/v1/audio/transcriptions'); assert.equal(options.headers.authorization, 'Bearer secret-for-test'); assert.equal(options.body.get('model'), 'recognizer'); assert.equal(options.body.get('file').type, 'audio/wav'); assert.equal(options.redirect, 'error');
    return Response.json({ text: ' hello ', dangerous: 'ignore' });
  } });
  assert.equal((await handlers.transcribe(input(Buffer.from('not-wav')))).status, 400); assert.equal(seen, false);
  assert.deepEqual(await (await handlers.transcribe(input(wav()))).json(), { text: 'hello' });
  assert.throws(() => validateWav(wav(16 * 24000)), /15 seconds/u);
  const invalid = wav(); invalid.writeUInt16LE(2, 22); assert.throws(() => validateWav(invalid), /mono/u);
});

test('upstream failures never expose body, URL, API key or native exception text', async () => {
  const handlers = createVoiceHandlers(memory(), { fetcher: async () => new Response('Bearer secret-for-test', { status: 401 }) });
  const response = await handlers.transcribe(input(wav())); assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'ASR service rejected the request (401)', code: 'asr_http_401' });
  const network = createVoiceHandlers(memory(), { fetcher: async () => { throw new Error('secret-for-test @ https://asr.test'); } });
  assert.equal((await (await network.transcribe(input(wav()))).text()).includes('secret-for-test'), false);
});

test('TTS streams promptly, rejoins odd-byte chunks and never accepts frontend credentials/models', async () => {
  let sent;
  const handlers = createVoiceHandlers(memory(), { fetcher: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4])); controller.close(); } }), { headers: { 'content-type': 'application/octet-stream' } });
  } });
  const response = await handlers.speech(json('/api/voice/speech', { text: 'hello', model: 'not-used', apiKey: 'not-used' }));
  assert.equal(response.headers.get('x-voice-sample-rate'), '24000'); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual(sent, { model: 'speaker', voice: 'alloy', input: 'hello', response_format: 'pcm', sample_rate: 24000, stream: true });
});

test('disabled features and missing models are rejected before provider access', async () => {
  const store = memory(); store.value.dictation = false; store.value.call = false; store.value.readAloud = false;
  const handlers = createVoiceHandlers(store, { fetcher() { assert.fail('provider called'); } });
  assert.equal((await handlers.transcribe(input(wav()))).status, 409); assert.equal((await handlers.speech(json('/api/voice/speech', { text: 'hello' }))).status, 409);
  store.value.dictation = true; store.value.asr.model = ''; assert.equal((await handlers.transcribe(input(wav()))).status, 409);
});

test('speech cancellation releases concurrency and cancels upstream reader', async () => {
  let cancelled = 0; const signals = [];
  const handlers = createVoiceHandlers(memory(), { fetcher: async (_url, options) => { signals.push(options.signal); return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'audio/pcm' } }); } });
  const make = () => handlers.speech(json('/api/voice/speech', { text: 'hello' }));
  const first = await make(), second = await make(), prefetched = await make();
  assert.equal(prefetched.status, 200); assert.equal((await make()).status, 429);
  await first.body.cancel(); assert.equal(signals[0].aborted, true); assert.equal(cancelled, 1);
  const third = await make(); assert.equal(third.status, 200); await second.body.cancel(); await prefetched.body.cancel(); await third.body.cancel();
});

test('request abort and plugin shutdown propagate while TTS stream is open', async () => {
  const shutdown = new AbortController(), abort = new AbortController(); let signal;
  const handlers = createVoiceHandlers(memory(), { shutdown: shutdown.signal, fetcher: async (_url, options) => { signal = options.signal; return new Response(new ReadableStream({}), { headers: { 'content-type': 'audio/pcm' } }); } });
  const response = await handlers.speech(json('/api/voice/speech', { text: 'hello' }, { signal: abort.signal }));
  abort.abort(); assert.equal(signal.aborted, true); await assert.rejects(response.arrayBuffer());
  const next = await handlers.speech(json('/api/voice/speech', { text: 'again' })); shutdown.abort(); assert.equal(signal.aborted, true); await assert.rejects(next.arrayBuffer());
  assert.equal((await handlers.config(json('/api/voice', { action: 'config' }))).status, 503);
});

test('call lease enforces one device, heartbeat TTL, 30 minute maximum and active media cancellation', () => {
  let now = 0; const calls = new CallLeases({ now: () => now });
  const first = calls.start({ sessionId: 'one', deviceId: 'browser' });
  assert.equal(calls.start({ sessionId: 'one', deviceId: 'browser' }).callId, first.callId);
  assert.throws(() => calls.start({ sessionId: 'one', deviceId: 'phone' }), /another device/u);
  const signal = calls.media(first.callId);
  now = 30000; assert.equal(calls.heartbeat(first).expiresAt, 75000);
  now = 75001; assert.throws(() => calls.heartbeat(first), /expired/u); assert.equal(signal.aborted, true);
  const second = calls.start({ sessionId: 'one', deviceId: 'phone' });
  now = second.startedAt + 30 * 60000; assert.throws(() => calls.heartbeat(second), /expired/u);
  calls.clear();
});

test('call APIs bind media to lease; config change and hangup abort live audio immediately', async () => {
  const store = memory(); store.value.dictation = false; store.value.readAloud = false; let upstream;
  const handlers = createVoiceHandlers(store, { fetcher: async (_url, options) => { upstream = options.signal; return new Response(new ReadableStream({}), { headers: { 'content-type': 'audio/pcm' } }); } });
  const control = async value => (await handlers.config(json('/api/voice', value))).json();
  const { call } = await control({ action: 'call.start', sessionId: 'session', deviceId: 'device' });
  const speech = () => handlers.speech(json('/api/voice/speech', { text: 'hello' }, { headers: { 'content-type': 'application/json', 'x-voice-call-id': call.callId } }));
  assert.equal((await handlers.speech(json('/api/voice/speech', { text: 'hello' }))).status, 409);
  const response = await speech(); assert.equal(response.status, 200);
  await control({ action: 'call.end', ...call }); assert.equal(upstream.aborted, true); await assert.rejects(response.arrayBuffer()); assert.equal((await speech()).status, 409);
  const next = await control({ action: 'call.start', sessionId: 'session', deviceId: 'device' });
  const audio = await handlers.speech(json('/api/voice/speech', { text: 'hello' }, { headers: { 'content-type': 'application/json', 'x-voice-call-id': next.call.callId } }));
  await control({ action: 'configure', config: { call: false } }); assert.equal(upstream.aborted, true); await assert.rejects(audio.arrayBuffer());
  assert.equal((await handlers.config(json('/api/voice', { action: 'call.heartbeat', ...next.call }))).status, 409); handlers.dispose();
});

test('Step native realtime routes enforce owner boundary, forward PCM, stream revisions and cancel on config change', async()=>{
  const {EventEmitter}=await import('node:events');let socket;
  class FakeSocket extends EventEmitter{constructor(){super();this.sent=[];this.bufferedAmount=0;queueMicrotask(()=>this.emit('open'));}send(raw){const e=JSON.parse(raw);this.sent.push(e);if(e.type==='session.update')queueMicrotask(()=>this.emit('message',JSON.stringify({type:'session.updated'})));}close(){this.closed=true;}}
  const store=memory();store.value.asr.protocol='step-websocket';store.value.asr.model='stepaudio-2.5-asr-stream';
  const h=createVoiceHandlers(store,{socket:()=>socket=new FakeSocket()});
  assert.equal((await h.config(json('/api/voice',{action:'asr.start'},{headers:{'content-type':'application/json',origin:'https://evil.test'}}))).status,403);
  const started=await h.config(json('/api/voice',{action:'asr.start'}));assert.equal(started.status,200);const {id}=await started.json();
  const downstream=await h.config(json('/api/voice',{action:'asr.events',id}));assert.equal(downstream.headers.get('content-type'),'application/x-ndjson');const reader=downstream.body.getReader();
  const append=await h.realtimeAppend(new Request('http://app.test/api/voice/realtime/audio',{method:'POST',headers:{'content-type':'application/octet-stream','x-voice-session-id':id,'x-voice-utterance-id':'1'},body:new Uint8Array(4800)}));assert.equal(append.status,200);assert.equal(socket.sent[1].type,'input_audio_buffer.append');
  const committed=await h.config(json('/api/voice',{action:'asr.commit',id,utteranceId:1}));assert.equal(committed.status,200);
  socket.emit('message',JSON.stringify({type:'conversation.item.input_audio_transcription.delta',text:'修订'}));const e=JSON.parse(new TextDecoder().decode((await reader.read()).value));assert.equal(e.text,'修订');
  socket.emit('message',JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'最终结果'}));assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type,'final');
  await h.config(json('/api/voice',{action:'configure',config:{dictation:false}}));assert.equal(socket.closed,true);assert.equal((await reader.read()).done,true);
  assert.equal((await h.config(json('/api/voice',{action:'asr.commit',id,utteranceId:1}))).status,409);h.dispose();
});
test('SSE transcription route emits partials and final; Step TTS chooses actual supported default',async()=>{
  const store=memory();store.value.asr.protocol='step-sse';store.value.tts.model='stepaudio-2.5-tts';store.value.tts.voice='';
  const h=createVoiceHandlers(store,{fetcher:async(url,options)=>{
    if(url.endsWith('/audio/asr/sse'))return new Response('data: {"type":"transcript.text.delta","delta":"你"}\n\ndata: {"type":"transcript.text.done","text":"你好"}\n\n',{headers:{'content-type':'text/event-stream'}});
    const body=JSON.parse(options.body);assert.equal(body.voice,'cixingnansheng');assert.equal(body.sample_rate,24000);return new Response(new Uint8Array(4),{headers:{'content-type':'audio/pcm'}});
  }});
  const response=await h.transcribe(input(wav())),events=(await response.text()).trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(e=>e.type),['partial','partial','final']);assert.equal(events.at(-1).text,'你好');
  assert.equal((await (await h.speech(json('/api/voice/speech',{text:'测试'}))).arrayBuffer()).byteLength,4);h.dispose();
});
test('pre-protocol RouterGo settings migrate to verified streaming endpoint; explicit choice is preserved', async () => {
  const legacy = { asr: { providerId: 'routergo', model: 'mimo-v2.5-asr' } };
  assert.equal(migrateLegacyConfig(legacy).asr.protocol, 'transcriptions-sse');
  assert.equal(legacy.asr.protocol, undefined);
  assert.equal(migrateLegacyConfig({ asr: { baseURL: 'https://routergo.cn/api/v1', model: 'stepaudio-2.5-asr' } }).asr.protocol, 'transcriptions-sse');
  assert.equal(migrateLegacyConfig({ asr: { ...legacy.asr, protocol: 'mimo-sse' } }).asr.protocol, 'mimo-sse');
  assert.equal(migrateLegacyConfig({ asr: { model: 'stepaudio-2.5-asr-stream' } }).asr.protocol, 'step-websocket');
  const directory = await mkdtemp(join(tmpdir(), 'voice-migrate-'));
  try {
    const { writeFile } = await import('node:fs/promises'); await writeFile(join(directory, 'config.json'), JSON.stringify(legacy));
    const store = await new VoiceConfig({ dataDir: directory }).open(); assert.equal(store.value.asr.protocol, 'transcriptions-sse');
    await store.configure({ call: true }); assert.equal(JSON.parse(await readFile(store.path, 'utf8')).asr.protocol, 'transcriptions-sse');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('safe upstream machine codes explain wrong protocol without reflecting provider message', async () => {
  const h = createVoiceHandlers(memory(), { fetcher: async () => Response.json({ error: { code: 'model_unavailable', message: 'Bearer secret-for-test private user text' } }, { status: 503 }) });
  const response = await h.transcribe(input(wav())), body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.code, 'model_unavailable'); assert.match(body.error, /503.*model_unavailable/u); assert.equal(JSON.stringify(body).includes('secret-for-test'), false); h.dispose();
});
test('TTS rejects contradictory PCM metadata rather than playing at the wrong pitch', async () => {
  for (const contentType of ['audio/pcm;rate=16000;channels=1', 'audio/pcm;rate=24000;channels=2']) {
    const h = createVoiceHandlers(memory(), { fetcher: async () => new Response(new Uint8Array(8), { headers: { 'content-type': contentType } }) });
    const response = await h.speech(json('/api/voice/speech', { text: 'hello' })); assert.equal(response.status, 502); assert.equal((await response.json()).code, 'tts_pcm_format'); h.dispose();
  }
});
