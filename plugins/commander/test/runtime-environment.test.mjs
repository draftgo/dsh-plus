import test from 'node:test';
import assert from 'node:assert/strict';
import { Commander } from '../src/runtime.mjs';

test('managed runtime PATH reaches Codex sessions without replacing configured environment', async () => {
  const commander = new Commander({ providers: { codex: { env: { KEEP: 'yes' } } } });
  commander.toolInstaller = { resolveLaunch: async () => ({ command: '/managed/codex', args: [], env: { PATH: '/managed/node:/usr/bin' } }) };
  const config = await commander.providerConfig('codex');
  assert.equal(config.env.PATH, '/managed/node:/usr/bin');
  assert.equal(config.env.KEEP, 'yes');
  assert.equal(commander.providers.get('codex').config.env.PATH, undefined);
  commander.providers.get('codex').config.command = '/custom/codex';
  assert.equal((await commander.providerConfig('codex')).env.PATH, undefined);
});
