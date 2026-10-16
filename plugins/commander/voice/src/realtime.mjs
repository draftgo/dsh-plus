import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { VoiceError } from './config.mjs';

/** One owner event stream and ordered PCM posts share a native, client-committed Step ASR session. */
export class RealtimeASR {
  constructor({ socket = (url, options) => new WebSocket(url, options) } = {}) { this.socket = socket; this.sessions = new Map(); }
  async connect(s) {
    const epoch = ++s.socketEpoch;
    s.ready = false; s.bytes = 0; s.utterance = 0; s.committing = false;
    const endpoint = new URL(s.config.baseURL + '/realtime/asr/stream'); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = this.socket(endpoint.href, { headers: s.config.apiKey ? { authorization: 'Bearer ' + s.config.apiKey } : {}, followRedirects: false, maxPayload: 131072, handshakeTimeout: 10000 });
    s.ws = ws; const current = () => !s.finished && s.socketEpoch === epoch;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new VoiceError('Realtime ASR handshake timed out', 502)), 12000); timer.unref?.();
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); s.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => finish(new DOMException('Aborted', 'AbortError')); s.signal.addEventListener('abort', abort, { once: true });
      ws.on('open', () => {
        if (!current()) return;
        ws.send(JSON.stringify({ event_id: randomUUID(), type: 'session.update', session: { audio: { input: { format: { type: 'pcm', codec: 'pcm_s16le', rate: 24000, bits: 16, channel: 1 }, transcription: { model: s.config.model, language: 'zh', full_rerun_on_commit: true, enable_itn: true }, turn_detection: null } } } }));
      });
      ws.on('message', raw => {
        if (!current()) return;
        let event; try { event = JSON.parse(String(raw)); } catch { finish(new VoiceError('Invalid realtime ASR event', 502)); s.emit({ type: 'error', error: 'Invalid realtime ASR event' }); this.close(s.id); return; }
        if (event.type === 'session.updated') { s.ready = true; finish(); return; }
        if (event.type === 'error') {
          const code = typeof event.error?.code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/u.test(event.error.code) ? event.error.code : 'upstream_error';
          const error = new VoiceError('Realtime ASR service rejected the session (' + code + ')', 502, code); finish(error); s.emit({ type: 'error', error: error.message, code }); this.close(s.id); return;
        }
        // An event from a discarded socket can never be associated with a new utterance.
        if (!s.ready || !s.utterance) return;
        if (event.type === 'conversation.item.input_audio_transcription.delta') {
          const text = typeof event.text === 'string' ? event.text : '';
          if (text.length > 20000) { this.close(s.id); return; }
          if (text) s.emit({ type: 'partial', text, utteranceId: s.utterance });
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          if (!s.committing) return;
          if (typeof event.transcript !== 'string' || event.transcript.length > 20000) { this.close(s.id); return; }
          s.emit({ type: 'final', text: event.transcript, utteranceId: s.utterance }); s.committing = false; s.bytes = 0; s.utterance = 0;
        }
      });
      ws.on('error', () => { if (!current()) return; finish(new VoiceError('Realtime ASR connection failed', 502)); s.emit({ type: 'error', error: 'Realtime ASR connection failed' }); this.close(s.id); });
      ws.on('unexpected-response', (_request, response) => {
        if (!current()) return; response.resume?.(); const status = Number(response.statusCode) || 502;
        finish(new VoiceError('Realtime ASR handshake rejected (' + status + '); verify that this provider supports native Step streaming', 502, 'asr_handshake_' + status)); this.close(s.id);
      });
      ws.on('close', () => { if (!current()) return; finish(new VoiceError('Realtime ASR connection closed before ready', 502)); s.emit({ type: 'error', error: 'Realtime ASR connection closed' }); this.close(s.id); });
      if (s.signal.aborted) abort();
    });
    s.signal.throwIfAborted();
  }
  async open(config, signal, callId = '') {
    signal.throwIfAborted();
    if (this.sessions.size >= 2) throw new VoiceError('Too many active realtime recognizers', 429);
    const id = randomUUID(), s = { id, config, signal, callId, socketEpoch: 0, queue: [], consumer: null, finished: false, attached: false };
    this.sessions.set(id, s);
    s.emit = event => {
      if (s.finished) return; const data = JSON.stringify(event) + String.fromCharCode(10);
      if (s.consumer) { if (s.consumer.desiredSize <= 0) { this.close(id); return; } try { s.consumer.enqueue(new TextEncoder().encode(data)); } catch { this.close(id); } }
      else { s.queue.push(data); if (s.queue.length > 128) this.close(id); }
    };
    s.abort = () => this.close(id); signal.addEventListener('abort', s.abort, { once: true });
    s.timer = setTimeout(() => this.close(id), 30 * 60 * 1000); s.timer.unref?.();
    try {
      await this.connect(s); s.attachTimer = setTimeout(() => this.close(id), 10000); s.attachTimer.unref?.(); return id;
    } catch (error) { this.close(id); throw error; }
  }
  get(id, callId) { const s = this.sessions.get(id); if (!s || s.finished || s.callId !== callId) throw new VoiceError('Realtime ASR session expired', 409); return s; }
  events(id, callId) {
    const s = this.get(id, callId); if (s.attached) throw new VoiceError('Realtime ASR stream already attached', 409); s.attached = true; clearTimeout(s.attachTimer);
    return new ReadableStream({ start: controller => { s.consumer = controller; for (const data of s.queue.splice(0)) controller.enqueue(new TextEncoder().encode(data)); }, cancel: () => this.close(id) }, { highWaterMark: 64 });
  }
  append(id, callId, bytes, utteranceId) {
    const s = this.get(id, callId); if (!s.ready) throw new VoiceError('Realtime ASR is resetting; wait for ready', 409);
    if (!Number.isSafeInteger(utteranceId) || utteranceId < 1) throw new VoiceError('Invalid utterance');
    if (!bytes.length || bytes.length % 2 || bytes.length > 24000) throw new VoiceError('Expected 1–12000 PCM16 samples');
    if (s.committing || s.bytes && s.utterance !== utteranceId) throw new VoiceError('Previous utterance has not completed', 409);
    if (s.ws.bufferedAmount > 96000 || s.bytes + bytes.length > 1440000) throw new VoiceError('Realtime ASR audio limit exceeded', 429);
    s.utterance = utteranceId; s.bytes += bytes.length; s.ws.send(JSON.stringify({ event_id: randomUUID(), type: 'input_audio_buffer.append', audio: Buffer.from(bytes).toString('base64') }));
  }
  commit(id, callId, utteranceId) { const s = this.get(id, callId); if (!s.ready || s.utterance !== utteranceId || !s.bytes || s.committing) throw new VoiceError('No pending ASR utterance', 409); s.committing = true; s.ws.send(JSON.stringify({ event_id: randomUUID(), type: 'input_audio_buffer.commit' })); }
  async reset(id, callId) {
    const s = this.get(id, callId); if (s.resetting) return s.resetting;
    // Step has no portable clear acknowledgement. Replace the upstream connection, retaining the authenticated browser stream.
    ++s.socketEpoch; s.ready = false; const old = s.ws; try { old.close(); } catch {}
    s.queue.length = 0; s.resetting = this.connect(s).catch(error => { s.emit({ type: 'error', error: error instanceof VoiceError ? error.message : 'Realtime ASR reset failed' }); this.close(id); throw error; }).finally(() => { s.resetting = null; });
    return s.resetting;
  }
  close(id) { const s = this.sessions.get(id); if (!s) return; s.finished = true; ++s.socketEpoch; this.sessions.delete(id); clearTimeout(s.timer); clearTimeout(s.attachTimer); s.signal.removeEventListener('abort', s.abort); try { s.consumer?.close(); } catch {} try { s.ws?.close(); } catch {} s.onClose?.(); }
  clear() { for (const id of [...this.sessions.keys()]) this.close(id); }
}
