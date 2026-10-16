import test from 'node:test';
import assert from 'node:assert/strict';
import { activeJob, toolState, parseOverrides, profileDraft, eligibleProviders, previewChecksums } from '../client/tool-settings-state.mjs';
test('tool management separates configuration support, native sessions and install ownership', () => {
  assert.deepEqual(toolState({ installed: true, source: 'external', configSupported: true, chatSupported: false, canUninstall: false }), { installed: true, installation: '外部安装', configSupported: true, chatSupported: false, canInstall: false, canUninstall: false });
  assert.equal(toolState({ canInstall: true, job: { status: 'running' } }).canInstall, false);
  assert.equal(toolState({ chatSupported: true }, { sessionSupported: false }).chatSupported, false);
  assert.equal(activeJob({ status: 'queued' }), true); assert.equal(activeJob({ status: 'succeeded' }), false);
});
test('advanced overrides reject secrets and unsafe JSON without echoing values', () => {
  assert.deepEqual(parseOverrides('{"config":{"timeout":120,"max_tokens":1024,"context_tokens":8192}}'), { config: { timeout: 120, max_tokens: 1024, context_tokens: 8192 } });
  for (const value of ['[]', 'null', '{', '{"unknown":{}}', '{"env":{"API_KEY":"never-print"}}', '{"auth":{"access_token":"never-print"}}', '{"config":{"__proto__":{}}}']) {
    assert.throws(() => parseOverrides(value), error => !error.message.includes('never-print'));
  }
});
test('profiles reference providers, apply uses preview checksums, provider tags filter without duplicating credentials', () => {
  assert.deepEqual(profileDraft(null), { providerId: '', model: '', protocol: '', overrides: '{}', revision: undefined });
  assert.equal(profileDraft({ providerId: 'shared', model: 'm', revision: 2 }).revision, 2);
  const providers = [{ id: 'implicit' }, { id: 'all' }, { id: 'one' }, { id: 'other' }];
  assert.deepEqual(eligibleProviders(providers, { all: [], one: ['codex'], other: ['pi'] }, 'codex').map(p => p.id), ['implicit', 'one']);
  assert.deepEqual(previewChecksums({ files: [{ path: '/one', checksum: 'abc' }, { path: '/new', checksum: null }] }), { '/one': 'abc', '/new': null });
});
