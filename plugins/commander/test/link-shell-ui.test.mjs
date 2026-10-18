import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { shellUi } from '../scripts/shell-ui.mjs';

test('remote connection settings uses the bundled Link icon without changing upstream', async () => {
  const path = fileURLToPath(new URL('../../../deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx', import.meta.url));
  const before = await readFile(path, 'utf8'), handlers = [];
  shellUi().setup({ onLoad(match, callback) { handlers.push({ ...match, callback }); } });
  const handler = handlers.find(item => item.filter.test(path));
  const { contents } = await handler.callback({ path });
  assert(contents.includes('if (id === "link") return <span className={css.navIcon}'));
  const catalog = JSON.parse(await readFile(new URL('../client/assets/iconsax/catalog.json', import.meta.url), 'utf8'));
  assert(contents.includes(JSON.stringify(catalog.link.linear.replace('<svg ', '<svg aria-hidden="true" ').replaceAll('width="24"', 'width="16"').replaceAll('height="24"', 'height="16"'))));
  assert.equal(await readFile(path, 'utf8'), before);
});
