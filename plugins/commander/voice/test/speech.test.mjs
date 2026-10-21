import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeakableChunker,SpeechQueue,speakable} from '../client/speech.mjs';
test('chunker filters code, hidden reasoning, markdown URLs across every character',()=>{
  const c=new SpeakableChunker(),out=[];const text='你好。<think>不应朗读。</think>请看 [文档](https://example.com)。 '+String.fromCharCode(96).repeat(3)+'js\nsecret();\n'+String.fromCharCode(96).repeat(3)+'最后 '+String.fromCharCode(96)+'danger'+String.fromCharCode(96)+' 再见！';
  for(const x of text)out.push(...c.push(x));out.push(...c.finish());const all=out.join('');assert.match(all,/你好/);assert.match(all,/文档/);assert.match(all,/最后/);assert.match(all,/danger/);assert.equal(all.split('代码我发在聊天里了。').length-1,1);assert.doesNotMatch(all,/不应|secret|example/);
});
test('chunker limits Chinese sentence size and keeps punctuation across deltas',()=>{const c=new SpeakableChunker({maxChars:50}),out=[];for(const d of ['你好','，今天很好。','很'.repeat(180),'结束！'])out.push(...c.push(d));out.push(...c.finish());assert.ok(out.every(x=>x.length<=50));assert.match(out.join(''),/今天很好/);});
test('secret-looking tokens are redacted',()=>{assert.doesNotMatch(speakable('token=abcdefghijklmnopqrstuvwxyz1234567890 api_key: sk-123456789012345678901234'),/abcdefghijklmnopqrstuvwxyz|sk-123/);});
test('TTS prefetch is concurrent, ordered, and playback starts before stream end',async()=>{
  const requests=[],played=[],ends=[];let finishFirst,firstStarted;
  const first=new ReadableStream({start(c){c.enqueue(new Uint8Array([1,0]));finishFirst=()=>c.close();}});
  const started=new Promise(r=>firstStarted=r);const player={enqueue:async(bytes,id)=>{played.push([id,...bytes]);firstStarted();},segmentEnd:id=>ends.push(id),clear(){}};
  const q=new SpeechQueue({player,synthesize:async text=>{requests.push(text);return new Response(text==='one'?first:new Uint8Array([2,0]));}});
  q.push('one');q.push('two');q.push('three');await started;assert.deepEqual(requests,['one','two','three']);assert.deepEqual(ends,[]);finishFirst();await q.finish();assert.deepEqual(ends,[1,2,3]);assert.deepEqual(played.map(x=>x[0]),[1,2,3]);await q.dispose();
});
test('TTS cancel aborts synthesis without waiting for uncooperative provider',async()=>{
  let signal;let clear=0;const q=new SpeechQueue({player:{clear(){clear++;}},synthesize:(_t,s)=>{signal=s;return new Promise(()=>{});}});q.push('one');await new Promise(r=>setTimeout(r,0));q.cancel();await q.finish();assert.equal(signal.aborted,true);assert.equal(clear,1);
});
test('TTS queue rejects excess backlog',async()=>{const errors=[];const q=new SpeechQueue({maxQueued:2,player:{clear(){}},synthesize:()=>new Promise(()=>{}),onError:e=>errors.push(e)});assert.equal(q.push('one'),true);assert.equal(q.push('two'),true);assert.equal(q.push('three'),false);assert.equal(errors.length,1);await q.dispose();});
test('idle chunking flushes safe clauses without splitting decimals or unfinished English words',()=>{
  let now=1000;const c=new SpeakableChunker({now:()=>now});assert.deepEqual(c.push('我会帮你检查这些配置，正在继续确认'),['我会帮你检查这些配置，']);now+=750;assert.deepEqual(c.flushIdle(),[]);assert.deepEqual(c.finish(),['正在继续确认']);const c2=new SpeakableChunker({now:()=>now});c2.push('approximately 3.14');now+=750;assert.deepEqual(c2.flushIdle(),['approximately']);assert.deepEqual(c2.finish(),['3.14']);const c3=new SpeakableChunker({now:()=>now});c3.push('G');now+=1500;assert.deepEqual(c3.flushIdle(),[]);c3.push('rok');assert.deepEqual(c3.finish(),['Grok']);
});
test('prefetched TTS bodies are consumed concurrently but have bounded PCM queues',async()=>{
  let firstFinish;const first=new ReadableStream({start(c){c.enqueue(new Uint8Array([1,0]));firstFinish=()=>c.close();}}),sent=[];
  const q=new SpeechQueue({maxPrefetchBytes:1920,player:{enqueue:async(bytes,id)=>sent.push(id),segmentEnd(){},clear(){}},synthesize:async text=>new Response(text==='first'?first:new Uint8Array(16000))});q.push('first');q.push('second');q.push('third');await new Promise(r=>setTimeout(r,5));assert.equal(q.items[1].buffered,1920);assert.equal(q.items[2].buffered,1920);assert.deepEqual(sent,[1]);firstFinish();await q.finish();assert.ok(sent.indexOf(2)>0);assert.ok(sent.lastIndexOf(2)<sent.indexOf(3));await q.dispose();
});
const filterChunks = text => { const chunker = new SpeakableChunker(), out = []; for (const character of text) out.push(...chunker.push(character)); out.push(...chunker.finish()); return out.join(' '); };
test('stream filter gives one code/table/URL hint per turn and never reads their payload', () => {
  const fence = String.fromCharCode(96).repeat(3), nl = String.fromCharCode(10);
  const text = '正文。' + fence + 'js' + nl + 'privateCode()' + nl + fence + nl + fence + 'json' + nl + 'anotherCode()' + nl + fence + nl + '| 私有表头 | 数值 |' + nl + '| --- | --- |' + nl + '| 私有单元格 | 10 |' + nl + nl + '请看 https://private.example/a.b?q=secret 后续。另见 https://second.example/x。结束。';
  const spoken = filterChunks(text);
  for (const hint of ['代码我发在聊天里了。', '表格我放在聊天里了。', '链接已发在聊天里。']) assert.equal(spoken.split(hint).length - 1, 1);
  assert.doesNotMatch(spoken, /private|anotherCode|私有|---|second/u); assert.match(spoken, /正文/u); assert.match(spoken, /后续/u); assert.match(spoken, /结束/u);
});
test('inline code and ordinary parentheses survive while short stage directions and emoji are removed', () => {
  const tick = String.fromCharCode(96);
  const spoken = filterChunks('(笑着说)你好（挠头），请运行 ' + tick + 'npm run dev' + tick + '。（预计耗时 2 分钟）保留这个说明。*sighs*继续。🙂');
  assert.match(spoken, /npm run dev/u); assert.match(spoken, /预计耗时 2 分钟/u); assert.doesNotMatch(spoken, /笑着说|挠头|sighs|🙂/u);
});
test('incomplete URL and Markdown destination remain silent across idle flushes', () => {
  let now = 1000; const chunker = new SpeakableChunker({ now: () => now }), out = [];
  for (const delta of ['请看 h', 'ttps://priv', 'ate.example/a', '.b']) { out.push(...chunker.push(delta)); now += 1500; out.push(...chunker.flushIdle()); }
  out.push(...chunker.push(' 然后查看 [文档](https://other.example/private) 完成。')); out.push(...chunker.finish());
  const spoken = out.join(' '); assert.doesNotMatch(spoken, /private|example|https|other/u); assert.match(spoken, /文档/u); assert.match(spoken, /完成/u);
});
test('unterminated code and Markdown links have bounded retained text', () => {
  const code = new SpeakableChunker(), fence = String.fromCharCode(96).repeat(3);
  code.push(fence + 'js '); for (let i = 0; i < 1000; i++) code.push('veryLongPrivateCode');
  assert.ok(code.raw.length <= 8); assert.ok(code.text.length <= 120); assert.doesNotMatch(code.finish().join(''), /PrivateCode/u);
  const link = new SpeakableChunker(); link.push('[文档]('); for (let i = 0; i < 1000; i++) link.push('private-link-destination');
  assert.ok(link.raw.length <= 2048); assert.doesNotMatch(link.finish().join(''), /private-link/u);
});
test('confirmed punctuation starts speech in the same delta without an idle timer', () => {
  const short=new SpeakableChunker();assert.deepEqual(short.push('你好。'),['你好。']);
  const first=new SpeakableChunker();assert.deepEqual(first.push('我会先检查你的语音配置，'),['我会先检查你的语音配置，']);
  assert.deepEqual(first.push('再核对实际请求，'),[]);
  assert.equal(first.finish().join(''),'再核对实际请求，');
  const number=new SpeakableChunker();assert.deepEqual(number.push('The total amount is 123,456.78'),[]);assert.equal(number.finish().join(''),'The total amount is 123,456.78');
  const privateText=filterChunks('我会先确认你的语音配置，<reasoning>绝不能朗读。</reasoning>请看 https://private.example/path 完成。');
  assert.doesNotMatch(privateText,/绝不能|private|https/u);assert.match(privateText,/完成/u);
});
test('arriving PCM is forwarded immediately without a per-packet coalescing timer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let stream,firstPlayed;const played=[];const started=new Promise(resolve=>firstPlayed=resolve);
  const q=new SpeechQueue({player:{enqueue:async bytes=>{played.push([...bytes]);firstPlayed();},segmentEnd(){},clear(){}},synthesize:async()=>new Response(new ReadableStream({start(controller){stream=controller;controller.enqueue(new Uint8Array([1,0]));}}))});
  try{q.push('one');await started;stream.enqueue(new Uint8Array([2,0]));for(let i=0;i<20;i++)await Promise.resolve();assert.deepEqual(played,[[1,0],[2,0]]);stream.close();await q.finish();}finally{await q.dispose();t.mock.timers.reset();}
});
test('dispose releases local readers when a provider never finishes cancelling', {timeout:1000},async()=>{
  let signal,started;const ready=new Promise(resolve=>started=resolve);let cancelled=0;
  const q=new SpeechQueue({player:{enqueue:async()=>started(),segmentEnd(){},clear(){}},synthesize:async(_text,abort)=>{signal=abort;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,0]));},cancel(){cancelled++;return new Promise(()=>{});}}));}});
  q.push('one');await ready;await q.dispose();assert.equal(signal.aborted,true);assert.equal(cancelled,1);assert.equal(q.controllers.size,0);assert.equal(q.readers.size,0);assert.deepEqual(q.items,[]);
});
