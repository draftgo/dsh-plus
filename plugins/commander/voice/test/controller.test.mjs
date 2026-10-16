import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceController} from '../client/controller.mjs';
import { Context } from '@deepseek-ai/cordis';
globalThis.document||={baseURI:'https://voice.example/'};
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function setup(options={}){
  let status={running:false,pendingInteraction:false},revision=0,snapshot={revision:0,entries:[],change:{kind:'replace'}};const listeners=new Set(),calls=[],sent=[],captures=[],players=[],queues=[];let cancelCalls=0;
  const source={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);}};
  const conversation={send:async(text,sessionId='s')=>{calls.push(text);sent.push({sessionId,text});await options.send?.(text,sessionId);},cancel:async()=>{cancelCalls++;await options.cancel?.();status.running=false;}};
  const cordisScope=options.cordisScope?new Context():null;if(cordisScope)cordisScope.provide('conversation',conversation);
  const ctx={uiSession:{sessionStatus:{getSnapshot:()=>new Map([['s',status]]),subscribe:()=>()=>{}}},sessions:{binding:id=>({sessionId:id,eventSource:source}),scope:sessionId=>cordisScope||({get:name=>name==='conversation'?{send:text=>conversation.send(text,sessionId),cancel:conversation.cancel}:undefined})}};
  const deps={window:{addEventListener(){},removeEventListener(){}},setInterval:options.setInterval||globalThis.setInterval,clearInterval:options.clearInterval||globalThis.clearInterval,json:async(action,args)=>{calls.push({action,args});if(action==='config')return {config:{dictation:true,readAloud:true,call:true,asr:{configured:true},tts:{configured:true}}};if(action==='call.start'){await options.callStart?.();return {call:{callId:'lease'}};}if(action==='call.heartbeat')await options.heartbeat?.();return {};},
    createCapture:callbacks=>{const c={callbacks,start:async()=>{await options.captureStart?.();},stop:async()=>'',dispose:async()=>{c.disposed=true;await options.captureDispose?.();}};captures.push(c);return c;},
    createPlayer:callbacks=>{const p={callbacks,start:async()=>{await options.playerStart?.();},dispose:async()=>{p.disposed=true;},clear(){}};players.push(p);return p;},
    createQueue:()=>{const q={items:[],sequence:0,text:[],push:t=>{q.sequence++;q.text.push(t);return true;},cancel(){q.cancelled=true;},dispose:async()=>{q.disposed=true;}};queues.push(q);return q;},
    createChunker:()=>({push:text=>[text],finish:()=>[]})};
  const api=createVoiceController(ctx,deps);
  return {api,calls,sent,captures,players,queues,get status(){return status;},set status(s){status=s;},get cancelCalls(){return cancelCalls;},texts:()=>calls.filter(x=>typeof x==='string'),publish(type,data={}){const e={type:'event',event:{seq:++revision,type,data}};snapshot={revision,entries:[...snapshot.entries,e],change:{kind:'append',entries:[e]}};for(const fn of listeners)fn();}};
}
test('older utterance final waits until current utterance final then merges once',async()=>{const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onSpeechStart(2);c.onFinal('前半句',{utteranceId:1});await flush();assert.deepEqual(h.texts(),[]);c.onFinal('后半句',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['前半句\n后半句']);await h.api.dispose();});
test('speech start invalidates earlier deliver while cancellation is pending',async()=>{const gate=deferred();const h=setup({cancel:()=>gate.promise});await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:false};const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('旧语段',{utteranceId:1});await flush();c.onSpeechStart(2);gate.resolve();await flush();assert.deepEqual(h.texts(),[]);c.onFinal('继续',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['旧语段\n继续']);await h.api.dispose();});
test('pending interaction neither cancels nor sends, and hangup preserves approval',async()=>{const h=setup();await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:true};const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('需要确认',{utteranceId:1});await flush();assert.deepEqual(h.texts(),[]);assert.equal(h.cancelCalls,0);assert.equal(h.api.state.getSnapshot().phase,'waiting');await h.api.hangup();assert.equal(h.cancelCalls,0);await h.api.dispose();});
test('startup failure and hangup release media and remote lease once',async()=>{const h=setup({captureStart:async()=>{throw Error('no mic');}});await assert.rejects(h.api.startCall({sessionId:'s'}),/no mic/);assert.equal(h.captures[0].disposed,true);assert.equal(h.players[0].disposed,true);assert.equal(h.calls.filter(x=>x.action==='call.end').length,1);assert.equal(h.api.state.getSnapshot().mode,'idle');await h.api.dispose();});
test('hangup is reentrant and cancels running call agent while releasing media',async()=>{const gate=deferred(),h=setup({captureDispose:()=>gate.promise});await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:false};const a=h.api.hangup(),b=h.api.hangup();assert.equal(a,b);assert.equal(h.cancelCalls,1);gate.resolve();await a;assert.equal(h.calls.filter(x=>x.action==='call.end').length,1);assert.equal(h.players[0].disposed,true);await h.api.dispose();});
test('concurrent start rejected, late acquired lease ended after hangup',async()=>{const gate=deferred(),h=setup({callStart:()=>gate.promise});const start=h.api.startCall({sessionId:'s'});await flush();await assert.rejects(h.api.startCall({sessionId:'s'}),/正在启动/);await h.api.hangup();gate.resolve();await start;assert.equal(h.captures.length,0);assert.equal(h.calls.filter(x=>x.action==='call.end').length,1);assert.equal(h.api.state.getSnapshot().mode,'idle');await h.api.dispose();});
test('automatic read keeps session binding and streams only fresh output after retry',async()=>{const h=setup();await h.api.toggleRead('s');assert.equal(h.api.state.getSnapshot().sessionId,'s');h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'reasoning-delta',text:'hidden'}});h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'首句'}});h.publish('llm/retry');h.publish('assistant/live-chunk',{attemptId:'b',chunk:{type:'text-delta',text:'重试'}});assert.deepEqual(h.queues[0].text,['首句','重试']);assert.equal(h.api.state.getSnapshot().readEnabled,true);await h.api.dispose();});
test('automatic read and call each play a successful streamed reply once',async()=>{
 for(const call of [false,true]){
  const h=setup();await h.api.toggleRead('s');if(call)await h.api.startCall({sessionId:'s'});
  h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',turn:1,step:1,chunk:{type:'text-delta',text:'只读一次。'}});
  h.publish('assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'只读一次。'}]}});h.publish('step/end',{turn:1,step:1});h.publish('turn/end');
  assert.equal(h.queues.length,1);assert.deepEqual(h.queues[0].text,['只读一次。']);await h.api.dispose();
 }
});
test('voice sends only the recognized transcript verbatim',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
 c.onSpeechStart(1);c.onPartial('暂时');c.onFinal('暂时没有。\n你可以帮我做什么呢？',{utteranceId:1});await flush();
 assert.deepEqual(h.texts(),['暂时没有。\n你可以帮我做什么呢？']);assert.equal(h.api.state.getSnapshot().transcript,h.texts()[0]);await h.api.dispose();
});
test('barge-in cancels playback and generation without appending playback status to user text',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});h.publish('turn/start');
 h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'完整听到'}});h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'尚未确认'}});
 h.players[0].callbacks.onPlayed(1);h.status={running:true,pendingInteraction:false};const c=h.captures[0].callbacks;c.onSpeechStart(1);
 assert.equal(h.queues[0].cancelled,true);assert.ok(h.cancelCalls>0);h.players[0].callbacks.onPlayed(2);c.onFinal('插话',{utteranceId:1});await flush();
 assert.deepEqual(h.texts(),['插话']);await h.api.dispose();
});
test('failed voice send restores only transcript for the next voice retry',async()=>{
 let attempts=0;const h=setup({send:async()=>{if(++attempts===1)throw Error('发送失败');}});await h.api.startCall({sessionId:'s'});
 h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'播放中'}});
 const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('保留语段',{utteranceId:1});await flush();assert.equal(h.api.state.getSnapshot().error,'发送失败');
 c.onSpeechStart(2);c.onFinal('继续说',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['保留语段','保留语段\n继续说']);
 c.onSpeechStart(3);c.onFinal('下一条',{utteranceId:3});await flush();assert.equal(h.texts()[2],'下一条');await h.api.dispose();
});
test('session switch discards pending transcript and ignores old playback and failed send callbacks',async()=>{
 const gate=deferred();let sends=0;const h=setup({send:()=>++sends===1?gate.promise:undefined});await h.api.startCall({sessionId:'s'});
 h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'旧回复'}});h.players[0].callbacks.onPlayed(1);
 const old=h.captures[0].callbacks;old.onSpeechStart(1);old.onFinal('旧输入',{utteranceId:1});await flush();await h.api.hangup();
 await h.api.startCall({sessionId:'s2'});gate.reject(Error('旧会话发送失败'));await flush();old.onFinal('迟到转录',{utteranceId:2});h.players[0].callbacks.onPlayed(1);h.players[0].callbacks.onPlaybackStart();h.players[0].callbacks.onMetrics({level:0.9});assert.equal(h.api.state.getSnapshot().phase,'listening');assert.equal(h.api.state.getSnapshot().playbackLevel,0);
 const current=h.captures[1].callbacks;current.onSpeechStart(1);current.onFinal('新会话输入',{utteranceId:1});await flush();
 assert.deepEqual(h.sent,[{sessionId:'s',text:'旧输入'},{sessionId:'s2',text:'新会话输入'}]);assert.equal(h.api.state.getSnapshot().error,'');assert.equal(h.api.state.getSnapshot().sessionId,'s2');await h.api.dispose();
});
test('heartbeat failure hangs up while retaining actionable error',async()=>{let heartbeat,cleared=false;const h=setup({setInterval:fn=>{heartbeat=fn;return 7;},clearInterval:()=>{cleared=true;},heartbeat:async()=>{throw Error('连接已失效');}});await h.api.startCall({sessionId:'s'});heartbeat();await flush();assert.equal(h.api.state.getSnapshot().mode,'idle');assert.equal(h.api.state.getSnapshot().error,'连接已失效');assert.equal(cleared,true);assert.equal(h.captures[0].disposed,true);await h.api.dispose();});
test('already sent segment is not merged again while previous send promise remains pending',async()=>{const gate=deferred();let sends=0;const h=setup({send:()=>++sends===1?gate.promise:undefined});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('第一条',{utteranceId:1});await flush();c.onSpeechStart(2);c.onFinal('第二条',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['第一条','第二条']);gate.resolve();await h.api.dispose();});
test('real un-injected Cordis session scope uses explicit get for send and cancel',async()=>{const h=setup({cordisScope:true});await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:false};const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('测试会话服务',{utteranceId:1});await flush();assert.ok(h.cancelCalls>0);assert.deepEqual(h.texts(),['测试会话服务']);await h.api.dispose();});
test('dictation revisions replace captured span and refuse overwriting manually edited draft',async()=>{
 const h=setup();let draft='前后',rev=1,selection={start:1,end:1},persisted=0;
 const actions={captureInsertion:()=>({...selection,draftRev:rev}),insertText(text,span){if(span.draftRev!==rev)return false;draft=draft.slice(0,span.start)+text+draft.slice(span.end);rev++;selection={start:span.start+text.length,end:span.start+text.length};return true;},persistDraft(){persisted++;}};
 await h.api.startDictation({sessionId:'s',inputActions:actions});const c=h.captures[0].callbacks;c.onPartial('错字');assert.equal(draft,'前错字后');c.onPartial('正确');assert.equal(draft,'前正确后');assert.equal(persisted,2);
 draft+='手写';rev++;c.onPartial('修订');assert.equal(draft,'前正确后手写');assert.match(h.api.state.getSnapshot().error,/草稿已被修改/);c.onFinal('最终');assert.equal(draft,'前正确后手写');await h.api.dispose();c.onPartial('迟到');assert.equal(draft,'前正确后手写');
});
test('newest final cannot overtake an older unfinished recognition',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
 c.onSpeechStart(1);c.onSpeechEnd(1);c.onSpeechStart(2);c.onSpeechEnd(2);c.onFinal('后句',{utteranceId:2});await flush();assert.deepEqual(h.texts(),[]);
 c.onFinal('前句',{utteranceId:1});await flush();assert.deepEqual(h.texts(),['前句\n后句']);await h.api.dispose();
});
test('muting drops pending speech and leaves receiving playback available',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;c.onSpeechStart(1);h.api.setMuted(true);assert.equal(h.api.state.getSnapshot().muted,true);assert.equal(h.api.state.getSnapshot().level,0);assert.deepEqual(h.texts(),[]);h.api.toggleMute();assert.equal(h.api.state.getSnapshot().muted,false);c.onSpeechStart(2);c.onFinal('新输入',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['新输入']);await h.api.dispose();
});
test('speaking phase follows real playback instead of queued synthesis',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'一句话'}});assert.notEqual(h.api.state.getSnapshot().phase,'speaking');h.players[0].callbacks.onPlaybackStart({id:1});assert.equal(h.api.state.getSnapshot().phase,'speaking');h.players[0].callbacks.onPlaybackIdle();assert.equal(h.api.state.getSnapshot().phase,'listening');await h.api.dispose();
});
