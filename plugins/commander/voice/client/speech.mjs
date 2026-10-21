// Only assistant-visible text belongs here: reasoning/tool payloads must be excluded by the caller.
export function speakable(text){
  return text
    .replace(/https?:\/\/\S+/gi,'')
    .replace(/\b(?:sk|dg|ghp|github_pat|AKIA|Bearer)[-_ ]?[A-Za-z0-9_+\/-]{10,}={0,2}/gi,'[敏感信息已略过]')
    .replace(/\b(?:api[_ -]?key|secret|token|password|密码|密钥)\s*[:=]\s*[^\s，。；;]+/gi,'[敏感信息已略过]')
    .replace(/\b[A-Za-z0-9_+\/=-]{36,}\b/g,'[长标识已略过]')
    .replace(/^[ \t]*#{1,6}\s+/gm,'').replace(/[*_~]+/g,'').replace(/\s+/g,' ').trim();
}
const ACTION = /^(?:微笑|笑着(?:说)?|轻笑|大笑|苦笑|叹气|轻叹|清嗓|咳嗽|点头|摇头|挠头|耸肩|沉默|停顿|深呼吸|吸气|呼气|开心|兴奋|低声|耳语|温柔|严肃|思考中|laughs?|chuckles?|sighs?|whispers?|smiles?|nods?|clears throat)(?:中|地|了一下)?$/iu;
const HINTS = { code: '代码我发在聊天里了。', table: '表格我放在聊天里了。', url: '链接已发在聊天里。' };
export class SpeakableChunker {
  constructor({maxChars=120,now=()=>Date.now()}={}){this.now=now;this.startedAt=0;this.updatedAt=0;this.emitted=0;this.maxChars=Math.max(40,Math.min(maxChars,500));this.raw='';this.text='';this.fenced=null;this.inline=false;this.hidden=null;this.discardToken=false;this.url=false;this.table=false;this.lineStart=true;this.hints=new Set();this.discardLink=false;}
  push(delta){if(!this.startedAt)this.startedAt=this.now();this.updatedAt=this.now();this.raw+=String(delta||'');return this.consume(false);}
  consume(final,drain=false){
    const out=[];
    const emit=()=>{const safe=speakable(this.text);this.text='';if(safe){out.push(safe);this.emitted++;this.startedAt=this.now();}};
    const append=value=>{for(const ch of value){this.text+=ch;if(/[。！？；!?\n]/u.test(ch)||ch==='.'&&(!this.raw[0]||/\s/.test(this.raw[0])))emit();else if(!this.emitted&&!this.inline&&/[，,]/u.test(ch)&&!/[0-9]/.test(this.text.at(-2)||'')&&this.text.trim().length>=(/[\p{Script=Han}]/u.test(this.text)?10:32))emit();else if(this.text.length>=this.maxChars){const boundary=Math.max(this.text.lastIndexOf(' '),this.text.lastIndexOf('，'),this.text.lastIndexOf(','));if(boundary>=this.maxChars*.4){const tail=this.text.slice(boundary+1);this.text=this.text.slice(0,boundary+1);emit();this.text=tail;}else if(/[\p{Script=Han}]/u.test(ch))emit();else if(this.text.length>this.maxChars+100){this.text='[过长标识已略过]';emit();this.discardToken=true;}}}};
    const hint=kind=>{if(this.hints.has(kind))return;this.hints.add(kind);if(this.text.trim())append(' ');append(HINTS[kind]);};
    // Emit confirmed sentence and first-clause boundaries without an idle delay.
    // The parser still retains incomplete markup and URL prefixes.
    while(this.raw.length&&(final||drain||this.raw.length>8||/[。！？；!?\n]/u.test(this.raw)||!this.emitted&&/[，,]/u.test(this.raw))){
      if(this.hidden){const close='</'+this.hidden+'>';const pos=this.raw.toLowerCase().indexOf(close);if(pos<0){this.raw=this.raw.slice(-close.length);break;}this.raw=this.raw.slice(pos+close.length);this.hidden=null;continue;}
      if(this.fenced){const pos=this.raw.indexOf(this.fenced);if(pos<0){this.raw=this.raw.slice(-2);if(final)this.raw='';break;}this.raw=this.raw.slice(pos+3);this.fenced=null;this.lineStart=true;continue;}
      if(this.discardLink){const end=this.raw.indexOf(')');const newline=this.raw.indexOf('\n');if(end>=0&&(newline<0||end<newline)){this.raw=this.raw.slice(end+1);this.discardLink=false;continue;}if(newline>=0){this.raw=this.raw.slice(newline);this.discardLink=false;continue;}this.raw='';break;}
      if(this.url){let end=0;while(end<this.raw.length&&!/[\s<>，。！？；）]/u.test(this.raw[end]))end++;this.raw=this.raw.slice(end);if(this.raw.length)this.url=false;else break;continue;}
      if(this.table){const newline=this.raw.indexOf('\n');if(newline<0){this.raw='';break;}this.raw=this.raw.slice(newline+1);this.table=false;this.lineStart=true;continue;}
      if(this.raw.startsWith('~~~')||this.raw.startsWith(String.fromCharCode(96).repeat(3))){this.fenced=this.raw.slice(0,3);this.inline=false;this.raw=this.raw.slice(3);hint('code');continue;}
      // Keep incomplete URL prefixes out of idle/final speech, including a prefix split between deltas.
      const lower=this.raw.toLowerCase();const prefixes=['https://','http://','www.'];
      if(prefixes.some(prefix=>lower.startsWith(prefix))){this.url=true;hint('url');continue;}
      if(!final&&prefixes.some(prefix=>prefix.startsWith(lower)))break;
      if(this.raw[0]==='<'){
        const end=this.raw.indexOf('>');if(end<0){if(this.raw.length<256&&!final)break;this.raw=this.raw.slice(-8);if(final)this.raw='';break;}
        const tag=this.raw.slice(1,end).trim().toLowerCase();if(['think','thinking','analysis','reasoning','secret'].includes(tag))this.hidden=tag;
        this.raw=this.raw.slice(end+1);continue;
      }
      if(this.lineStart){
        const line=this.raw.split('\n',1)[0];
        if(/^\s*\|/u.test(line)||line.includes('|')&&(/\|.*\|/u.test(line)||/^[^。！？!?]{0,160}\|/u.test(line))){this.table=true;this.text='';hint('table');continue;}
        if(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u.test(line)){const match=/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u.exec(this.raw);this.raw=this.raw.slice(match[0].length);if(!this.raw)break;}
      }
      if(this.raw.charCodeAt(0)===96){this.inline=!this.inline;this.raw=this.raw.slice(1);continue;}
      if(this.raw[0]==='['){
        const labelEnd=this.raw.indexOf(']');
        if(labelEnd<0||this.raw.length===labelEnd+1){if(this.raw.length<2048&&!final)break;if(!final){this.raw='';this.discardLink=true;break;}}
        if(labelEnd>=0&&this.raw[labelEnd+1]==='('){const urlEnd=this.raw.indexOf(')',labelEnd+2);if(urlEnd<0){if(this.raw.length<2048&&!final)break;const label=this.raw.slice(1,labelEnd);this.raw='';append(label);this.discardLink=!final;break;}const label=this.raw.slice(1,labelEnd);this.raw=this.raw.slice(urlEnd+1);append(label);this.lineStart=false;continue;}
      }
      const pair={'(' : ')','（':'）','[':']','*':'*'}[this.raw[0]];
      if(pair){const end=this.raw.indexOf(pair,1);if(end>0&&end<=80&&ACTION.test(this.raw.slice(1,end).trim())){this.raw=this.raw.slice(end+1);continue;}if(end<0&&this.raw.length<82&&!final)break;}
      const ch=String.fromCodePoint(this.raw.codePointAt(0));this.raw=this.raw.slice(ch.length);
      if(this.discardToken){if(/\s|[，。！？；]/u.test(ch))this.discardToken=false;else continue;}
      if(/[\p{Extended_Pictographic}️‍]/u.test(ch))continue;
      if(ch==='|'&&!this.inline){this.table=true;this.text='';hint('table');continue;}
      this.lineStart=ch==='\n'||this.lineStart&&/[ 	]/u.test(ch);append(ch);
    }
    if(final){this.raw='';emit();}return out;
  }
  flushIdle(now=this.now()){
    if(this.hidden||this.fenced||this.inline||this.url||this.table||this.discardLink)return [];
    const idle=now-this.updatedAt,age=now-this.startedAt,first=this.emitted===0;
    if(idle<(first?300:650)&&age<(first?700:1200))return [];
    const held=this.consume(false,idle>=(first?300:650));if(held.length)return held;
    const content=this.text;if(content.length<(first?10:18))return [];let boundary=-1;
    for(let i=0;i<content.length;i++)if(/[，,；; ]/u.test(content[i])&&!(/[0-9]/.test(content[i-1]||'')&&/[0-9]/.test(content[i+1]||'')))boundary=i+1;
    if(boundary<4&&age>=1200&&/[\p{Script=Han}]/u.test(content.at(-1)))boundary=content.length;
    if(boundary<4)return [];const safe=speakable(content.slice(0,boundary));this.text=content.slice(boundary);this.startedAt=now;if(!safe)return [];this.emitted++;return [safe];
  }
  finish(){return this.consume(true);}
}
export class SpeechQueue {
  constructor({synthesize,player,onError=()=>{},concurrency=3,maxQueued=32,maxPrefetchBytes=96000}={}){
    Object.assign(this,{synthesize,player,onError});this.concurrency=Math.max(1,Math.min(3,concurrency));this.maxQueued=maxQueued;this.maxPrefetchBytes=Math.max(1920,maxPrefetchBytes);this.items=[];this.epoch=0;this.sequence=0;this.controllers=new Set();this.readers=new Set();this.running=null;this.closed=false;
  }
  push(text){if(this.closed||!text?.trim())return false;if(this.items.length>=this.maxQueued){this.onError(Error('朗读队列已满，已跳过多余文本'));return false;}this.items.push({id:++this.sequence,text:text.slice(0,1500),chunks:[],buffered:0,waiters:[]});this.prefetch();this.pump();return true;}
  wake(item){for(const resolve of item.waiters.splice(0))resolve();}
  wait(item){return new Promise(resolve=>item.waiters.push(resolve));}
  async bounded(operation,signal){let timer,fail;const abort=new Promise((_,reject)=>{fail=()=>reject(new DOMException('Speech cancelled','AbortError'));if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});});try{return await Promise.race([operation,abort,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('语音合成流读取超时')),30000))]);}finally{clearTimeout(timer);signal.removeEventListener('abort',fail);}}
  prefetch(){let active=this.items.filter(item=>item.promise).length;for(const item of this.items){if(active>=this.concurrency)break;if(item.promise)continue;active++;const controller=new AbortController();item.controller=controller;this.controllers.add(controller);const epoch=this.epoch;
      item.promise=(async()=>{let reader;try{
        const response=await this.bounded(Promise.resolve().then(()=>this.synthesize(item.text,controller.signal)).then(response=>{if(controller.signal.aborted)response.body?.cancel().catch(()=>{});return response;}),controller.signal);
        if(epoch!==this.epoch||controller.signal.aborted){response.body?.cancel().catch(()=>{});return;}
        if(response.ok===false)throw Error('语音合成失败：'+response.status);if(!response.body?.getReader)throw Error('TTS 未返回流式 PCM');
        reader=response.body.getReader();this.readers.add(reader);
        while(epoch===this.epoch&&!controller.signal.aborted){
          // Each prefetched sentence has a bounded PCM budget; playback releases capacity.
          while(item.buffered>=this.maxPrefetchBytes&&epoch===this.epoch&&!controller.signal.aborted)await this.wait(item);
          if(epoch!==this.epoch||controller.signal.aborted)break;
          const {done,value}=await this.bounded(reader.read(),controller.signal);if(done)break;if(value.byteLength>1024*1024)throw Error('TTS 音频包超出限制');
          for(let offset=0;offset<value.length;){
            while(item.buffered>=this.maxPrefetchBytes&&epoch===this.epoch&&!controller.signal.aborted)await this.wait(item);
            if(epoch!==this.epoch||controller.signal.aborted)break;
            const size=Math.min(value.length-offset,this.maxPrefetchBytes-item.buffered),part=value.slice(offset,offset+size);offset+=size;item.chunks.push(part);item.buffered+=size;this.wake(item);
          }
        }
      }catch(error){item.error=error;}finally{item.done=true;this.wake(item);controller.abort();this.controllers.delete(controller);if(reader){this.readers.delete(reader);reader.cancel().catch(()=>{});reader.releaseLock();}}})();
    }}
  pump(){if(this.running)return this.running;const epoch=this.epoch;const run=(async()=>{while(this.items.length&&epoch===this.epoch){this.prefetch();const item=this.items[0];try{
        while(epoch===this.epoch){if(item.chunks.length){
          const size=Math.min(item.buffered,1920),chunk=new Uint8Array(size);let used=0;while(used<size){const part=item.chunks[0],count=Math.min(part.length,size-used);chunk.set(part.subarray(0,count),used);used+=count;if(count===part.length)item.chunks.shift();else item.chunks[0]=part.subarray(count);}
          item.buffered-=size;this.wake(item);await this.player.enqueue(chunk,item.id);}else if(item.done){if(item.error)throw item.error;this.player.segmentEnd(item.id);break;}else await this.wait(item);}
      }catch(error){if(epoch===this.epoch&&error.name!=='AbortError')this.onError(error);}finally{item.controller.abort();this.wake(item);}
      if(epoch===this.epoch){this.items.shift();this.prefetch();}
    }})();let wrapped;this.running=wrapped=run.finally(()=>{if(this.running===wrapped)this.running=null;if(this.items.length&&!this.closed)this.pump();});return wrapped;}
  async finish(){while(this.items.length||this.running)await(this.running||this.pump());}
  cancel(){this.epoch++;for(const item of this.items){item.controller?.abort();this.wake(item);}this.items=[];for(const c of this.controllers)c.abort();this.controllers.clear();for(const r of this.readers)r.cancel().catch(()=>{});this.player.clear();}
  async dispose(){this.closed=true;const producers=this.items.map(item=>item.promise).filter(Boolean);this.cancel();await Promise.allSettled([this.running,...producers]);}
}
