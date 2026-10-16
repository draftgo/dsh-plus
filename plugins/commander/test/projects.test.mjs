import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubRepository, projectActions } from '../src/projects.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'commander-projects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registered = [];
  const ctx = { baseUrl: pathToFileURL(`${directory}/`).href, workspaceRegistry: { async create(path) { registered.push(path); return { id: 'shared-project', path, title: 'Cloned' }; } } };
  return { directory, registered, ctx };
}

test('browse shows only visible directories with parent, home and name filtering', async t => {
  const { directory, ctx } = await fixture(t);
  await mkdir(join(directory, 'Alpha'));
  await mkdir(join(directory, 'Beta'));
  await mkdir(join(directory, '.hidden'));
  await writeFile(join(directory, 'file.txt'), 'not a directory');
  const actions = projectActions(ctx);
  const result = await actions.browse({ path: directory });
  assert.equal(result.home, homedir());
  assert.equal(result.path, directory);
  assert.deepEqual(result.entries.map(e => e.name), ['Alpha', 'Beta']);
  assert.deepEqual((await actions.browse({ path: directory, name: 'ALP' })).entries.map(e => e.name), ['Alpha']);
  await assert.rejects(actions.browse({ path: 'relative' }), /absolute/);
  await assert.rejects(actions.browse({ path: join(directory, 'file.txt') }), /not a directory/);
});

test('GitHub repository validation only permits HTTPS repository identities', () => {
  assert.deepEqual(githubRepository('https://github.com/anywhere-labs/dsh-desktop.git'), { owner: 'anywhere-labs', name: 'dsh-desktop', url: 'https://github.com/anywhere-labs/dsh-desktop.git' });
  for (const url of ['http://github.com/o/r', 'https://evil.com/o/r', 'https://github.com/o/r/tree/main', 'https://token@github.com/o/r', 'https://github.com/o/r?x=y', 'https://github.com/o/..', 'https://github.com/o/%2e%2e', 'https://github.com/o/-rf;echo']) {
    assert.throws(() => githubRepository(url), /GitHub|Invalid/);
  }
});

test('clone uses active profile workspaces and registers a successful checkout without overwriting existing directories', async t => {
  const { directory, ctx, registered } = await fixture(t);
  const calls = [];
  const actions = projectActions(ctx, { runClone: async (url, path) => { calls.push({ url, path }); await mkdir(path); await writeFile(join(path, 'README.md'), 'cloned'); } });
  const result = await actions.clone({ url: 'https://github.com/owner/repo' });
  assert.equal(result.project.path, join(directory, 'workspaces', 'repo'));
  assert.deepEqual(registered, [result.project.path]);
  assert.equal(calls[0].url, 'https://github.com/owner/repo.git');
  assert.equal(await readFile(join(result.project.path, 'README.md'), 'utf8'), 'cloned');
  await assert.rejects(actions.clone({ url: 'https://github.com/another/repo' }), /already exists/);
  assert.equal(calls.length, 1);
  assert.deepEqual(await readdir(join(directory, 'workspaces')), ['repo']);
});

test('clone limits concurrency and cleans failed checkout and staging without touching existing paths', async t => {
  const { directory, ctx, registered } = await fixture(t);
  let release;
  const actions = projectActions(ctx, { runClone: async (_url, path) => { await mkdir(path); await new Promise(resolve => { release = resolve; }); throw new Error('clone fixture failed'); } });
  const pending = actions.clone({ url: 'https://github.com/owner/failed' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(actions.clone({ url: 'https://github.com/owner/another' }), /being cloned/);
  release();
  await assert.rejects(pending, /fixture failed/);
  assert.deepEqual(await readdir(join(directory, 'workspaces')), []);
  assert.deepEqual(registered, []);
});
