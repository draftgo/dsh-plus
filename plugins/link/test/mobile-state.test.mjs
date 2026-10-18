import test from 'node:test';
import assert from 'node:assert/strict';
import { recentSessions, sessionGroups, defaultProjectId } from '../client/mobile-state.mjs';
import { createPreviewRuntime } from '../client/preview.mjs';

const projects = [
  { id: 'code', name: 'Dowork', path: '~/Workspace/Dowork' },
  { id: 'notes', name: '灵感笔记', path: '~/Personal/Notes' },
];

test('recent sessions span projects, use numeric and ISO timestamps, and keep missing dates stable', () => {
  const sessions = [
    { id: 'missing-a', projectId: 'code' },
    { id: 'older', projectId: 'code', updatedAt: 1_700_000_000_000 },
    { id: 'newest', projectId: 'notes', updatedAt: '2025-01-01T10:00:00.000Z' },
    { id: 'missing-b', projectId: 'notes', updatedAt: 'invalid' },
    { id: 'same-time', projectId: 'code', updatedAt: '1735725600000' },
    { id: 'created-fallback', projectId: 'notes', updatedAt: 'invalid', createdAt: '2024-01-01T10:00:00.000Z' },
  ];
  const snapshot = structuredClone({ sessions, projects });
  const result = recentSessions(sessions, projects);
  assert.deepEqual(result.map(item => item.id), ['newest', 'same-time', 'created-fallback', 'older', 'missing-a', 'missing-b']);
  assert.notEqual(result, sessions);
  assert.equal(result[0], sessions[2]);
  assert.deepEqual({ sessions, projects }, snapshot);
});

test('recent search matches session title and project name or path without selecting a project', () => {
  const sessions = [
    { id: 'code-session', projectId: 'code', title: '修复连接', updatedAt: 10 },
    { id: 'notes-session', projectId: 'notes', title: '记录灵感', updatedAt: 20 },
    { id: 'orphan', projectId: 'removed', title: 'Archive', updatedAt: 30 },
  ];
  for (const query of ['  dowork ', '~/WORKSPACE/', '连接']) assert.deepEqual(recentSessions(sessions, projects, query).map(item => item.id), ['code-session']);
  for (const query of ['灵感笔记', '/personal/notes']) assert.deepEqual(recentSessions(sessions, projects, query).map(item => item.id), ['notes-session']);
  assert.equal(recentSessions(sessions, projects, 'ARCHIVE')[0].id, 'orphan');
  assert.deepEqual(recentSessions(sessions, projects, '不存在'), []);
  assert.equal(recentSessions(sessions, projects, ' ').length, 3);
  assert.deepEqual(recentSessions(), []);
});

test('session groups use local calendar boundaries, descending order and only nonempty groups', () => {
  const today = new Date(2026, 9, 17, 0, 0, 0, 0);
  const at = (days, hours = 12) => new Date(2026, 9, 17 + days, hours).getTime();
  const sessions = [
    { id: 'old', updatedAt: at(-8) },
    { id: 'week-boundary', updatedAt: at(-7, 0) },
    { id: 'today-boundary', updatedAt: today.getTime() },
    { id: 'no-time', updatedAt: null },
    { id: 'yesterday', createdAt: at(-1) },
    { id: 'today-later', updatedAt: at(0, 10) },
    { id: 'this-week', updatedAt: at(-2) },
  ];
  assert.deepEqual(sessionGroups(sessions, at(0)), [
    { label: '今天', items: [sessions[5], sessions[2]] },
    { label: '昨天', items: [sessions[4]] },
    { label: '过去7天', items: [sessions[6], sessions[1]] },
    { label: '更早', items: [sessions[0]] },
    { label: '未标注时间', items: [sessions[3]] },
  ]);
  assert.deepEqual(sessionGroups([], at(0)), []);
  assert.deepEqual(sessionGroups([sessions[3]], at(0)), [{ label: '未标注时间', items: [sessions[3]] }]);
});

test('default project honors valid preference, then latest existing project, then first project', () => {
  const sessions = [
    { id: 'deleted', projectId: 'removed', updatedAt: 30 },
    { id: 'recent', projectId: 'notes', updatedAt: 20 },
    { id: 'old', projectId: 'code', updatedAt: 10 },
  ];
  assert.equal(defaultProjectId(projects, sessions, 'code'), 'code');
  assert.equal(defaultProjectId(projects, sessions, 'missing'), 'notes');
  assert.equal(defaultProjectId(projects, sessions), 'notes');
  assert.equal(defaultProjectId(projects, [sessions[0]]), 'code');
  assert.equal(defaultProjectId(projects, []), 'code');
  assert.equal(defaultProjectId([], sessions, 'notes'), '');
  assert.equal(defaultProjectId(), '');
});

test('preview provides cross project recent, running and historical fixtures without network access', async () => {
  const runtime = createPreviewRuntime(); runtime.enterWorkspace();
  const state = await runtime.call('state');
  for (const id of ['preview-design', 'preview-readme', 'preview-ideas']) assert.ok(state.sessions.some(session => session.id === id));
  assert.equal(new Set(state.sessions.map(session => session.projectId)).size, 2);
  assert.ok(state.sessions.every(session => typeof session.updatedAt === 'number'));
  const labels = sessionGroups(state.sessions).map(group => group.label);
  for (const label of ['今天', '昨天', '更早']) assert.ok(labels.includes(label), label);
  const active = state.sessions.find(session => session.running);
  assert.ok(active);
  assert.equal((await runtime.call('history', { id: active.id })).running, true);
  await runtime.call('cancel', { id: active.id });
  assert.equal((await runtime.call('history', { id: active.id })).running, false);
  assert.equal((await runtime.call('state')).sessions.find(session => session.id === active.id).running, false);
});

test('preview create and send update recent timestamps, while retried sends stay idempotent', async () => {
  const runtime = createPreviewRuntime(); runtime.enterWorkspace();
  const state = await runtime.call('state');
  const beforeCreate = Date.now();
  const created = await runtime.call('create', { projectId: 'preview-dowork', requestId: 'create-recent' });
  assert.ok(created.createdAt >= beforeCreate);
  assert.equal(created.updatedAt, created.createdAt);
  assert.deepEqual(await runtime.call('create', { projectId: 'preview-dowork', requestId: 'create-recent' }), created);
  const previous = state.sessions.find(session => session.id === 'preview-readme');
  const message = { id: previous.id, text: '继续整理说明', requestId: 'send-recent' };
  await runtime.call('send', message);
  const after = await runtime.call('state');
  const updated = after.sessions.find(session => session.id === previous.id);
  assert.ok(updated.updatedAt > previous.updatedAt);
  assert.equal(recentSessions(after.sessions, after.projects)[0].id, previous.id);
  await runtime.call('send', message);
  assert.equal((await runtime.call('state')).sessions.find(session => session.id === previous.id).updatedAt, updated.updatedAt);
  assert.equal((await runtime.call('history', { id: previous.id })).messages.length, 4);
});
