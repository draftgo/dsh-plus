import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Commander } from '../src/runtime.mjs';

// No model request is submitted unless COMMANDER_LIVE=1 is explicitly set.
for (const provider of (process.env.COMMANDER_NATIVE_PROVIDERS ?? 'codex').split(',')) {
  test(`real ${provider}: native handshake${process.env.COMMANDER_LIVE === '1' ? ', multi-turn and restore' : ''}`, { timeout: 300_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `commander-native-${provider}-`));
    const config = { dataDir: join(directory, 'state'), providers: {} };
    if (process.env.COMMANDER_HTTP_PROXY) config.providers[provider] = { env: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(key => [key, process.env.COMMANDER_HTTP_PROXY])) };
    let commander = await new Commander(config).open();
    try {
      const session = await commander.create({ provider, cwd: directory });
      assert.equal(session.status, 'idle');
      if (process.env.COMMANDER_LIVE === '1') {
        await commander.submit(session.id, 'Reply with exactly COMMANDER_OK. Do not call any tools.', { requestId: 'first' });
        let result = await commander.wait(session.id, { timeout: 60_000 });
        if (result.status === 'running') result = await commander.wait(session.id, { timeout: 60_000 });
        assert.equal(result.status, 'idle', JSON.stringify(commander.events(session.id)));
        const text = commander.events(session.id).events.filter(e => e.type === 'text.delta').map(e => e.data.text).join('');
        assert.match(text, /COMMANDER_OK/);
        const nativeId = result.nativeId; assert.ok(nativeId);
        await commander.close(); commander = await new Commander(config).open();
        await commander.connect(session.id);
        assert.equal(commander.snapshot(session.id).nativeId, nativeId);
        const cursor = commander.snapshot(session.id).cursor;
        await commander.submit(session.id, 'What exact token did you just reply with? Reply only that token. Do not call tools.', { requestId: 'second' });
        result = await commander.wait(session.id, { timeout: 60_000 });
        if (result.status === 'running') result = await commander.wait(session.id, { timeout: 60_000 });
        assert.equal(result.status, 'idle', JSON.stringify(commander.events(session.id)));
        const after = commander.events(session.id, cursor).events.filter(e => e.type === 'text.delta').map(e => e.data.text).join('');
        assert.match(after, /COMMANDER_OK/);
        if (provider === 'pi' && process.env.COMMANDER_LIVE_TOOLS === '1') {
          let approved = false;
          commander.on('event', event => {
            if (event.type !== 'approval.requested') return;
            let input;
            try { input = JSON.parse(event.data.details.message); } catch {}
            const allow = event.data.details.title === 'Commander: bash' && input?.input?.command === 'printf COMMANDER_TOOL_OK';
            if (allow) approved = true;
            commander.approve(event.sessionId, event.data.id, { allow });
          });
          await commander.submit(session.id, 'Use the bash tool to execute exactly this command: printf COMMANDER_TOOL_OK . Then report its output. Do not use other tools.', { requestId: 'permission-test' });
          const done = await commander.wait(session.id, { timeout: 60_000 });
          assert.equal(done.status, 'idle'); assert.equal(approved, true, 'Pi tool must pass through Commander human approval bridge');
        }
      }
    } finally { await commander.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
