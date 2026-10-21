import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { VoiceError, validateRealtime } from './config.mjs';
import { realtimeProtocol } from './realtime-protocols.mjs';

export function realtimeEndpoint(config) {
  const adapter = realtimeProtocol(config.protocol);
  const settings = validateRealtime(config.realtime || {}, config.apiKey || '');
  let endpoint;
  try { endpoint = new URL(settings.url || String(config.baseURL || '').replace(/\/+$/u, '') + adapter.path); }
  catch { throw new VoiceError('Invalid realtime ASR endpoint'); }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(endpoint.protocol)) throw new VoiceError('Invalid realtime ASR endpoint');
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : endpoint.protocol === 'http:' ? 'ws:' : endpoint.protocol;
  const supplied = new URLSearchParams(endpoint.search); endpoint.search = '';
  // A complete explicit URL owns its query string; protocol defaults apply only
  // when the endpoint is derived from the provider base URL.
  if (!settings.url) for (const [key, value] of Object.entries(adapter.query)) endpoint.searchParams.set(key, value);
  for (const [key, value] of supplied) endpoint.searchParams.set(key, value);
  for (const [key, value] of Object.entries(settings.query)) endpoint.searchParams.set(key, value.replaceAll('{model}', String(config.model || '')));
  // Validate expanded values too, so credentials never escape into URL logs.
  validateRealtime({ url: endpoint.href, query: {} }, config.apiKey || '');
  return endpoint;
}

