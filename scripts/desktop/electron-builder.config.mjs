import { readFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElectronBuilderConfig } from '../../deepseek-harness/apps/desktop/scripts/electron-builder-config.mjs';
import { prepareDesktopBrand } from './prepare-brand.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
// The official factory requires policy metadata. Updates use the application's own feed.
const config = createElectronBuilderConfig({
  ...process.env, DSH_DESKTOP_APP_ID: 'cn.draftgo.dshplus', DSH_DESKTOP_UNSIGNED: '1',
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://localhost',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{}', DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
});
delete config.extraMetadata.dshMandatoryUpdatePolicy;
config.extraMetadata.name = 'dsh-plus-desktop';
config.extraMetadata.version = version;
config.extraMetadata.dshDesktopUpdateChannel = 'latest';
config.extraMetadata.description = 'DeepSeek Harness with DSH-Plus, Voice and Link';
config.productName = 'DSH-Plus';
config.executableName = 'DSH-Plus';
config.protocols = [{ name: 'DSH-Plus', schemes: ['dsh'] }];
config.artifactName = `dsh-plus-${version}-win-x64-setup.exe`;
config.directories.output = `${root}/artifacts/windows`;
const brandOutput = `${root}/.local/desktop/brand`;
const officialBeforeBuild = config.beforeBuild;
config.beforeBuild = async (...args) => {
  const result = await officialBeforeBuild(...args);
  await prepareDesktopBrand(root, brandOutput);
  await copyFile(`${root}/deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/installer-ui/window-frame.dll`, `${brandOutput}/window-frame.dll`);
  return result;
};
config.win.icon = `${root}/assets/brand/dsh-plus-logo.png`;
config.nsis.installerIcon = config.nsis.uninstallerIcon = `${brandOutput}/dsh-plus.ico`;
config.nsis.installerSidebar = config.nsis.uninstallerSidebar = `${brandOutput}/uninstaller-sidebar.bmp`;
config.extraResources = config.extraResources.map(resource => resource.to === 'icon.png'
  ? { from: `${root}/assets/brand/dsh-plus-logo.png`, to: 'icon.png' }
  : resource.to === 'tray.ico' ? { from: `${brandOutput}/dsh-plus.ico`, to: 'tray.ico' } : resource);
// Electron-builder resource mapping keeps the official main process and preload intact.
config.files.push('!renderer/welcome.html',
  { from: `${root}/scripts/desktop/renderer`, to: 'renderer', filter: ['**/*'] },
  { from: `${root}/assets/brand/dsh-plus-logo.png`, to: 'renderer/assets/dsh-plus-logo.png' });
// A physical runtime also lets installation initialize a profile entirely offline.
config.asarUnpack.push('**/dsh/**/*');
config.extraResources.push({ from: `${root}/scripts/desktop/plugin-bundle.mjs`, to: 'dsh-plus/plugin-bundle.mjs' });
config.extraResources.push({ from: `${root}/plugins/commander/shared/plugin-install.mjs`, to: 'dsh-plus/shared/plugin-install.mjs' });
config.extraResources.push({ from: `${root}/plugins/commander/shared/update-feed.mjs`, to: 'dsh-plus/shared/update-feed.mjs' });
config.extraResources.push({ from: `${root}/deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/plus-seed`, to: 'dsh-plus/seed' });
config.publish = [{ provider: 'generic', url: 'https://ghfast.top/https://github.com/draftgo/dsh-plus/releases/download/app-updates/', channel: 'latest' }];
config.nsis.include = `${root}/.local/desktop/installer-plus.nsh`;
export default config;
