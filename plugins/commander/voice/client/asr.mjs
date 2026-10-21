export async function readVoiceEvents(response, signal, onEvent) {
  if (!response.ok) { const result = await response.json(); throw Error(result.error || '语音识别请求失败'); }
  if (!response.body) throw Error('语音识别未返回事件流');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', total = 0;
  const abort = () => { reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  const parse = line => { if (!line.trim()) return; let e; try { e = JSON.parse(line); } catch { throw Error('语音识别事件格式错误'); } if (e.type === 'error') throw Error(e.error || '语音识别连接失败'); if (typeof e.text === 'string' && e.text.length <= 20000) onEvent(e); };
  try { while (true) { signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break; total += value.length; if (total > 16 * 1024 * 1024) throw Error('语音事件流超限'); pending += decoder.decode(value, { stream: true }); if (pending.length > 65536) throw Error('语音事件过大'); let end; while ((end = pending.indexOf(String.fromCharCode(10))) >= 0) { parse(pending.slice(0, end)); pending = pending.slice(end + 1); } } pending += decoder.decode(); if (pending.trim()) parse(pending); }
  finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const cancelled = () => new DOMException('Voice input cleared', 'AbortError');
const FRAME_SAMPLES = 480, MAX_QUEUED_FRAMES = 30, MAX_AGE_MS = 600, WINDOW = 12;
/** Frames never wait for an HTTP response. Only commit/final forms a turn barrier. */
export class RealtimeRecognizer {
  constructor({ request, endpoint, headers, openSocket, onError = () => {}, onWarning = () => {}, now = Date.now }) {
    Object.assign(this, { request, endpoint, headers, openSocket, onError, onWarning, now });
    this.abort = new AbortController(); this.utterances = new Map(); this.queue = []; this.inflight = new Map();
    this.epoch = 0; this.sequence = 0; this.closed = false; this.ready = false; this.committing = 0; this.dropped = 0;
  }
  async action(action, extra = {}, signal = this.abort.signal) {
    const response = await this.request(this.endpoint('api/voice'), {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      headers: { 'content-type': 'application/json', ...this.headers() }, body: JSON.stringify({ action, id: this.id, ...extra }),
    });
    const data = await response.json(); if (!response.ok) throw Error(data.error || '实时识别连接失败'); return data;
  }
  async start() {
    try {
      if (typeof this.openSocket !== 'function') throw Error('当前载体不支持实时语音连接');
      const { id, ticket } = await this.action('asr.start'); this.id = id;
      if (this.closed) { await this.action('asr.end', {}, AbortSignal.timeout(3000)).catch(() => {}); this.abort.signal.throwIfAborted(); }
      this.abort.signal.throwIfAborted();
      const ws = this.openSocket('/api/voice/realtime'); this.ws = ws;
      this.handshake = deferred();
      ws.addEventListener('open', () => { if (!this.closed) ws.send(JSON.stringify({ type: 'attach', id, ticket, callId: this.headers()['x-voice-call-id'] || '' })); });
      ws.addEventListener('message', event => this.receive(event.data));
      ws.addEventListener('error', () => this.fail(Error('实时语音连接失败')));
      ws.addEventListener('close', () => { if (!this.closed) this.fail(Error('实时语音连接已断开')); });
      const timer = setTimeout(() => this.fail(Error('实时语音连接超时')), 10000);
      try { await this.handshake.promise; } finally { clearTimeout(timer); }
      this.pulse = setInterval(() => this.pump(), 20); this.pulse.unref?.();
    } catch (error) { await this.close(); throw error; }
  }
  receive(raw) {
    if (this.closed) return;
    try {
      if (typeof raw !== 'string' || raw.length > 65536) throw Error('实时语音事件无效');
      const event = JSON.parse(raw);
      if (event.type === 'error') throw Error(event.error || '实时识别失败');
      if (event.type === 'closed') throw Error('实时语音会话已结束');
      if (event.epoch !== this.epoch) return;
      if (event.type === 'ready') {
        this.ready = true; this.handshake?.resolve(); this.clearing?.resolve(); this.clearing = null; this.pump(); return;
      }
      if (event.type === 'ack') {
        if (!this.inflight.delete(event.sequence)) return;
        if (!event.accepted) this.drop(1);
        this.pump(); return;
      }
      const u = this.utterances.get(event.utteranceId); if (!u) return;
      if (typeof event.text !== 'string' || event.text.length > 20000) throw Error('实时识别文本无效');
      if (event.type === 'partial' && event.text !== u.lastPartial) { u.lastPartial = event.text; u.partial(event.text); }
      if (event.type === 'final') {
        clearTimeout(u.timer); this.utterances.delete(event.utteranceId);
        if (this.committing === event.utteranceId) this.committing = 0;
        u.resolve(event.text); this.pump();
      }
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    if (this.closed) return;
    this.handshake?.reject(error); this.clearing?.reject(error);
    for (const u of this.utterances.values()) { clearTimeout(u.timer); u.reject(error); }
    const report = !!this.pulse; void this.close(); if (report) this.onError(error);
  }
  drop(count) {
    this.dropped += count;
    if (!this.warnedAt || this.now() - this.warnedAt >= 2000) {
      this.warnedAt = this.now(); this.onWarning({ droppedFrames: this.dropped, message: '网络拥堵，已跳过过期语音；请重说未识别内容' });
    }
  }
  prune() {
    const now = this.now(); let count = 0, total = this.queue.reduce((n, item) => n + (item.type === 'audio'), 0);
    this.queue = this.queue.filter(item => {
      if (item.type !== 'audio') return true;
      if (now - item.at > MAX_AGE_MS || total > MAX_QUEUED_FRAMES) { total--; count++; return false; }
      return true;
    });
    if (count) this.drop(count);
  }
  append(frames, id, partial) {
    this.abort.signal.throwIfAborted();
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff) throw Error('语音段标识无效');
    let u = this.utterances.get(id);
    if (!u) {
      if (this.utterances.size >= 8) throw Error('识别响应过慢，请稍后重试');
      u = { ...deferred(), partial, lastPartial: '', committed: false }; this.utterances.set(id, u);
    }
    if (u.committed) throw Error('语音段已经提交');
    const count = frames.reduce((n, frame) => n + frame.length, 0);
    const samples = new Int16Array(count); let offset = 0;
    for (const frame of frames) { samples.set(frame, offset); offset += frame.length; }
    for (let at = 0; at < samples.length; at += FRAME_SAMPLES) {
      this.queue.push({ type: 'audio', id, pcm: samples.slice(at, at + FRAME_SAMPLES), at: this.now() });
    }
    this.prune(); this.pump();
  }
  pump() {
    if (this.closed) return;
    this.prune();
    if (this.inflight.size && this.now() - this.inflight.values().next().value > 12000) { this.fail(Error('实时语音网络响应超时')); return; }
    if (!this.ready || this.committing || this.ws?.readyState !== 1) return;
    try {
      while (this.queue.length) {
        const next = this.queue[0];
        // Leave controls room and keep the browser's immutable send buffer short.
        if (this.ws.bufferedAmount > 1920 || this.inflight.size >= WINDOW) return;
        this.queue.shift();
        if (next.type === 'commit') {
          this.committing = next.id;
          this.ws.send(JSON.stringify({ type: 'commit', epoch: this.epoch, utteranceId: next.id })); return;
        }
        const sequence = ++this.sequence;
        const bytes = new Uint8Array(12 + next.pcm.length * 2), view = new DataView(bytes.buffer);
        view.setUint32(0, this.epoch, true); view.setUint32(4, next.id, true); view.setUint32(8, sequence, true);
        for (let i = 0; i < next.pcm.length; i++) view.setInt16(12 + i * 2, next.pcm[i], true);
        this.inflight.set(sequence, this.now()); this.ws.send(bytes);
      }
    } catch (error) { this.fail(error); }
  }
  commit(id) {
    const u = this.utterances.get(id); if (!u) return Promise.resolve('');
    if (!u.committed) {
      u.committed = true;
      u.timer = setTimeout(() => this.fail(Error('实时识别等待最终结果超时')), 25000);
      this.queue.push({ type: 'commit', id }); this.pump();
    }
    return u.promise;
  }
  clear() {
    if (this.closed || !this.ws) return Promise.resolve();
    const pendingReset = this.clearing;
    if (!pendingReset) this.epoch++;
    this.ready = false; this.committing = 0; this.queue = []; this.inflight.clear();
    for (const u of this.utterances.values()) { clearTimeout(u.timer); u.reject(cancelled()); }
    this.utterances.clear(); if (pendingReset) return pendingReset.promise; this.clearing = deferred();
    const result = this.clearing.promise;
    this.resetTimer = setTimeout(() => this.fail(Error('实时识别重置超时')), 12000);
    result.finally(() => clearTimeout(this.resetTimer)).catch(() => {});
    try { this.ws.send(JSON.stringify({ type: 'clear', epoch: this.epoch })); } catch (error) { this.fail(error); }
    return result;
  }
  async close() {
    if (this.closed) return; this.closed = true; this.ready = false;
    clearInterval(this.pulse); clearTimeout(this.resetTimer); this.abort.abort();
    this.handshake?.reject(cancelled()); this.clearing?.reject(cancelled());
    for (const u of this.utterances.values()) { clearTimeout(u.timer); u.reject(cancelled()); }
    this.utterances.clear(); this.queue = []; this.inflight.clear(); this.ws?.close();
    if (this.id) await this.action('asr.end', {}, AbortSignal.timeout(3000)).catch(() => {});
  }
}