/** One authenticated media socket owns each native ASR session. */
export class RealtimeASR {
  constructor({ socket = (url, options) => new WebSocket(url, options) } = {}) { this.socket = socket; this.sessions = new Map(); }
  async connect(s) {
    const epoch = ++s.socketEpoch;
    s.ready = false; s.bytes = 0; s.utterance = 0; s.committing = false; s.text = ''; s.itemId = ''; s.retiredItems = new Set();
    const adapter = realtimeProtocol(s.config.protocol);
    const endpoint = realtimeEndpoint(s.config);
    const ws = this.socket(endpoint.href, { headers: s.config.apiKey ? { authorization: 'Bearer ' + s.config.apiKey } : {}, followRedirects: false, maxPayload: 131072, handshakeTimeout: 10000 });
    s.ws = ws; const current = () => !s.finished && s.socketEpoch === epoch;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new VoiceError('Realtime ASR handshake timed out', 502)), 12000); timer.unref?.();
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); s.signal.removeEventListener('abort', abort); if (s.cancelConnect === cancel) s.cancelConnect = null; error ? reject(error) : resolve(); };
      const cancel = () => finish(s.signal.aborted ? new DOMException('Aborted', 'AbortError') : new VoiceError('Realtime ASR connection cancelled', 409)); s.cancelConnect = cancel;
      const abort = () => finish(new DOMException('Aborted', 'AbortError')); s.signal.addEventListener('abort', abort, { once: true });
      ws.on('open', () => {
        if (!current()) return;
        try { ws.send(JSON.stringify({ event_id: randomUUID(), type: 'session.update', session: adapter.session(s.config.model) })); }
        catch { finish(new VoiceError('Realtime ASR session initialization failed', 502)); this.close(s.id); }
      });
      ws.on('message', raw => {
        if (!current()) return;
        let event; try { event = JSON.parse(String(raw)); if (!event || typeof event !== 'object' || Array.isArray(event)) throw Error(); } catch { finish(new VoiceError('Invalid realtime ASR event', 502)); s.emit({ type: 'error', error: 'Invalid realtime ASR event' }); this.close(s.id); return; }
        if (adapter.ready(event.type)) { s.ready = true; finish(); return; }
        if (event.type === 'error') {
          const code = typeof event.error?.code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/u.test(event.error.code) ? event.error.code : 'upstream_error';
          const error = new VoiceError('Realtime ASR service rejected the session (' + code + ')', 502, code); finish(error); s.emit({ type: 'error', error: error.message, code }); this.close(s.id); return;
        }
        // Epochs fence discarded sockets; item IDs fence delayed same-socket events.
        if (!s.ready || !s.utterance) return;
        const transcriptEvent = ['conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.completed', 'conversation.item.input_audio_transcription.failed'].includes(event.type);
        if (event.type !== 'input_audio_buffer.committed' && !transcriptEvent) return;
        if ((event.type === 'input_audio_buffer.committed' || event.type === 'conversation.item.input_audio_transcription.completed') && !s.committing) return;
        const itemId = typeof event.item_id === 'string' && event.item_id.length <= 512 ? event.item_id : '';
        if ((adapter.requiresItemId && !itemId) || (itemId && (s.retiredItems.has(itemId) || (s.itemId && itemId !== s.itemId)))) return;
        if (itemId) s.itemId = itemId;
        if (event.type === 'conversation.item.input_audio_transcription.delta') {
          const text = adapter.partial(event, s.text);
          if (text.length > 20000) { this.close(s.id); return; }
          if (text !== s.text) { s.text = text; s.emit({ type: 'partial', text, utteranceId: s.utterance }); }
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          if (!s.committing) return;
          if (typeof event.transcript !== 'string' || event.transcript.length > 20000) { this.close(s.id); return; }
          s.emit({ type: 'final', text: event.transcript, utteranceId: s.utterance });
          if (s.itemId) s.retiredItems.add(s.itemId);
          s.committing = false; s.bytes = 0; s.utterance = 0; s.itemId = ''; s.text = '';
          if (s.retiredItems.size > 4096) this.close(s.id);
        }
        if (event.type === 'conversation.item.input_audio_transcription.failed') {
          s.emit({ type: 'error', error: 'Realtime ASR transcription failed', code: 'asr_transcription_failed' }); this.close(s.id);
        }
      });
      ws.on('error', () => { if (!current()) return; finish(new VoiceError('Realtime ASR connection failed', 502)); s.emit({ type: 'error', error: 'Realtime ASR connection failed' }); this.close(s.id); });
      ws.on('unexpected-response', (_request, response) => {
        if (!current()) return; response.resume?.(); const status = Number(response.statusCode) || 502;
        finish(new VoiceError('Realtime ASR handshake rejected (' + status + '); verify the configured realtime URL and protocol', 502, 'asr_handshake_' + status)); this.close(s.id);
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
    if (s.bytes + bytes.length > 1440000) throw new VoiceError('Realtime ASR audio limit exceeded', 429);
    // Congestion drops a frame instead of growing stale upstream audio.
    if (s.ws.bufferedAmount > 12800) return false;
    s.utterance = utteranceId; s.bytes += bytes.length; s.ws.send(JSON.stringify({ event_id: randomUUID(), type: 'input_audio_buffer.append', audio: Buffer.from(bytes).toString('base64') }));
  }
  commit(id, callId, utteranceId) { const s = this.get(id, callId); if (!s.ready || s.utterance !== utteranceId || !s.bytes || s.committing) throw new VoiceError('No pending ASR utterance', 409); s.committing = true; s.ws.send(JSON.stringify({ event_id: randomUUID(), type: 'input_audio_buffer.commit' })); }
  async reset(id, callId) {
    const s = this.get(id, callId); if (s.resetting) return s.resetting;
    // Replace the connection to fence late events without vendor-specific clear acknowledgements.
    ++s.socketEpoch; s.ready = false; const old = s.ws; try { old.close(); } catch {}
    s.queue.length = 0; s.resetting = this.connect(s).catch(error => { s.emit({ type: 'error', error: error instanceof VoiceError ? error.message : 'Realtime ASR reset failed' }); this.close(id); throw error; }).finally(() => { s.resetting = null; });
    return s.resetting;
  }
  close(id) { const s = this.sessions.get(id); if (!s) return; s.finished = true; s.cancelConnect?.(); ++s.socketEpoch; this.sessions.delete(id); clearTimeout(s.timer); clearTimeout(s.attachTimer); s.signal.removeEventListener('abort', s.abort); try { s.consumer?.close(); } catch {} try { s.ws?.close(); } catch {} s.onClose?.(); }
  clear() { for (const id of [...this.sessions.keys()]) this.close(id); }
}
