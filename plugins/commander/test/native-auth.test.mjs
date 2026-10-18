import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAuth } from '../src/native-auth.mjs';

test('native auth only uses status commands and publishes no account or token output', async () => {
  const calls = [];
  const auth = createNativeAuth({ installer: { resolveLaunch: async tool => ({ command: tool, args: [] }) }, env: { HOME: '/original-home' }, executor: async (command, args, options) => {
    calls.push({ command, args, home: options.env.HOME });
    return command === 'codex' ? { stdout: '', stderr: 'Logged in using ChatGPT' } : { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'private@example.test', token: 'never-publish' }) };
  } });
  const [codex, same, claude] = await Promise.all([auth.status('codex'), auth.status('codex'), auth.status('claude')]);
  assert.equal(calls.length, 2); assert.deepEqual(codex, same);
  assert.equal(codex.status, 'subscription'); assert.equal(claude.status, 'subscription');
  assert.deepEqual(calls[0].args, ['login', 'status']); assert.deepEqual(calls[1].args, ['auth', 'status', '--json']);
  assert.equal(calls.every(call => call.home === '/original-home'), true);
  assert.doesNotMatch(JSON.stringify([codex, claude]), /private|token|never-publish/);
  await auth.status('codex'); assert.equal(calls.length, 2);
});

test('API or ambiguous login output never claims subscription and command errors are sanitized', async () => {
  let output = 'Logged in using an API key: redacted';
  const auth = createNativeAuth({ cacheMs: 0, installer: { resolveLaunch: async () => ({ command: 'codex', args: [] }) }, executor: async () => { if (!output) throw Object.assign(Error('secret'), { code: 1 }); return { stdout: output }; } });
  assert.equal((await auth.status('codex')).status, 'api');
  output = 'unexpected output'; assert.equal((await auth.status('codex')).status, 'unknown');
  output = ''; assert.deepEqual(await auth.status('codex'), { tool: 'codex', status: 'logged-out' });
});
