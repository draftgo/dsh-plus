const LIMIT = 4 * 1024 * 1024;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
class ProviderError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function text(value, label, max = 512) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new ProviderError('Invalid ' + label); return value.trim(); }
function endpoint(value) {
  let url; try { url = new URL(text(value, 'provider URL', 2048)); } catch { throw new ProviderError('Invalid provider URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProviderError('Provider URL must be HTTP(S), without credentials, query or fragment');
  return url.href.replace(/\/$/u, '');
}
function pathValue(value, path) { for (const part of path || []) { if (forbidden.has(part) || !value || !Object.hasOwn(value, part)) return undefined; value = value[part]; } return value; }
function classification(model) {
  const kinds = new Set(), metadata = [model.type, model.task, model.pipeline_tag, model.modality, model.modalities, model.capabilities, model.architecture, model.metadata].filter(value => value !== undefined);
  const description = JSON.stringify(metadata).toLowerCase(), hasMetadata = /(?:^|[^a-z])(?:transcri|speech|audio|text|chat|completion|asr|tts|embedding|rerank|moderation|image|video|realtime)/u.test(JSON.stringify([model.task, model.pipeline_tag, model.modality, model.modalities, model.capabilities, model.architecture, model.metadata]).toLowerCase()) || /generation|embedding|rerank|moderation|image|audio|speech|asr|tts/u.test(String(model.type || '').toLowerCase());
  if (/transcri|speech.to.text|audio.to.text|automatic.speech.recognition|"asr"/u.test(description)) kinds.add('asr');
  if (/text.to.speech|speech.synth|"tts"|"speech"\s*:\s*true/u.test(description)) kinds.add('tts');
  const architecture = model.architecture || model.modalities || {};
  const inputs = architecture.input_modalities || architecture.input || [], outputs = architecture.output_modalities || architecture.output || [];
  if (Array.isArray(inputs) && Array.isArray(outputs)) {
    if (inputs.includes('audio') && outputs.includes('text') && !outputs.includes('audio')) kinds.add('asr');
    if (inputs.includes('text') && outputs.includes('audio') && !outputs.includes('text')) kinds.add('tts');
  }
  let inferred = false;
  if (!hasMetadata) {
    const id = model.id.toLowerCase();
    if (/whisper|transcri|(?:^|[-_/])asr(?:$|[-_/])|sensevoice|paraformer|funasr/u.test(id)) { kinds.add('asr'); inferred = true; }
    if (/(?:^|[-_/])tts(?:$|[-_/])|text.to.speech|cosyvoice|kokoro|fish.speech|speech.synth/u.test(id)) { kinds.add('tts'); inferred = true; }
  }
  const explicitChat = /text.generation|chat|completion/u.test(description) || Array.isArray(outputs) && outputs.includes('text') && Array.isArray(inputs) && inputs.includes('text');
  const nonChat = kinds.size > 0 || !explicitChat && /audio|speech|realtime|image|embedding|rerank|moderation|video/u.test(hasMetadata ? description : model.id.toLowerCase());
  return { kinds: [...kinds], inferred, chat: !nonChat };
}
async function limitedJson(response, signal) {
  if (Number(response.headers.get('content-length')) > LIMIT) { await response.body?.cancel(); throw new ProviderError('Model catalog exceeds 4 MiB', 502); }
  if (!response.body) throw new ProviderError('Model service returned an empty response', 502);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break; size += value.byteLength; if (size > LIMIT) throw new ProviderError('Model catalog exceeds 4 MiB', 502); chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProviderError('Model service returned invalid JSON', 502); }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
async function discover(config, signal) {
  const timeout = AbortSignal.timeout(20000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout; let data;
  try {
    const response = await fetch(config.baseURL + '/models', { headers: { authorization: 'Bearer ' + config.apiKey, accept: 'application/json' }, signal: requestSignal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderError('Model service rejected the request (' + response.status + ')', 502); } data = await limitedJson(response, requestSignal);
  } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError(requestSignal.aborted ? 'Model request cancelled or timed out' : 'Unable to reach the model service', 502); }
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null;
  if (!rows || rows.length > 20000) throw new ProviderError('Model service returned an invalid catalog', 502);
  const seen = new Set(), models = [];
  for (const row of rows) { if (!row || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 512 || /[\u0000-\u001f]/u.test(row.id) || row.id.includes(config.apiKey) || seen.has(row.id)) continue; seen.add(row.id); const info = classification(row), name = typeof row.name === 'string' && row.name.length <= 512 && !row.name.includes(config.apiKey) && !/[\u0000-\u001f]/u.test(row.name) ? row.name : row.id; models.push({ id: row.id, name, kinds: info.kinds, inferred: info.inferred }); }
  return { models };
}
export function createModelProviders(ctx) {
  const entries = () => ctx.llm.listConfigurableProviders();
  const document = ns => ctx.settings.describe().find(row => row.ns === ns);
  const profile = entry => pathValue(document(entry.settingsNs)?.value, entry.settingsPath) || {};
  const credential = async (entry, value) => { const refs = value.apiKeyEnv ? [value.apiKeyEnv] : entry.nativeAuth?.env || []; for (const ref of refs) { const hit = await ctx.credentials.resolve(ref); if (hit?.value) return hit.value; } return ''; };
  const address = (entry, value) => value.baseURL || entry.defaultBaseURL || '';
  const service = {
    async list() {
      // describe() projects every plugin schema/config; do it once per directory read.
      const documents = new Map(ctx.settings.describe().map(row => [row.ns, row.value])), list = [];
      for (const entry of entries()) { const value = pathValue(documents.get(entry.settingsNs), entry.settingsPath) || {}, baseURL = address(entry, value); if (!baseURL || !await credential(entry, value)) continue; list.push({ id: entry.provider, name: value.displayName || entry.displayName || entry.provider, baseURL: endpoint(baseURL), configured: true, ...(entry.declared === true ? { declared: true } : {}) }); }
      return list.sort((a, b) => Number(/routergo/iu.test(b.id + b.name + b.baseURL)) - Number(/routergo/iu.test(a.id + a.name + a.baseURL)) || a.name.localeCompare(b.name));
    },
    async resolve(id) {
      const entry = entries().find(row => row.provider === id); if (!entry) throw new ProviderError('Provider is not configured', 404);
      const value = profile(entry), baseURL = endpoint(address(entry, value)), apiKey = await credential(entry, value);
      if (!apiKey) throw new ProviderError('Provider credential is not configured', 409); return { baseURL, apiKey };
    },
    async describeRoute(id) {
      const entry = entries().find(row => row.provider === id);
      if (!entry) throw new ProviderError('Provider is not configured', 404);
      const value = profile(entry), config = await service.resolve(id);
      return { ...config, protocol: value.api || value.protocol || entry.protocol || null, credentialRef: value.apiKeyEnv || entry.nativeAuth?.env?.join('|') || '' };
    },
    async models(id, signal) {
      const originalEntry = entries().find(row => row.provider === id), originalRef = originalEntry ? profile(originalEntry).apiKeyEnv || originalEntry.nativeAuth?.env?.join('|') || '' : '';
      const config = await service.resolve(id), { models } = await discover(config, signal);
      const entry = entries().find(row => row.provider === id);
      if (!entry) throw new ProviderError('Provider changed; refresh the model list again', 409);
      const current = profile(entry), currentRef = current.apiKeyEnv || entry.nativeAuth?.env?.join('|') || '';
      if (endpoint(address(entry, current)) !== config.baseURL || currentRef !== originalRef || await credential(entry, current) !== config.apiKey) throw new ProviderError('Provider changed; refresh the model list again', 409);
      return models;
    },
  }; return service;
}
