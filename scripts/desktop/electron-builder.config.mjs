import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElectronBuilderConfig } from '../../deepseek-harness/apps/desktop/scripts/electron-builder-config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../../plugins/commander/package.json', import.meta.url))).version;
// The official factory requires policy metadata. Plus previews intentionally omit that
// optional application metadata and carry no upstream update or policy endpoint.
const config = createElectronBuilderConfig({
  ...process.env, DSH_DESKTOP_APP_ID: 'cn.draftgo.dshplus', DSH_DESKTOP_UNSIGNED: '1',
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://localhost',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{}', DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
});
delete config.extraMetadata.dshMandatoryUpdatePolicy;
config.extraMetadata.name = 'dsh-plus-desktop';
config.extraMetadata.version = version;
config.extraMetadata.description = 'DeepSeek Harness with DSH-Plus, Voice and Link';
config.productName = 'DSH-Plus';
config.executableName = 'DSH-Plus';
config.artifactName = `dsh-plus-${version}-win-x64-setup.exe`;
config.directories.output = `${root}/artifacts/windows`;
// A physical runtime also lets installation initialize a profile entirely offline.
config.asarUnpack.push('**/dsh/**/*');
config.extraResources.push({ from: `${root}/scripts/desktop/plugin-bundle.mjs`, to: 'dsh-plus/plugin-bundle.mjs' });
config.nsis.include = `${root}/.local/desktop/installer-plus.nsh`;
export default config;
