import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationInfo } from '../client/session-info.mjs';

test('copy preserves distinct Harness, Commander and native tool IDs', () => {
  const result = conversationInfo({ id: 'harness-1', provider: 'codex', nativeId: 'commander-1', title: '任务' },
    { id: 'commander-1', provider: 'codex', model: 'gpt-model', nativeId: 'thread-1', ownerSessionId: 'harness-1', parentId: 'delegate-1', events: ['private'], token: 'secret' },
    { id: 'project-1', path: '/work/example' });
  assert.equal(result.harnessSessionId, 'harness-1');
  assert.equal(result.commanderSessionId, 'commander-1');
  assert.equal(result.nativeSessionId, 'thread-1');
  assert.equal(result.tool, 'codex');
  assert.equal(result.model, 'gpt-model');
  assert.equal(result.parentSessionId, 'delegate-1');
  assert.equal(result.projectPath, '/work/example');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!('events' in result));
});

test('legacy and plain DeepSeek rows retain correct identifier meanings', () => {
  const legacy = conversationInfo({ native: true, id: 'commander-pi', provider: 'pi', nativeId: '/profile/session.jsonl', ownerSessionId: 'commander-web:legacy', cwd: '/work/pi' });
  assert.equal(legacy.nativeSessionId, '/profile/session.jsonl');
  assert.equal(legacy.commanderSessionId, 'commander-pi');
  assert.equal(legacy.tool, 'pi');
  const plain = conversationInfo({ id: 'harness-ds', provider: 'deepseek' });
  assert.equal(plain.harnessSessionId, 'harness-ds');
  assert.equal(plain.commanderSessionId, null);
  assert.equal(plain.nativeSessionId, null);
});
