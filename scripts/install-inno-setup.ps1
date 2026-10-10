$ErrorActionPreference = 'Stop'
$installer = Join-Path $env:RUNNER_TEMP 'innosetup-7.1.0-x64.exe'
$directory = Join-Path $env:RUNNER_TEMP 'inno-setup'
Invoke-WebRequest -Uri 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe' -OutFile $installer
$expected = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant() -ne $expected) { throw 'Inno Setup compiler checksum mismatch' }
$process = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $directory + '"')) -Wait -PassThru
if ($process.ExitCode -ne 0) { throw ('Inno Setup compiler install failed: ' + $process.ExitCode) }
('ISCC_PATH=' + (Join-Path $directory 'ISCC.exe')) | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
