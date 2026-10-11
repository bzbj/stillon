param([Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference = 'Stop'
if (-not $env:WINDOWS_CERTIFICATE_BASE64 -or -not $env:WINDOWS_CERTIFICATE_PASSWORD) { throw 'Configure Windows code-signing certificate secrets before publishing installers' }
$certificatePath = Join-Path $env:RUNNER_TEMP 'stillon-signing.pfx'
try {
  [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))
  $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
  $certificate = Get-PfxCertificate -FilePath $certificatePath -Password $password
  $signature = Set-AuthenticodeSignature -FilePath $File -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
  if ($signature.Status -ne 'Valid') { throw ('Windows signing failed: ' + $signature.StatusMessage) }
} finally { Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue }
