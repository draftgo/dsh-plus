const RATE=24000;
let microphoneOwner=null;
const abortError=()=>new DOMException('Voice operation cancelled','AbortError');
export function pcmWav(frames){
  const length=frames.reduce((n,f)=>n+f.length,0),bytes=new ArrayBuffer(44+length*2),v=new DataView(bytes);
  const str=(p,s)=>{for(let i=0;i<s.length;i++)v.setUint8(p+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+length*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,RATE,true);v.setUint32(28,RATE*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,length*2,true);
  let p=44;for(const f of frames)for(const x of f){v.setInt16(p,x,true);p+=2;}
  return new Blob([bytes],{type:'audio/wav'});
}
const join=(a,b)=>!a?b:!b?a:a+(/[\p{Script=Han}]$/u.test(a)||/^[\p{Script=Han}，。！？、]/u.test(b)?'':' ')+b;
export class Capture {
  constructor({transcribe,realtime,onPartial=()=>{},onFinal=()=>{},onSpeechStart=()=>{},onSpeechEnd=()=>{},onLevel=()=>{},onError=()=>{},silenceMs=400,workletURL='api/voice/worklet'}={}){
    Object.assign(this,{transcribe,realtime,onPartial,onFinal,onSpeechStart,onSpeechEnd,onLevel,onError,silenceMs,workletURL});this.levelAt=0;this.generation=0;this.active=false;this.pending=Promise.resolve();this.controllers=new Set();this.pre=[];this.noise=.001;this.muted=false;this.playbackActive=false;this.echoUntil=0;this.attack=0;this.backlog=0;this.segment=null;this.stopping=null;this.utteranceId=0;this.finals=new Set();this.queuedSamples=0;
  }
  async start(){
    if(this.active)return;if(this.stopping)await this.stopping;if(microphoneOwner&&microphoneOwner!==this)throw Error('麦克风已被另一个语音入口使用');
    if(!globalThis.navigator?.mediaDevices?.getUserMedia)throw Error('麦克风需要 HTTPS 或 localhost 安全环境');
    microphoneOwner=this;this.active=true;this.lastFinal='';const generation=++this.generation;
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(!this.active||generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;this.context=new Audio();
      const context=this.context;await context.audioWorklet.addModule(String(this.workletURL));if(!this.active||generation!==this.generation){if(this.context===context)await this.release();return;}
      this.node=new AudioWorkletNode(this.context,'voice-capture',{numberOfOutputs:1,outputChannelCount:[1]});this.node.port.onmessage=({data})=>{if(this.active&&!this.muted&&data.epoch===this.generation&&data.type==='pcm')this.accept(new Int16Array(data.data));};
      this.node.port.postMessage({type:'mute',value:this.muted,epoch:this.generation});for(const track of stream.getAudioTracks?.()||[])track.enabled=!this.muted;this.source=this.context.createMediaStreamSource(stream);this.source.connect(this.node);this.node.connect(this.context.destination);await this.context.resume();
    }catch(e){if(generation===this.generation){this.active=false;await this.release();}throw e;}
  }
  setPlaybackActive(value){this.playbackActive=!!value;if(!value)this.echoUntil=Date.now()+350;}
  setMuted(value){
    if(this.muted===!!value)return;this.muted=!!value;if(this.muted)this.generation++;for(const track of this.stream?.getAudioTracks?.()||[])track.enabled=!this.muted;this.node?.port.postMessage({type:'mute',value:this.muted,epoch:this.generation});
    if(this.muted){const id=this.segment?.id;this.segment=null;this.pre=[];this.attack=0;for(const c of this.controllers)c.abort();void this.realtime?.clear?.().catch(error=>this.onError(error));this.onLevel(0);if(id)this.onSpeechEnd(id,{cancelled:true});}
  }
  accept(frame){
    if(this.muted)return;
    let sum=0;for(const x of frame)sum+=(x/32768)**2;const rms=Math.sqrt(sum/frame.length),ms=frame.length/RATE*1000;
    const now=Date.now();if(now-this.levelAt>=66){this.levelAt=now;this.onLevel(Math.min(1,rms*8));}
    const protectedAudio=this.playbackActive||now<this.echoUntil;const voice=rms>Math.max(protectedAudio?.009:.004,this.noise*(protectedAudio?3.5:2.2));
    if(!this.segment){
      this.pre.push(frame);while(this.pre.reduce((n,f)=>n+f.length,0)>RATE*.22)this.pre.shift();
      this.attack=voice?this.attack+ms:0;if(!voice&&!protectedAudio)this.noise=this.noise*(rms<this.noise?.9:.995)+rms*(rms<this.noise?.1:.005);
      if(this.attack<(protectedAudio?260:120))return;
      this.segment={frames:this.pre.splice(0),samples:0,total:0,silence:0,text:'',generation:this.generation,id:++this.utteranceId};
      this.segment.samples=this.segment.frames.reduce((n,f)=>n+f.length,0);this.attack=0;this.onSpeechStart(this.segment.id);
    }else{this.segment.frames.push(frame);this.segment.samples+=frame.length;}
    const s=this.segment;s.total+=ms;s.silence=voice?0:s.silence+ms;
    if(s.silence>=this.silenceMs||s.total>=15000)this.commit();else if(s.samples>=RATE*(this.realtime?.1:2))this.submit(s);
  }
  submit(s){
    if(!s.frames.length)return;
    if(this.realtime?this.queuedSamples+s.samples>RATE*6:this.backlog>=6){s.frames=[];s.samples=0;this.onError(Error('语音识别处理过慢，已丢弃超限音频'));return;}
    const frames=s.frames,blob=this.realtime?null:pcmWav(frames);s.frames=[];s.samples=0;this.backlog++;const queuedSamples=frames.reduce((n,f)=>n+f.length,0);this.queuedSamples+=queuedSamples;
    this.pending=this.pending.then(async()=>{
      if(s.generation!==this.generation)return;
      const controller=new AbortController();this.controllers.add(controller);let timer;
      try{
        if(this.realtime){await this.realtime.append(frames,s.id,text=>{if(s.generation===this.generation){s.text=text;this.onPartial(text,{utteranceId:s.id});}});return;}
        const prefix=s.text;
        const result=await Promise.race([Promise.resolve().then(()=>this.transcribe(blob,controller.signal,text=>{if(s.generation===this.generation)this.onPartial(join(prefix,text),{utteranceId:s.id});})),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Error('语音识别超时'));controller.abort();},25000);controller.signal.addEventListener('abort',()=>reject(abortError()),{once:true});})]);
        if(s.generation!==this.generation)return;const text=(typeof result==='string'?result:result?.text||'').trim();s.text=join(s.text,text);if(text)this.onPartial(s.text,{utteranceId:s.id});
      }catch(e){if(e.name!=='AbortError'&&s.generation===this.generation)this.onError(e);}
      finally{clearTimeout(timer);this.controllers.delete(controller);}
    }).finally(()=>{this.backlog--;this.queuedSamples=Math.max(0,this.queuedSamples-queuedSamples);});
  }
  commit(){const s=this.segment;if(!s)return Promise.resolve('');this.segment=null;this.pre=[];this.onSpeechEnd(s.id,{cancelled:false});this.submit(s);
    const final=this.pending.then(async()=>{if(this.realtime&&s.generation===this.generation)s.text=await this.realtime.commit(s.id);if(s.generation===this.generation){if(s.text)this.lastFinal=s.text;this.onFinal(s.text,{utteranceId:s.id,final:true});return s.text;}return '';});const settled=final.then(()=>{},error=>{if(s.generation===this.generation&&error.name!=='AbortError')this.onError(error);}).finally(()=>this.finals.delete(settled));this.finals.add(settled);this.pending=settled;return final;
  }
  async release(){
    this.node?.disconnect();this.source?.disconnect();if(this.node)this.node.port.onmessage=null;this.stream?.getTracks().forEach(t=>t.stop());
    const context=this.context;this.node=null;this.source=null;this.stream=null;this.context=null;if(context&&context.state!=='closed')await context.close().catch(()=>{});if(microphoneOwner===this)microphoneOwner=null;
  }
  stop({flush=true}={}){
    if(this.stopping)return this.stopping;this.active=false;const final=flush?this.commit():Promise.resolve('');
    if(!flush){this.generation++;this.segment=null;for(const c of this.controllers)c.abort();void this.realtime?.close();}
    this.pre=[];this.attack=0;this.stopping=(async()=>{await this.release();const text=await final;await this.pending;await Promise.allSettled([...this.finals]);await this.realtime?.close();return flush?(text||this.lastFinal||''):'';})().finally(()=>{this.stopping=null;});return this.stopping;
  }
  dispose(){return this.stop({flush:false});}
}
export class PCMPlayer {
  constructor({onPlayed=()=>{},onPlaybackStart=()=>{},onPlaybackIdle=()=>{},onMetrics=()=>{},onError=()=>{},workletURL='api/voice/worklet',maxBufferedSeconds=2}={}){
    Object.assign(this,{onPlayed,onPlaybackStart,onPlaybackIdle,onMetrics,onError,workletURL});this.maxSamples=Math.max(RATE,maxBufferedSeconds*RATE);this.epoch=0;this.queued=0;this.waiters=[];this.odd=null;this.starting=null;
  }
  async start(){
    if(this.starting)return this.starting;if(this.context?.state==='running'&&this.node)return;
    this.starting=(async()=>{const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)throw Error('此浏览器不支持 Web Audio');
      if(!this.context){this.context=new Audio();try{await this.context.audioWorklet.addModule(String(this.workletURL));this.node=new AudioWorkletNode(this.context,'voice-playback',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});this.node.port.onmessage=({data:m})=>{if(m.epoch!==this.epoch)return;if(m.type==='consumed'){this.queued=Math.max(0,this.queued-m.count);this.wake();}else if(m.type==='played')this.onPlayed(m.id);else if(m.type==='playing')this.onPlaybackStart({id:m.id,epoch:this.epoch});else if(m.type==='idle'||m.type==='buffering')this.onPlaybackIdle();else if(m.type==='error')this.onError(Error(m.error));if(m.type==='level')this.onMetrics({bufferedSeconds:this.queued/RATE,level:m.level});};this.node.connect(this.context.destination);this.node.port.postMessage({type:'clear',epoch:this.epoch});}catch(e){await this.context.close().catch(()=>{});this.context=null;throw e;}}
      await this.context.resume();})().finally(()=>this.starting=null);return this.starting;
  }
  wake(){for(const done of this.waiters.splice(0))done();}
  async enqueue(bytes,id){
    const epoch=this.epoch;await this.start();if(epoch!==this.epoch)return;
    if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
    if(this.odd!==null){const merged=new Uint8Array(bytes.length+1);merged[0]=this.odd;merged.set(bytes,1);bytes=merged;this.odd=null;}
    if(bytes.length%2){this.odd=bytes[bytes.length-1];bytes=bytes.subarray(0,-1);}
    for(let offset=0;offset<bytes.length;offset+=24000){
      const part=bytes.subarray(offset,Math.min(bytes.length,offset+24000));while(epoch===this.epoch&&this.queued+part.length/2>this.maxSamples)await new Promise(resolve=>this.waiters.push(resolve));if(epoch!==this.epoch)return;
      const samples=new Int16Array(part.length/2),view=new DataView(part.buffer,part.byteOffset,part.byteLength);for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true);
      this.queued+=samples.length;this.node.port.postMessage({type:'pcm',id,epoch,data:samples.buffer},[samples.buffer]);
    }
  }
  segmentEnd(id){if(this.odd!==null){this.odd=null;this.onError(Error('TTS PCM 数据存在不完整采样'));}this.node?.port.postMessage({type:'end',id,epoch:this.epoch});}
  clear(){this.onPlaybackIdle();this.epoch++;this.queued=0;this.odd=null;this.node?.port.postMessage({type:'clear',epoch:this.epoch});this.wake();}
  async dispose(){this.clear();await this.starting?.catch(()=>{});this.node?.disconnect();if(this.node)this.node.port.onmessage=null;const c=this.context;this.node=null;this.context=null;if(c&&c.state!=='closed')await c.close();}
}
