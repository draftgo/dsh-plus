/* Persistent Blackman-windowed sinc conversion; packet edges retain phase/history. */
const RATE=24000, HALF=12;
function kernel(x,c){if(Math.abs(x)>=HALF)return 0;return (Math.abs(x)<1e-8?c:Math.sin(Math.PI*c*x)/(Math.PI*x))*(.42+.5*Math.cos(Math.PI*x/HALF)+.08*Math.cos(2*Math.PI*x/HALF));}
function coefficients(c){return Array.from({length:256},(_,phase)=>{const row=new Float32Array(HALF*2);let sum=0;for(let j=0;j<row.length;j++)sum+=(row[j]=kernel(phase/256+HALF-1-j,c));for(let j=0;j<row.length;j++)row[j]/=sum;return row;});}
class CaptureResampler {
  constructor(rate){this.step=rate/RATE;this.cutoff=Math.min(1,RATE/rate)*.94;this.coefficients=coefficients(this.cutoff);this.ring=new Float32Array(4096);this.written=0;this.position=0;}
  push(value,output){this.ring[this.written++%4096]=value;while(this.position+HALF<this.written){let sum=0;const integer=Math.floor(this.position),start=integer-HALF+1,row=this.coefficients[Math.min(255,Math.floor((this.position-integer)*256))];for(let j=0;j<HALF*2;j++){const index=start+j;sum+=(index<0?0:this.ring[index%4096])*row[j];}output(sum);this.position+=this.step;}}
}
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(){super();this.resampler=new CaptureResampler(sampleRate);this.frame=new Int16Array(480);this.used=0;this.muted=false;this.inputEpoch=0;this.port.onmessage=({data:m})=>{if(m.type==='mute'){this.muted=!!m.value;this.inputEpoch=m.epoch??this.inputEpoch;this.used=0;this.resampler=new CaptureResampler(sampleRate);}};}
  process(inputs){const channels=inputs[0];if(this.muted||!channels?.length)return true;for(let i=0;i<channels[0].length;i++){let value=0;for(const c of channels)value+=c[i]||0;this.resampler.push(value/channels.length,v=>{this.frame[this.used++]=Math.round(Math.max(-1,Math.min(1,v))*32767);if(this.used===480){const data=this.frame.buffer;this.port.postMessage({type:'pcm',epoch:this.inputEpoch,data},[data]);this.frame=new Int16Array(480);this.used=0;}});}return true;}
}
class VoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor(){super();this.ring=new Float32Array(RATE*8);this.epoch=0;this.coefficients=coefficients(Math.min(1,sampleRate/RATE)*.94);this.reset();this.port.onmessage=({data:m})=>{if(m.type==='clear'){this.epoch=m.epoch;this.reset();}else if(m.epoch===this.epoch&&m.type==='pcm'){const samples=new Int16Array(m.data);if(samples.length+this.written-Math.floor(this.position)>this.ring.length-HALF){this.port.postMessage({type:'error',epoch:this.epoch,error:'播放缓冲超限'});return;}this.spans.push({at:this.written,id:m.id});for(const v of samples)this.ring[this.written++%this.ring.length]=v/32768;}else if(m.epoch===this.epoch&&m.type==='end')this.ends.push({at:this.written,id:m.id});};}
  // Start after a short 60 ms cushion; grow it adaptively only when a stream
  // underruns, so the first TTS packet becomes audible sooner.
  reset(){this.ring.fill(0);this.position=0;this.written=0;this.acked=0;this.ends=[];this.spans=[];this.started=false;this.active=false;this.meterFrames=0;this.target=RATE*.06;this.stable=0;}
  process(_inputs,outputs){const out=outputs[0]?.[0];if(!out)return true;out.fill(0);const step=RATE/sampleRate;let rendered=false;
    for(let i=0;i<out.length;i++){
      const remaining=this.written-this.position,complete=this.ends.some(e=>e.at===this.written);
      if(!this.started){if(remaining>=this.target||complete&&remaining>0){this.started=true;if(!this.active){this.active=true;this.port.postMessage({type:'playing',id:this.spans[0]?.id,epoch:this.epoch});}}else continue;}
      if(remaining<=0||!complete&&remaining<=HALF){if(this.started&&remaining<=HALF&&!complete){this.target=Math.min(RATE*.18,this.target+RATE*.02);this.port.postMessage({type:'buffering',epoch:this.epoch});}this.started=false;continue;}
      let value=0;const integer=Math.floor(this.position),start=integer-HALF+1,row=this.coefficients[Math.min(255,Math.floor((this.position-integer)*256))];for(let j=0;j<HALF*2;j++){const at=start+j;value+=(at<0||at>=this.written?0:this.ring[at%this.ring.length])*row[j];}out[i]=value;this.position=Math.min(this.written,this.position+step);rendered=true;
    }
    // Confirm only audio consumed by this render quantum, never on receipt.
    while(this.spans[1]?.at<=this.position)this.spans.shift();const consumed=Math.floor(this.position)-this.acked;if(consumed>0){this.acked+=consumed;this.port.postMessage({type:'consumed',count:consumed,epoch:this.epoch});}
    let completed=false;while(this.ends[0]?.at<=this.position){this.port.postMessage({type:'played',id:this.ends.shift().id,epoch:this.epoch});completed=true;}
    // An underrun is still an active utterance: keep echo/interrupt protection
    // until its explicit end, including an end received after the last sample.
    if(this.position>=this.written&&this.active&&completed){this.active=false;this.started=false;this.port.postMessage({type:'idle',epoch:this.epoch});}
    if(rendered){this.meterFrames+=out.length;if(this.meterFrames>=sampleRate/15){this.meterFrames=0;let energy=0;for(const value of out)energy+=value*value;this.port.postMessage({type:'level',level:Math.min(1,Math.sqrt(energy/out.length)*4),epoch:this.epoch});}this.stable+=out.length/sampleRate;if(this.stable>=3){this.target=Math.max(RATE*.06,this.target-RATE*.02);this.stable=0;}}else this.stable=0;return true;
  }
}
registerProcessor('voice-capture',VoiceCaptureProcessor);
registerProcessor('voice-playback',VoicePlaybackProcessor);
