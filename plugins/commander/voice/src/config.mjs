import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export class VoiceError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; if (code) this.code = code; }
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const defaults = () => ({ dictation: false, readAloud: false, call: false, asr: { baseURL: '', apiKey: '', model: '', protocol: 'transcriptions' }, tts: { baseURL: '', apiKey: '', model: '', voice: '' } });
const string = (value, label, limit) => {
  if (typeof value !== 'string' || value.length > limit || /[\r\n\u0000]/u.test(value)) throw new VoiceError(`Invalid ${label}`);
  return value.trim();
};
function endpoint(value) {
  value = string(value, 'baseURL', 2048);
  if (!value) return '';
  let url; try { url = new URL(value); } catch { throw new VoiceError('Invalid baseURL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new VoiceError('baseURL must be an HTTP(S) API base without credentials, query or fragment');
  return url.href.replace(/\/+$/u, '');
}
export function updateConfig(current, patch) {
  if (!object(patch)) throw new VoiceError('Expected config object');
  if (Object.keys(patch).some(key => !['dictation', 'readAloud', 'call', 'asr', 'tts'].includes(key))) throw new VoiceError('Unknown config field');
  const next = structuredClone(current);
  for (const key of ['dictation', 'readAloud', 'call']) if (Object.hasOwn(patch, key)) {
    if (typeof patch[key] !== 'boolean') throw new VoiceError(`Invalid ${key}`);
    next[key] = patch[key];
  }
  for (const kind of ['asr', 'tts']) if (Object.hasOwn(patch, kind)) {
    if (!object(patch[kind])) throw new VoiceError(`Invalid ${kind}`);
    for (const [key, value] of Object.entries(patch[kind])) {
      // Read-only metadata may be round-tripped by settings forms.
      if (['configured', 'apiKeyConfigured', 'apiKeyMasked'].includes(key)) continue;
      if (!['providerId', 'baseURL', 'apiKey', 'model', ...(kind === 'tts' ? ['voice'] : ['protocol'])].includes(key)) throw new VoiceError(`Unknown ${kind} field`);
      if (key === 'protocol' && !['transcriptions', 'transcriptions-sse', 'mimo-sse', 'step-sse', 'step-websocket'].includes(value)) throw new VoiceError('Unknown ASR protocol');
      next[kind][key] = key === 'baseURL' ? endpoint(value) : string(value, key, key === 'apiKey' ? 4096 : 200);
    }
    if (next[kind].providerId) { next[kind].apiKey = ''; next[kind].baseURL = ''; }
  }
  return next;
}
/** Upgrade pre-protocol settings once, rather than sending known speech models to an incompatible endpoint. */
export function migrateLegacyConfig(value) {
  const next = structuredClone(value);
  if (next.asr && !Object.hasOwn(next.asr, 'protocol')) {
    const model = String(next.asr.model || '').toLowerCase();
    const routergo = next.asr.providerId === 'routergo' || /(^|\.)routergo\.cn$/u.test((() => { try { return new URL(next.asr.baseURL).hostname; } catch { return ''; } })());
    next.asr.protocol = routergo && /^(?:mimo|stepaudio)-.*-asr(?:-max)?$/u.test(model) ? 'transcriptions-sse' : /^mimo-.*-asr$/u.test(model) ? 'mimo-sse' : /^stepaudio-.*-asr-stream$/u.test(model) ? 'step-websocket' : /^stepaudio-.*-asr(?:-max)?$/u.test(model) ? 'step-sse' : 'transcriptions';
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
