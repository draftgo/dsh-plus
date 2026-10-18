$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem -Path (Join-Path $PSScriptRoot '../../artifacts/windows') -Filter '*-setup.exe' | Select-Object -First 1
if ($null -eq $installer) { throw 'DSH-Plus installer was not generated' }
$previousHome = $env:DSH_HOME
$env:DSH_HOME = Join-Path $env:RUNNER_TEMP 'dsh-plus-installer-smoke'
try {
    $process = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
    $manifestPath = Join-Path $env:DSH_HOME 'profiles/desktop/package.json'
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $state = $manifest.dsh.plusInstall
    if ($null -eq $state -or $manifest.dsh.profile.bundles -notcontains $state.bundleName) { throw 'The installer did not activate managed DSH-Plus' }
    if (-not (Test-Path (Join-Path $env:DSH_HOME "profiles/desktop/node_modules/$($state.bundleName)/package.json"))) { throw 'The profile-local plugin wrapper is missing' }
    $installed = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'DSH-Plus.exe' -Recurse | Select-Object -First 1
    if ($null -eq $installed) { throw 'The installed desktop executable is missing' }
    if (-not (Test-Path (Join-Path $installed.DirectoryName 'resources/dsh-plus/plugin-bundle.mjs'))) { throw 'The offline plugin bootstrap is missing' }
    if (-not (Test-Path (Join-Path $installed.DirectoryName 'resources/dsh-plus/seed/release.json'))) { throw 'The offline plugin seed is missing' }
    if (Test-Path (Join-Path $installed.DirectoryName 'resources/app.asar.unpacked/dsh/node_modules/dsh-plus/package.json')) { throw 'DSH-Plus must be external to the sealed engine runtime' }
    Write-Output "Silent installation passed: $($installed.FullName)"
} finally {
    $env:DSH_HOME = $previousHome
}
