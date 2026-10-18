import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { streamTranscription } from '../src/asr.mjs';
import { RealtimeASR, realtimeEndpoint } from '../src/realtime.mjs';
import { validateRealtime } from '../src/config.mjs';
import { Capture } from '../client/media.mjs';
import { readVoiceEvents } from '../client/asr.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function sse(events) { return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } }); }
test('MiMo/Step SSE deliver cumulative partials and corrected final', async () => {
  for (const protocol of ['mimo-sse','step-sse']) {
    const partial = [];
    const events = protocol === 'mimo-sse' ? [{choices:[{delta:{content:'你'}}]},{choices:[{delta:{content:'好'},finish_reason:'stop'}]}] : [{type:'transcript.text.delta',delta:'你'},{type:'transcript.text.delta',delta:'号'},{type:'transcript.text.done',text:'你好'}];
    const result = await streamTranscription(async (url, options) => { assert.ok(url.endsWith(protocol==='mimo-sse'?'/chat/completions':'/audio/asr/sse')); const body = JSON.parse(options.body); if(protocol==='mimo-sse') assert.equal(body.stream,true); else assert.equal(body.audio.input.transcription.model,'test-model'); return sse(events); }, {protocol,baseURL:'https://asr.test/v1',model:'test-model'},new Uint8Array([1,2]),new AbortController().signal,text=>partial.push(text));
    assert.equal(result.text,'你好'); assert.equal(partial[0],'你'); assert.equal(partial.at(-1),'你好');
  }
});
test('SSE refuses truncated final and propagates cancellation', async () => {
  await assert.rejects(streamTranscription(async()=>sse([{type:'transcript.text.delta',delta:'partial'}]),{protocol:'step-sse',baseURL:'https://test',model:'test'},new Uint8Array(),new AbortController().signal,()=>{}),/before final/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(streamTranscription(async()=>sse([]),{protocol:'step-sse',baseURL:'https://test',model:'test'},new Uint8Array(),controller.signal,()=>{}),{name:'AbortError'});
});
class Socket extends EventEmitter {
  constructor(){ super(); this.sent=[];this.bufferedAmount=0;queueMicrotask(()=>this.emit('open')); }
  send(raw){const e=JSON.parse(raw);this.sent.push(e);if(e.type==='session.update')queueMicrotask(()=>this.emit('message',JSON.stringify({type:'session.updated'})));}
  event(e){this.emit('message',JSON.stringify(e));}
  close(){this.closed=true;}
}
test('Step WSS append/commit revised partial/final and abort lifecycle', async () => {
  let ws; const abort = new AbortController(), asr = new RealtimeASR({socket:(url,options)=>{assert.equal(url,'wss://step.test/v1/realtime/asr/stream');assert.equal(options.headers.authorization,'Bearer fixture');return ws=new Socket();}});
  const id = await asr.open({baseURL:'https://step.test/v1',apiKey:'fixture',model:'stepaudio-2.5-asr-stream',protocol:'step-websocket'},abort.signal,'lease');
  const reader = asr.events(id,'lease').getReader();
  assert.throws(()=>asr.events(id,'lease'),/already/); assert.throws(()=>asr.append(id,'wrong',new Uint8Array(8),1),/expired/);
  asr.append(id,'lease',new Uint8Array(4800),1);asr.commit(id,'lease',1);
  assert.equal(ws.sent[0].session.audio.input.format.rate,24000);assert.equal(ws.sent[1].type,'input_audio_buffer.append');assert.equal(ws.sent[2].type,'input_audio_buffer.commit');
  ws.event({type:'conversation.item.input_audio_transcription.delta',text:'你',stash:'号'});assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).text,'你');
  ws.event({type:'conversation.item.input_audio_transcription.delta',text:'你好'});assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).text,'你好');
  ws.event({type:'conversation.item.input_audio_transcription.completed',transcript:'你好。'});assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type,'final');
  abort.abort();assert.equal(ws.closed,true);assert.equal(asr.sessions.size,0);assert.equal((await reader.read()).done,true);
});
test('realtime endpoints follow protocol defaults and explicit routing without provider branches', () => {
  assert.equal(realtimeEndpoint({ baseURL: 'https://generic.test/v1', model: 'custom-model' }).href, 'wss://generic.test/v1/realtime?intent=transcription');
  for (const baseURL of ['https://routergo.cn/api/v1', 'https://generic.test/v1']) {
    const config = { baseURL, providerId: 'routergo', model: 'custom-model', protocol: 'step-websocket' };
    assert.equal(realtimeEndpoint(config).href, baseURL.replace('https:', 'wss:') + '/realtime/asr/stream');
    assert.equal(realtimeEndpoint({ ...config, protocol: 'openai-websocket' }).href, baseURL.replace('https:', 'wss:') + '/realtime?intent=transcription');
  }
  const endpoint = realtimeEndpoint({ baseURL: 'https://unused.test/v1', model: 'custom/model', protocol: 'step-websocket', realtime: { url: 'https://routergo.cn/api/v1/realtime?region=cn', query: { model: '{model}', intent: 'transcription', exit_id: 'stepfun.audio.transcriptions.websocket' } } });
  assert.equal(endpoint.protocol, 'wss:'); assert.equal(endpoint.pathname, '/api/v1/realtime');
  assert.equal(endpoint.searchParams.get('model'), 'custom/model'); assert.equal(endpoint.searchParams.get('region'), 'cn');
  assert.equal(endpoint.searchParams.get('exit_id'), 'stepfun.audio.transcriptions.websocket');
  assert.equal(realtimeEndpoint({ model: 'custom', protocol: 'openai-websocket', realtime: { url: 'ws://localhost:1234/custom?intent=custom' } }).href, 'ws://localhost:1234/custom?intent=custom');
  assert.throws(() => realtimeEndpoint({ baseURL: 'https://test', protocol: 'unknown' }), /protocol/);
  assert.throws(() => realtimeEndpoint({ baseURL: 'https://test', protocol: 'constructor' }), /protocol/);
  assert.throws(() => realtimeEndpoint({ baseURL: 'https://test', protocol: '__proto__' }), /protocol/);
});
test('realtime routing rejects credentials, unsafe URLs and expanded key leaks', () => {
  assert.deepEqual(validateRealtime({ query: { model: '{model}' } }), { url: '', query: { model: '{model}' } });
  for (const realtime of [{url:'wss://user:pass@test/realtime'}, {url:'wss://test/realtime#hash'}, {url:'file:///tmp/socket'}, {url:'wss://test?api_key=hidden'}, {query:{authorization:'hidden'}}, {query:{model:'line\nbreak'}}, {query:{model:'x'.repeat(513)}}]) {
    assert.throws(() => realtimeEndpoint({ baseURL: 'https://test', model: 'model', protocol: 'step-websocket', realtime }));
  }
  assert.throws(() => realtimeEndpoint({ apiKey: 'private-secret', model: 'private-secret', protocol: 'openai-websocket', realtime: { url: 'wss://test/realtime', query: { model: '{model}' } } }), /credentials/);
});
test('OpenAI waits for session.updated and keeps its PCM and transcription schema separate', async () => {
  let ws, resolved = false;
  const asr = new RealtimeASR({ socket: (url, options) => {
    assert.equal(url, 'wss://generic.test/v1/realtime?intent=transcription');
    assert.deepEqual(options.headers, { authorization: 'Bearer server-secret' }); assert.equal(options.followRedirects, false);
    ws = new Socket(); ws.send = raw => ws.sent.push(JSON.parse(raw)); return ws;
  } });
  const opening = asr.open({ baseURL: 'https://generic.test/v1', protocol: 'openai-websocket', apiKey: 'server-secret', model: 'chosen-transcriber' }, new AbortController().signal, 'owner').then(id => { resolved = true; return id; });
  await tick(); ws.event({ type: 'session.created' }); await tick(); assert.equal(resolved, false);
  assert.deepEqual(ws.sent[0].session, { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'chosen-transcriber' }, turn_detection: null } } });
  ws.event({ type: 'session.updated' }); const id = await opening;
  assert.throws(() => asr.events(id, 'other'), /expired/);
  const reader = asr.events(id, 'owner').getReader(), next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value));
  asr.append(id, 'owner', new Uint8Array(4800), 1); asr.commit(id, 'owner', 1);
  ws.event({ type: 'input_audio_buffer.committed', item_id: 'first' });
  ws.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', delta: '你', text: 'wrong-step-text' });
  assert.deepEqual(await next(), { type: 'partial', text: '你', utteranceId: 1 });
  ws.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', delta: '好' });
  assert.equal((await next()).text, '你好');
  ws.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: '你好。' });
  assert.deepEqual(await next(), { type: 'final', text: '你好。', utteranceId: 1 });
  asr.append(id, 'owner', new Uint8Array(4800), 2); asr.commit(id, 'owner', 2);
  ws.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: 'stale' });
  ws.event({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'first', error: { message: 'secret' } });
  ws.event({ type: 'input_audio_buffer.committed', item_id: 'second' });
  ws.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', delta: 'stale' });
  ws.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'second', delta: '新' });
  assert.deepEqual(await next(), { type: 'partial', text: '新', utteranceId: 2 });
  ws.event({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'second', error: { message: 'server-secret' } });
  const failure = await next(); assert.equal(failure.code, 'asr_transcription_failed'); assert.doesNotMatch(JSON.stringify(failure), /server-secret/);
  assert.equal(asr.sessions.size, 0); assert.equal(ws.closed, true);
});
test('slow realtime event consumer is closed rather than accumulating unbounded memory',async()=>{
  let ws;const asr=new RealtimeASR({socket:()=>ws=new Socket()}),id=await asr.open({baseURL:'https://step.test',model:'test',protocol:'step-websocket'},new AbortController().signal);
  asr.events(id,'');asr.append(id,'',new Uint8Array(4800),1);for(let i=0;i<65;i++)ws.event({type:'conversation.item.input_audio_transcription.delta',text:'text '+i});assert.equal(asr.sessions.size,0);assert.equal(ws.closed,true);
});
test('Capture SSE revisions replace same chunk and preserve previous chunks',async()=>{
  const partial=[],final=[];let n=0;const c=new Capture({transcribe:async(_blob,_signal,update)=>{n++;update(n===1?'hell':'worl');update(n===1?'hello':'world');return n===1?'hello':'world';},onPartial:text=>partial.push(text),onFinal:text=>final.push(text)});
  for(let i=0;i<120;i++)c.accept(new Int16Array(480).fill(2000));await c.stop();assert.equal(final[0],'hello world');assert.ok(partial.includes('hello worl'));assert.equal(partial.some(x=>x.includes('hellhello')),false);
});
test('parallel SSE chunks reduce tail latency while preserving transcript order',async()=>{
  let active=0,maxActive=0,calls=0;const final=[];
  const c=new Capture({parallel:true,transcribe:async(_blob,_signal,update)=>{const id=++calls;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,id===1?30:5));update(id===1?'甲':'乙');active--;return id===1?'甲':'乙';},onFinal:text=>final.push(text)});
  for(let i=0;i<120;i++)c.accept(new Int16Array(480).fill(2000));await c.stop();
  assert.equal(calls,2);assert.equal(maxActive,2);assert.deepEqual(final,['甲乙']);
});
test('Capture realtime sends frames before silence and stop waits for final',async()=>{
  const sent=[],partial=[],final=[];let finish;
  const c=new Capture({realtime:{append:async(frames,id,update)=>{sent.push(frames.reduce((n,f)=>n+f.length,0));update('修订');},commit:()=>new Promise(resolve=>finish=resolve),close:async()=>{}},onPartial:text=>partial.push(text),onFinal:text=>final.push(text)});
  for(let i=0;i<20;i++)c.accept(new Int16Array(480).fill(2000));await tick();assert.ok(sent.length>=2);let stopped=false;const stop=c.stop().then(()=>stopped=true);await tick();assert.equal(stopped,false);finish('最终');await stop;assert.deepEqual(final,['最终']);assert.ok(partial.length);
});
test('normalized browser events reject early stream errors and abort late partials',async()=>{
 const c=new AbortController(),seen=[];await readVoiceEvents(new Response('{"type":"partial","text":"one"}\n{"type":"final","text":"two"}\n'),c.signal,e=>seen.push(e.text));assert.deepEqual(seen,['one','two']);
 await assert.rejects(readVoiceEvents(new Response('{"type":"error","error":"fixture"}\n'),c.signal,()=>{}),/fixture/);
});
test('OpenAI transcription SSE sends multipart streaming and delivers partial before final arrives', async () => {
  let stream, first; const seen = [], signal = new AbortController().signal, nl = String.fromCharCode(10);
  const partial = new Promise(resolve => first = resolve);
  const encode = event => new TextEncoder().encode('data: ' + JSON.stringify(event) + nl + nl);
  const task = streamTranscription(async (url, options) => {
    assert.equal(url, 'https://router.test/api/v1/audio/transcriptions');
    assert.equal(options.headers['content-type'], undefined);
    assert.equal(options.headers.accept, 'text/event-stream');
    assert.equal(options.body.get('model'), 'mimo-v2.5-asr');
    assert.equal(options.body.get('stream'), 'true');
    assert.equal(options.body.get('file').type, 'audio/wav');
    return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(encode({ type: 'transcript.text.delta', delta: '你好' })); } }), { headers: { 'content-type': 'text/event-stream' } });
  }, { protocol: 'transcriptions-sse', baseURL: 'https://router.test/api/v1', model: 'mimo-v2.5-asr' }, new Uint8Array(4), signal, text => { seen.push(text); first(); });
  await partial; assert.deepEqual(seen, ['你好']);
  stream.enqueue(encode({ type: 'transcript.text.done', text: '你好。' })); stream.close();
  assert.deepEqual(await task, { text: '你好。' }); assert.deepEqual(seen, ['你好', '你好。']);
});
test('native clear replaces Step connection and rejects late old final without changing browser session', async () => {
  const sockets = []; const asr = new RealtimeASR({ socket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  const id = await asr.open({ baseURL: 'https://step.test', model: 'test', protocol: 'step-websocket' }, new AbortController().signal, 'call');
  const reader = asr.events(id, 'call').getReader();
  asr.append(id, 'call', new Uint8Array(4800), 1); asr.commit(id, 'call', 1);
  await asr.reset(id, 'call'); assert.equal(sockets[0].closed, true);
  assert.equal(sockets[1].sent[0].session.audio.input.turn_detection, null);
  asr.append(id, 'call', new Uint8Array(4800), 2); asr.commit(id, 'call', 2);
  sockets[0].event({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'stale' });
  sockets[1].event({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'fresh' });
  const event = JSON.parse(new TextDecoder().decode((await reader.read()).value)); assert.equal(event.text, 'fresh'); assert.equal(event.utteranceId, 2);
  asr.close(id);
});
test('OpenAI reset fences old sockets and handshake cancellation settles immediately', async () => {
  const sockets = [], asr = new RealtimeASR({ socket: () => { const ws = new Socket(); sockets.push(ws); return ws; } });
  const abort = new AbortController(), id = await asr.open({ baseURL: 'https://generic.test', model: 'custom', protocol: 'openai-websocket' }, abort.signal, 'call');
  const reader = asr.events(id, 'call').getReader(); asr.append(id, 'call', new Uint8Array(4800), 1); asr.commit(id, 'call', 1);
  await asr.reset(id, 'call'); assert.equal(sockets[0].closed, true);
  asr.append(id, 'call', new Uint8Array(4800), 2); asr.commit(id, 'call', 2);
  sockets[0].event({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'old' });
  sockets[0].event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old', transcript: 'stale' });
  sockets[1].event({ type: 'input_audio_buffer.committed', item_id: 'new' });
  sockets[1].event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new', transcript: 'fresh' });
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await reader.read()).value)), { type: 'final', text: 'fresh', utteranceId: 2 });
  abort.abort(); assert.equal(asr.sessions.size, 0);
  const pendingAbort = new AbortController(), pending = new RealtimeASR({ socket: () => { const ws = new Socket(); ws.send = () => {}; return ws; } });
  const opening = pending.open({ baseURL: 'https://generic.test', model: 'custom', protocol: 'openai-websocket' }, pendingAbort.signal);
  const rejected = assert.rejects(opening, { name: 'AbortError' }); pendingAbort.abort(); await rejected; assert.equal(pending.sessions.size, 0);
});
test('native protocols exchange continuous PCM over a real local WebSocket', async t => {
  for (const protocol of ['step-websocket', 'openai-websocket']) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(resolve => server.once('listening', resolve));
    const asr = new RealtimeASR(), messages = [];
    t.after(async () => { asr.clear(); for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
    server.on('connection', (ws, request) => {
      assert.equal(request.headers.authorization, 'Bearer local-fixture');
      assert.equal(new URL(request.url, 'http://localhost').searchParams.get('model'), 'custom-model');
      ws.on('message', raw => {
        const event = JSON.parse(String(raw)); messages.push(event);
        if (event.type === 'session.update') { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }
        if (event.type === 'input_audio_buffer.commit') {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'local-item' }));
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'local-item', ...(protocol === 'openai-websocket' ? { delta: '你好' } : { text: '你好' }) }));
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'local-item', transcript: '你好。' }));
        }
      });
    });
    const id = await asr.open({ protocol, model: 'custom-model', apiKey: 'local-fixture', realtime: { url: 'ws://127.0.0.1:' + server.address().port + '/custom', query: { model: '{model}' } } }, new AbortController().signal);
    const reader = asr.events(id, '').getReader(); asr.append(id, '', new Uint8Array(4800), 1); asr.append(id, '', new Uint8Array(4800), 1); asr.commit(id, '', 1);
    const partial = JSON.parse(new TextDecoder().decode((await reader.read()).value)), final = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    assert.equal(partial.text, '你好'); assert.equal(final.text, '你好。'); assert.equal(final.type, 'final');
    assert.equal(messages.filter(event => event.type === 'input_audio_buffer.append').length, 2);
    assert.equal(Buffer.from(messages[1].audio, 'base64').length, 4800); asr.close(id);
  }
});
