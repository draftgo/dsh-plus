param([string]$PreviousInstaller = '')
$ErrorActionPreference = 'Stop'
$installers = @(Get-ChildItem -Path (Join-Path $PSScriptRoot '../../artifacts/windows') -Filter 'xiaojiao-*-win-x64-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one 小角 installer' }
$installer = $installers[0]
$previousHome = $env:DSH_HOME
$env:DSH_HOME = Join-Path $env:RUNNER_TEMP 'dsh-plus-installer-smoke'

# WScript.Shell can expose the ANSI shell-link target on non-Chinese Windows.
# Read IShellLinkW explicitly so the Unicode executable name remains intact.
if (-not ('XiaojiaoInstallerShortcut' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class XiaojiaoInstallerShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr findData, uint flags);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int capacity);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint capacity);

    public sealed class ShortcutDetails
    {
        public string TargetPath { get; set; }
        public string Arguments { get; set; }
        public string WorkingDirectory { get; set; }
    }

    public static ShortcutDetails Read(string path)
    {
        object instance = new ShellLink();
        try
        {
            ((IPersistFile)instance).Load(path, 0);
            var link = (IShellLinkW)instance;
            var target = new StringBuilder(32768);
            var arguments = new StringBuilder(32768);
            var working = new StringBuilder(32768);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            link.GetArguments(arguments, arguments.Capacity);
            link.GetWorkingDirectory(working, working.Capacity);
            return new ShortcutDetails { TargetPath = target.ToString(), Arguments = arguments.ToString(), WorkingDirectory = working.ToString() };
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }

    public static string ExistingLongPath(string path)
    {
        if (String.IsNullOrEmpty(path) || !File.Exists(path)) throw new FileNotFoundException("Shortcut target must be an existing file", path);
        var output = new StringBuilder(32768);
        uint length = GetLongPathNameW(Path.GetFullPath(path), output, (uint)output.Capacity);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length >= output.Capacity) throw new IOException("Shortcut target path exceeds the supported length");
        return output.ToString();
    }
}
'@
}

