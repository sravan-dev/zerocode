# Stops the background ZeroCode (the hidden launcher first, so it can't respawn node).
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'scripts\zerocode-hidden.vbs'
$entry = Join-Path $root 'dist\index.js'

$all = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine }
$wscript = $all | Where-Object { $_.Name -eq 'wscript.exe' -and $_.CommandLine.Contains($launcher) }
$node = $all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine.Contains($entry) }

foreach ($p in @($wscript) + @($node)) {
  if ($p) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}
$n = @($wscript).Count + @($node).Count
if ($n -gt 0) { Write-Host "Stopped ZeroCode." } else { Write-Host "ZeroCode was not running in the background." }
