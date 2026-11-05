param([Parameter(Mandatory = $true)][string[]]$Path)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ('StillOnIconResources' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class StillOnIconResources {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern uint ExtractIconEx(string file, int index, out IntPtr large, out IntPtr small, uint count);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);
}
'@
}

function Get-EmbeddedIcons([string]$File) {
  $large = [IntPtr]::Zero
  $small = [IntPtr]::Zero
  try {
    # ExtractIconEx reads actual resources; ExtractAssociatedIcon can hide a
    # missing resource by returning the shell's generic application icon.
    $count = [StillOnIconResources]::ExtractIconEx($File, 0, [ref]$large, [ref]$small, 1)
    if ($count -eq 0 -or $count -eq [uint32]::MaxValue -or $large -eq [IntPtr]::Zero -or $small -eq [IntPtr]::Zero) {
      throw "Missing embedded icon: $File"
    }
    foreach ($handle in @($large, $small)) {
      $icon = [System.Drawing.Icon]::FromHandle($handle)
      $stream = [System.IO.MemoryStream]::new()
      try {
        $icon.Save($stream)
        [Convert]::ToBase64String($stream.ToArray())
      } finally {
        $stream.Dispose()
        $icon.Dispose()
      }
    }
  } finally {
    if ($large -ne [IntPtr]::Zero) { [StillOnIconResources]::DestroyIcon($large) | Out-Null }
    if ($small -ne [IntPtr]::Zero) { [StillOnIconResources]::DestroyIcon($small) | Out-Null }
  }
}

$expected = @(Get-EmbeddedIcons (Join-Path $PSScriptRoot '../packaging/windows/StillOn.ico'))
foreach ($file in $Path) {
  $resolved = (Resolve-Path -LiteralPath $file).Path
  $actual = @(Get-EmbeddedIcons $resolved)
  if ($actual[0] -cne $expected[0] -or $actual[1] -cne $expected[1]) {
    throw "Embedded icon does not match StillOn.ico: $resolved"
  }
  Write-Host "Verified embedded StillOn icons: $resolved"
}