function Install-Silently([string]$Path) {
    $process = Start-Process -FilePath $Path -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
}
function Get-Installed([string]$Name) {
    $items = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter $Name -Recurse)
    if ($items.Count -ne 1) { throw "Expected one installed $Name, got $($items.Count)" }
    return $items[0]
}
function Assert-Plus([System.IO.FileInfo]$Installed) {
    $manifest = Get-Content (Join-Path $env:DSH_HOME 'profiles/desktop/package.json') -Raw | ConvertFrom-Json
    $state = $manifest.dsh.plusInstall
    if ($null -eq $state -or $manifest.dsh.profile.bundles -notcontains $state.bundleName) { throw 'The installer did not activate managed DSH-Plus' }
    if (-not (Test-Path (Join-Path $env:DSH_HOME "profiles/desktop/node_modules/$($state.bundleName)/package.json"))) { throw 'The profile-local plugin wrapper is missing' }
    if (-not (Test-Path (Join-Path $Installed.DirectoryName 'resources/dsh-plus/plugin-bundle.mjs'))) { throw 'The offline plugin bootstrap is missing' }
    if (-not (Test-Path (Join-Path $Installed.DirectoryName 'resources/dsh-plus/seed/release.json'))) { throw 'The offline plugin seed is missing' }
    $seed = Get-Content (Join-Path $Installed.DirectoryName 'resources/dsh-plus/seed/release.json') -Raw | ConvertFrom-Json
    if (-not $seed.version -or $state.version -ne $seed.version) { throw "Installed profile plugin version $($state.version) does not match installer seed $($seed.version)" }
    $plugin = Get-Content (Join-Path $state.directory 'node_modules/dsh-plus/package.json') -Raw | ConvertFrom-Json
    if ($plugin.name -ne 'dsh-plus' -or $plugin.version -ne $seed.version) { throw "Active plugin payload version $($plugin.version) does not match installer seed $($seed.version)" }
    Assert-PluginResolution $Installed $state.version $state.directory
    if (Test-Path (Join-Path $Installed.DirectoryName 'resources/app.asar.unpacked/dsh/node_modules/dsh-plus/package.json')) { throw 'DSH-Plus must be external to the sealed engine runtime' }
    if ($Installed.VersionInfo.ProductName -ne '小角') { throw 'Executable product name is not 小角' }
    $entries = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object { $_.InstallLocation -eq $Installed.DirectoryName })
    if ($entries.Count -ne 1 -or $entries[0].DisplayName -notlike '小角 *') { throw 'Uninstall entry must display 小角' }
    $shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/小角.lnk'
    if (-not (Test-Path $shortcut)) { throw '小角 Start Menu shortcut is missing' }
    $shell = New-Object -ComObject WScript.Shell
    $scriptLink = $shell.CreateShortcut($shortcut)
    $nativeLink = [XiaojiaoInstallerShortcut]::Read($shortcut)
    Write-Output ([ordered]@{ shortcut = $shortcut; installed = $Installed.FullName; wscriptTarget = $scriptLink.TargetPath; nativeTarget = $nativeLink.TargetPath; arguments = $nativeLink.Arguments; workingDirectory = $nativeLink.WorkingDirectory } | ConvertTo-Json -Compress)
    $target = [XiaojiaoInstallerShortcut]::ExistingLongPath($nativeLink.TargetPath)
    $expected = [XiaojiaoInstallerShortcut]::ExistingLongPath($Installed.FullName)
    if (-not [String]::Equals($target, $expected, [StringComparison]::OrdinalIgnoreCase) -or [System.IO.Path]::GetFileName($target) -ne '小角.exe' -or $nativeLink.Arguments -ne '') { throw 'Start Menu shortcut does not launch 小角.exe without arguments' }
}
function Assert-PluginResolution([System.IO.FileInfo]$Installed, [string]$ExpectedVersion, [string]$ExpectedDirectory) {
    $code = @'
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [profile, resources, expectedVersion, expectedDirectory] = process.argv.slice(1);
const runtime = join(resources, 'app.asar.unpacked', 'dsh');
const bootPath = join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
const { PluginPackages, createRuntimeResolution, loadProfileDirectory } = await import(pathToFileURL(bootPath).href);
const { Context } = createRequire(bootPath)('@deepseek-ai/cordis');
const loaded = loadProfileDirectory('dsh', profile, anchor);
const resolution = await createRuntimeResolution({ installAnchor: anchor, profile: loaded, home: dirname(dirname(profile)) });
const ctx = new Context();
try {
  await ctx.plugin(PluginPackages, { resolution });
  const parent = pathToFileURL(join(profile, 'package.json')).href;
  const selected = ctx.pluginPackages.packageOf('dsh-plus', parent);
  assert.equal(selected?.version, expectedVersion, 'actual plugin metadata must match the installed version');
  assert.equal(realpathSync.native(selected.dir), realpathSync.native(join(expectedDirectory, 'node_modules/dsh-plus')));
  const require = createRequire(parent);
  assert.equal(JSON.parse(readFileSync(require.resolve('dsh-plus/package.json'), 'utf8')).version, expectedVersion);
  assert.equal(realpathSync.native(require.resolve('dsh-plus')), realpathSync.native(join(selected.dir, 'src/plugin.mjs')));
  assert.equal(realpathSync.native(require.resolve('dsh-plus/client')), realpathSync.native(join(selected.dir, 'lib/client.js')));
  console.log(`Actual profile plugin resolution passed: ${expectedVersion}`);
} finally { await ctx.fiber.dispose(); }
'@
    $previousNode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        # Electron is a GUI-subsystem executable: a pipeline makes PowerShell
        # wait for Node-mode verification before reading its native exit code.
        & $Installed.FullName --expose-internals --input-type=module --eval $code (Join-Path $env:DSH_HOME 'profiles/desktop') (Join-Path $Installed.DirectoryName 'resources') $ExpectedVersion $ExpectedDirectory | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Actual profile plugin resolution failed: $LASTEXITCODE" }
    } finally { $env:ELECTRON_RUN_AS_NODE = $previousNode }
}
function Add-LegacyPluginShadow {
    $directory = Join-Path $env:DSH_HOME 'profiles/desktop/node_modules/dsh-plus'
    if (Test-Path $directory) { throw 'Legacy shadow fixture must not overwrite an existing package' }
    New-Item (Join-Path $directory 'src') -ItemType Directory -Force | Out-Null
    New-Item (Join-Path $directory 'lib') -ItemType Directory -Force | Out-Null
    $metadata = '{"name":"dsh-plus","version":"0.1.6","type":"module","main":"./src/plugin.mjs","exports":{".":"./src/plugin.mjs","./client":"./lib/client.js","./package.json":"./package.json"}}'
    Set-Content (Join-Path $directory 'package.json') $metadata -Encoding utf8NoBOM
    Set-Content (Join-Path $directory 'src/plugin.mjs') 'export default true;' -Encoding utf8NoBOM
    Set-Content (Join-Path $directory 'lib/client.js') 'export default true;' -Encoding utf8NoBOM
}
try {
    Install-Silently $installer.FullName
    $installed = Get-Installed '小角.exe'
    Assert-Plus $installed
    Write-Output "Fresh silent installation passed: $($installed.FullName)"
    Add-LegacyPluginShadow
    Assert-PluginResolution $installed '0.1.6' (Join-Path $env:DSH_HOME 'profiles/desktop')
    Install-Silently $installer.FullName
    Assert-Plus $installed
    if (Test-Path (Join-Path $env:DSH_HOME 'profiles/desktop/node_modules/dsh-plus')) { throw 'Reinstall left a legacy physical plugin shadow' }
    Write-Output 'Same-version reinstall repaired the legacy physical plugin and resolved the current version.'

    if ($PreviousInstaller) {
        if (-not (Test-Path $PreviousInstaller)) { throw 'Previous installer is missing' }
        $uninstallers = @(Get-ChildItem $installed.DirectoryName -Filter 'Uninstall*.exe')
        if ($uninstallers.Count -ne 1) { throw 'Expected one uninstaller' }
        # Run a copied NSIS uninstaller directly so -Wait covers its full cleanup.
        $uninstaller = Join-Path $env:RUNNER_TEMP 'xiaojiao-smoke-uninstall.exe'
        Copy-Item $uninstallers[0].FullName $uninstaller -Force
        $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$($installed.DirectoryName)") -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Uninstaller exited $($process.ExitCode)" }
        Install-Silently (Resolve-Path $PreviousInstaller).Path
        $legacy = Get-Installed 'DSH-Plus.exe'
        $profileMarker = Join-Path $env:DSH_HOME 'xiaojiao-upgrade-marker.txt'
        $dataDirectory = Join-Path $env:APPDATA 'dsh-plus-desktop'
        New-Item $dataDirectory -ItemType Directory -Force | Out-Null
        $dataMarker = Join-Path $dataDirectory 'xiaojiao-upgrade-marker.txt'
        Set-Content $profileMarker 'keep profile'
        Set-Content $dataMarker 'keep desktop data'
        Install-Silently $installer.FullName
        $upgraded = Get-Installed '小角.exe'
        Assert-Plus $upgraded
        if ($upgraded.DirectoryName -ne $legacy.DirectoryName) { throw 'Upgrade changed the registered installation directory' }
        if (Test-Path $legacy.FullName) { throw 'The previous DSH-Plus.exe was left behind' }
        if ((Get-Content $profileMarker) -ne 'keep profile' -or (Get-Content $dataMarker) -ne 'keep desktop data') { throw 'Upgrade did not preserve user data' }
        if (Test-Path (Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/DSH-Plus.lnk')) { throw 'The legacy Start Menu shortcut was left behind' }
        $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
        if (Test-Path (Join-Path $desktop 'DSH-Plus.lnk')) { throw 'The legacy Desktop shortcut was left behind' }
        Write-Output "DSH-Plus to 小角 upgrade passed: $($upgraded.FullName)"
    }
} finally {
    $env:DSH_HOME = $previousHome
}
