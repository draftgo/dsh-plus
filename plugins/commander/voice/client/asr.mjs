export async function readVoiceEvents(response, signal, onEvent) {
  if (!response.ok) { const result = await response.json(); throw Error(result.error || '语音识别请求失败'); }
  if (!response.body) throw Error('语音识别未返回事件流');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', total = 0;
  const abort = () => { reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  const parse = line => { if (!line.trim()) return; let e; try { e = JSON.parse(line); } catch { throw Error('语音识别事件格式错误'); } if (e.type === 'error') throw Error(e.error || '语音识别连接失败'); if (typeof e.text === 'string' && e.text.length <= 20000) onEvent(e); };
  try { while (true) { signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break; total += value.length; if (total > 16 * 1024 * 1024) throw Error('语音事件流超限'); pending += decoder.decode(value, { stream: true }); if (pending.length > 65536) throw Error('语音事件过大'); let end; while ((end = pending.indexOf(String.fromCharCode(10))) >= 0) { parse(pending.slice(0, end)); pending = pending.slice(end + 1); } } pending += decoder.decode(); if (pending.trim()) parse(pending); }
  finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class StepRecognizer {
  constructor({ request, endpoint, headers, onError }) { Object.assign(this, { request, endpoint, headers, onError }); this.abort = new AbortController(); this.utterances = new Map(); this.closed = false;this.transport=Promise.resolve(); }
  async action(action, extra = {}, signal = this.abort.signal) {
    if(action !== 'asr.events') signal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    const response = await this.request(this.endpoint('api/voice'), { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json', ...this.headers() }, body: JSON.stringify({ action, id: this.id, ...extra }) });
    if (action === 'asr.events') return response;
    const data = await response.json(); if (!response.ok) throw Error(data.error || '实时识别连接失败'); return data;
  }
  async start() {
    const result = await this.action('asr.start'); this.id = result.id;
    const response = await this.action('asr.events');
    this.reading = readVoiceEvents(response, this.abort.signal, event => {
      const u = this.utterances.get(event.utteranceId); if (!u) return;
      if (event.type === 'partial'&&event.text!==u.lastPartial) {u.lastPartial=event.text;u.partial(event.text);}
      if (event.type === 'final') { this.utterances.delete(event.utteranceId); u.resolve(event.text); }
    }).then(() => { if (!this.closed) throw Error('实时语音识别连接已断开'); }).catch(error => { for (const u of this.utterances.values()) u.reject(error); this.utterances.clear(); if (!this.closed && error.name !== 'AbortError') this.onError(error); });
  }
  ordered(operation){const result=this.transport.then(operation);this.transport=result.catch(()=>{});return result;}
  async append(frames, id, partial) {
    this.abort.signal.throwIfAborted(); if (!this.utterances.has(id)) { let resolve, reject; const result = new Promise((a, b) => { resolve = a; reject = b; }); result.catch(() => {}); this.utterances.set(id, { partial, result, resolve, reject,lastPartial:'' }); }
    const count = frames.reduce((n, frame) => n + frame.length, 0), bytes = new Uint8Array(count * 2), view = new DataView(bytes.buffer); let at = 0;
    for (const frame of frames) for (const sample of frame) { view.setInt16(at, sample, true); at += 2; }
    const response = await this.ordered(()=>this.request(this.endpoint('api/voice/realtime/audio'), { method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]), headers: { 'content-type': 'application/octet-stream', 'x-voice-session-id': this.id, 'x-voice-utterance-id': String(id), ...this.headers() }, body: bytes }));
    if (!response.ok) { const data = await response.json(); throw Error(data.error || '实时音频发送失败'); }
  }
  async clear() {
    for (const u of this.utterances.values()) u.reject(new DOMException('Input cleared','AbortError')); this.utterances.clear();
    if(!this.closed&&this.id)await this.ordered(()=>this.action('asr.clear'));
  }
  async commit(id) {
    const u = this.utterances.get(id); if (!u) return ''; await this.ordered(()=>this.action('asr.commit', { utteranceId: id }));
    let timer; try { return await Promise.race([u.result, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('实时识别等待最终结果超时')), 25000); })]); } finally { clearTimeout(timer); this.utterances.delete(id); }
  }
  async close() {
    if (this.closed) return; this.closed = true; this.abort.abort();
    for (const u of this.utterances.values()) u.reject(new DOMException('Aborted', 'AbortError')); this.utterances.clear();
    if (this.id) { const timeout = AbortSignal.timeout(5000); await this.action('asr.end', {}, timeout).catch(() => {}); }
    await this.reading;
  }
}
