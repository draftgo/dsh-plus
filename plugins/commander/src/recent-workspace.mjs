import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { profileDirectory } from './projects.mjs';

/** Commander owns recovery identity; the official first-use marker is never rewritten. */
export function recentWorkspaceActions(ctx, directory) {
  const file = join(directory, 'recent-workspace.json');
  let queue = Promise.resolve();
  return {
    ensure({ workspaceId } = {}) {
      const task = queue.then(async () => {
        let saved;
        try {
          saved = JSON.parse(await readFile(file, 'utf8'));
          if (typeof saved.id !== 'string' || typeof saved.path !== 'string' || !isAbsolute(saved.path)) throw new Error('Invalid recent workspace record');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        // A valid official default takes priority; otherwise recover our durable identity.
        const existing = (typeof workspaceId === 'string' && ctx.workspaceRegistry.get(workspaceId))
          || (saved && ctx.workspaceRegistry.get(saved.id));
        const path = existing?.path ?? saved?.path ?? join(profileDirectory(ctx), 'workspaces', 'default-workspace');
        await mkdir(path, { recursive: true });
        const workspace = await ctx.workspaceRegistry.create(path);
        const next = { id: workspace.id, path: workspace.path };
        if (saved?.id !== next.id || saved?.path !== next.path) {
          const temp = `${file}.${randomUUID()}.tmp`;
          try { await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, file); }
          finally { await rm(temp, { force: true }); }
        }
        return { workspaceId: workspace.id, path: workspace.path, title: workspace.title };
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
