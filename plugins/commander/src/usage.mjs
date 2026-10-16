import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSameOrigin } from '../voice/src/web.mjs';
import { readJson } from '../voice/src/media.mjs';
import { MachineUsageImporter } from './usage-import.mjs';
import { usageTimeline } from './usage-timeline.mjs';
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = values => values.length && values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
export function normalizeUsage(usage = {}, convention = 'disjoint') {
  const input = count(usage.inputTokens ?? usage.input_tokens ?? usage.input);
  const outputTokens = count(usage.outputTokens ?? usage.output_tokens ?? usage.output);
  const cacheReadTokens = count(usage.cacheReadTokens ?? usage.cachedTokens ?? usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cacheRead ?? usage.cache?.read);
  const cacheWriteTokens = count(usage.cacheWriteTokens ?? usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens ?? usage.cacheWrite ?? usage.cache?.write);
  const reportedTotal = count(usage.totalTokens ?? usage.total_tokens ?? usage.total);
  const promptTokens = convention === 'inclusive' ? input : reportedTotal !== null && outputTokens !== null ? Math.max(0, reportedTotal - outputTokens) : sum([input, cacheReadTokens, cacheWriteTokens]);
  return { inputTokens: convention === 'inclusive' ? input !== null && cacheReadTokens !== null ? Math.max(0, input - cacheReadTokens) : null : input, outputTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens: reportedTotal ?? (promptTokens !== null && outputTokens !== null ? promptTokens + outputTokens : null),
    contextTokens: count(usage.contextTokens) ?? promptTokens, contextWindow: count(usage.contextWindow ?? usage.modelContextWindow), reasoningTokens: count(usage.reasoningTokens ?? usage.reasoning_output_tokens) };
}

