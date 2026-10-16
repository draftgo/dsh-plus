import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamTranscription } from '../src/asr.mjs';
import { RealtimeASR } from '../src/realtime.mjs';
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
  const id = await asr.open({baseURL:'https://step.test/v1',apiKey:'fixture',model:'stepaudio-2.5-asr-stream'},abort.signal,'lease');
  const reader = asr.events(id,'lease').getReader();
  assert.throws(()=>asr.events(id,'lease'),/already/); assert.throws(()=>asr.append(id,'wrong',new Uint8Array(8),1),/expired/);
  asr.append(id,'lease',new Uint8Array(4800),1);asr.commit(id,'lease',1);
  assert.equal(ws.sent[0].session.audio.input.format.rate,24000);assert.equal(ws.sent[1].type,'input_audio_buffer.append');assert.equal(ws.sent[2].type,'input_audio_buffer.commit');
  ws.event({type:'conversation.item.input_audio_transcription.delta',text:'你',stash:'号'});assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).text,'你');
  ws.event({type:'conversation.item.input_audio_transcription.delta',text:'你好'});assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).text,'你好');
  ws.event({type:'conversation.item.input_audio_transcription.completed',transcript:'你好。'});assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type,'final');
  abort.abort();assert.equal(ws.closed,true);assert.equal(asr.sessions.size,0);assert.equal((await reader.read()).done,true);
});
test('slow realtime event consumer is closed rather than accumulating unbounded memory',async()=>{
  let ws;const asr=new RealtimeASR({socket:()=>ws=new Socket()}),id=await asr.open({baseURL:'https://step.test',model:'test'},new AbortController().signal);
  asr.events(id,'');asr.append(id,'',new Uint8Array(4800),1);for(let i=0;i<65;i++)ws.event({type:'conversation.item.input_audio_transcription.delta',text:'text '+i});assert.equal(asr.sessions.size,0);assert.equal(ws.closed,true);
});
test('Capture SSE revisions replace same chunk and preserve previous chunks',async()=>{
  const partial=[],final=[];let n=0;const c=new Capture({transcribe:async(_blob,_signal,update)=>{n++;update(n===1?'hell':'worl');update(n===1?'hello':'world');return n===1?'hello':'world';},onPartial:text=>partial.push(text),onFinal:text=>final.push(text)});
  for(let i=0;i<120;i++)c.accept(new Int16Array(480).fill(2000));await c.stop();assert.equal(final[0],'hello world');assert.ok(partial.includes('hello worl'));assert.equal(partial.some(x=>x.includes('hellhello')),false);
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
  const id = await asr.open({ baseURL: 'https://step.test', model: 'test' }, new AbortController().signal, 'call');
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
