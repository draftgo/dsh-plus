import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { officialModelsUi } from '../scripts/official-models-ui.mjs';

const upstream = new URL('../../../deepseek-harness/packages/client/ui-settings-models/src/client/', import.meta.url);
const handlers = [];
officialModelsUi().setup({ onLoad(match, callback) { handlers.push({ ...match, callback }); } });
const transform = filename => {
  const path = fileURLToPath(new URL(filename, upstream));
  const handler = handlers.find(item => item.filter.test(path));
  assert(handler, 'expected a build-only adapter for ' + filename);
  return handler.callback({ path });
};

test('provider picker adapts official add flow and leaves upstream file unchanged', async () => {
  const path = new URL('ModelsSection.tsx', upstream);
  const original = await readFile(path, 'utf8');
  const { contents } = await transform('ModelsSection.tsx');
  assert(contents.includes('<ProviderSelect'));
  assert(contents.includes('<ProviderBrandIcon id={row.entry.provider}'));
  assert(contents.includes('declared={row.entry.declared === true}'));
  assert(contents.includes('declared: row.entry.declared === true'));
  assert(!contents.includes('<select\n'));
  assert(contents.includes('setEditing(targetOf(picked.row)); setAddMode("catalog")'));
  assert(contents.includes('preset={providerPreset}'));
  assert(contents.includes('routerAvailable='));
  assert.equal((contents.match(/<ProviderSelect/g) || []).length, 1);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('RouterGo only seeds the official create form and reuses its operations', async () => {
  const { contents } = await transform('CustomProviderCard.tsx');
  for (const field of ['id', 'name', 'baseURL', 'protocol']) assert(contents.includes('props.preset?.' + field));
  assert(contents.includes('operations.storeCredential('));
  assert(contents.includes('operations.writeSettings('));
  assert(!contents.includes('/api/plus/providers'));
});

test('official Models CSS remains a scoped module rather than a text export', async () => {
  const { contents, loader } = await transform('ModelsSection.module.css');
  assert.equal(loader, 'js');
  assert(contents.includes('commander-official-models-style'));
  assert(contents.includes('export default {'));
  assert(contents.includes('"addModes":'));
});

test('Harness applicability is first in the official editor and saves only after official commit', async () => {
  for (const filename of ['ProviderEditor.tsx', 'CustomProviderCard.tsx']) {
    const path = new URL(filename, upstream), original = await readFile(path, 'utf8');
    const { contents } = await transform(filename);
    assert(contents.includes('useProviderHarness('));
    const field = contents.indexOf('<ProviderHarnessField');
    assert(field > 0);
    assert(field < contents.indexOf(filename === 'ProviderEditor.tsx' ? '{props.hideTitle' : "<span className={styles['fieldLabel']}>"));
    assert(contents.indexOf('await harness.save()') < contents.indexOf('props.onClose(true)'));
    assert(contents.includes('catch (error)'));
    if (filename === 'ProviderEditor.tsx') {
      assert(contents.includes('<ProviderBrandIcon id={props.provider}'));
      assert(contents.indexOf('await applyOnce()') < contents.indexOf('await harness.save()'));
      assert(contents.includes('if (props.credentialOnly !== true) await harness.save()'));
      assert(contents.includes('props.credentialOnly === true ? null : <ProviderHarnessField'));
    } else assert(contents.indexOf('await createOnce()') < contents.indexOf('await harness.save()'));
    assert.equal(await readFile(path, 'utf8'), original);
  }
});
