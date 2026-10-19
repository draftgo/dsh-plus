param([string]$PreviousInstaller = '')
$ErrorActionPreference = 'Stop'
$installers = @(Get-ChildItem -Path (Join-Path $PSScriptRoot '../../artifacts/windows') -Filter 'xiaojiao-*-win-x64-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one 小角 installer' }
$installer = $installers[0]
$previousHome = $env:DSH_HOME
$env:DSH_HOME = Join-Path $env:RUNNER_TEMP 'dsh-plus-installer-smoke'

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
    if (Test-Path (Join-Path $Installed.DirectoryName 'resources/app.asar.unpacked/dsh/node_modules/dsh-plus/package.json')) { throw 'DSH-Plus must be external to the sealed engine runtime' }
    if ($Installed.VersionInfo.ProductName -ne '小角') { throw 'Executable product name is not 小角' }
    $entries = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object { $_.InstallLocation -eq $Installed.DirectoryName })
    if ($entries.Count -ne 1 -or $entries[0].DisplayName -notlike '小角 *') { throw 'Uninstall entry must display 小角' }
    $shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/小角.lnk'
    if (-not (Test-Path $shortcut)) { throw '小角 Start Menu shortcut is missing' }
    $shell = New-Object -ComObject WScript.Shell
    if ($shell.CreateShortcut($shortcut).TargetPath -ne $Installed.FullName) { throw 'Start Menu shortcut does not launch 小角.exe' }
}
try {
    Install-Silently $installer.FullName
    $installed = Get-Installed '小角.exe'
    Assert-Plus $installed
    Write-Output "Fresh silent installation passed: $($installed.FullName)"

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
        Write-Output "DSH-Plus to 小角 upgrade passed: $($upgraded.FullName)"
    }
} finally {
    $env:DSH_HOME = $previousHome
}
