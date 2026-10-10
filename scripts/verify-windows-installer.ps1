$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Installer acceptance requires a disposable CI runner' }
$installer = @(Get-ChildItem -LiteralPath 'dist/desktop/release' -Filter '*-setup.exe')
if ($installer.Count -ne 1) { throw 'Expected one Windows installer' }
$directory = Join-Path $env:RUNNER_TEMP 'stillon-installer-acceptance'
$log = Join-Path $env:RUNNER_TEMP 'stillon-installer-acceptance.log'
$process = Start-Process -FilePath $installer[0].FullName -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $directory + '"'),('/LOG="' + $log + '"')) -Wait -PassThru
if ($process.ExitCode -ne 0) { Get-Content $log; throw ('Installer failed: ' + $process.ExitCode) }
& (Join-Path $directory 'payload/runtime/bun.exe') --no-env-file (Join-Path $directory 'payload/bin/desktop') --verify
if ($LASTEXITCODE -ne 0) { throw 'Installed payload did not verify' }
$uninstall = Start-Process -FilePath (Join-Path $directory 'unins000.exe') -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw ('Uninstaller failed: ' + $uninstall.ExitCode) }
if (Test-Path (Join-Path $directory 'StillOn.exe')) { throw 'Uninstaller left the desktop launcher' }
New-Item -ItemType Directory -Path 'dist/desktop/reports' -Force | Out-Null
'{"status":"passed","checks":["native EXE silent install","installed runtime integrity","native EXE uninstall"]}' | Set-Content 'dist/desktop/reports/windows-installer.json'
