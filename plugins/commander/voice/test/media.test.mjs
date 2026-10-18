import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {Capture,PCMPlayer,pcmWav,HTTP_CHUNK_SECONDS} from '../client/media.mjs';
const frame=(n=2000)=>new Int16Array(480).fill(n);
const tick=()=>new Promise(r=>setTimeout(r,0));
test('HTTP ASR starts a short WAV upload while the user is still speaking',async()=>{
  let calls=0;const c=new Capture({transcribe:async()=>{calls++;return '';}});
  for(let i=0;i<Math.ceil(HTTP_CHUNK_SECONDS*50)+2;i++)c.accept(frame());
  await tick();assert.equal(calls,1);await c.dispose();
});
test('WAV is mono little-endian PCM24k',async()=>{const v=new DataView(await pcmWav([new Int16Array([-32768,32767])]).arrayBuffer());assert.equal(v.getUint32(24,true),24000);assert.equal(v.getUint16(22,true),1);assert.equal(v.getInt16(44,true),-32768);assert.equal(v.getUint32(40,true),4);});
test('short utterance retains preroll and commits only after ASR',async()=>{
  const events=[];let finish;const c=new Capture({silenceMs:100,transcribe:()=>new Promise(r=>finish=r),onSpeechStart:()=>events.push('start'),onPartial:t=>events.push('partial:'+t),onFinal:t=>events.push('final:'+t)});
  for(let i=0;i<4;i++)c.accept(frame(0));for(let i=0;i<6;i++)c.accept(frame());for(let i=0;i<5;i++)c.accept(frame(0));await tick();assert.deepEqual(events,['start']);finish('你好');await c.pending;assert.deepEqual(events,['start','partial:你好','final:你好']);await c.dispose();
});
test('continuous ASR pieces preserve order and accumulate within utterance',async()=>{
  const partial=[],final=[];let count=0;const c=new Capture({transcribe:async()=>++count===1?'hello':'world',onPartial:t=>partial.push(t),onFinal:t=>final.push(t)});
  for(let i=0;i<120;i++)c.accept(frame());const text=await c.stop();assert.equal(text,'hello world');assert.deepEqual(partial,['hello','hello world']);assert.deepEqual(final,['hello world']);
});
test('dispose aborts ASR and isolates late results',async()=>{
  let finish,signal;const final=[];const c=new Capture({transcribe:(_b,s)=>{signal=s;return new Promise(r=>finish=r);},onFinal:t=>final.push(t)});
  for(let i=0;i<110;i++)c.accept(frame());await tick();await c.dispose();assert.equal(signal.aborted,true);finish('late');await tick();assert.deepEqual(final,[]);assert.equal(c.backlog,0);
});
test('ASR queue stays bounded',async()=>{const c=new Capture({transcribe:()=>new Promise(()=>{}),onError:()=>{}});for(let i=0;i<2000;i++)c.accept(frame());assert.ok(c.backlog<=12);await c.dispose();});
test('player joins odd PCM bytes and isolates old epochs',async()=>{
  const messages=[];const p=new PCMPlayer();p.context={state:'running'};p.node={port:{postMessage:m=>messages.push(m)}};
  await p.enqueue(new Uint8Array([1]),1);await p.enqueue(new Uint8Array([2,3,4]),1);p.segmentEnd(1);assert.deepEqual([...new Int16Array(messages[0].data)],[513,1027]);assert.equal(messages.at(-1).type,'end');p.clear();assert.equal(p.queued,0);
});
test('worklet resamples 48/44.1 kHz continuously and ACKs only consumed PCM',async()=>{
  const code=await fs.readFile(new URL('../client/audio-worklet.js',import.meta.url),'utf8');
  for(const sampleRate of [48000,44100]){
    const types={},sent=[];const context={sampleRate,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m)};}},registerProcessor:(n,c)=>types[n]=c};vm.runInNewContext(code,context);
    const capture=new types['voice-capture']();for(let n=0;n<Math.ceil(sampleRate/128);n++)capture.process([[new Float32Array(128).fill(.2)]]);
    assert.ok(Math.abs(sent.length*480-24000)<=480);sent.length=0;
    const player=new types['voice-playback']();player.port.onmessage({data:{type:'pcm',epoch:0,id:1,data:new Int16Array(480).fill(1000).buffer}});player.port.onmessage({data:{type:'end',epoch:0,id:1}});assert.equal(sent.length,0);
    player.process([],[[new Float32Array(128)]]);assert.equal(sent.some(x=>x.type==='played'),false);for(let i=0;i<10;i++)player.process([],[[new Float32Array(128)]]);assert.equal(sent.filter(x=>x.type==='played').length,1);
  }
});
test('player clear releases buffer backpressure and discards stale packet',async()=>{
  const messages=[],p=new PCMPlayer({maxBufferedSeconds:1});p.context={state:'running'};p.node={port:{postMessage:m=>messages.push(m)}};
  await p.enqueue(new Uint8Array(48000),1);const blocked=p.enqueue(new Uint8Array(4),1);await tick();p.clear();await blocked;assert.equal(messages.filter(m=>m.type==='pcm').length,2);assert.equal(p.queued,0);
});
test('RMS level callback reflects PCM energy and throttles UI updates',()=>{const values=[];const capture=new Capture({onLevel:value=>values.push(value)});capture.active=true;capture.accept(frame(0));capture.accept(frame(4000));assert.equal(values.length,1);assert.equal(values[0],0);capture.levelAt=0;capture.accept(frame(4000));assert.ok(values[1]>.5&&values[1]<=1);capture.active=false;});
test('muting disables microphone track, drops input and ignores delayed recognizer results',async()=>{
  const finals=[],ends=[];let resolve;const c=new Capture({transcribe:()=>new Promise(done=>resolve=done),onFinal:t=>finals.push(t),onSpeechEnd:(id,m)=>ends.push([id,m.cancelled])});
  const track={enabled:true};c.stream={getAudioTracks:()=>[track],getTracks:()=>[]};for(let i=0;i<110;i++)c.accept(frame());await tick();c.setMuted(true);assert.equal(track.enabled,false);assert.equal(c.segment,null);for(let i=0;i<100;i++)c.accept(frame());assert.equal(c.segment,null);resolve('stale');await c.pending;assert.deepEqual(finals,[]);assert.deepEqual(ends,[[1,true]]);c.setMuted(false);assert.equal(track.enabled,true);await c.dispose();
});
test('empty ASR final still closes local utterance so controller never remains busy',async()=>{
  const events=[];const c=new Capture({transcribe:async()=>'',onSpeechEnd:(id)=>events.push(['end',id]),onFinal:(text,meta)=>events.push(['final',text,meta.final])});for(let i=0;i<10;i++)c.accept(frame());await c.stop();assert.deepEqual(events,[['end',1],['final','',true]]);
});
test('playback startup prebuffer holds short incomplete streams then flushes completed tail',async()=>{
  const code=await fs.readFile(new URL('../client/audio-worklet.js',import.meta.url),'utf8'),types={},sent=[];
  vm.runInNewContext(code,{sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m)};}},registerProcessor:(n,c)=>types[n]=c});
  const p=new types['voice-playback']();p.port.onmessage({data:{type:'pcm',epoch:0,id:1,data:new Int16Array(480).fill(1000).buffer}});const out=new Float32Array(128);p.process([],[[out]]);assert.equal(out.some(Boolean),false);assert.equal(sent.length,0);p.port.onmessage({data:{type:'end',epoch:0,id:1}});for(let i=0;i<8;i++)p.process([],[[out]]);assert.equal(sent.filter(e=>e.type==='played').length,1);assert.ok(sent.some(e=>e.type==='playing'));assert.ok(sent.some(e=>e.type==='idle'));
});
test('capture resampler attenuates out-of-band high-frequency energy',async()=>{
  const code=await fs.readFile(new URL('../client/audio-worklet.js',import.meta.url),'utf8');function measure(hz){const types={},sent=[];vm.runInNewContext(code,{sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m)};}},registerProcessor:(n,c)=>types[n]=c});const capture=new types['voice-capture']();for(let block=0;block<100;block++){const frame=new Float32Array(128);for(let i=0;i<128;i++)frame[i]=Math.sin((block*128+i)*2*Math.PI*hz/48000)*.5;capture.process([[frame]]);}const all=sent.flatMap(e=>[...new Int16Array(e.data)]).slice(500);return Math.sqrt(all.reduce((n,v)=>n+v*v,0)/all.length);}assert.ok(measure(18000)<measure(1000)*.05);
});
