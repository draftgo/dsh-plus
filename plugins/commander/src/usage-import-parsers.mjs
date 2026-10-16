import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const known = value => typeof value === 'string' && value.length <= 1024 ? value : null;
export function parseUsageLine(tool, item, state, normalize) {
  const p = item.payload ?? {}, m = item.message ?? {};
  const time = item.timestamp ?? m.timestamp;
  if (tool === 'codex') {
    if (item.type === 'session_meta') { state.nativeId = p.id ?? p.session_id; state.contextWindow = p.context_window; state.inherited = p.forked_from_ordinal_exclusive ?? null; }
    if (item.type === 'turn_context') { state.model = p.model; state.turnId = p.turn_id; }
    if (state.inherited != null && item.ordinal != null && item.ordinal < state.inherited) return;
    let usage, cumulative, callId;
    if (item.type === 'token_usage_record') { usage = p.usage; cumulative = p.thread_token_usage; callId = p.response_id; state.nativeId ??= p.thread_id ?? p.session_id; state.turnId = p.turn_id ?? state.turnId; }
    else if (item.type === 'event_msg' && p.type === 'token_count') { usage = p.info?.last_token_usage; cumulative = p.info?.total_token_usage; state.contextWindow = p.info?.model_context_window ?? state.contextWindow; }
    if (!usage || !state.nativeId) return;
    const signature = hash(cumulative ?? usage);
    if (state.lastUsageSignature === signature) return;
    state.lastUsageSignature = signature;
    // One stable cumulative accounting position is shared by both modern and legacy records.
    return row(tool, state.nativeId, signature, state.model, time, normalize({ ...usage, contextTokens: usage.input_tokens, contextWindow: state.contextWindow }, 'inclusive'), state.turnId, callId);
  }
  if (tool === 'claude' && item.type === 'assistant' && m.usage && m.id) {
    return row(tool, item.sessionId ?? state.nativeId, m.id, m.model, time, normalize(m.usage), null, m.id);
  }
  if (tool === 'pi') {
    if (item.type === 'session') state.nativeId = item.id;
    if (item.type === 'model_change') state.model = item.modelId;
    if (item.type === 'message' && m.role === 'assistant' && m.usage) return row(tool, state.nativeId, item.id ?? String(m.timestamp), m.model ?? state.model, time, normalize(m.usage), null, item.id);
  }
}
function row(tool, nativeId, id, model, time, usage, turnId, callId) {
  if (!nativeId || !Number.isFinite(new Date(time).getTime())) return;
  return { id: 'machine:' + tool + ':' + nativeId + ':' + id, source: 'machine', tool, model: known(model), nativeId: known(nativeId), callId: known(callId), sessionId: null, turnId: known(turnId), time: new Date(time).toISOString(), status: 'recorded', ...usage };
}
export function parseOpenCodeMessage(info, normalize) {
  if (info.role !== 'assistant' || !info.tokens || !info.id || !info.sessionID) return;
  return row('opencode', info.sessionID, info.id, info.modelID ? (info.providerID ? info.providerID + '/' : '') + info.modelID : null, info.time?.completed ?? info.time?.created, normalize(info.tokens), null, info.id);
}
