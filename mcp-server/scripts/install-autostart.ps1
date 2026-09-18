<#
  Installs the My Recorder bridge daemon to start automatically at logon, as a
  per-user Scheduled Task (no admin required). This is the practical "always-on"
  option — the daemon is up before any Claude session starts.

  Install:    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
  Uninstall:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall

  (For a true session-0 Windows *service* instead, see README — use NSSM.)
#>
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskName = 'MyRecorderBridge'

if ($Uninstall) {
  try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch {}
  Write-Output "Removed scheduled task '$taskName'."
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
$daemon = (Resolve-Path (Join-Path $PSScriptRoot '..\dist\bridge-daemon.js')).Path
if (-not (Test-Path $daemon)) { throw "Daemon not built. Run 'npm run build' first ($daemon missing)." }

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$daemon`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'My Recorder bridge daemon (broker between MCP servers and the browser extension)' -Force | Out-Null

Write-Output "Installed scheduled task '$taskName' — runs at logon:"
Write-Output "  $node `"$daemon`""
Write-Output "Start it now without logging off:  Start-ScheduledTask -TaskName $taskName"
