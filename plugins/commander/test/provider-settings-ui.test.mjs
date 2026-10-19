import { readJsonResponse } from '../client/http-response.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');
const source = readFileSync(new URL('../client/provider-settings.jsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
async function setup({ failSave = false, providerAccess = [] } = {}) {
  const values = [], effects = [], calls = []; let cursor = 0, mounted = false;
  const react = { useState: initial => { const id = cursor++; if (!(id in values)) values[id] = typeof initial === 'function' ? initial() : initial; return [values[id], value => { values[id] = typeof value === 'function' ? value(values[id]) : value; }]; }, useEffect: effect => { if (!mounted) effects.push(effect); } };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, URL, AbortController, document: { baseURI: 'https://example.test/' }, fetch: async (_, request) => { const body = JSON.parse(request.body); calls.push(body); return new Response(JSON.stringify(body.action === 'catalog' ? { tools: [{ id: 'codex', name: 'Codex', configSupported: true }, { id: 'pi', name: 'PI', configSupported: true }], providerAccess, bindings: { routergo: ['harness', 'codex'] } } : failSave ? { error: 'retry later' } : { bindings: { routergo: body.tools } }), { status: failSave && body.action === 'setBindings' ? 500 : 200 }); }, require: id => id === './http-response.mjs' ? { readJsonResponse } : id === 'react' ? react : id.includes('ModelsSection') ? { ModelsSection() {} } : id.includes('ui-primitives') ? {} : id.includes('iconsax') ? {} : { default: '' } });
  const render = (id = 'routergo') => { cursor = 0; const result = module.exports.useProviderHarness(id); mounted = true; return result; };
  render(); for (const effect of effects) effect(); await new Promise(resolve => setTimeout(resolve, 0));
  return { render, calls };
}
test('supplier applicability stays draft until official save and unchanged form does not write', async () => {
  const h = await setup(); let draft = h.render();
  assert.deepEqual([...draft.current], ['harness', 'codex']);
  await draft.save(); assert.equal(h.calls.length, 1);
  draft.toggle('pi'); assert.equal(h.calls.length, 1);
  draft = h.render(); await draft.save();
  assert.deepEqual(h.calls[1], { action: 'setBindings', providerId: 'routergo', tools: ['harness', 'codex', 'pi'] });
  assert.deepEqual([...h.render().current], ['harness', 'codex', 'pi']);
});
test('binding failure keeps draft for retry and reports official provider already saved', async () => {
  const h = await setup({ failSave: true }); h.render().toggle('pi');
  await assert.rejects(h.render().save(), /供应商已保存；Harness 适用范围保存失败/);
  assert.deepEqual([...h.render().current], ['harness', 'codex', 'pi']);
});
test('subscription supplier exposes only its matching tool and cannot draft other bindings', async () => {
  const h = await setup({ providerAccess: [{ id: 'openai-codex', authMode: 'subscription', configured: true, harnessTools: ['codex'] }] });
  const draft = h.render('openai-codex');
  assert.equal(draft.restricted, true); assert.deepEqual([...draft.current], ['codex']);
  draft.toggle('pi'); draft.toggle('harness'); draft.toggle('codex');
  assert.deepEqual([...h.render('openai-codex').current], ['codex']);
  await h.render('openai-codex').save(); assert.equal(h.calls.length, 1);
  assert.equal(h.render('routergo').restricted, false);
});
test('provider editors present supported tools as accessible brand controls', () => {
  assert(source.includes('ToolBrandIcon')); assert(source.includes('aria-label={tool.name'));
  const css = readFileSync(new URL('../client/provider-settings.css', import.meta.url), 'utf8');
  assert(css.includes('[data-commander-provider-editor=true]'));
  assert(css.includes('.cmd-provider-harness-options>button:focus-visible'));
  assert(css.includes('prefers-reduced-motion'));
});
test('tool settings display applied metadata and no separate applicability manager', () => {
  const text = readFileSync(new URL('../client/tool-settings.jsx', import.meta.url), 'utf8');
  assert(text.includes('profileFor(data?.defaults, selected)'));
  assert(text.includes('新会话默认')); assert(text.includes("request('setDefault'"));
  assert(!text.includes('bindingProvider')); assert(!text.includes('setBindings'));
});