export class UsageLedger {
  constructor(directory) { this.path = join(directory, 'usage.json'); this.rows = new Map(); this.writes = Promise.resolve(); this.error = null; }
  async open() {
    try { const data = JSON.parse(await readFile(this.path, 'utf8')); if (data.version !== 1 || !Array.isArray(data.rows)) throw Error('Unsupported usage ledger'); for (const row of data.rows) this.rows.set(row.id, row); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  put(row) {
    // Strict allowlist: never persist prompts, completions, arbitrary event payloads or credentials.
    const safe = Object.fromEntries(['id', 'tool', 'model', 'time', 'sessionId', 'nativeId', 'callId', 'source', 'turnId', 'status', 'scope', 'durationMs', 'speedOutputTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'contextTokens', 'contextWindow', 'reasoningTokens'].map(key => [key, row[key] ?? null]));
    if (!safe.id || !Number.isFinite(Date.parse(safe.time))) return;
    const prior = this.rows.get(safe.id);
    if (prior) {
      // Historical replay may lack the live execution duration or model metadata.
      for (const key of Object.keys(safe)) if (safe[key] === null && prior[key] !== null) safe[key] = prior[key];
    }
    if (JSON.stringify(prior) === JSON.stringify(safe)) return;
    this.rows.set(safe.id, safe); this.dirty = true;
  }
  flush() {
    if (!this.dirty) return this.writes; this.dirty = false;
    const data = JSON.stringify({ version: 1, rows: [...this.rows.values()] });
    const task = this.writes.then(async () => { const temp = this.path + '.' + randomUUID() + '.tmp'; try { await writeFile(temp, data, { mode: 0o600 }); await rename(temp, this.path); } finally { await rm(temp, { force: true }); } });
    this.writes = task.catch(error => { this.error = error.message; }); return task;
  }
  query({ start, end, page = 1, pageSize = 50, timeZone = 'UTC' } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || ![25, 50, 100].includes(pageSize)) throw Error('无效的分页参数');
    const from = Date.parse(start), to = Date.parse(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw Error('请选择有效起止日期');
    let excludedDuplicates = 0;
    const managed = this.managed?.() ?? new Map(), imported = new Set([...this.rows.values()].filter(row => row.source === 'machine').map(row => row.tool + ':' + row.nativeId));
    const preferred = new Set([...managed.values()].filter(key => imported.has(key) && this.importer?.coverage.state !== 'scanning' && this.importer?.completeNativeIds.has(key)));
    const rows = [...this.rows.values()].filter(row => {
      const nativeKey = row.source === 'machine' ? row.tool + ':' + row.nativeId : managed.get(row.sessionId);
      const duplicate = row.source === 'machine' ? [...managed.values()].includes(nativeKey) && !preferred.has(nativeKey) : nativeKey && preferred.has(nativeKey);
      if (duplicate) { excludedDuplicates++; return false; }
      const time = Date.parse(row.time); return time >= from && time < to;
    }).sort((a, b) => b.time.localeCompare(a.time));
    const groups = new Map();
    for (const row of rows) { const key = JSON.stringify([row.tool, row.model]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
    const summarize = group => {
      const total = field => sum(group.map(row => row[field]));
      const cacheReadTokens = total('cacheReadTokens'), inputTokens = total('inputTokens'), cacheWriteTokens = total('cacheWriteTokens');
      const prompt = sum(group.map(row => row.totalTokens !== null && row.outputTokens !== null ? row.totalTokens - row.outputTokens : sum([row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens])));
      const timed = group.filter(row => row.durationMs > 0 && row.outputTokens !== null);
      const context = group.filter(row => row.contextTokens !== null).sort((a, b) => b.contextTokens - a.contextTokens)[0];
      return { calls: group.length, inputTokens, outputTokens: total('outputTokens'), totalTokens: total('totalTokens'), cacheReadTokens, cacheWriteTokens,
        cacheHitRate: prompt > 0 && cacheReadTokens !== null ? cacheReadTokens / prompt : null, contextTokens: context?.contextTokens ?? null,
        contextWindow: context?.contextWindow ?? null, tokensPerSecond: timed.length ? timed.reduce((n, row) => n + (row.speedOutputTokens ?? row.outputTokens), 0) / timed.reduce((n, row) => n + row.durationMs / 1000, 0) : null, measuredCalls: group.filter(row => row.totalTokens !== null).length };
    };
    const timeline = usageTimeline(rows, { start, end, timeZone });
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize)), currentPage = Math.min(page, pageCount);
    return { start, end, timeline, page: currentPage, pageSize, pageCount, summary: summarize(rows), groups: [...groups.values()].map(group => ({ tool: group[0].tool, model: group[0].model, ...summarize(group) })), records: rows.slice((currentPage - 1) * pageSize, currentPage * pageSize), recordCount: rows.length, error: this.error, coverage: { ...(this.importer?.coverage ?? { state: 'idle', sources: [] }), excludedDuplicates, deduplication: '完整导入的原生会话以本机历史为准；未完整导入的已管理会话保留实时记录，不叠加历史；未匹配会话按原生调用标识独立统计' } };
  }
}

export async function mountUsage(ctx, commander, options = {}) {
  let ledger;
  try { ledger = await new UsageLedger(commander.store.directory).open(); }
  catch (error) { ledger = new UsageLedger(commander.store.directory); ledger.error = '历史用量无法读取，本次仅显示内存采集；原文件保留。'; ledger.flush = () => Promise.resolve(); }
  ledger.managed = () => new Map([...commander.sessions.values()].filter(session => session.nativeId).map(session => [session.id, session.provider + ':' + (session.provider === 'pi' ? session.nativeId.split('/').at(-1)?.replace(/.jsonl$/u, '').split('_').at(-1) : session.nativeId)]));
  ledger.importer = await new MachineUsageImporter(ledger, normalizeUsage, options.enabled === false ? { roots: {} } : options).open();
  let scanTimer, scanRounds = 0;
  const scanMachine = async () => { await ledger.importer.scan(); scanRounds++; if (!ledger.importer.closed && scanRounds < 100 && ledger.importer.coverage.scannedBytes > 0 && ledger.importer.coverage.sources.some(source => source.continuable)) { scanTimer = setTimeout(scanMachine, 1000); scanTimer.unref?.(); } };
  void scanMachine();
  const routes = new Map(), stepFirst = new Map(); let stopped = false, backfill;
  // Earlier versions measured entire native turns. Remove those incompatible
  // intervals rather than mixing them into the official settled-step speed.
  for (const row of ledger.rows.values()) if (row.id.startsWith('native:') && (row.durationMs !== null || row.speedOutputTokens !== null)) { row.durationMs = null; row.speedOutputTokens = null; ledger.dirty = true; }
  const native = event => {
    const session = commander.sessions.get(event.sessionId); if (!session) return;
    const key = session.id + ':' + event.turnId;
    if (event.type === 'usage') {
      const id = 'native:' + key + ':' + (event.data.id ?? 'turn');
      const old = ledger.rows.get(id);
      ledger.put({ ...old, id, tool: session.provider, model: event.data.model ?? session.model ?? null, time: event.time, sessionId: session.id, turnId: event.turnId, status: session.status, scope: event.data.scope, ...normalizeUsage(event.data.usage, event.data.convention), durationMs: count(event.data.durationMs) ?? old?.durationMs ?? null });
    }
    // Legacy Claude message events already carry authoritative per-message usage.
    if (event.type === 'message' && session.provider === 'claude' && event.data.type === 'assistant' && event.data.message?.usage) {
      const message = event.data.message; ledger.put({ id: 'native:' + key + ':' + (message.id ?? event.seq), tool: session.provider, model: message.model ?? session.model ?? null, time: event.time, sessionId: session.id, turnId: event.turnId, status: session.status, durationMs: null, ...normalizeUsage(message.usage) });
    }
    if (event.type === 'turn.completed') {
      const turnRows = [...ledger.rows.values()].filter(row => row.sessionId === session.id && row.turnId === event.turnId);
      for (const row of turnRows) ledger.put({ ...row, status: event.data.status, durationMs: null, speedOutputTokens: null });
      if (![...ledger.rows.values()].some(row => row.sessionId === session.id && row.turnId === event.turnId)) ledger.put({ id: 'native:' + key + ':turn', tool: session.provider, model: session.model, time: event.time, sessionId: session.id, turnId: event.turnId, status: event.data.status });
    }
  };
  for (const session of commander.sessions.values()) for (const event of session.events) native(event);
  const listener = event => { native(event); void ledger.flush().catch(() => {}); }; commander.on('event', listener);
  const official = (session, event) => {
    if (event.type === 'request/header') { routes.set(session.id, event.data.header?.config ?? {}); return; }
    if (!['assistant/message', 'assistant/attempt'].includes(event.type) || event.seq < (session.inheritedEventCount ?? 0)) return;
    const source = event.data.message?.source ?? routes.get(session.id) ?? {};
    if (source.provider?.startsWith('commander-')) return;
    const stream = event.data.stream ?? []; const usage = event.data.usage ?? stream.filter(record => record.chunk?.type === 'usage').at(-1)?.chunk?.usage;
    const stepKey = session.id + ':' + event.data.turn + ':' + event.data.step;
    const first = assistantStreamFirstTokenTime(stream), pending = stepFirst.get(stepKey);
    const firstTime = Number.isFinite(first) ? Number.isFinite(pending) ? Math.min(first, pending) : first : pending;
    if (event.type === 'assistant/attempt') {
      if (Number.isFinite(firstTime)) stepFirst.set(stepKey, firstTime);
      if (ledger.rows.delete('harness:' + session.id + ':' + event.seq)) ledger.dirty = true;
      return;
    }
    stepFirst.delete(stepKey);
    if (!usage && event.type !== 'assistant/message') return;
    const durationMs = Number.isFinite(firstTime) && event.time > firstTime ? event.time - firstTime : null;
    ledger.put({ id: 'harness:' + session.id + ':' + event.seq, tool: source.provider ?? 'harness', model: source.model ?? null, time: new Date(event.time).toISOString(), sessionId: session.id, turnId: String(event.data.turn), status: event.data.interrupted ? 'interrupted' : 'completed', durationMs, ...normalizeUsage(usage ?? {}) });
  };
  ctx.on('session/event', (session, event) => { official(session, event); void ledger.flush().catch(() => {}); });
  ctx.inject(['sessionQuery'], child => {
    backfill = (async () => { for (const record of await child.sessionQuery.listSessions()) { if (stopped) return; try { const snapshot = await child.sessionQuery.readSession(record.header.id); const session = { id: record.header.id, inheritedEventCount: snapshot.inheritedEventCount }; for (const event of snapshot.events) official(session, event); } catch { /* Unreadable old sessions must not prevent current usage collection. */ } } await ledger.flush(); })().catch(error => { ledger.error = error.message; });
  });
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/commander/usage', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try { assertSameOrigin(request); const input = await readJson(request); await backfill; if (input.refresh === true) await ledger.importer.scan(); return Response.json(ledger.query(input), { headers: { 'cache-control': 'no-store' } }); }
    catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  } }));
  ctx.effect(() => async () => { stopped = true; clearTimeout(scanTimer); commander.off('event', listener); await backfill; await ledger.importer.close(); await ledger.flush(); });
  await ledger.flush(); return ledger;
}
