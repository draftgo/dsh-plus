import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';

const failure = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });

export class Store {
  constructor(directory) { this.directory = directory; this.writes = Promise.resolve(); }

  async open() {
    if (this.lock) throw failure('DSH_PLUS_DATA_LOCKED', 'DSH-Plus store is already open');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.directory, 'owner.lock');
    this.guardPath = join(this.directory, 'owner-guard');
    // The short-lived official writer lock serializes recovery with acquisition
    // and release, so competing recoverers cannot remove a successor's lock.
    await withFileLock(this.guardPath, async () => {
      let existing;
      try {
        const metadata = await lstat(this.lockPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw failure('DSH_PLUS_LOCK_UNREADABLE', 'DSH-Plus owner lock is not a regular file; existing data was preserved');
        existing = await readFile(this.lockPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (existing !== undefined) {
        let owner;
        try { owner = JSON.parse(existing); }
        catch (cause) { throw failure('DSH_PLUS_LOCK_UNREADABLE', 'DSH-Plus owner lock is unreadable; existing data was preserved', cause); }
        if (!owner || typeof owner !== 'object' || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647 || typeof owner.host !== 'string' || !owner.host) {
          throw failure('DSH_PLUS_LOCK_UNREADABLE', 'DSH-Plus owner lock has an invalid PID or host; existing data was preserved');
        }
        if (owner.host !== hostname()) throw failure('DSH_PLUS_LOCK_OTHER_HOST', 'DSH-Plus data directory is owned by another host');
        let exited = false;
        try { process.kill(owner.pid, 0); }
        catch (cause) {
          if (cause.code === 'ESRCH') exited = true;
          else throw failure('DSH_PLUS_LOCK_PROBE_FAILED', 'DSH-Plus cannot verify the owner process; existing lock was preserved', cause);
        }
        if (!exited) throw failure('DSH_PLUS_DATA_LOCKED', 'DSH-Plus data directory is already in use');
        await rm(this.lockPath);
      }
      const lock = await open(this.lockPath, 'wx', 0o600);
      const record = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
      try { await lock.writeFile(record); }
      catch (error) { await lock.close(); await rm(this.lockPath, { force: true }); throw error; }
      this.lock = lock;
      this.lockRecord = record;
    });
    try {
      return JSON.parse(await readFile(join(this.directory, 'sessions.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, sessions: [] };
      await this.close();
      throw error;
    }
  }

  save(sessions) {
    const payload = JSON.stringify({ version: 1, sessions }, null, 2);
    const write = this.writes.then(async () => {
      const target = join(this.directory, 'sessions.json');
      const temp = `${target}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(payload); await file.sync(); } finally { await file.close(); }
      try { await rename(temp, target); } finally { await rm(temp, { force: true }); }
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async close() {
    await this.writes;
    if (!this.lock) return;
    await withFileLock(this.guardPath, async () => {
      if (!this.lock) return;
      await this.lock.close(); this.lock = undefined;
      let record;
      try { record = await readFile(this.lockPath, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (record !== this.lockRecord) throw failure('DSH_PLUS_LOCK_OWNERSHIP_CHANGED', 'DSH-Plus owner lock changed; successor lock was preserved');
      await rm(this.lockPath);
    });
  }
}

export async function workingDirectory(value) {
  const { resolve } = await import('node:path');
  const cwd = resolve(value ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
  return cwd;
}
