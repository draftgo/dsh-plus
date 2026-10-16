import test from 'node:test';
import assert from 'node:assert/strict';
import { askNativeQuestion } from '../src/questions.mjs';

test('human answers preserve Codex IDs, OpenCode order and Claude question keys', async () => {
  const details = { questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
  const ask = async ({ questions }) => ({ answers: questions.map(q => ({ id: q.id, selected: ['B'], custom: 'extra' })) });
  assert.deepEqual(await askNativeQuestion('codex', { details }, ask), { allow: false, answers: { q1: { answers: ['B', 'extra'] } } });
  assert.deepEqual(await askNativeQuestion('opencode', { details }, ask), { allow: false, answers: [['B', 'extra']] });
  assert.deepEqual(await askNativeQuestion('claude', { details }, ask), { allow: true, answers: { 'Which?': 'B, extra' } });
});

test('Pi choice and text input use actual human values; missing answers are never invented', async () => {
  assert.deepEqual(await askNativeQuestion('pi', { details: { title: 'Choose', options: ['A', 'B'] } }, async () => ({ answers: [{ id: 'value', selected: ['B'] }] })), { allow: false, value: 'B' });
  assert.deepEqual(await askNativeQuestion('pi', { details: { title: 'Input' } }, async () => ({ answers: [{ id: 'value', selected: [], custom: '' }] })), { allow: false, value: '' });
  await assert.rejects(askNativeQuestion('codex', { details: { questions: [{ id: 'q1', question: 'Q' }] } }, async () => ({ answers: [] })), /did not answer/);
});
