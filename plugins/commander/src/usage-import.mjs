import { readdir, stat, open, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseUsageLine, parseOpenCodeMessage } from './usage-import-parsers.mjs';

export function usageRoots(env = process.env, home = homedir()) {
  const codex = env.CODEX_HOME || join(home, '.codex');
  return { codex: [join(codex, 'sessions'), join(codex, 'archived_sessions')], claude: [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')], pi: [join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'sessions')], opencode: [env.OPENCODE_DATA_DIR || join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode')] };
}
export class MachineUsageImporter {
  constructor(ledger, normalize, { roots = usageRoots(), maxFiles = 10000, maxBytesPerScan = 32 * 1024 * 1024, maxLineBytes = 8 * 1024 * 1024 } = {}) {
    this.ledger = ledger; this.normalize = normalize; this.roots = roots; this.limits = { maxFiles, maxBytesPerScan, maxLineBytes }; this.path = join(ledger.path, '..', 'usage-import.json'); this.cursors = {}; this.pending = new Map(); this.completeNativeIds = new Set(); this.coverage = { state: 'idle', sources: [], limits: this.limits }; this.closed = false;
  }
  async open() { try { const saved = JSON.parse(await readFile(this.path, 'utf8')); if (saved.version === 1) this.cursors = saved.cursors ?? {}; } catch (e) { if (e.code !== 'ENOENT') this.coverage.error = '扫描游标不可读，将重新安全去重扫描'; } return this; }
  scan() { if (this.running) return this.running; this.running = this.run().catch(error => { this.coverage.state = 'error'; this.coverage.error = error.code || 'scan-failed'; }).finally(() => { this.running = null; }); return this.running; }
  async run() {
    this.completeNativeIds.clear();
    this.coverage = { state: 'scanning', startedAt: new Date().toISOString(), completedAt: null, sources: [], scannedBytes: 0, limits: this.limits };
    let budget = this.limits.maxBytesPerScan, filesCount = 0;
    for (const [tool, roots] of Object.entries(this.roots)) {
      budget = Math.max(1, Math.floor(this.limits.maxBytesPerScan / Math.max(1, Object.keys(this.roots).length)));
      const source = { tool, status: 'missing', files: 0, scannedFiles: 0, records: 0, errors: [], truncated: false, continuable: false }; this.coverage.sources.push(source);
      for (const root of roots) {
        const paths = [];
        const walk = async (directory, depth = 0) => {
          if (depth > 12 || filesCount >= this.limits.maxFiles || this.closed) { source.truncated = true; return; }
          let entries; try { entries = await readdir(directory, { withFileTypes: true }); source.status = 'ready'; } catch (e) { if (e.code !== 'ENOENT') source.errors.push(e.code || 'read-directory'); return; }
          for (const entry of entries) { if (entry.isSymbolicLink()) continue; const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path, depth + 1); else if ((tool === 'opencode' && (entry.name.endsWith('.json') || entry.name === 'opencode.db')) || entry.name.endsWith('.jsonl')) { if (++filesCount > this.limits.maxFiles) { source.truncated = true; break; } paths.push(path); } }
        };
        await walk(root); source.files += paths.length;
        for (const path of paths) {
          if (this.closed || budget <= 0) { source.truncated = true; source.continuable = !this.closed; break; }
          try {
            const info = await stat(path);
            if (tool === 'opencode') { if (path.endsWith('.db')) { const result = await this.sqlite(path, source, budget); budget -= result; this.coverage.scannedBytes += result; } else if (path.includes('/message/')) { if (info.size > this.limits.maxLineBytes || info.size > budget) { source.truncated = true; continue; } const key = path, prior = this.cursors[key]; if (prior?.mtime === info.mtimeMs && prior.size === info.size) continue; const item = JSON.parse(await readFile(path, 'utf8')); const row = parseOpenCodeMessage(item, this.normalize); if (row) this.ledger.put(row); this.cursors[key] = { mtime: info.mtimeMs, size: info.size }; budget -= info.size; this.coverage.scannedBytes += info.size; source.scannedFiles++; } continue; }
            let cursor = this.cursors[path];
            if (!cursor || cursor.ino !== info.ino || info.size < cursor.offset) cursor = { ino: info.ino, offset: 0, state: { nativeId: basename(path, '.jsonl') } };
            let pending = this.pending.get(path);
            if (pending && (pending.ino !== info.ino || pending.offset !== cursor.offset || info.size < pending.nextOffset)) { this.pending.delete(path); pending = null; }
            if (pending?.tail && pending.size === info.size && pending.mtime === info.mtimeMs) { source.truncated = true; continue; }
            if (pending?.tail) { this.pending.delete(path); pending = null; }
            const readOffset = pending?.nextOffset ?? cursor.offset;
            const length = Math.min(info.size - readOffset, budget); if (length <= 0) { if (cursor.offset === info.size && cursor.state.nativeId) this.completeNativeIds.add(tool + ':' + cursor.state.nativeId); continue; }
            const handle = await open(path, 'r'); const fresh = Buffer.alloc(length); let bytesRead;
            try { ({ bytesRead } = await handle.read(fresh, 0, length, readOffset)); } finally { await handle.close(); }
            // Keep unfinished bounded records in memory only, never in the cursor file.
            const buffer = pending?.buffer ? Buffer.concat([pending.buffer, fresh.subarray(0, bytesRead)]) : fresh.subarray(0, bytesRead);
            let position = 0, consumed = 0;
            if (cursor.state.skipOversize) {
              const newline = buffer.indexOf(10);
              if (newline >= 0) {
                consumed = newline + 1;
                cursor.state.skipOversize = false;
                position = consumed;
              } else {
                consumed = buffer.length;
                position = buffer.length;
              }
            }
            while (position < buffer.length) {
              const end = buffer.indexOf(10, position); if (end < 0) break;
              if (end - position > this.limits.maxLineBytes) { source.errors.push('line-too-large'); consumed = end + 1; position = end + 1; continue; }
              try { const item = JSON.parse(buffer.subarray(position, end).toString('utf8')); const row = parseUsageLine(tool, item, cursor.state, this.normalize); if (row) this.ledger.put(row); } catch { source.errors.push('invalid-json-record'); }
              consumed = end + 1; position = consumed;
            }
            if (buffer.length - consumed > this.limits.maxLineBytes) {
              source.errors.push('line-too-large');
              cursor.state.skipOversize = true;
              consumed = buffer.length;
            }
            cursor.offset += consumed; this.cursors[path] = cursor; this.pending.delete(path);
            const nextOffset = readOffset + bytesRead;
            if (cursor.offset < nextOffset) {
              if (nextOffset < info.size) this.pending.set(path, { ino: info.ino, offset: cursor.offset, nextOffset, buffer: buffer.subarray(consumed) });
              else this.pending.set(path, { ino: info.ino, offset: cursor.offset, nextOffset, tail: true, size: info.size, mtime: info.mtimeMs });
            }
            if (cursor.offset === info.size && cursor.state.nativeId && !source.errors.length) this.completeNativeIds.add(tool + ':' + cursor.state.nativeId); else this.completeNativeIds.delete(tool + ':' + cursor.state.nativeId);
            if (cursor.offset < info.size) source.truncated = true;
            if (nextOffset < info.size) source.continuable = true;
            budget -= bytesRead; this.coverage.scannedBytes += bytesRead; source.scannedFiles++;
          } catch (e) { source.errors.push(e.code || 'read-history'); }
        }
      }
      source.records = [...this.ledger.rows.values()].filter(row => row.source === 'machine' && row.tool === tool).length;
      source.errors = [...new Set(source.errors)].slice(0, 10); if (source.errors.length || source.truncated) source.status = 'partial';
    }
    this.coverage.state = this.coverage.sources.some(source => source.status === 'partial') ? 'partial' : 'ready'; this.coverage.completedAt = new Date().toISOString();
    await this.ledger.flush();
    const temp = this.path + '.' + randomUUID() + '.tmp'; try { await writeFile(temp, JSON.stringify({ version: 1, cursors: this.cursors }), { mode: 0o600 }); await rename(temp, this.path); } finally { await rm(temp, { force: true }); }
  }
  async sqlite(path, source, budget) {
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(path, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message','part')").all();
      if (!tables.some(row => row.name === 'message')) { source.errors.push('unsupported-opencode-schema'); return 0; }
      const columns = db.prepare('PRAGMA table_info(message)').all().map(row => row.name);
      if (!columns.includes('data')) { source.errors.push('unsupported-opencode-schema'); return 0; }
      const file = await stat(path), prior = this.cursors[path];
      let walTime = 0; try { walTime = (await stat(path + '-wal')).mtimeMs; } catch {}
      // Usage is often written back into an existing assistant row. A changed DB
      // restarts a bounded idempotent scan; stable row ids overwrite prior counts.
      let offset = prior?.mtime === file.mtimeMs && prior?.size === file.size && prior?.walTime === walTime ? prior.rowid ?? 0 : 0, bytes = 0;
      if (prior?.complete && offset > 0) return 0;
      const selected = ['rowid AS cursor', 'data', ...(columns.includes('id') ? ['id'] : []), ...(columns.includes('session_id') ? ['session_id'] : [])];
      const rows = db.prepare('SELECT ' + selected.join(',') + ' FROM message WHERE rowid > ? ORDER BY rowid LIMIT 1000').all(offset);
      let complete = rows.length < 1000;
      for (const item of rows) { const size = Buffer.byteLength(String(item.data)); if (bytes + size > budget) { source.truncated = true; complete = false; break; } bytes += size; const info = typeof item.data === 'string' ? JSON.parse(item.data) : item.data; const row = parseOpenCodeMessage({ id: item.id, sessionID: item.session_id, ...info }, this.normalize); if (row) this.ledger.put(row); offset = item.cursor; }
      this.cursors[path] = { rowid: offset, mtime: file.mtimeMs, walTime, size: file.size, complete }; source.scannedFiles++; if (!complete) { source.truncated = true; source.continuable ||= bytes > 0; } return bytes;
    } catch (e) { source.errors.push(e.code || 'sqlite-unavailable'); return 0; } finally { db?.close(); }
  }
  async close() { this.closed = true; await this.running; }
}
