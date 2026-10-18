import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recentWorkspaceActions } from '../src/recent-workspace.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'commander-recent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const items = new Map();
  let created = 0;
  const ctx = { baseUrl: pathToFileURL(`${directory}/`).href, workspaceRegistry: {
    get: id => items.get(id),
    async create(path) {
      path = await realpath(path);
      const existing = [...items.values()].find(item => item.path === path);
      if (existing) return existing;
      const item = { id: `workspace-${++created}`, path, title: 'default-workspace' };
      items.set(item.id, item);
      return item;
    },
  } };
  return { directory, ctx, items, actions: recentWorkspaceActions(ctx, directory) };
}

test('missing Recent is created even with other projects; concurrent requests and restart preserve identity', async t => {
  const { directory, ctx, items, actions } = await fixture(t);
  items.set('user-project', { id: 'user-project', path: directory, title: 'default-workspace' });
  const [first, second] = await Promise.all([actions.ensure(), actions.ensure()]);
  assert.equal(first.path, join(directory, 'workspaces', 'default-workspace'));
  assert.equal(second.workspaceId, first.workspaceId);
  assert.notEqual(first.workspaceId, 'user-project');
  assert.equal(items.size, 2);
  assert.deepEqual(await recentWorkspaceActions(ctx, directory).ensure(), first);
});

test('official default keeps its identity and contents; removed registration and directory are automatically rebuilt', async t => {
  const { directory, ctx, items, actions } = await fixture(t);
  const path = join(directory, 'Documents', 'original');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'keep.txt'), 'user data');
  items.set('official-default', { id: 'official-default', path, title: 'Renamed' });
  const original = await actions.ensure({ workspaceId: 'official-default' });
  assert.equal(original.workspaceId, 'official-default');
  items.delete('official-default');
  const rebuilt = await recentWorkspaceActions(ctx, directory).ensure();
  assert.notEqual(rebuilt.workspaceId, original.workspaceId);
  assert.equal(rebuilt.path, path);
  assert.equal(await readFile(join(path, 'keep.txt'), 'utf8'), 'user data');
  // The registration can also outlive the directory on disk.
  await rm(path, { recursive: true });
  assert.deepEqual(await actions.ensure(), rebuilt);
  assert.equal(await realpath(path), path);
});

test('filesystem failure is surfaced and a later retry recovers without adopting a user project', async t => {
  const { directory, items, actions } = await fixture(t);
  const path = join(directory, 'workspaces');
  await writeFile(path, 'file blocking directory');
  await assert.rejects(actions.ensure(), { code: 'ENOTDIR' });
  assert.equal(items.size, 0);
  await rm(path);
  assert.ok((await actions.ensure()).workspaceId);
});
