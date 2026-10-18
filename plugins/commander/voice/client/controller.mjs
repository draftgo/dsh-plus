import { readVoiceEvents, RealtimeRecognizer } from './asr.mjs';
import { Capture, PCMPlayer } from './media.mjs';
import { SpeakableChunker, SpeechQueue } from './speech.mjs';
import { AgentFeed } from './agent-feed.mjs';
const url=path=>new URL(path,document.baseURI);
async function json(action,args={}) {
  const response=await fetch(url('api/voice'),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({action,...args})});
  const data=await response.json(); if(!response.ok)throw Error(data.error||'语音服务不可用'); return data;
}
function observable(initial) { let value=initial;const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},patch:patch=>{value={...value,...patch};for(const fn of listeners)fn();}}; }
export function createVoiceController(ctx,deps={}) {
  const request=deps.fetch||globalThis.fetch,requestJson=deps.json||json,environment=deps.window||globalThis.window;
  const makeCapture=deps.createCapture||(options=>new Capture(options)),makePlayer=deps.createPlayer||(options=>new PCMPlayer(options)),makeQueue=deps.createQueue||(options=>new SpeechQueue(options)),makeChunker=deps.createChunker||(()=>new SpeakableChunker());
  const wait=deps.wait||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const schedule=deps.setInterval||globalThis.setInterval,unschedule=deps.clearInterval||globalThis.clearInterval;
  const state=observable({config:null,mode:'idle',phase:'idle',sessionId:null,error:'',transcript:'',level:0,playbackLevel:0,muted:false,readEnabled:false});
  const deviceId=crypto.randomUUID(),played=new Set(),pendingText=new Map(),awaitingFinal=new Set();
  let delivering=null;
  let capture,player,queue,chunker,stopFeed,lease,heartbeat,binding,generation=0,inputSequence=0,latestUtterance=0,inputActive=false,speaking=false,blocked=false,disposed=false,stopping=false,starting=false,ending=null;
  const patch=value=>{if(!disposed)state.patch(value);};
  const fail=error=>patch({error:error?.message||String(error)});
  const callHeaders=()=>lease?{'x-voice-call-id':lease.callId}:{};
  const status=(sessionId=state.getSnapshot().sessionId)=>ctx.uiSession.sessionStatus.getSnapshot().get(sessionId);
  const refreshPhase=()=>patch({phase:state.getSnapshot().phase==='starting'&&starting?'starting':status()?.pendingInteraction?'waiting':speaking?'speaking':status()?.running?'thinking':awaitingFinal.size&&!inputActive?'transcribing':state.getSnapshot().mode!=='idle'?'listening':'idle'});
  const statusOff=ctx.uiSession.sessionStatus.subscribe(refreshPhase);
  function stopSpeech() {blocked=true;speaking=false;capture?.setPlaybackActive?.(false);patch({playbackLevel:0});chunker=makeChunker();queue?.cancel();played.clear();refreshPhase(); }
  function ensurePlayer() {
    if(!player){const current=makePlayer({workletURL:url('api/voice/worklet'),onError:error=>{if(player===current)fail(error);},onPlaybackStart:()=>{if(player!==current)return;speaking=true;capture?.setPlaybackActive?.(true);refreshPhase();},onPlaybackIdle:()=>{if(player!==current)return;speaking=false;capture?.setPlaybackActive?.(false);patch({playbackLevel:0});refreshPhase();},onMetrics:metrics=>{if(player===current&&metrics.level!==undefined)patch({playbackLevel:metrics.level});},onPlayed:id=>{if(player!==current)return;played.delete(id);if(!played.size&&!queue?.items.length){speaking=false;capture?.setPlaybackActive?.(false);refreshPhase();}}});player=current;}
    return player.start();
  }
  function ensureQueue() {
    if(!queue)queue=makeQueue({player,synthesize:async(text,signal)=>{
      const response=await request(url('api/voice/speech'),{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'application/json',...callHeaders()},body:JSON.stringify({text})});
      if(!response.ok){const result=await response.json();throw Error(result.error||'朗读失败');}return response;
    },onError:error=>{stopSpeech();fail(error);}});
  }
  function enqueue(text) {if(played.size>=128){fail(Error('播放确认队列已满，请停止后重新朗读'));return;}if(queue.push(text)){played.add(queue.sequence);refreshPhase();} }
  function pushText(delta) {
    if(blocked||!(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')||!delta)return;
    ensureQueue();chunker||=makeChunker();for(const text of chunker.push(delta))enqueue(text);
  }
  function attach(sessionId) {
    if(binding?.sessionId===sessionId)return;const next=ctx.sessions.binding(sessionId);if(!next)throw Error('请先打开一个可用对话');if(binding)stopSpeech();stopFeed?.();binding=next;
    const source=binding.eventSource;
    const feed=new AgentFeed({onText:pushText,onStart:()=>{if(!inputActive&&!awaitingFinal.size)blocked=false;chunker=makeChunker();refreshPhase();},onReset:()=>stopSpeech(),onEnd:()=>{
      if(!blocked&&(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')) {ensureQueue();for(const text of (chunker||=makeChunker()).finish())enqueue(text);}
      refreshPhase();
    }});
    feed.baseline(source.getSnapshot());stopFeed=source.subscribe(()=>feed.accept(source.getSnapshot()));patch({sessionId});
  }
  async function cancelAgent(sessionId=state.getSnapshot().sessionId) {if(status(sessionId)?.pendingInteraction)return false;const scope=ctx.sessions.scope(sessionId);if(scope&&status(sessionId)?.running)await scope.get('conversation').cancel();return true;}
  async function deliver(gen,sequence) {
    const claim=gen+':'+sequence;if(delivering===claim)return;delivering=claim;
    try{
    const valid=()=>gen===generation&&sequence===inputSequence&&state.getSnapshot().mode==='call'&&!inputActive&&!awaitingFinal.size;if(!valid())return;
    const entries=[...pendingText.entries()].sort((a,b)=>a[0]-b[0]),text=entries.map(x=>x[1]).filter(Boolean).join('\n');if(!text.trim())return;
    const awaiting=()=>{if(!status()?.pendingInteraction)return false;patch({error:'请先在对话中完成授权或交互；本段语音尚未发送',transcript:text,phase:'waiting'});return true;};if(awaiting())return;
    const scope=ctx.sessions.scope(state.getSnapshot().sessionId);if(!scope)throw Error('对话已经关闭');
    await cancelAgent();if(!valid()||awaiting())return;const deadline=Date.now()+10000;
    while(status()?.running){if(!valid()||awaiting())return;if(Date.now()>deadline)throw Error('原工具尚未停止，本段语音未发送，请手动重试');await wait(50);}
    if(!valid()||awaiting())return;blocked=false;chunker=makeChunker();patch({transcript:text,phase:'thinking'});
    for(const [id,value]of entries)if(pendingText.get(id)===value)pendingText.delete(id);
    try{await scope.get('conversation').send(text);}catch(error){if(gen===generation){for(const [id,value]of entries)if(!pendingText.has(id))pendingText.set(id,value);}throw error;}
    }finally{if(delivering===claim)delivering=null;}
  }
  async function begin({sessionId,inputActions},mode) {
    if(disposed)throw Error('语音插件已停用');if(starting)throw Error('语音正在启动');if(stopping)throw Error('正在释放上一段语音，请稍后重试');starting=true;let gen,createdCapture;
    try{
    if(ending)await ending;if(capture)await api.hangup();gen=++generation;
    const config=state.getSnapshot().config||await api.load();if(gen!==generation||disposed)return;
    if(!config[mode==='call'?'call':'dictation']||!config.asr.configured||mode==='call'&&!config.tts.configured)throw Error('请先在「设置 → 语音」启用功能并配置模型');
    attach(sessionId);patch({mode,sessionId,phase:'starting',error:'',transcript:'',muted:false,playbackLevel:0});pendingText.clear();awaitingFinal.clear();latestUtterance=0;inputActive=false;inputSequence++;
    if(mode==='call'){
      await ensurePlayer();if(gen!==generation||disposed)return;const result=await requestJson('call.start',{sessionId,deviceId});
      if(gen!==generation||disposed){await requestJson('call.end',{sessionId,deviceId,callId:result.call.callId});return;}lease={...result.call,sessionId};const currentLease=lease;
      heartbeat=schedule(()=>{void requestJson('call.heartbeat',{sessionId,deviceId,callId:currentLease.callId}).catch(error=>{if(lease===currentLease){fail(error);void api.hangup();}});},15000);
    }
    patch({mode,sessionId,phase:'listening',error:'',transcript:''});blocked=false;
    let span=mode==='dictation'?inputActions.captureInsertion():null,inserted='',finalText='',draftConflict=false;
    const writeDraft=text=>{
      if(gen!==generation||text===inserted||draftConflict)return;
      if(!inputActions.insertText(text,span)){draftConflict=true;patch({error:'草稿已被修改，请复制语音栏转录文字后插入',transcript:text});return;}
      inserted=text;const next=inputActions.captureInsertion();span={start:span.start,end:span.start+text.length,draftRev:next.draftRev};inputActions.persistDraft();
    };
    const realtime=['step-websocket','openai-websocket'].includes(config.asr.protocol)?new RealtimeRecognizer({request,endpoint:url,headers:callHeaders,onError:error=>{if(gen===generation){fail(error);void api.hangup();}}}):null;
    if(realtime){createdCapture={dispose:()=>realtime.close()};capture=createdCapture;await realtime.start();if(gen!==generation){await realtime.close();return;}}
    createdCapture=makeCapture({realtime,parallel:['transcriptions-sse','mimo-sse','step-sse'].includes(config.asr.protocol),workletURL:url('api/voice/worklet'),transcribe:async(blob,signal,onPartial)=>{
      const response=await request(url('api/voice/transcribe'),{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'audio/wav',...callHeaders()},body:blob});
      if(response.headers.get('content-type')?.includes('application/x-ndjson')){let text='',final=false;await readVoiceEvents(response,signal,event=>{if(event.type==='partial'){text=event.text;onPartial?.(text);}if(event.type==='final'){text=event.text;final=true;}});if(!final)throw Error('识别连接在最终结果前关闭');return {text};}
      const result=await response.json();if(!response.ok)throw Error(result.error||'转录失败');return result;
    },onLevel:level=>{if(gen===generation)patch({level});},onSpeechStart:id=>{if(gen!==generation)return;latestUtterance=id??latestUtterance+1;awaitingFinal.add(latestUtterance);inputActive=true;inputSequence++;if(mode==='call'){stopSpeech();void cancelAgent(sessionId).catch(error=>{if(gen===generation)fail(error);});}patch({phase:status(sessionId)?.pendingInteraction?'waiting':'listening'});},
    onSpeechEnd:(id,meta={})=>{if(gen!==generation)return;if(id===latestUtterance)inputActive=false;if(meta.cancelled){awaitingFinal.delete(id);pendingText.delete(id);}refreshPhase();},
    onPartial:(text,meta={})=>{if(gen!==generation)return;if(mode==='dictation'){patch({transcript:text});writeDraft(finalText+text);}else if((meta.utteranceId??latestUtterance)===latestUtterance)patch({transcript:[...pendingText.values(),text].filter(Boolean).join('\n')});},
    onFinal:(text,meta={})=>{if(gen!==generation)return;const id=meta.utteranceId??latestUtterance;awaitingFinal.delete(id);if(id===latestUtterance)inputActive=false;if(mode==='dictation'){finalText+=text;writeDraft(finalText);}else{pendingText.set(id,text);patch({transcript:[...pendingText.values()].join('\n')});if(!inputActive&&!awaitingFinal.size)void deliver(gen,inputSequence).catch(error=>{if(gen===generation)fail(error);});}},
    onError:error=>{if(gen===generation){fail(error);void api.hangup();}}});
    capture=createdCapture;await createdCapture.start();if(gen!==generation||disposed){await createdCapture.dispose();return;}patch({phase:'listening'});blocked=false;
    }catch(error){if(gen===generation)await api.hangup();else await createdCapture?.dispose();throw error;}finally{starting=false;}
  }
  const api={state,
    async load(){try{const {config}=await requestJson('config');patch({config,error:''});return config;}catch(error){fail(error);throw error;}},
    async configure(config){await api.hangup();const result=await requestJson('configure',{config});patch({config:result.config,error:''});return result.config;},
    setMuted(value){if(state.getSnapshot().mode!=='call')return;const muted=!!value;if(muted===state.getSnapshot().muted)return;capture?.setMuted?.(muted);inputSequence++;inputActive=false;awaitingFinal.clear();pendingText.clear();patch({muted,level:0,transcript:''});refreshPhase();},
    toggleMute(){api.setMuted(!state.getSnapshot().muted);},
    async toggleRead(sessionId){
      if(state.getSnapshot().mode==='call')return;
      if(state.getSnapshot().readEnabled){stopSpeech();patch({readEnabled:false});return;}
      const config=state.getSnapshot().config||await api.load();if(!config.readAloud||!config.tts.configured)throw Error('请先在「设置 → 语音」配置并开启朗读');
      const gen=generation;attach(sessionId);try{await ensurePlayer();if(gen!==generation||disposed)return;ensureQueue();chunker=makeChunker();blocked=false;patch({readEnabled:true,sessionId,error:''});}catch(error){await api.hangup();throw error;}
    },
    startDictation:args=>begin(args,'dictation'),
    async stopDictation(){if(!capture||state.getSnapshot().mode!=='dictation')return;const current=capture;stopping=true;try{await current.stop({flush:true});}finally{if(capture===current){capture=null;patch({mode:'idle',phase:'idle'});}stopping=false;}},
    startCall:args=>begin(args,'call'),
    hangup(){
      if(ending)return ending;++generation;inputSequence++;inputActive=false;unschedule(heartbeat);const snapshot=state.getSnapshot(),oldCapture=capture,oldLease=lease,oldQueue=queue,oldPlayer=player;capture=null;lease=null;
      stopSpeech();queue=null;player=null;played.clear();pendingText.clear();awaitingFinal.clear();stopFeed?.();stopFeed=null;binding=null;patch({mode:'idle',phase:'idle',level:0,playbackLevel:0,muted:false,readEnabled:false});
      const run=(async()=>{const jobs=[oldCapture?.dispose(),oldQueue?.dispose(),oldPlayer?.dispose()];if(snapshot.mode==='call')jobs.push(cancelAgent(snapshot.sessionId));if(oldLease)jobs.push(requestJson('call.end',{sessionId:oldLease.sessionId,deviceId,callId:oldLease.callId}));await Promise.allSettled(jobs);})();ending=run.finally(()=>{ending=null;});return ending;
    },
    async dispose(){unschedule(chunkTimer);await api.hangup();statusOff();environment?.removeEventListener('pagehide',leave);environment?.removeEventListener('offline',leave);disposed=true;}
  };
  const chunkTimer=schedule(()=>{if(!blocked&&chunker?.flushIdle&&(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call'))for(const text of chunker.flushIdle(Date.now()))enqueue(text);},25);chunkTimer?.unref?.();
  const leave=()=>{void api.hangup();};environment?.addEventListener('pagehide',leave);environment?.addEventListener('offline',leave);return api;
}
