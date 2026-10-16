/** Only fresh append publications are eligible for automatic speech. */
export class AgentFeed {
  constructor({onText,onStart,onEnd,onReset}={}) { Object.assign(this,{onText,onStart,onEnd,onReset}); this.attempts=new Map();this.steps=new Map();this.seen=new Set();this.revision=null;this.restart=false; }
  key(event){return event.data?.attemptId??String(event.data?.turn??'')+':'+String(event.data?.step??'');}
  step(event){const {turn,step}=event.data||{};return turn!==undefined&&step!==undefined?turn+':'+step:undefined;}
  track(event){const key=this.key(event),step=this.step(event);if(step!==undefined)this.steps.set(step,key);return key;}
  forget(key){this.attempts.delete(key);for(const [step,id]of this.steps)if(id===key)this.steps.delete(step);}
  clear(){this.attempts.clear();this.steps.clear();}
  remember(event){const key=event.type+':'+event.seq+':'+this.key(event);if(this.seen.has(key))return false;this.seen.add(key);if(this.seen.size>4096)this.seen.delete(this.seen.values().next().value);return true;}
  baseline(window) { this.revision=window.revision;this.clear();this.seen.clear();this.restart=false;for(const {event}of window.entries||[]){this.remember(event);if(event.type==='assistant/live-chunk'&&event.data?.chunk?.type==='text-delta'){const key=this.track(event);this.attempts.set(key,(this.attempts.get(key)||'')+event.data.chunk.text);}} }
  accept(window) {
    if(window.revision!==undefined&&window.revision===this.revision)return;this.revision=window.revision;
    const change=window.change;
    if(change.kind==='replace') { this.onReset?.(); this.baseline(window); return; }
    if(change.kind==='prepend'){for(const {event}of change.entries||[])this.remember(event);return;}
    if(change.kind==='settle-assistant'&&!change.entry){this.forget(change.attemptId);return;}
    const entries=change.kind==='settle-assistant'?[change.entry].filter(Boolean):change.entries||[];
    for(const {event} of entries) {
      if(!this.remember(event))continue;
      if(event.type==='assistant/live-chunk') {
        const {chunk}=event.data;const key=this.track(event);
        if(chunk.type==='text-delta') {if(this.restart){this.restart=false;this.onStart?.(event);}this.attempts.set(key,(this.attempts.get(key)||'')+chunk.text); this.onText?.(chunk.text); }
        continue;
      }
      if(event.type==='turn/start'){this.restart=false;this.clear();this.onStart?.();}
      if(event.type==='llm/retry'||event.type==='assistant/attempt') { this.onReset?.(); this.clear();this.restart=true; }
      if(event.type==='assistant/message') {
        const text=(event.data.message?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
        // Successful messages append before step/end retires the transient attempt.
        // Durable messages carry turn/step, while live chunks carry attemptId.
        const key=change.kind==='settle-assistant'?change.attemptId??this.key(event):this.steps.get(this.step(event))??this.key(event),prefix=this.attempts.get(key)||'';
        if(!event.data.interrupted&&text.startsWith(prefix)){if(this.restart){this.restart=false;this.onStart?.(event);}if(text.length>prefix.length)this.onText?.(text.slice(prefix.length));}
        this.forget(key);
      }
      if(event.type==='turn/end')this.onEnd?.(event);
    }
  }
}
