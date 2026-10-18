import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export class VoiceError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; if (code) this.code = code; }
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// Portable multipart transcription is the default; native protocols are explicit.
export const DEFAULT_TTS_SPEED = 1.2;
const TTS_SPEED_MIN = 0.25, TTS_SPEED_MAX = 4;
const defaults = () => ({ dictation: false, readAloud: false, call: false, asr: { baseURL: '', apiKey: '', model: 'stepaudio-2.5-asr', protocol: 'transcriptions-sse' }, tts: { baseURL: '', apiKey: '', model: 'stepaudio-2.5-tts', voice: '', speed: DEFAULT_TTS_SPEED } });
const string = (value, label, limit) => {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new VoiceError(`Invalid ${label}`);
  return value.trim();
};
function endpoint(value) {
  value = string(value, 'baseURL', 2048);
  if (!value) return '';
  let url; try { url = new URL(value); } catch { throw new VoiceError('Invalid baseURL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new VoiceError('baseURL must be an HTTP(S) API base without credentials, query or fragment');
  return url.href.replace(/\/+$/u, '');
}
const sensitiveQuery = /api.?key|authorization|token|secret|password|credential|^key$|^bearer$/iu;
/** Public routing metadata only: credentials belong exclusively in server headers. */
export function validateRealtime(value, apiKey = '') {
  if (!object(value) || Object.keys(value).some(key => !['url', 'query'].includes(key))) throw new VoiceError('Invalid realtime ASR configuration');
  const result = { url: '', query: {} };
  const parameter = (key, val) => {
    if (!/^[a-zA-Z0-9_.~-]{1,80}$/u.test(key) || sensitiveQuery.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new VoiceError('Invalid realtime ASR query key');
    const clean = string(val, 'realtime ASR query', 512);
    if (apiKey && clean.includes(apiKey)) throw new VoiceError('Realtime ASR routing must not contain API credentials');
    return clean;
  };
  if (value.url) {
    const raw = string(value.url, 'realtime ASR URL', 2048);
    let url; try { url = new URL(raw); } catch { throw new VoiceError('Invalid realtime ASR URL'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new VoiceError('Realtime ASR URL must be HTTP(S) or WS(S), without credentials or fragment');
    for (const [key, val] of url.searchParams) parameter(key, val);
    if (apiKey && decodeURIComponent(url.href).includes(apiKey)) throw new VoiceError('Realtime ASR routing must not contain API credentials');
    result.url = url.href;
  } else if (Object.hasOwn(value, 'url') && typeof value.url !== 'string') throw new VoiceError('Invalid realtime ASR URL');
  if (Object.hasOwn(value, 'query')) {
    if (!object(value.query) || Object.keys(value.query).length > 32) throw new VoiceError('Invalid realtime ASR query');
    for (const [key, val] of Object.entries(value.query)) result.query[key] = parameter(key, val);
  }
  return result;
}
// StepFun's public ID is stepaudio-2.5-tts. Accept the commonly mistyped
// stepfun-2.5-tts alias at the boundary so old/local settings keep working.
export function normalizeTtsModel(model) {
  const value = String(model || '').trim();
  return /^stepfun-2\.5-tts$/iu.test(value) ? 'stepaudio-2.5-tts' : value;
}
// Preserve shorthand compatibility at the model boundary, independent of providers.
export function normalizeAsrModel(model) {
  const value = String(model || '').trim();
  return /^(?:step-asr|stepfun-2\.5-asr)$/iu.test(value) ? 'stepaudio-2.5-asr' : value;
}
export function isStepTtsModel(model) {
  const value = normalizeTtsModel(model).toLowerCase();
  return /^(?:stepaudio-(?:2\.5|3)-tts|step-tts-(?:2|mini))$/u.test(value);
}
export function normalizeTtsSpeed(value) {
  if (value === undefined) return DEFAULT_TTS_SPEED;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < TTS_SPEED_MIN || value > TTS_SPEED_MAX || Math.round(value * 100) !== value * 100) throw new VoiceError('Invalid TTS speed');
  return value;
}
export function updateConfig(current, patch) {
  if (!object(patch)) throw new VoiceError('Expected config object');
  if (Object.keys(patch).some(key => !['dictation', 'readAloud', 'call', 'asr', 'tts'].includes(key))) throw new VoiceError('Unknown config field');
  const next = structuredClone(current);
  if (next.tts && !Object.hasOwn(next.tts, 'speed')) next.tts.speed = DEFAULT_TTS_SPEED;
  for (const key of ['dictation', 'readAloud', 'call']) if (Object.hasOwn(patch, key)) {
    if (typeof patch[key] !== 'boolean') throw new VoiceError(`Invalid ${key}`);
    next[key] = patch[key];
  }
  for (const kind of ['asr', 'tts']) if (Object.hasOwn(patch, kind)) {
    if (!object(patch[kind])) throw new VoiceError(`Invalid ${kind}`);
    for (const [key, value] of Object.entries(patch[kind])) {
      // Read-only metadata may be round-tripped by settings forms.
      if (['configured', 'apiKeyConfigured', 'apiKeyMasked'].includes(key)) continue;
      if (!['providerId', 'baseURL', 'apiKey', 'model', 'protocol', ...(kind === 'tts' ? ['voice', 'speed'] : ['realtime'])].includes(key)) throw new VoiceError(`Unknown ${kind} field`);
      if (key === 'realtime') { next.asr.realtime = validateRealtime(value); continue; }
      if (kind === 'tts' && key === 'speed') { next.tts.speed = normalizeTtsSpeed(value); continue; }
      if (key === 'protocol' && !(kind === 'tts' ? ['speech', 'step-speech'] : ['transcriptions', 'transcriptions-sse', 'mimo-sse', 'step-sse', 'step-websocket', 'openai-websocket']).includes(value)) throw new VoiceError(`Unknown ${kind.toUpperCase()} protocol`);
      const normalized = key === 'baseURL' ? endpoint(value) : string(value, key, key === 'apiKey' ? 4096 : 200);
      next[kind][key] = key === 'model' ? (kind === 'asr' ? normalizeAsrModel(normalized) : normalizeTtsModel(normalized)) : normalized;
    }
    const changedProvider = Object.hasOwn(patch[kind], 'providerId') && (current[kind].providerId || '') !== next[kind].providerId || Object.hasOwn(patch[kind], 'baseURL') && !next[kind].providerId && current[kind].baseURL !== next[kind].baseURL;
    if (changedProvider) {
      if (kind === 'asr' && !Object.hasOwn(patch.asr, 'realtime')) delete next.asr.realtime;
      if (!Object.hasOwn(patch[kind], 'protocol')) next[kind].protocol = kind === 'asr' ? 'transcriptions-sse' : 'speech';
      if (kind === 'tts' && !Object.hasOwn(patch.tts, 'voice')) next.tts.voice = '';
    }
    if (next[kind].providerId) { next[kind].apiKey = ''; next[kind].baseURL = ''; }
    if (kind === 'asr' && next.asr.realtime) next.asr.realtime = validateRealtime(next.asr.realtime, next.asr.apiKey);
  }
  return next;
}
/** Upgrade pre-protocol settings once, rather than sending known speech models to an incompatible endpoint. */
export function migrateLegacyConfig(value) {
  const next = structuredClone(value);
  if (next.asr?.model) next.asr.model = normalizeAsrModel(next.asr.model);
  if (next.tts?.model) next.tts.model = normalizeTtsModel(next.tts.model);
  if (next.asr && !Object.hasOwn(next.asr, 'protocol')) {
    const model = String(next.asr.model || '').toLowerCase();
    next.asr.protocol = /^stepaudio-.*-asr-stream$/u.test(model) ? 'step-websocket' : /^(?:mimo|stepaudio)-.*-asr(?:-max)?$/u.test(model) ? 'transcriptions-sse' : 'transcriptions';
  }
  return next;
}
export function publicConfig(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => {
    if (!['asr', 'tts'].includes(key)) return [key, value];
    const { apiKey, ...safe } = value;
    return [key, { ...safe, configured: !!((value.providerId || value.baseURL) && value.model), apiKeyConfigured: !!apiKey, apiKeyMasked: apiKey ? '••••••••' : '' }];
  }));
}
export class VoiceConfig {
  constructor({ dataDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'voice') } = {}) {
    this.directory = dataDir; this.path = join(dataDir, 'config.json'); this.value = defaults(); this.writes = Promise.resolve(); this.listeners = new Set();
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.value = updateConfig(defaults(), migrateLegacyConfig(JSON.parse(await readFile(this.path, 'utf8')))); await chmod(this.path, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw new VoiceError('Voice configuration could not be loaded', 500); }
    return this;
  }
  snapshot() { return publicConfig(this.value); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  configure(patch) {
    const operation = this.writes.then(async () => {
      const next = updateConfig(this.value, patch);
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temp, this.path); }
      finally { await rm(temp, { force: true }); }
      this.value = next; for (const listener of this.listeners) listener(); return this.snapshot();
    });
    this.writes = operation.catch(() => {}); return operation;
  }
}
