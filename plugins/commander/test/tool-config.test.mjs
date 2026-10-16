import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TOOL_IDS, nativeConfigFiles, parseConfig, renderConfig, toolCapabilities } from '../src/tool-config.mjs';
import { createToolProfiles } from '../src/tool-profiles.mjs';
const secret = 'native-secret-do-not-return', providers = { async resolve(id) { if (id !== 'official') throw Error('missing'); return { baseURL: 'https://example.test/v1', apiKey: secret }; } };
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'tool-config-')); return { dir, service: createToolProfiles({ directory: join(dir, 'state'), providers, home: dir, env: {}, platform: 'linux' }) }; }

test('all ten reference tools receive native formats and keep unknown configuration', async () => {
  const { dir, service } = await setup();
  try {
    for (const tool of TOOL_IDS) {
      for (const spec of nativeConfigFiles(tool, { home: dir, env: {}, platform: 'linux' })) { await mkdir(join(spec.path, '..'), { recursive: true }); await writeFile(spec.path, spec.format === 'yaml' ? '# retained\nfuture: keep\n' : spec.format === 'toml' ? 'future = "keep"\n' : spec.format === 'env' ? '# retained\nFUTURE=keep\n' : '{\n // retained\n "future": "keep",\n}\n'); }
      await service.save({ tool, providerId: 'official', model: 'test-model' });
      const preview = await service.preview({ tool }); assert.ok(preview.files.length); assert.doesNotMatch(JSON.stringify(preview), /native-secret|inferenceGatewayApiKey/);
      const result = await service.apply({ tool, revision: preview.revision, checksums: Object.fromEntries(preview.files.map(x => [x.path, x.checksum])) }); assert.ok(result.backupId);
      for (const spec of nativeConfigFiles(tool, { home: dir, env: {}, platform: 'linux' })) {
        const raw = await readFile(spec.path, 'utf8'); assert.match(raw, /keep/); assert.equal((await stat(spec.path)).mode & 0o777, 0o600);
        if (spec.format !== 'env') assert.equal(parseConfig(raw, spec.format).future, 'keep');
      }
    }
    const list = await service.list(); assert.equal(list.profiles.length, 10); assert.equal(list.backups.length, 10); assert.doesNotMatch(JSON.stringify(list), /native-secret/);
    assert.equal(toolCapabilities().filter(x => x.sessionSupported).length, 8);
    assert.equal((await service.runtime('claude')).env.ANTHROPIC_AUTH_TOKEN, secret);
    assert.doesNotMatch(await readFile(join(dir, 'state', 'tool-profiles.json'), 'utf8'), /native-secret/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('preview checksum protects external edits and restore preserves original bytes', async () => {
  const { dir, service } = await setup();
  try {
    const path = nativeConfigFiles('codex', { home: dir, env: {} })[0].path;
    await mkdir(join(path, '..'), { recursive: true }); const original = '# original\nmodel = "old"\n[unrelated]\nvalue = 3\n'; await writeFile(path, original);
    const saved = await service.save({ tool: 'codex', providerId: 'official', model: 'new' }); const preview = await service.preview({ tool: 'codex' });
    await writeFile(path, original + 'other = true\n'); await assert.rejects(service.apply({ tool: 'codex', checksums: Object.fromEntries(preview.files.map(x => [x.path, x.checksum])) }), { status: 409 });
    await writeFile(path, original); const applied = await service.apply({ tool: 'codex', revision: saved.revision });
    assert.match(await readFile(path, 'utf8'), /new/); await service.restore({ backupId: applied.backupId }); assert.equal(await readFile(path, 'utf8'), original);
    const again = await service.apply({ tool: 'codex' }); await writeFile(path, 'model = "external"\n'); await assert.rejects(service.restore({ backupId: again.backupId }), { status: 409 });
    await assert.rejects(service.save({ tool: 'codex', providerId: 'official', model: 'new', expectedRevision: 'stale' }), { status: 409 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bindings, advanced validation and symlinks prevent unsafe changes', async () => {
  const { dir, service } = await setup();
  try {
    await service.save({ tool: 'claude', providerId: 'official', model: 'test' }); await service.setBindings({ providerId: 'official', tools: ['codex'] });
    await assert.rejects(service.preview({ tool: 'claude' }), { status: 409 });
    for (const overrides of [{ settings: { env: { ANTHROPIC_API_KEY: 'other' } } }, { config: { base_url: 'https://evil.test' } }, JSON.parse('{"__proto__":{"polluted":true}}')]) await assert.rejects(service.save({ tool: 'codex', providerId: 'official', model: 'test', overrides }));
    await service.setBindings({ providerId: 'official', tools: ['claude'] });
    await symlink(join(dir, 'elsewhere'), join(dir, '.claude')); await assert.rejects(service.apply({ tool: 'claude' }), { status: 409 });
    assert.equal({}.polluted, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('format adapters preserve JSONC/YAML comments and dotenv unknown lines', () => {
  const json = renderConfig('{ // note\n"env":{"KEEP":"yes"}}', 'jsonc', { env: { NEW: 'value' } }); assert.match(json, /note/); assert.equal(parseConfig(json, 'jsonc').env.KEEP, 'yes');
  const yaml = renderConfig('# note\nagent:\n  future: yes\n', 'yaml', { model: { default: 'test' } }); assert.match(yaml, /# note/); assert.equal(parseConfig(yaml, 'yaml').agent.future, 'yes');
  const env = renderConfig('# note\nKEEP=abc\nGEMINI_API_KEY=old\n', 'env', { GEMINI_API_KEY: 'new', GEMINI_MODEL: 'model' }); assert.match(env, /KEEP=abc/); assert.match(env, /GEMINI_API_KEY="new"/); assert.doesNotMatch(env, /old/);
  assert.throws(() => renderConfig('model = [', 'toml', { model: 'new' }), { status: 409 });
  const merged = parseConfig(renderConfig('{"models":[{"id":"same","future":1},{"id":"other"}]}', 'jsonc', { models: [{ id: 'same', name: 'updated' }] }), 'jsonc');
  assert.deepEqual(merged.models, [{ id: 'same', future: 1, name: 'updated' }, { id: 'other' }]);
  assert.equal(parseConfig(renderConfig("{future: 'keep',}", 'json5', { model: 'new' }), 'json5').future, 'keep');
});

test('runtime only uses applied snapshots and restores previous active selection', async () => {
  const { dir, service } = await setup();
  try {
    await service.save({ tool: 'claude', providerId: 'official', model: 'first' });
    assert.equal((await service.runtime('claude')).configured, false);
    const first = await service.apply({ tool: 'claude' }); assert.equal((await service.runtime('claude')).model, 'first');
    await service.save({ tool: 'claude', providerId: 'official', model: 'second' }); assert.equal((await service.runtime('claude')).model, 'first');
    const second = await service.apply({ tool: 'claude' }); assert.equal((await service.runtime('claude')).model, 'second');
    await service.restore({ backupId: second.backupId }); assert.equal((await service.runtime('claude')).model, 'first');
    await service.setBindings({ providerId: 'official', tools: ['harness'] }); await assert.rejects(service.runtime('claude'), { status: 409 });
    await service.setBindings({ providerId: 'official', tools: ['claude'] });
    await service.restore({ backupId: first.backupId }); assert.equal((await service.runtime('claude')).configured, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('new session default is plugin-only and leaves native config and history byte-identical', async () => {
 const {dir,service}=await setup();
 try {
  const path=nativeConfigFiles('codex',{home:dir,env:{}})[0].path;
  await mkdir(join(path,'..'),{recursive:true});
  const original='# user config\nmodel = "user-model"\n',historyPath=join(path,'..','history.jsonl'),history='{"user":"original-history"}\n';
  await writeFile(path,original);await writeFile(historyPath,history);
  const saved=await service.save({tool:'codex',providerId:'official',model:'isolated-model'});
  await service.setDefault({tool:'codex',revision:saved.revision});
  const list=await service.list();assert.equal(list.defaults[0].model,'isolated-model');assert.equal(list.applied.length,0);assert.equal(list.backups.length,0);
  assert.equal(await readFile(path,'utf8'),original);assert.equal(await readFile(historyPath,'utf8'),history);
  await assert.rejects(service.setDefault({tool:'codex',revision:'stale'}),{status:409});
 } finally {await rm(dir,{recursive:true,force:true});}
});
