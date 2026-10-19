import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareInstallerSources } from './prepare-brand.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('DSH-Plus Windows packaging requires a native Windows x64 build host. Use the Windows installer workflow.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const engine = join(root, 'deepseek-harness');
const desktop = join(engine, 'apps/desktop');
const target = join(desktop, '.desktop-build/targets/win-x64');
const pnpm = join(desktop, 'node_modules/pnpm/bin/pnpm.cjs');
const env = { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_DESKTOP_APP_ID: 'cn.draftgo.dshplus', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_7Z_FILTER: 'BCJ' };
for (const key of Object.keys(env)) if (/^(?:DSH_DESKTOP_WINDOWS_|(?:WIN_)?CSC_(?!IDENTITY_AUTO_DISCOVERY)|APPLE_)/.test(key)) delete env[key];
function run(args, cwd = engine) {
  console.log(`\n[Plus packaging] ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Packaging failed (${signal ?? code}): ${args.join(' ')}`)));
  });
}
const pm = (args, cwd) => run([pnpm, ...args], cwd);
await pm(['run', 'build:official']);
await pm(['run', 'release:pack', '--family', 'dsh', '--out', join(target, 'packed/dsh')]);
await pm(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', join(target, 'packed/dsh')]);
await pm(['run', 'release:pack', '--family', 'vendor', '--out', join(target, 'packed/vendor')]);
await mkdir(join(target, 'packed/landlock'), { recursive: true });
await pm(['--dir', 'native/system', 'run', 'build:ts']);
await pm(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(target, 'packed/landlock')]);
await pm(['run', 'prepare:runtime'], desktop);
await pm(['run', 'prepare:packages'], desktop);
await pm(['run', 'prepare:dsh'], desktop);
await rm(join(target, 'plus-seed'), { recursive: true, force: true });
await run([join(root, 'scripts/desktop/plugin-bundle.mjs'), 'stage', '--runtime', join(target, 'dsh'), '--output', join(target, 'plus-seed')], root);
await pm(['exec', 'tsx', join(root, 'scripts/desktop/seal-runtime.mjs'), join(target, 'dsh')], desktop);

const installerSources = join(root, '.local/desktop/installer');
await prepareInstallerSources(root, installerSources);
const include = (await readFile(join(desktop, 'scripts/installer.nsh'), 'utf8')).replaceAll('\r\n', '\n').replaceAll('${__FILEDIR__}', join(desktop, 'scripts')).replace('!define INSTALLER_SOURCE_DIR', '!define /ifndef INSTALLER_SOURCE_DIR');
if (include.split('!macro customInstall\n').length !== 2) throw new Error('Official installer changed: customInstall hook must be reviewed');
if (include.split('!macro customInit\n').length !== 2) throw new Error('Official installer changed: customInit hook must be reviewed');
const bootstrap = `
!ifndef BUILD_UNINSTALLER
Var dshPreviousInstallLocation
Var dshPreviousShortcutName
!endif

!macro customInit
  ReadRegStr $dshPreviousInstallLocation HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $dshPreviousShortcutName HKCU "\${INSTALL_REGISTRY_KEY}" "ShortcutName"
  !insertmacro dshOfficialCustomInit
!macroend

!macro customInstall
  !insertmacro dshOfficialCustomInstall
  Push $R0
  Push $R1
  Push $R2
  Push $0
  Push $1
  ReadEnvStr $R2 ELECTRON_RUN_AS_NODE
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i("ELECTRON_RUN_AS_NODE", "1").r0'
  nsExec::ExecToStack '"$INSTDIR\\小角.exe" --expose-internals "$INSTDIR\\resources\\dsh-plus\\plugin-bundle.mjs" init-profile --resources "$INSTDIR\\resources" --runtime "$INSTDIR\\resources\\app.asar.unpacked\\dsh"'
  Pop $R0
  Pop $R1
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i("ELECTRON_RUN_AS_NODE", "$R2").r1'
  \${If} $R0 != 0
    MessageBox MB_OK|MB_ICONSTOP "小角初始化失败。请关闭小角后重新运行安装程序。$\\r$\\n$R1" /SD IDOK
    SetErrorLevel 2
    Quit
  \${EndIf}
  ; Only remove the old brand's links when upgrading its registered installation.
  \${If} $dshPreviousInstallLocation == $INSTDIR
  \${AndIf} $dshPreviousShortcutName == "DSH-Plus"
    Delete "$SMPROGRAMS\\DSH-Plus.lnk"
    Delete "$DESKTOP\\DSH-Plus.lnk"
  \${EndIf}
  Pop $1
  Pop $0
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
`;
await mkdir(join(root, '.local/desktop'), { recursive: true });
// Includes in the official text are relative to its original directory.
await writeFile(join(root, '.local/desktop/installer-plus.nsh'), `!addincludedir "${join(desktop, 'scripts')}"\n!define INSTALLER_SOURCE_DIR "${installerSources}"\n!define INSTALLER_BUILD_DIR "${join(root, '.local/desktop/brand')}"\n!define INSTALLER_STRINGS_FILE "${join(root, '.local/desktop/brand/strings-plus.nsh')}"\n${include.replace('!macro customInit\n', '!macro dshOfficialCustomInit\n').replace('!macro customInstall\n', '!macro dshOfficialCustomInstall\n')}${bootstrap}`);
await pm(['exec', 'electron-builder', '--config', join(root, 'scripts/desktop/electron-builder.config.mjs'), '--win', '--x64', '--publish', 'never'], desktop);
await pm(['exec', 'tsx', join(root, 'scripts/desktop/smoke-windows.mjs')], desktop);
