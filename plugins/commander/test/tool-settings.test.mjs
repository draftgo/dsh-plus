import test from 'node:test';
import assert from 'node:assert/strict';
import { activeJob, toolState, parseOverrides, profileDraft, eligibleProviders, previewChecksums, setQuickSetting, nextToolTab, nativeOnlyDraft } from '../client/tool-settings-state.mjs';
import { quickSettingsFor, validateQuickSettings } from '../shared/tool-quick-settings.mjs';
test('tool management separates configuration support, native sessions and install ownership', () => {
  assert.deepEqual(toolState({ installed: true, source: 'external', configSupported: true, chatSupported: false, canUninstall: false }), { installed: true, installation: '外部安装', configSupported: true, chatSupported: false, canInstall: false, canUpdate: false, canReinstall: false, canUninstall: false });
  assert.equal(toolState({ canInstall: true, job: { status: 'running' } }).canInstall, false);
  assert.equal(toolState({ chatSupported: true }, { sessionSupported: false }).chatSupported, false);
  assert.equal(activeJob({ status: 'queued' }), true); assert.equal(activeJob({ status: 'succeeded' }), false);
  for (const key of ['canInstall', 'canUpdate', 'canReinstall', 'canUninstall']) {
    assert.equal(toolState({ [key]: true })[key], true);
    assert.equal(toolState({ [key]: true, job: { status: 'running' } })[key], false);
  }
});
test('advanced overrides reject secrets and unsafe JSON without echoing values', () => {
  assert.deepEqual(parseOverrides('{"config":{"timeout":120,"max_tokens":1024,"context_tokens":8192}}'), { config: { timeout: 120, max_tokens: 1024, context_tokens: 8192 } });
  for (const value of ['[]', 'null', '{', '{"unknown":{}}', '{"env":{"API_KEY":"never-print"}}', '{"auth":{"access_token":"never-print"}}', '{"config":{"__proto__":{}}}']) {
    assert.throws(() => parseOverrides(value), error => !error.message.includes('never-print'));
  }
});
test('profiles reference providers, apply uses preview checksums, provider tags filter without duplicating credentials', () => {
  assert.deepEqual(profileDraft(null), { providerId: '', model: '', protocol: '', overrides: '{}', quickSettings: {}, revision: undefined });
  assert.equal(profileDraft({ providerId: 'shared', model: 'm', revision: 2 }).revision, 2);
  const providers = [{ id: 'implicit' }, { id: 'all' }, { id: 'one' }, { id: 'other' }];
  assert.deepEqual(eligibleProviders(providers, { all: [], one: ['codex'], other: ['pi'] }, 'codex').map(p => p.id), ['implicit', 'one']);
  assert.deepEqual(previewChecksums({ files: [{ path: '/one', checksum: 'abc' }, { path: '/new', checksum: null }] }), { '/one': 'abc', '/new': null });
});
test('subscription providers only appear for their entitled Harness', () => {
  const providers = [{ id: 'api' }, { id: 'oauth', authMode: 'subscription', harnessTools: ['codex'] }];
  assert.deepEqual(eligibleProviders(providers, {}, 'claude').map(item => item.id), ['api']);
  assert.deepEqual(eligibleProviders(providers, {}, 'codex').map(item => item.id), ['api', 'oauth']);
  assert.deepEqual(eligibleProviders([{ id: 'oauth' }], {}, 'claude', [{ id: 'oauth', authMode: 'subscription', harnessTools: ['codex'] }]), []);
  assert.deepEqual(eligibleProviders(providers, { oauth: [] }, 'codex').map(item => item.id), ['api']);
});
test('quick settings retain explicit false and can return to tool defaults', () => {
  const source = { multiAgent: true, agentThreads: 4 }, draft = profileDraft({ quickSettings: source });
  const next = setQuickSetting(draft.quickSettings, 'multiAgent', false);
  assert.equal(source.multiAgent, true);
  assert.deepEqual(validateQuickSettings('codex', next), { multiAgent: false, agentThreads: 4 });
  assert.deepEqual(setQuickSetting(next, 'multiAgent', undefined), { agentThreads: 4 });
  assert.deepEqual(setQuickSetting(next, 'multiAgent', ''), { agentThreads: 4 });
  assert.ok(quickSettingsFor('claude').some(field => field.key === 'agentWindow'));
});
test('icon tabs support wrapping arrow navigation and Home/End', () => {
  const tools = [{ id: 'claude' }, { id: 'codex' }, { id: 'pi' }];
  assert.equal(nextToolTab(tools, 'claude', 'ArrowLeft'), 'pi');
  assert.equal(nextToolTab(tools, 'pi', 'ArrowRight'), 'claude');
  assert.equal(nextToolTab(tools, 'codex', 'ArrowUp'), 'claude');
  assert.equal(nextToolTab(tools, 'codex', 'ArrowDown'), 'pi');
  assert.equal(nextToolTab(tools, 'codex', 'Home'), 'claude');
  assert.equal(nextToolTab(tools, 'codex', 'End'), 'pi');
  assert.equal(nextToolTab([], 'codex', 'ArrowRight'), 'codex');
});
test('advanced JSON stays out of isolated session defaults', () => {
  assert.equal(nativeOnlyDraft({ routeSupported: true }, '{}'), false);
  assert.equal(nativeOnlyDraft({ routeSupported: true }, '{ "settings": {} }'), true);
  assert.equal(nativeOnlyDraft({ routeSupported: false }, '{}'), true);
  assert.equal(nativeOnlyDraft({ routeSupported: true }, '{'), true);
});
