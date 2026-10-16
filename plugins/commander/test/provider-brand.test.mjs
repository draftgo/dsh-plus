import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providerBrand, providerInitial } from '../client/provider-brand.mjs';
import { providersForTool } from '../client/model-picker-state.mjs';
const catalog = JSON.parse(readFileSync(new URL('../client/assets/provider-brands/catalog.json', import.meta.url)));
test('registered providers resolve local brand marks while custom routes retain initials', () => {
  assert.equal(providerBrand('deepseek'), 'deepseek');
  assert.equal(providerBrand('deepseek-account'), 'deepseek');
  assert.equal(providerBrand('deepseek-official', true), 'deepseek');
  assert.equal(providerBrand('claude'), 'anthropic');
  assert.equal(providerBrand('google-generative-ai'), 'google');
  assert.equal(providerBrand('routergo'), null);
  assert.equal(providerBrand('my-deepseek-proxy'), null);
  assert.equal(providerBrand('deepseek', true), null);
  assert.equal(providerInitial('RouterGo'), 'R');
  assert.equal(providerInitial('我的供应商'), '我');
  assert.equal(providerInitial('🚀 API'), '🚀');
  for (const brand of Object.keys(catalog)) {
    assert.equal(providerBrand(brand), brand);
    assert.match(catalog[brand], /^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(catalog[brand].split(',')[1], 'base64').toString();
    assert.match(svg, /<svg/); assert.doesNotMatch(svg, /<script|<foreignObject|https?:\/\/(?!www\.w3\.org)/i);
  }
  assert.match(Buffer.from(catalog.deepseek.split(',')[1], 'base64').toString(), /#4D6BFE/);
});
test('custom route identity stays custom in both builtin and delegated supplier views', () => {
  const groups = [{ id: 'deepseek', name: 'My API', models: [{ id: 'model' }] }, { id: 'commander-codex', name: 'Codex', models: [{ id: 'opaque' }] }];
  const data = { providers: [{ id: 'deepseek', name: 'My API', declared: true }], routes: [{ tool: 'codex', providerId: 'deepseek', providerName: 'My API', modelId: 'opaque', nativeModelId: 'model' }] };
  for (const tool of ['deepseek', 'codex']) assert.equal(providersForTool(groups, data, tool)[0].declared, true);
});
