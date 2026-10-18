import { VoiceError, normalizeAsrModel } from './config.mjs';

export const LIMITS = Object.freeze({ audioBytes: 2 * 1024 * 1024, audioSeconds: 15, jsonBytes: 32768, speechCharacters: 4000, speechBytes: 12 * 1024 * 1024, requestTimeout: 90000 });
export async function readLimited(request, limit, signal = request.signal) {
  if (Number(request.headers.get('content-length')) > limit) throw new VoiceError('Request is too large', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = []; let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new VoiceError('Request is too large', 413); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
export async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new VoiceError('Expected application/json', 415);
  let value; try { value = JSON.parse(new TextDecoder().decode(await readLimited(request, LIMITS.jsonBytes))); }
  catch (error) { if (error instanceof VoiceError || request.signal.aborted) throw error; throw new VoiceError('Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VoiceError('Expected JSON object');
  return value;
}
export async function upstreamFailure(response, kind, signal) {
  let code = '';
  try {
    if (response.headers.get('content-type')?.includes('application/json')) {
      const raw = await readLimited(new Request('http://voice.internal', { method: 'POST', body: response.body, duplex: 'half', signal }), 8192);
      const body = JSON.parse(new TextDecoder().decode(raw));
      // Only a bounded machine code is safe to expose. Upstream messages may echo credentials or audio.
      const candidate = body.error?.code; if (typeof candidate === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/u.test(candidate)) code = candidate;
    }
  } catch {} finally { await response.body?.cancel().catch(() => {}); }
  return new VoiceError(kind + ' service rejected the request (' + response.status + ')' + (code ? '; ' + code : ''), 502, code || kind.toLowerCase() + '_http_' + response.status);
}
export function validateWav(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE' || buffer.readUInt32LE(4) + 8 !== buffer.length) throw new VoiceError('Expected a complete PCM WAV file');
  let format, data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > buffer.length) throw new VoiceError('Malformed WAV chunk');
    if (id === 'fmt ') {
      if (length < 16) throw new VoiceError('Malformed WAV format');
      format = { codec: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), rate: buffer.readUInt32LE(start + 4), alignment: buffer.readUInt16LE(start + 12), bits: buffer.readUInt16LE(start + 14) };
    }
    if (id === 'data') data = length;
    offset = start + length + (length % 2);
  }
  if (!format || !data || format.codec !== 1 || format.channels !== 1 || format.bits !== 16 || format.alignment !== 2 || ![16000, 22050, 24000, 44100, 48000].includes(format.rate) || data % 2) throw new VoiceError('Audio must be mono PCM16 WAV (16–48 kHz)');
  if (data / (format.rate * 2) > LIMITS.audioSeconds) throw new VoiceError('Audio segment exceeds 15 seconds', 413);
  return format;
}
export async function transcribe(fetcher, config, bytes, signal) {
  const body = new FormData();
  body.set('file', new Blob([bytes], { type: 'audio/wav' }), 'segment.wav'); body.set('model', normalizeAsrModel(config.model)); body.set('response_format', 'json');
  const upstream = await fetcher(`${config.baseURL}/audio/transcriptions`, { method: 'POST', headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}, body, signal, redirect: 'error' });
  if (!upstream.ok) throw await upstreamFailure(upstream, 'ASR', signal);
  const raw = await readLimited(new Request('http://voice.internal', { method: 'POST', body: upstream.body, duplex: 'half', signal }), 65536);
  let result; try { result = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new VoiceError('ASR service returned invalid JSON', 502); }
  if (typeof result.text !== 'string' || result.text.length > 20000) throw new VoiceError('ASR service returned invalid transcription', 502);
  signal.throwIfAborted();
  return { text: result.text.trim() };
}
