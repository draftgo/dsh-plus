import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export function githubRepository(value) {
  if (typeof value !== 'string' || value.length > 500 || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(value)) throw new Error('Use an HTTPS GitHub repository URL: https://github.com/owner/repo');
  const [owner, raw] = value.slice('https://github.com/'.length).split('/');
  const name = raw.replace(/\.git$/, '');
  if (!name || name === '.' || name === '..' || name.startsWith('.')) throw new Error('Invalid GitHub repository name');
  return { owner, name, url: `https://github.com/${owner}/${name}.git` };
}

function profileDirectory(ctx) {
  const pathService = ctx.get?.('path');
  if (typeof pathService?.baseDir === 'string' && isAbsolute(pathService.baseDir)) return pathService.baseDir;
  // Official app-boot sets baseUrl to the active configuration/profile folder.
  const base = ctx.baseUrl ?? ctx.get?.('baseUrl');
  if (typeof base === 'string' && base.startsWith('file:')) return fileURLToPath(base);
  throw new Error('The active Harness profile directory is unavailable');
}

async function cloneGit(url, destination, { timeout = 5 * 60_000 } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'credential.interactive=false', 'clone', '--', url, destination], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    let tail = '', timedOut = false;
    child.stderr.on('data', chunk => { tail = (tail + chunk.toString()).slice(-3000); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Git clone timed out; try again'));
      else if (code !== 0) reject(new Error(`Git clone failed: ${tail.trim() || `exit ${code}`}`));
      else resolve();
    });
  });
}

export function projectActions(ctx, { runClone = cloneGit } = {}) {
  let cloning = false;
  return {
    async browse({ path = homedir(), name = '' } = {}) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) throw new Error('Directory path must be absolute');
      if (typeof name !== 'string' || name.length > 200) throw new Error('Invalid directory name filter');
      const current = await realpath(path);
      if (!(await stat(current)).isDirectory()) throw new Error('Path is not a directory');
      const dirents = await readdir(current, { withFileTypes: true });
      const entries = [];
      for (const entry of dirents) {
        if (entry.name.startsWith('.') || !entry.name.toLowerCase().includes(name.toLowerCase())) continue;
        const child = join(current, entry.name);
        if (entry.isDirectory()) entries.push({ name: entry.name, path: child });
        else if (entry.isSymbolicLink()) {
          try { if ((await stat(child)).isDirectory()) entries.push({ name: entry.name, path: child }); } catch {}
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { path: current, parent: dirname(current) === current ? null : dirname(current), home: homedir(), entries };
    },
    async clone({ url } = {}) {
      const repo = githubRepository(url);
      if (cloning) throw new Error('Another repository is being cloned; wait for it to finish');
      cloning = true;
      let staging, destination, reserved = false;
      try {
        const root = join(profileDirectory(ctx), 'workspaces');
        await mkdir(root, { recursive: true });
        destination = join(root, repo.name);
        // Exclusive reservation forbids overwriting any pre-existing path,
        // including symlinks and concurrent clones from another process.
        try { await lstat(destination); throw new Error('Repository destination already exists'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { await mkdir(destination); reserved = true; }
        catch (error) { if (error.code === 'EEXIST') throw new Error('Repository destination already exists'); throw error; }
        staging = await mkdtemp(join(root, '.clone-'));
        const checkout = join(staging, 'repository');
        await runClone(repo.url, checkout);
        await rename(checkout, destination);
        const p = await ctx.workspaceRegistry.create(await realpath(destination));
        return { project: { id: p.id, path: p.path, title: p.title } };
      } catch (error) {
        if (reserved) await rm(destination, { recursive: true, force: true });
        throw error;
      } finally {
        if (staging) await rm(staging, { recursive: true, force: true });
        cloning = false;
      }
    },
  };
}
