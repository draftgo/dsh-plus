import { VoiceError, normalizeAsrModel } from './config.mjs';
import { transcribe, upstreamFailure } from './media.mjs';

/** Normalizes vendor SSE into cumulative replacement text, never append revised text twice. */
export async function streamTranscription(fetcher, config, bytes, signal, partial) {
  const protocol = config.protocol || 'transcriptions';
  if (protocol === 'transcriptions') return transcribe(fetcher, config, bytes, signal);
  if (!['transcriptions-sse', 'mimo-sse', 'step-sse'].includes(protocol)) throw new VoiceError('This ASR protocol requires a realtime session', 409);
  const audio = Buffer.from(bytes).toString('base64');
  const mimo = protocol === 'mimo-sse';
  const fileStream = protocol === 'transcriptions-sse';
  let body;
  const model = normalizeAsrModel(config.model);
  if (fileStream) { body = new FormData(); body.set('file', new Blob([bytes], { type: 'audio/wav' }), 'segment.wav'); body.set('model', model); body.set('response_format', 'json'); body.set('stream', 'true'); }
  else body = JSON.stringify(mimo ? { model, stream: true, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: audio, format: 'wav' } }] }] } : { audio: { data: audio, input: { format: { type: 'wav' }, transcription: { model, language: 'zh', enable_itn: true } } } });
  const upstream = await fetcher(config.baseURL + (fileStream ? '/audio/transcriptions' : mimo ? '/chat/completions' : '/audio/asr/sse'), { method: 'POST', headers: { ...(!fileStream ? { 'content-type': 'application/json' } : {}), accept: 'text/event-stream', ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) }, body, signal, redirect: 'error' });
  if (!upstream.ok) throw await upstreamFailure(upstream, 'ASR', signal);
  if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) { await upstream.body?.cancel(); throw new VoiceError('ASR service must return SSE', 502); }
  const reader = upstream.body.getReader(), decoder = new TextDecoder(); let pending = '', text = '', delivered = '', total = 0, doneEvent = false;
  const abort = () => { reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  const event = packet => {
    const data = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return; if (data === '[DONE]') { doneEvent = true; return; }
    let value; try { value = JSON.parse(data); } catch { throw new VoiceError('Invalid ASR stream event', 502); }
    if (value.error) throw new VoiceError('ASR streaming request failed', 502);
    if (mimo) { const delta = value.choices?.[0]?.delta?.content; if (typeof delta === 'string') text += delta; if (value.choices?.[0]?.finish_reason) doneEvent = true; }
    else if (value.type === 'transcript.text.delta' && typeof value.delta === 'string') text += value.delta;
    else if (value.type === 'transcript.text.done' && typeof value.text === 'string') { text = value.text; doneEvent = true; }
    if (text.length > 20000) throw new VoiceError('ASR transcript exceeds limit', 502);
    signal.throwIfAborted(); if (text && text !== delivered) { delivered = text; partial(text); }
  };
  try {
    while (true) {
      signal.throwIfAborted(); const result = await reader.read(); signal.throwIfAborted();
      if (result.done) break; total += result.value.length; if (total > 1024 * 1024) throw new VoiceError('ASR stream exceeds limit', 502);
      pending = (pending + decoder.decode(result.value, { stream: true })).replace(/\r\n/gu, '\n');
      let end; while ((end = pending.indexOf('\n\n')) >= 0) { event(pending.slice(0, end)); pending = pending.slice(end + 2); }
      if (pending.length > 65536) throw new VoiceError('ASR event exceeds limit', 502);
    }
    pending += decoder.decode(); if (pending.trim()) event(pending);
    if (!doneEvent) throw new VoiceError('ASR stream ended before final transcription', 502);
    return { text: text.trim() };
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
