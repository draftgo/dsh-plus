import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineUsageImporter, usageRoots } from '../src/usage-import.mjs';
import { UsageLedger, normalizeUsage } from '../src/usage.mjs';
const line = item => JSON.stringify(item) + '\n';
const time = '2026-10-16T08:00:00Z';
const usage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 20, total_tokens: 120 };
test('environment roots follow each native tool and XDG directory', () => {
  assert.deepEqual(usageRoots({ CODEX_HOME: '/a', CLAUDE_CONFIG_DIR: '/b', PI_CODING_AGENT_DIR: '/c', XDG_DATA_HOME: '/d' }, '/home/user'), { codex: ['/a/sessions', '/a/archived_sessions'], claude: ['/b/projects'], pi: ['/c/sessions'], opencode: ['/d/opencode'] });
});
test('incremental histories deduplicate accounting positions and persist metadata only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-import-')); const roots = {};
  try {
    for (const tool of ['codex', 'claude', 'pi', 'opencode']) { roots[tool] = [join(dir, tool)]; await mkdir(roots[tool][0]); }
    const codex = join(roots.codex[0], 'session.jsonl');
    await writeFile(codex, [
      { type: 'session_meta', timestamp: time, payload: { id: 'native-codex' } },
      { type: 'turn_context', timestamp: time, payload: { turn_id: 'turn', model: 'codex-model' } },
      { type: 'token_usage_record', timestamp: time, payload: { thread_id: 'native-codex', response_id: 'call', usage, thread_token_usage: usage } },
      { type: 'event_msg', timestamp: time, payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage, model_context_window: 1000 } } },
    ].map(line).join(''));
    await writeFile(join(roots.claude[0], 'session.jsonl'), line({ type: 'assistant', timestamp: time, sessionId: 'native-claude', message: { id: 'message', model: 'claude-model', content: 'private prompt text', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } }));
    await writeFile(join(roots.pi[0], 'session.jsonl'), line({ type: 'session', id: 'native-pi' }) + line({ type: 'message', id: 'pi-message', timestamp: time, message: { role: 'assistant', model: 'pi-model', content: 'private completion', usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } } }));
    await mkdir(join(roots.opencode[0], 'storage/message/session'), { recursive: true });
    await writeFile(join(roots.opencode[0], 'storage/message/session/msg.json'), JSON.stringify({ id: 'op-message', sessionID: 'native-op', role: 'assistant', providerID: 'router', modelID: 'op-model', time: { created: Date.parse(time) }, tokens: { input: 1, output: 2, cache: { read: 3, write: 0 } } }));
    const ledger = await new UsageLedger(dir).open(), importer = await new MachineUsageImporter(ledger, normalizeUsage, { roots }).open();
    await importer.scan(); assert.equal(ledger.rows.size, 4); assert.equal(importer.coverage.state, 'ready');
    await importer.scan(); assert.equal(ledger.rows.size, 4); assert.equal(importer.coverage.scannedBytes, 0);
    await appendFile(codex, line({ type: 'token_usage_record', timestamp: time, payload: { response_id: 'next', usage: { ...usage, output_tokens: 30, total_tokens: 130 }, thread_token_usage: { ...usage, input_tokens: 200, output_tokens: 50, total_tokens: 250 } } }));
    await importer.scan(); assert.equal(ledger.rows.size, 5); assert.equal(importer.completeNativeIds.has('codex:native-codex'), true);
    const reopened = await new MachineUsageImporter(ledger, normalizeUsage, { roots }).open(); await reopened.scan(); assert.equal(reopened.coverage.scannedBytes, 0); assert.equal(reopened.completeNativeIds.has('codex:native-codex'), true);
    assert.doesNotMatch(await readFile(ledger.path, 'utf8'), /private|completion|prompt/); assert.doesNotMatch(await readFile(importer.path, 'utf8'), /private|completion|prompt/);
    ledger.importer = importer; ledger.managed = () => new Map([['managed', 'codex:native-codex']]); ledger.put({ id: 'managed', source: 'native', tool: 'codex', sessionId: 'managed', time, ...normalizeUsage(usage, 'inclusive') });
    assert.equal(ledger.query({ start: '2026-10-16', end: '2026-10-17' }).recordCount, 5);
    importer.completeNativeIds.clear(); assert.equal(ledger.query({ start: '2026-10-16', end: '2026-10-17' }).recordCount, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('bounded scan resumes partial JSONL and tolerates missing roots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-import-bounds-'));
  try {
    const root = join(dir, 'codex'); await mkdir(root); const path = join(root, 'one.jsonl');
    const metadata = line({ type: 'session_meta', payload: { id: 'one' } }); await writeFile(path, metadata + line({ type: 'token_usage_record', timestamp: time, payload: { usage, thread_token_usage: usage } }));
    const ledger = await new UsageLedger(dir).open(), importer = await new MachineUsageImporter(ledger, normalizeUsage, { roots: { codex: [root], claude: [join(dir, 'missing')] }, maxBytesPerScan: metadata.length + 20 }).open();
    await importer.scan(); assert.equal(importer.coverage.state, 'partial'); assert.equal(importer.completeNativeIds.size, 0);
    importer.limits.maxBytesPerScan = 4096; await importer.scan(); assert.equal(ledger.rows.size, 1); assert.equal(importer.coverage.sources[1].status, 'missing');
    await appendFile(path, '{'); await importer.scan(); assert.equal(importer.completeNativeIds.size, 0); assert.equal(ledger.rows.size, 1);
    await appendFile(path, '}\n'); await importer.scan(); assert.equal(ledger.rows.size, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('OpenCode SQLite revisits updated usage on an existing row', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'usage-import-sqlite-'));
  let db;
  try {
    const path = join(dir, 'opencode.db'); db = new DatabaseSync(path);
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
    const info = { role: 'assistant', modelID: 'model', time: { created: Date.parse(time) }, tokens: { input: 2, output: 3, cache: { read: 0, write: 0 } } };
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('message', 'session', JSON.stringify(info));
    const ledger = await new UsageLedger(dir).open(), importer = await new MachineUsageImporter(ledger, normalizeUsage, { roots: { opencode: [dir] } }).open();
    await importer.scan(); assert.equal(ledger.rows.size, 1); assert.equal([...ledger.rows.values()][0].outputTokens, 3);
    db.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify({ ...info, tokens: { ...info.tokens, output: 5000 } }), 'message');
    await importer.scan(); assert.equal(ledger.rows.size, 1); assert.equal([...ledger.rows.values()][0].outputTokens, 5000);
    db.exec('DROP TABLE message; CREATE TABLE message (id TEXT)'); await importer.scan(); assert.ok(importer.coverage.sources[0].errors.includes('unsupported-opencode-schema'));
  } finally { db?.close(); await rm(dir, { recursive: true, force: true }); }
});
test('records span scan budgets without loss and unchanged incomplete tails stop continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-import-spanning-'));
  try {
    const root = join(dir, 'codex'); await mkdir(root);
    const path = join(root, 'one.jsonl');
    const record = line({ type: 'token_usage_record', timestamp: time, payload: { usage, thread_token_usage: usage }, privateText: 'private'.repeat(30) });
    await writeFile(path, record);
    const ledger = await new UsageLedger(dir).open(), importer = await new MachineUsageImporter(ledger, normalizeUsage, { roots: { codex: [root] }, maxBytesPerScan: 64, maxLineBytes: record.length + 1 }).open();
    for (let pass = 0; pass < 30 && !ledger.rows.size; pass++) await importer.scan();
    assert.equal(ledger.rows.size, 1); assert.equal(importer.coverage.state, 'ready');
    assert.deepEqual(importer.coverage.sources[0].errors, []);
    assert.doesNotMatch(await readFile(importer.path, 'utf8'), /privateText|privateprivate/);
    await appendFile(path, '{"type":'); await importer.scan();
    assert.equal(importer.coverage.sources[0].continuable, false);
    await importer.scan(); assert.equal(importer.coverage.scannedBytes, 0);
    await appendFile(path, '"ignored"}\n'); await importer.scan();
    assert.equal(importer.coverage.state, 'ready');
    await writeFile(path, 'x'.repeat(200) + '\n' + record);
    importer.cursors = {}; importer.pending.clear(); importer.limits.maxLineBytes = 100;
    let sawOversized = false;
    for (let pass = 0; pass < 30; pass++) { await importer.scan(); sawOversized ||= importer.coverage.sources[0].errors.includes('line-too-large'); if (!importer.coverage.sources[0].continuable) break; }
    assert.equal(sawOversized, true);
    assert.equal(importer.cursors[path].offset, (await readFile(path)).length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
