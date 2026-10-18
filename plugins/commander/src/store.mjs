import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) { this.directory = directory; this.writes = Promise.resolve(); }

  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.directory, 'owner.lock');
    // Do not automatically reclaim stale locks: simultaneous reclaimers could
    // unlink a newly acquired owner's lock. Recovery is an operator action.
    for (let attempt = 0; attempt < 1; attempt++) {
      try {
        this.lock = await open(this.lockPath, 'wx', 0o600);
        await this.lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readFile(this.lockPath, 'utf8')); }
        catch { throw new Error('DSH-Plus owner lock is unreadable; inspect it before removing'); }
        if (owner.host !== hostname()) throw new Error('DSH-Plus data directory is owned by another host');
        try { process.kill(owner.pid, 0); throw new Error('DSH-Plus data directory is already in use'); }
        catch (check) { if (check.code !== 'ESRCH') throw check; }
        throw new Error('Stale DSH-Plus owner.lock: verify the recorded process has exited, then remove the lock explicitly');
      }
    }
    if (!this.lock) throw new Error('Could not acquire DSH-Plus owner lock');
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
    if (this.lock) { await this.lock.close(); this.lock = undefined; await rm(this.lockPath, { force: true }); }
  }
}

export async function workingDirectory(value) {
  const { resolve } = await import('node:path');
  const cwd = resolve(value ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
  return cwd;
}
