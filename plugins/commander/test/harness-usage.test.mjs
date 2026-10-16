import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessUsage, singleRequestUsage } from '../src/harness-usage.mjs';

test('Codex inclusive input becomes official disjoint input without double counting', () => {
  assert.deepEqual(harnessUsage('codex', { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, totalTokens: 120, reasoningOutputTokens: 5 }), { inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, totalTokens: 120, reasoningTokens: 5 });
  assert.equal(harnessUsage('codex', { inputTokens: 100, outputTokens: 20 }), undefined);
  assert.equal(harnessUsage('codex', { inputTokens: 20, cachedInputTokens: 30, outputTokens: 10 }), undefined);
});

test('Claude, Pi and OpenCode preserve disjoint cache buckets and unknown fields', () => {
  assert.deepEqual(harnessUsage('claude', { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 80, cache_creation_input_tokens: 6 }), { inputTokens: 10, outputTokens: 4, cacheReadTokens: 80, cacheWriteTokens: 6 });
  assert.deepEqual(harnessUsage('pi', { input: 10, output: 4, cacheRead: 80, cacheWrite: 6, totalTokens: 100 }), { inputTokens: 10, outputTokens: 4, cacheReadTokens: 80, cacheWriteTokens: 6, totalTokens: 100 });
  assert.deepEqual(harnessUsage('opencode', { input: 10, output: 4, cache: { read: 80, write: 6 } }), { inputTokens: 10, outputTokens: 4, cacheReadTokens: 80, cacheWriteTokens: 6 });
  assert.equal(harnessUsage('pi', { input: 10 }), undefined);
});

test('multiple or unidentifiable native requests never masquerade as one context', () => {
  const sample = { usage: { input: 10, output: 4 } };
  assert.deepEqual(singleRequestUsage('pi', new Map([['one', sample]])), { inputTokens: 10, outputTokens: 4 });
  assert.equal(singleRequestUsage('pi', new Map([['one', sample], ['two', sample]])), undefined);
  assert.equal(singleRequestUsage('pi', new Map([['unidentified:1', sample]])), undefined);
});
