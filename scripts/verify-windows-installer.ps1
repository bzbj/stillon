$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Installer acceptance requires a disposable CI runner' }
$installer = @(Get-ChildItem -LiteralPath 'dist/desktop/release' -Filter '*-setup.exe')
if ($installer.Count -ne 1) { throw 'Expected one Windows installer' }
$directory = Join-Path $env:RUNNER_TEMP 'stillon-installer-acceptance'
$log = Join-Path $env:RUNNER_TEMP 'stillon-installer-acceptance.log'
$profileDirectory = Join-Path $env:RUNNER_TEMP 'stillon-installed-profile'
$env:HOME = $profileDirectory
$env:USERPROFILE = $profileDirectory
$env:LOCALAPPDATA = Join-Path $profileDirectory 'AppData/Local'
$custom = Join-Path $profileDirectory '.stillon/customizations/skins/personal/custom.css'
New-Item -ItemType Directory -Path (Split-Path $custom) -Force | Out-Null
'personal installed skin' | Set-Content $custom
$process = Start-Process -FilePath $installer[0].FullName -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $directory + '"'),('/LOG="' + $log + '"')) -Wait -PassThru
if ($process.ExitCode -ne 0) { Get-Content $log; throw ('Installer failed: ' + $process.ExitCode) }
& (Join-Path $directory 'payload/runtime/bun.exe') --no-env-file (Join-Path $directory 'payload/bin/desktop') --verify
if ($LASTEXITCODE -ne 0) { throw 'Installed payload did not verify' }
& (Join-Path $directory 'payload/runtime/bun.exe') --no-env-file (Join-Path $directory 'payload/bin/desktop') --no-open
if ($LASTEXITCODE -ne 0) { throw 'Installed payload did not start its native services' }
$uninstall = Start-Process -FilePath (Join-Path $directory 'unins000.exe') -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw ('Uninstaller failed: ' + $uninstall.ExitCode) }
if (Test-Path (Join-Path $directory 'StillOn.exe')) { throw 'Uninstaller left the desktop launcher' }
if ((Get-Content $custom -Raw).Trim() -ne 'personal installed skin') { throw 'Native uninstaller changed personal skin data' }
if (Test-Path (Join-Path $env:LOCALAPPDATA 'StillOn/ManagedUpdates/deployment.json')) { throw 'Native uninstaller left an active service deployment' }
New-Item -ItemType Directory -Path 'dist/desktop/reports' -Force | Out-Null
'{"status":"passed","checks":["native EXE silent install","installed runtime integrity","installed payload native service start","native EXE uninstall stops owned services","personal skin preserved"]}' | Set-Content 'dist/desktop/reports/windows-installer.json'
