import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import config from './electron-builder.config.mjs';

test('external seed explicitly includes root node_modules with the official packaging convention', () => {
  const seed = config.extraResources.find(item => item.to === 'dsh-plus/seed');
  const modules = config.extraResources.find(item => item.to === 'dsh-plus/seed/node_modules');
  assert.ok(seed);
  assert.equal(modules.from, `${seed.from}/node_modules`);
  assert.deepEqual(modules.filter, ['**/*']);
  assert.equal(typeof config.afterPack, 'function');
});

test('application version stays independent of plugin-only releases', async () => {
  const app = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  assert.equal(config.extraMetadata.version, app.version);
  assert.equal(config.artifactName, `xiaojiao-${app.version}-win-x64-setup.exe`);
});


test('小角 display naming preserves installed application identity and update channel', () => {
  assert.equal(config.productName, '小角');
  assert.equal(config.executableName, '小角');
  assert.equal(config.nsis.shortcutName, '小角');
  assert.equal(config.nsis.uninstallDisplayName, '小角 ${version}');
  assert.equal(config.appId, 'cn.draftgo.dshplus');
  assert.equal(config.extraMetadata.name, 'dsh-plus-desktop');
  assert.equal(config.extraMetadata.dshDesktopUpdateChannel, 'latest');
  assert.deepEqual(config.protocols[0].schemes, ['dsh']);
  assert.match(config.publish[0].url, /releases\/download\/app-updates\/$/);
});

test('legacy shortcut cleanup is limited to the original registered brand after successful bootstrap', async () => {
  const source = await readFile(new URL('./package-windows.mjs', import.meta.url), 'utf8');
  const literal = source.match(/const bootstrap = ([\s\S]+?);\nawait mkdir/)[1];
  const overlay = runInNewContext(literal);
  assert.match(overlay, /!ifndef BUILD_UNINSTALLER\nVar dshPreviousInstallLocation\nVar dshPreviousShortcutName\n!endif/);
  assert.match(overlay, /ReadRegStr \$dshPreviousInstallLocation HKCU "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"/);
  assert.match(overlay, /ReadRegStr \$dshPreviousShortcutName HKCU "\$\{INSTALL_REGISTRY_KEY\}" "ShortcutName"/);
  assert.ok(overlay.indexOf('ReadRegStr $dshPreviousShortcutName') < overlay.indexOf('!insertmacro dshOfficialCustomInit'));
  assert.match(overlay, /\$\{If\} \$dshPreviousInstallLocation == \$INSTDIR\n  \$\{AndIf\} \$dshPreviousShortcutName == "DSH-Plus"/);
  const deletions = [...overlay.matchAll(/Delete "([^"]+)"/g)].map(item => item[1]);
  assert.deepEqual(deletions, ['$SMPROGRAMS\\DSH-Plus.lnk', '$DESKTOP\\DSH-Plus.lnk']);
  assert.ok(overlay.indexOf('Delete ') > overlay.indexOf('SetErrorLevel 2\n    Quit\n  ${EndIf}'));
  const upstream = await readFile(new URL('../../deepseek-harness/apps/desktop/scripts/installer.nsh', import.meta.url), 'utf8');
  for (const hook of ['customInit', 'customInstall']) assert.equal(upstream.replaceAll('\r\n', '\n').split('!macro ' + hook + '\n').length, 2);
});
